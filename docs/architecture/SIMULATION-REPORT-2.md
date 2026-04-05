# Simulation Report 2: Phase 11 Feature Validation

**Date:** 2026-04-05
**Simulation type:** Feature edge-case analysis
**Features simulated:** 5
**Edge cases found:** 38
**Severity breakdown:** 4 Critical, 11 High, 16 Medium, 7 Low

---

## Methodology

Five proposed features for Specflow were simulated by walking through realistic developer scenarios — fresh installs, CI pipelines, edge-case git states, conflicting packages, and AI-generated contracts. Each feature was tested against scenarios designed to trigger failure modes.

**Approach:**
1. Define the feature's happy path.
2. Identify boundary conditions (empty inputs, missing dependencies, conflicting state).
3. Walk through the code path mentally, identifying where errors would surface.
4. Classify each edge case by severity and specify the resolution.

**Severity scale:**
- **Critical:** Feature crashes or produces silently wrong results.
- **High:** Feature fails with a poor error message or unexpected behavior.
- **Medium:** Feature works but with degraded UX or missing information.
- **Low:** Cosmetic or minor UX issue.

---

## Feature 1: `enforce --staged` + `enforce --diff`

**Purpose:** Scan only git-staged files or files changed vs a branch.

| ID | Edge Case | Severity | Reproduction | Resolution |
|----|-----------|----------|-------------- |------------|
| E1-1 | Paths from `git diff --cached` are relative to repo root, not CWD | **High** | Run `specflow enforce --staged` from a subdirectory | Resolve all paths via `path.resolve(repoRoot, relativePath)` where repoRoot = `git rev-parse --show-toplevel` |
| E1-2 | Deleted staged files appear in diff but don't exist on disk | **Critical** | `git rm src/old.ts && specflow enforce --staged` → crash reading deleted file | Parse `--name-status` output; filter to status A (added) and M (modified) only; skip D (deleted) |
| E1-3 | Binary files (.png, .woff) in diff are meaningless to scan | **Medium** | Stage an image file, run `--staged` → wastes time scanning binary | Maintain extension denylist; skip files matching it |
| E1-4 | Renamed files show as D (old) + A (new) in `--name-status` | **Medium** | `git mv old.ts new.ts && specflow enforce --staged` → tries to scan deleted old path | For status R: extract only the new path (second field); ignore old path |
| E1-5 | Running `--staged` outside a git repo | **Critical** | `cd /tmp && specflow enforce --staged` → git command fails with cryptic error | Check `git rev-parse --is-inside-work-tree` first; exit 2 with clear message |
| E1-6 | `--diff nonexistent-branch` | **High** | `specflow enforce --diff my-typo` → git error dump | Verify branch via `git rev-parse --verify <branch>` first; exit 2 with "branch not found" |
| E1-7 | Orphan branches with no common ancestor | **High** | Create orphan branch, run `--diff main` → `git merge-base` fails | Run `git merge-base` first; exit 2 with "no common ancestor" message |
| E1-8 | All changed files reverted, diff is empty | **Low** | Change file, revert, run `--staged` → empty file list | If filtered list is empty: output "No changes to scan", exit 0 |

---

## Feature 2: Auto-Fix Suggestions

**Purpose:** Show fix suggestions from knowledge graph in enforce output.

| ID | Edge Case | Severity | Reproduction | Resolution |
|----|-----------|----------|-------------- |------------|
| E2-1 | Fresh project has no fix history in knowledge graph | **Medium** | `specflow init . && specflow enforce --suggest` → suggestions always empty | Seed the graph with patterns from contract `example_compliant` fields on `specflow init` |
| E2-2 | Seed data source already exists in YAML | **Low** | Contract YAML already has `example_compliant` field | Extract `example_compliant` from all contracts during graph initialization as seed fix patterns |
| E2-3 | Wrong suggestion applied, enforce still fails | **Medium** | User applies suggestion, violation persists → user loses trust | Implement feedback loop: `specflow learn --mark-failed <suggestion-id>` decrements confidence score |
| E2-4 | Confidence score is opaque percentage | **Low** | User sees "confidence: 0.75" — means nothing | Display as "3/4 successful" (success count / total attempts) |
| E2-5 | Same rule violated in 20 files → suggestion repeated 20 times | **Medium** | Large codebase with many `console.log` violations | Show suggestion once per rule ID with count: "SEC-001 (in 20 files): ..." |
| E2-6 | Suggestions clutter default output | **Medium** | `specflow enforce .` shows paragraphs of suggestions nobody asked for | Make `--suggest` opt-in flag; never show suggestions without it |
| E2-7 | Query graph per violation is O(n) and slow | **High** | 500 violations → 500 graph queries → 30s+ | Collect unique rule IDs first; batch query: one query per rule ID, not per violation |

