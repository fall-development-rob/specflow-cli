# PRD-007: Incremental Enforcement & PR Compliance

**Status:** Proposed
**Date:** 2026-04-05
**Phase:** 11 (sub-phases 11a, 11b, 11d)
**Depends on:** Phase 10 (Knowledge Graph), Phase 8 (Simulation Fixes), Phase 2 (CLI Rewrite)

---

## Overview

Three related features that make `specflow enforce` CI-ready and developer-friendly:

1. **`--staged` flag** — Enforce only git-staged files (for pre-commit hooks)
2. **`--diff <branch>` flag** — Enforce only files changed vs a branch (for PR checks)
3. **`--suggest` flag** — Show fix suggestions from the knowledge graph
4. **PR compliance report** — Post enforcement results as a PR comment in CI

See [ADR-008](../adrs/ADR-008-incremental-enforcement.md) for the architectural decision and [DDD-005](../ddds/DDD-005-incremental-enforcement.md) for the domain model.

---

## Feature 1: `specflow enforce --staged` (Phase 11a)

### Specification

Scan only files staged in the git index against all active contracts.

**Command:**
```bash
specflow enforce --staged
```

**Behavior:**
1. Run `git diff --cached --name-status` to get staged files.
2. Filter to `A` (added) and `M` (modified) statuses. Extract new path from `R` (renamed).
3. Resolve paths to absolute using `git rev-parse --show-toplevel`.
4. Exclude binary files (extension denylist).
5. Exclude files outside all contract scopes.
6. Pass filtered file list to contract engine.
7. Report violations and exit with appropriate code.

**Acceptance Criteria:**
- [ ] `--staged` with no staged files outputs "No changes to scan" and exits 0
- [ ] `--staged` with staged .ts files scans them against all contracts
- [ ] `--staged` outside a git repo exits 2 with clear error message
- [ ] Deleted staged files (status D) are skipped without error
- [ ] Binary staged files (.png, .woff, etc.) are skipped without error
- [ ] Renamed files scan only the new path
- [ ] Exit code 0 when no violations, 1 when violations found, 2 on system error
- [ ] `--staged --json` outputs JSON format

### Edge Cases (E1-1 through E1-8)

| ID | Edge Case | Resolution |
|----|-----------|------------|
| E1-1 | Relative paths from git diff | Resolve via `path.resolve(repoRoot, relativePath)` |
| E1-2 | Deleted files in diff | Filter by status: only A, M, R(new path) |
| E1-3 | Binary files | Extension denylist filter |
| E1-4 | Renamed files | Extract new path from R status |
| E1-5 | Not in git repo | Exit 2 with clear error |
| E1-6 | Branch doesn't exist | Exit 2 with clear error (applies to --diff) |
| E1-7 | No common ancestor | Exit 2 with clear error (applies to --diff) |
| E1-8 | Empty diff | "No changes to scan", exit 0 |

---

## Feature 2: `specflow enforce --diff <branch>` (Phase 11a)

### Specification

Scan only files changed between a base branch and HEAD.

**Command:**
```bash
specflow enforce --diff main
specflow enforce --diff main --json
```

**Behavior:**
1. Verify branch exists via `git rev-parse --verify <branch>`.
2. Find merge-base via `git merge-base <branch> HEAD`.
3. Run `git diff <branch>...HEAD --name-status`.
4. Apply same filter pipeline as `--staged`.
5. Pass filtered file list to contract engine.

**Acceptance Criteria:**
- [ ] `--diff main` scans only files changed since diverging from main
- [ ] `--diff nonexistent` exits 2 with "branch 'nonexistent' not found"
- [ ] Orphan branches (no merge-base) exit 2 with clear error
- [ ] `--diff main --json` outputs machine-readable JSON
- [ ] Compatible with `--suggest` flag

---

## Feature 3: `specflow enforce --suggest` (Phase 11b)

### Specification

Query the knowledge graph for fix suggestions and include them in enforcement output.

**Command:**
```bash
specflow enforce . --suggest
specflow enforce --staged --suggest
specflow enforce --diff main --suggest --json
```

**Behavior:**
1. After enforcement finds violations, query the knowledge graph for each unique violated rule ID.
2. Retrieve fix suggestions ranked by confidence score (success count / total attempts).
3. Append suggestions to violation output, grouped by rule (not per file).
4. In JSON mode, include suggestions in the `suggestions` field.

**Acceptance Criteria:**
- [ ] `--suggest` without knowledge graph (fresh project) shows no suggestions, does not error
- [ ] `--suggest` with knowledge graph shows suggestions grouped by rule ID
- [ ] Suggestions include confidence score as "X/Y successful" (e.g., "3/4 successful")
- [ ] Same rule violated in multiple files shows suggestion once
- [ ] `--suggest` is opt-in, not included by default
- [ ] Performance: batch graph queries (one per unique rule ID, not per violation)
- [ ] Seed suggestions from contract `example_compliant` fields when no history exists

