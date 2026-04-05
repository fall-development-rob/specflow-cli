# DDD-005: Incremental Enforcement Domain Design

**Status:** Proposed
**Date:** 2026-04-05
**Depends on:** DDD-001 (Contract Engine), DDD-002 (Enforcement Pipeline)

---

## Domain Overview

Incremental enforcement scopes the existing contract engine to a subset of files determined by git state — either staged files (`--staged`) or files changed relative to a branch (`--diff <branch>`). This domain sits between the CLI command layer and the contract engine, providing a filtered file list and optional baseline comparison for identifying new-vs-existing violations.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Staged File** | A file added to the git index via `git add`. Identified by `git diff --cached --name-status`. |
| **Diff File** | A file changed between a base branch and HEAD. Identified by `git diff <branch>...HEAD --name-status`. |
| **File Status** | Git's single-letter status code: `A` (added), `M` (modified), `D` (deleted), `R` (renamed), `C` (copied). |
| **Scannable File** | A file with status `A` or `M` (or the new path of `R`) that exists on disk, is not binary, and falls within at least one contract's scope. |
| **Binary File** | A file whose extension is in the binary denylist. Not meaningful to scan against regex patterns. |
| **Baseline Comparison** | Running enforcement on the base branch to determine pre-existing violations, then subtracting them from the PR's violations to find only new ones. |
| **New Violation** | A violation present in the current enforcement run but absent from the baseline. |
| **Repo Root** | The absolute path returned by `git rev-parse --show-toplevel`. All relative paths are resolved against this. |

---

## Value Objects

### FileStatus

```typescript
interface FileStatus {
  status: 'A' | 'M' | 'D' | 'R' | 'C';
  path: string;           // Relative to repo root
  newPath?: string;       // Only for R (renamed): the destination path
}
```

### StagedFile

```typescript
interface StagedFile {
  absolutePath: string;   // Resolved from repo root + relative path
  relativePath: string;   // As reported by git
  status: 'A' | 'M';     // Only scannable statuses
}
```

### DiffResult

```typescript
interface DiffResult {
  baseBranch: string;     // The branch compared against
  mergeBase: string;      // The common ancestor commit SHA
  files: StagedFile[];    // Filtered, scannable files
  totalRaw: number;       // Total files in raw diff (before filtering)
  filtered: {
    deleted: number;      // Skipped because status = D
    binary: number;       // Skipped because binary extension
    outOfScope: number;   // Skipped because no contract scope matches
  };
}
```

### BaselineComparison

```typescript
interface BaselineComparison {
  baseViolations: ViolationRecord[];    // Violations on base branch
  headViolations: ViolationRecord[];    // Violations on HEAD
  newViolations: ViolationRecord[];     // In HEAD but not in base
  resolvedViolations: ViolationRecord[]; // In base but not in HEAD
}
```

### ViolationRecord

```typescript
interface ViolationRecord {
  ruleId: string;         // e.g., "SEC-001"
  contractId: string;     // e.g., "security_defaults"
  filePath: string;       // Absolute path
  line: number;           // Line number of violation
  pattern: string;        // The regex that matched
  message: string;        // Human-readable description
}
```

---

## Domain Services

### GitIntegrationService

Responsible for all git interactions. Isolates the domain from git CLI details.

```typescript
interface GitIntegrationService {
  /** Returns absolute path to repo root, or throws NotInGitRepoError */
  getRepoRoot(): string;

  /** Returns staged files with status codes */
  getStagedFiles(): FileStatus[];

  /** Returns files changed between branch and HEAD */
  getDiffFiles(baseBranch: string): FileStatus[];

  /** Returns the merge-base SHA, or throws NoCommonAncestorError */
  getMergeBase(baseBranch: string): string;

  /** Verifies a branch ref exists */
  branchExists(branch: string): boolean;
}
```

**Implementation notes:**
- All methods execute `git` via `child_process.execSync` (enforcement is synchronous).
- Parse `--name-status` output line by line: `status\tpath` or `status\told\tnew` for renames.
- Cache `getRepoRoot()` result for the duration of the run.

### FileFilterPipeline

Transforms raw git output into a list of scannable files.

```typescript
interface FileFilterPipeline {
  /** Full pipeline: parse → filter status → resolve paths → filter binary → filter scope */
  filter(
    rawFiles: FileStatus[],
    repoRoot: string,
    contractScopes: string[]  // Glob patterns from all active contracts
  ): StagedFile[];
}
```

**Filter stages (in order):**

1. **Status filter:** Keep only `A`, `M`. For `R`, extract `newPath` and treat as `A`.
2. **Path resolution:** `path.resolve(repoRoot, file.path)` → absolute path.
3. **Existence check:** Verify file exists on disk (`fs.existsSync`). Skip if not.
4. **Binary filter:** Check extension against denylist. Skip if binary.
5. **Scope filter:** Test absolute path against all contract scope globs. Skip if no scope matches.

### BaselineComparisonService

Computes which violations are new vs pre-existing.

```typescript
interface BaselineComparisonService {
  /**
   * Compare violations between base branch and HEAD.
   * "New" = present in headViolations but not in baseViolations.
   * Matching key: (ruleId, filePath, line) — but line numbers shift,
   * so match on (ruleId, filePath, pattern match content) instead.
   */
  compare(
    baseViolations: ViolationRecord[],
    headViolations: ViolationRecord[]
  ): BaselineComparison;
}
```

**Matching strategy:** Two violations match if they share `ruleId` + `filePath` + `matchedContent` (the actual text that matched the regex). Line numbers are unreliable because code above may have shifted them.

---

## Aggregates

### IncrementalEnforcementRun

The root aggregate orchestrating an incremental enforcement run.

```
IncrementalEnforcementRun
├── mode: 'staged' | 'diff'
├── baseBranch?: string            # Only for 'diff' mode
├── diffResult: DiffResult
├── violations: ViolationRecord[]
├── comparison?: BaselineComparison # Only when baseline requested
├── suggestions?: FixSuggestion[]   # Only with --suggest flag
└── exitCode: 0 | 1 | 2
```

**Invariants:**
- `mode = 'staged'` requires being inside a git repo.
- `mode = 'diff'` requires `baseBranch` to exist and have a common ancestor with HEAD.
- If `diffResult.files` is empty, `violations` is empty and `exitCode` is 0.

---

## Error Types

| Error | Trigger | Exit Code | Message |
|-------|---------|-----------|---------|
| `NotInGitRepoError` | `--staged` or `--diff` outside git repo | 2 | `--staged and --diff require a git repository` |
| `BranchNotFoundError` | `--diff <branch>` where branch doesn't exist | 2 | `branch '<branch>' not found` |
| `NoCommonAncestorError` | Orphan branches with no merge-base | 2 | `no common ancestor between '<branch>' and HEAD` |

---

## Integration Points

| Component | How It Integrates |
|-----------|-------------------|
| `enforce` command | Calls `GitIntegrationService` + `FileFilterPipeline` to build file list, passes to contract engine |
| Contract engine (Rust/NAPI-RS) | Receives filtered file list — no changes needed |
| Knowledge graph (Phase 10) | `ViolationRecorder` records violations from incremental runs the same way as full runs |
| PR compliance report (PRD-007) | Uses `BaselineComparisonService` to distinguish new vs existing violations |
| `--suggest` flag | Queries knowledge graph `FixTracker` for suggestions, keyed by `ruleId` |