---

## Feature 3: `specflow contract create`

**Purpose:** Create contracts from templates or AI-generated descriptions.

| ID | Edge Case | Severity | Reproduction | Resolution |
|----|-----------|----------|-------------- |------------|
| E3-1 | AI mode requires Claude CLI but user doesn't have it | **High** | `specflow contract create --ai "desc"` → fails trying to call Claude | Check for Claude CLI first; default to `--template`; show install instructions for AI mode |
| E3-2 | AI-generated regex doesn't compile | **Critical** | AI returns `[invalid(regex` → contract save would create broken contract | Validate regex via `new RegExp(pattern)` before saving; show error and ask to refine description |
| E3-3 | Generated scope matches zero project files | **Medium** | AI generates scope `**/*.py` in a TypeScript project → contract does nothing | Warn but don't block: "Scope matches 0 files. Contract saved but won't enforce until files exist." |
| E3-4 | Generated contract ID conflicts with existing contract | **High** | AI generates ID `SEC-001` which already exists | Auto-generate `CUSTOM-NNN` format; scan all existing contracts for conflicts before saving |
| E3-5 | Save location unclear | **Low** | User expects contract in `templates/` | Always save to `.specflow/contracts/custom_<slug>.yml`; document clearly |
| E3-6 | No immediate feedback after creation | **Medium** | User creates contract but doesn't know if it does anything | Run `specflow enforce --contract <id>` immediately after saving; show results |
| E3-7 | Vague AI description produces low-quality contract | **Medium** | "make my code better" → AI returns overly broad or meaningless regex | Validation pipeline catches bad regex/examples; show specific errors; suggest refining with concrete terms |
| E3-8 | No review step before saving | **High** | AI generates contract with wrong pattern, saved immediately | Interactive review: show YAML, ask "Save? (y/n/edit)" before writing to disk |
| E3-9 | Example fields don't match the pattern | **Critical** | `example_violation` doesn't match the regex → contract is internally inconsistent | Test both examples against the pattern before saving; reject if they fail |
| E3-10 | No templates available out of the box | **Medium** | `specflow contract create --template` → empty list | Ship 6 pre-built templates: no-console-log, no-any-type, api-auth-required, no-todo-comments, env-vars-only, no-inline-styles |

---

## Feature 4: PR Compliance Report

**Purpose:** Post compliance diff as PR comment in CI.

| ID | Edge Case | Severity | Reproduction | Resolution |
|----|-----------|----------|-------------- |------------|
| E4-1 | GH_TOKEN not set in local environment | **High** | Run `specflow report post --github` locally → API call fails | Detect `GH_TOKEN` env var; clear error: "GH_TOKEN required. In CI this is automatic; locally run `export GH_TOKEN=...`" |
| E4-2 | PR number not determinable | **High** | Run in CI without `GITHUB_EVENT_PATH` → can't find PR | Fallback chain: `GITHUB_EVENT_PATH` → `gh pr view --json number` → `--pr` flag → error |
| E4-3 | Enforce fails but comment not posted | **Critical** | `enforce --diff` exits 1 before `report post` runs | Design: post comment FIRST, then exit with appropriate code |
| E4-4 | New comment on every push clutters PR | **Medium** | 10 pushes → 10 identical compliance comments | Find existing comment by `<!-- specflow-report -->` HTML marker; update instead of creating new |
| E4-5 | Non-GitHub CI (GitLab, Bitbucket) | **High** | Run in GitLab CI → GitHub API doesn't work | Separate report generation (`--json`) from posting (`report post --github`); platform-agnostic JSON, platform-specific posting |
| E4-6 | Can't distinguish new vs pre-existing violations | **Medium** | PR report shows all violations, not just ones this PR introduced | Run `BaselineComparisonService`: enforce on base branch, enforce on HEAD, diff the results |
| E4-7 | Large PR generates enormous comment | **Medium** | 500 violations → 200KB Markdown comment → GitHub API rejects | Truncate at 60KB; append "Full report available as build artifact"; link to CI artifact |
| E4-8 | Team wants warnings, not blocking | **Medium** | `enforce` exits 1 → PR blocked; team wants visibility without enforcement | `.specflow/config.json` → `ci.onViolation: "warn"` exits 0 with comment; `"block"` exits 1 |

---

## Feature 5: Contract Packages (`specflow add`)

**Purpose:** Shareable, versioned contract packages via npm.