### Edge Cases (E2-1 through E2-7)

| ID | Edge Case | Resolution |
|----|-----------|------------|
| E2-1 | Fresh project, no fix history | Seed from `example_compliant` fields in YAML contracts |
| E2-2 | Seed data source | Extract from existing contract YAML `example_compliant` patterns |
| E2-3 | Wrong suggestion applied | Feedback loop: `specflow learn --mark-failed <suggestion-id>` updates confidence |
| E2-4 | Confidence score explanation | Show "3/4 successful" format, not opaque percentage |
| E2-5 | Same rule, multiple files | Show suggestion once per rule, with count of affected files |
| E2-6 | Verbose output concern | `--suggest` is opt-in flag, not default behavior |
| E2-7 | Performance | Batch: collect unique rule IDs, one graph query per rule, not per violation |

---

## Feature 4: PR Compliance Report (Phase 11d)

### Specification

Generate a compliance report from incremental enforcement and post it as a PR comment in CI.

### Two-step design (platform-agnostic)

**Step 1: Generate report (platform-agnostic)**
```bash
specflow enforce --diff main --json > report.json
```

**Step 2: Post report (platform-specific)**
```bash
specflow report post --github          # Uses GH_TOKEN + PR number from env
specflow report post --github --pr 42  # Explicit PR number
```

**Report format (JSON):**
```json
{
  "summary": {
    "filesScanned": 12,
    "totalViolations": 3,
    "newViolations": 2,
    "existingViolations": 1,
    "resolvedViolations": 0
  },
  "violations": [...],
  "suggestions": [...],
  "metadata": {
    "baseBranch": "main",
    "headSha": "abc123",
    "timestamp": "2026-04-05T10:00:00Z"
  }
}
```

**PR comment format (Markdown):**
```markdown
<!-- specflow-report -->
## Specflow Compliance Report

**2 new violations** | 1 existing | 0 resolved | 12 files scanned

### New Violations
| Rule | File | Line | Description |
|------|------|------|-------------|
| SEC-001 | src/auth.ts | 42 | Hardcoded credential detected |

### Suggestions
- **SEC-001**: Use environment variables instead of hardcoded values (3/4 successful)

---
*Generated by [Specflow](https://github.com/fall-development-rob/specflow-cli)*
```

**Acceptance Criteria:**
- [ ] `specflow enforce --diff main --json` generates complete JSON report
- [ ] `specflow report post --github` posts/updates PR comment
- [ ] Existing comment updated (found by `<!-- specflow-report -->` marker) instead of creating new one
- [ ] Report posted BEFORE non-zero exit (post then exit 1)
- [ ] Missing `GH_TOKEN` → clear error: "GH_TOKEN required for posting PR comments"
- [ ] PR number auto-detected from `GITHUB_EVENT_PATH` or `gh pr view`
- [ ] Large reports truncated at 60KB with link to full artifact
- [ ] Configurable exit behavior: `block` (exit 1) or `warn` (exit 0) via `.specflow/config.json`

### Edge Cases (E4-1 through E4-8)

| ID | Edge Case | Resolution |
|----|-----------|------------|
| E4-1 | GH_TOKEN missing | Detect env; clear error message pointing to CI token setup |
| E4-2 | PR number detection | `GITHUB_EVENT_PATH` (CI) → `gh pr view --json number` (local) → `--pr` flag (manual) |
| E4-3 | Post before exit | `report post` always runs before process exits, even on violations |
| E4-4 | Duplicate comments | Find existing comment by `<!-- specflow-report -->` HTML marker, update it |
| E4-5 | Non-GitHub CI | Two-step design: JSON generation is platform-agnostic, posting is platform-specific |
| E4-6 | New vs existing violations | `BaselineComparisonService` runs enforcement on base branch, diffs results |
| E4-7 | Large PRs | Truncate Markdown body at 60KB, append "Full report available as artifact" |
| E4-8 | Block vs warn mode | `.specflow/config.json` → `{ "ci": { "onViolation": "block" | "warn" } }` |

---

## Configuration

New `.specflow/config.json` fields:

```json
{
  "ci": {
    "onViolation": "block",
    "reportFormat": "markdown",
    "maxReportSize": 61440,
    "postComment": true
  },
  "suggestions": {
    "seedFromExamples": true,
    "minConfidence": 0.5
  }
}
```

---

## Implementation Priority

1. **11a: `--staged` + `--diff`** — Foundation for everything else
2. **11b: `--suggest`** — Leverages Phase 10 knowledge graph
3. **11d: PR compliance report** — Builds on `--diff --json` output
