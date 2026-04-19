---
id: ADR-008
title: Incremental Enforcement (--staged and --diff)
type: ADR
status: Accepted
version: 1
date: '2026-04-05'
last_reviewed: '2026-04-17'
implements:
  - ADR-003
  - DDD-002
implemented_by:
  - ADR-010
  - PRD-010
---

# ADR-008: Incremental Enforcement (--staged and --diff)

---

## Context

Today `specflow enforce .` scans the entire project on every run. In CI, developers only care about violations introduced by their PR. Locally, developers working on a feature want to check only the files they've staged for commit. Scanning the full project is slow on large codebases and produces noise from pre-existing violations unrelated to current work.

Git provides the primitives needed to scope enforcement: `git diff --cached` (staged files) and `git diff <branch>...HEAD` (changed vs a branch). By integrating these, Specflow can enforce only what changed.

---

## Decision

Add two new flags to `specflow enforce`:

1. **`--staged`** — Enforce only files currently staged in the git index (`git diff --cached --name-status`).
2. **`--diff <branch>`** — Enforce only files changed between `<branch>` and HEAD (`git diff <branch>...HEAD --name-status`).

Both flags filter the file list before passing it to the existing contract engine. The engine itself is unchanged — it receives a list of absolute file paths and scans them against compiled contract patterns.

### Additional output flags

3. **`--json`** — Output enforcement results as JSON (already exists; works with `--staged` and `--diff`).
4. **`--suggest`** — Query the knowledge graph for fix suggestions and append them to violation output (see ADR-007, Phase 10).

---

## Git Integration Design

### File Resolution Pipeline

```
git diff command
    → parse --name-status output
    → filter: keep only A (added) and M (modified) statuses
    → resolve paths: join repo root + relative path → absolute path
    → filter: exclude binary files (by extension allowlist)
    → filter: exclude files outside contract scopes
    → pass to contract engine
```

### Commands Used

| Flag | Git Command | Notes |
|------|-------------|-------|
| `--staged` | `git diff --cached --name-status` | Staged files only |
| `--diff <branch>` | `git diff <branch>...HEAD --name-status` | Three-dot diff for merge-base comparison |

---

## Edge Cases and Resolutions

### E1-1: Relative Path Resolution

**Problem:** `git diff --cached` returns paths relative to the repository root (e.g., `src/auth/login.ts`). The contract engine expects absolute paths.

**Resolution:** Detect the repo root via `git rev-parse --show-toplevel`, then join: `path.resolve(repoRoot, relativePath)`. Cache the repo root for the duration of the run.

### E1-2: Deleted Staged Files

**Problem:** Deleted files appear in `git diff --cached` with status `D`. They cannot be scanned because the file no longer exists on disk.

**Resolution:** Parse the status column from `--name-status` output. Only process files with status `A` (added) or `M` (modified). Skip `D` (deleted) entries entirely.

### E1-3: Binary Files in Diff

**Problem:** Binary files (images, compiled assets) may appear in the diff. Scanning them against regex patterns is meaningless and slow.

**Resolution:** Maintain an extension denylist: `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.eot`, `.mp4`, `.webm`, `.zip`, `.tar`, `.gz`, `.pdf`, `.lock`. If a file's extension matches the denylist, skip it. Additionally, respect each contract's `scope` glob — binary files outside scope are already excluded.

### E1-4: Renamed Files

**Problem:** `git diff --name-status` shows renamed files as `R100\told-path\tnew-path`. The old path appears as a deletion, the new path as an addition.

**Resolution:** For status `R` (renamed), extract only the new path (second tab-separated field). The old path no longer exists and should not be scanned.

### E1-5: Not in a Git Repository

**Problem:** Running `--staged` or `--diff` outside a git repo causes `git` commands to fail with a non-descriptive error.

**Resolution:** Before executing any git command, check for a `.git` directory or run `git rev-parse --is-inside-work-tree`. If not in a repo, exit with code 1 and message: `Error: --staged and --diff require a git repository. Run from inside a git repo.`

### E1-6: Target Branch Does Not Exist

**Problem:** `--diff nonexistent-branch` causes `git diff` to fail.

**Resolution:** Before running the diff, verify the branch exists via `git rev-parse --verify <branch>`. If it fails, exit with code 1 and message: `Error: branch '<branch>' not found. Check the branch name and try again.`

### E1-7: No Common Ancestor (Orphan Branches)

**Problem:** `git diff <branch>...HEAD` fails when there is no merge-base between the branches (orphan branches).

**Resolution:** Run `git merge-base <branch> HEAD` first. If it returns non-zero, exit with code 1 and message: `Error: no common ancestor between '<branch>' and HEAD. Cannot compute diff.`

### E1-8: Empty Diff

**Problem:** Files were changed then reverted, or `--staged` is used with nothing staged. The diff is empty.

**Resolution:** If the filtered file list is empty after all filters, output: `No changes to scan. 0 files matched after filtering.` Exit with code 0 (no violations found in zero files is not an error).

---

## Exit Codes

Consistent with existing `specflow enforce` behavior:

| Code | Meaning |
|------|---------|
| 0 | No violations found (or no files to scan) |
| 1 | Violations found |
| 2 | System error (not in git repo, branch not found, etc.) |

---

## Consequences

### Positive

- CI pipelines only report violations introduced in the PR, not pre-existing ones
- Local pre-commit hooks run faster by scanning only staged files
- Reduces noise and developer frustration with legacy violations
- Enables PR compliance reports (see PRD-007) by providing `--diff --json` output

### Negative

- Adds git as a runtime dependency for `--staged` and `--diff` (already effectively required)
- Developers may miss project-wide violations that aren't in their diff
- Renamed file handling adds parsing complexity

### Neutral

- The contract engine itself is unchanged — only the file list generation is new
- Full-project enforcement (`specflow enforce .`) remains the default behavior