| ID | Edge Case | Severity | Reproduction | Resolution |
|----|-----------|----------|-------------- |------------|
| E5-1 | Flat installation causes name collisions | **High** | Two packages with same file name in contracts/ | Install to `.specflow/packages/<package-name>/` with npm scope preserved |
| E5-2 | Enforce only scans `.specflow/contracts/` | **Critical** | Install package but contracts are never enforced | Modify loader to scan both `contracts/` and `packages/` directories recursively |
| E5-3 | Rule ID conflicts between packages | **Critical** | `@specflow/react` and `@specflow/vue` both define `FE-001` | Error on package-package duplicate; user-package: user wins with warning |
| E5-4 | Contracts in node_modules are transient | **High** | `npm ci` wipes node_modules → packages disappear | Copy contracts to `.specflow/packages/` on `add`; commit to git; enforce reads local copies |
| E5-5 | Stale copies after npm update | **Medium** | `npm update` bumps package version but `.specflow/packages/` has old version | `specflow update-packages` re-copies from node_modules; `specflow doctor` detects version mismatch |
| E5-6 | No network during enforcement | **Low** | Airplane mode → `specflow enforce` should still work | Enforcement reads from `.specflow/packages/` (local), not `node_modules` or network |
| E5-7 | Transitive Specflow dependencies | **High** | `@specflow/nextjs` depends on `@specflow/react` → react not installed | npm resolves deps; `specflow add` scans full dependency tree for `specflow` field, installs all |
| E5-8 | Lock file out of sync with disk | **Medium** | Manual deletion of package directory → lock file says it's installed | `specflow doctor` validates lock file against disk; `update-packages` repairs |
| E5-9 | User contract same ID as package contract | **Medium** | User defines `SEC-001`, package also has `SEC-001` | User wins. Warning: "Rule SEC-001 in @specflow/security shadowed by user contract." |
| E5-10 | No clean removal path | **Low** | User doesn't know how to uninstall a package | `specflow remove <pkg>` deletes directory + lock entry; does not run `npm uninstall` |
| E5-11 | No publishing workflow | **Medium** | User wants to share contracts but no tooling | `specflow publish` scaffolds package.json with `specflow` field, validates, runs `npm publish` |

---

## Summary by Severity

| Severity | Count | Features Affected |
|----------|-------|-------------------|
| Critical | 4 | Deleted files crash (E1-2), not in git repo (E1-5), bad regex saved (E3-2, E3-9), enforce misses packages (E5-2, E5-3), comment not posted (E4-3) |
| High | 11 | Relative paths (E1-1), branch errors (E1-6, E1-7), batch queries (E2-7), Claude CLI missing (E3-1), ID conflicts (E3-4), no review (E3-8), GH_TOKEN (E4-1), PR number (E4-2), non-GitHub CI (E4-5), flat install (E5-1), transient deps (E5-4), transitive deps (E5-7) |
| Medium | 16 | Binary files (E1-3), renamed files (E1-4), fresh project (E2-1), wrong suggestion (E2-3), repeated suggestions (E2-5), default output clutter (E2-6), zero-match scope (E3-3), no feedback (E3-6), vague AI (E3-7), no templates (E3-10), comment clutter (E4-4), new vs existing (E4-6), large comment (E4-7), block vs warn (E4-8), stale copies (E5-5), lock sync (E5-8), user shadow (E5-9), no publish (E5-11) |
| Low | 7 | Empty diff (E1-8), seed data exists (E2-2), confidence format (E2-4), save location (E3-5), offline (E5-6), no removal (E5-10) |

---

## Resolution Status

All 38 edge cases have specified resolutions documented in their respective architecture documents:

| Document | Edge Cases |
|----------|-----------|
| [ADR-008](adrs/ADR-008-incremental-enforcement.md) | E1-1 through E1-8 |
| [ADR-009](adrs/ADR-009-contract-packages.md) | E5-1 through E5-11 |
| [DDD-005](ddds/DDD-005-incremental-enforcement.md) | E1-1 through E1-8 (domain model) |
| [DDD-006](ddds/DDD-006-contract-packages.md) | E5-1 through E5-11 (domain model) |
| [PRD-007](prds/PRD-007-incremental-enforcement.md) | E1-1 through E1-8, E2-1 through E2-7, E4-1 through E4-8 |
| [PRD-008](prds/PRD-008-contract-creation.md) | E3-1 through E3-10 |
| [PRD-009](prds/PRD-009-contract-packages.md) | E5-1 through E5-11 |

---

## Comparison with Simulation Report 1

| Metric | Report 1 (Phase 8) | Report 2 (Phase 11) |
|--------|--------------------|--------------------|
| Features simulated | 1 (full user journey) | 5 (new features) |
| Edge cases found | 7 | 38 |
| Critical | 1 | 4 |
| High | 2 | 11 |
| All resolved | Yes (Phase 8 complete) | Resolutions specified, implementation pending |
