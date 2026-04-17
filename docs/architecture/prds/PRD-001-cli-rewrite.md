---
id: PRD-001
title: Specflow CLI Rewrite
type: PRD
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implemented_by:
  - PRD-002
  - PRD-003
  - PRD-004
---

# PRD-001: Specflow CLI Rewrite

**Status:** Proposed
**Author:** Specflow Team
**Phase:** 2
**Priority:** Critical

---

## Problem Statement

Specflow's CLI is a 154-line Node.js dispatcher that delegates to three large bash scripts totaling 1,712 lines. These scripts require `jq` (a system dependency not declared anywhere), use platform-specific shell behavior, and account for 26 of the project's 26 failing tests. The hook installer fails on first run because `jq` is missing, which means the core promise of "self-enforcing specs" doesn't work out of the box.

No developer should need to debug a bash script to use a Node.js framework.

## Goals

1. Replace all bash scripts with Node.js equivalents
2. Zero system dependencies beyond Node.js 20+ and npm
3. Fix all 26 failing tests
4. Add missing commands: `enforce`, `status`
5. Support machine-readable output (`--json`) for CI integration
6. Detect MCP mode (stdin not TTY) for future MCP server

## Non-Goals

- GUI or web dashboard
- Watch mode (future phase)
- Plugin system (future phase)
- Multi-language support (Node.js only for v1.0)

---

## Command Specifications

### `specflow init [dir] [--wizard]`

**Replaces:** `setup-project.sh` (636 lines)

**Behavior:**
1. If `--wizard`: prompt for repository name, board type (GitHub/Jira/Linear), tech stack, base branch
2. Create directory structure:
   ```
   docs/contracts/          # YAML contracts
   tests/contracts/         # Contract test files
   tests/e2e/               # Journey test stubs
   .claude/hooks/           # Claude Code hook scripts
   .specflow/               # State directory
   ```
3. Detect project stack and generate tailored contracts (replaces hardcoded defaults)
4. Generate `tests/helpers/contract-loader.js`
5. Generate contract schema test from template
6. Generate or update `package.json` with test scripts
7. Generate or update `jest.config.js`
8. Generate `CLAUDE.md` from template (fill in wizard answers)
9. Create `.specflow/baseline.json` (empty baseline)
10. Create `.claude/.defer-journal` (empty deferral log)
11. Install git `commit-msg` hook (rejects commits without `#issue`)
12. Install Claude Code hooks (write `.claude/settings.json`, copy hook scripts)
13. Run `npm install` if package.json was created/modified
14. Run `specflow doctor` to verify

**Flags:**
- `--wizard` — interactive prompts
- `--no-install` — skip npm install
- `--no-hooks` — skip hook installation
- `--ci` — also install GitHub Actions workflows
- `--json` — output results as JSON

**Exit codes:** 0 success, 1 error

### `specflow doctor [dir]`

**Replaces:** `verify-setup.sh` (763 lines)

**Behavior:** Run 13 health checks, output colored pass/warn/fail table.

| # | Check | Severity |
|---|-------|----------|
| 1 | Node.js >= 20 | CRITICAL |
| 2 | `docs/contracts/` exists with >= 1 YAML file | CRITICAL |
| 3 | All contract YAML files parse without error | CRITICAL |
| 4 | All regex patterns in contracts compile | CRITICAL |
| 5 | `tests/contracts/` exists with >= 1 test file | HIGH |
| 6 | `package.json` has test scripts | HIGH |
| 7 | CLAUDE.md exists with required sections | HIGH |
| 8 | Git commit-msg hook installed and executable | MEDIUM |
| 9 | Claude Code hooks installed (`.claude/settings.json`) | MEDIUM |
| 10 | Contract test files referenced in YAML exist | MEDIUM |
| 11 | `gh` CLI installed and authenticated (for audit) | LOW |
| 12 | Playwright installed (for journey tests) | LOW |
| 13 | Contract graph passes integrity checks | LOW |

**Flags:**
- `--fix` — auto-remediate fixable issues
- `--json` — machine-readable output
- `--strict` — treat warnings as errors

**Exit codes:** 0 all pass, 1 critical/high failures

### `specflow enforce [dir] [--contract <name>]`

**New command.** Runs contract pattern enforcement directly.

**Behavior:**
1. Load all contracts from `docs/contracts/*.yml`
2. For each contract, for each rule:
   - Compile forbidden/required patterns
   - Glob target files matching rule scope
   - Scan each file for pattern matches
3. Output: violations grouped by contract, rule, file, line number
4. Summary: X contracts, Y rules, Z violations

**Flags:**
- `--contract <name>` — run only one contract
- `--fix` — attempt auto-fix for simple violations (future)
- `--json` — machine-readable output
- `--quiet` — only output violations, no summary

**Exit codes:** 0 clean, 1 violations found

### `specflow update [dir] [--ci]`

**Replaces:** `install-hooks.sh` (313 lines)

**Behavior:**
1. Read existing `.claude/settings.json` (or create new)
2. Merge Specflow hook entries into `PostToolUse` array (preserve existing hooks)
3. Copy hook scripts to `.claude/hooks/`
4. Update git commit-msg hook
5. If `--ci`: copy CI workflow templates to `.github/workflows/`

**Key change:** JSON merging done with Node.js `JSON.parse`/`JSON.stringify` instead of `jq`.

### `specflow compile <csv-file> [--out-dir <dir>]`

**Wraps:** `scripts/specflow-compile.cjs` (418 lines, already Node.js)

**Behavior:** Parse journey CSV, generate contract YAML + Playwright test stubs.

### `specflow audit <issue-number>`

**Existing.** Fetches GitHub issue via `gh`, checks 11 compliance markers. No changes needed.

### `specflow graph [dir]`

**Wraps:** `scripts/verify-graph.cjs` (475 lines, already Node.js)

**Behavior:** 7 contract graph integrity checks.

### `specflow status [dir]`

**New command.**

**Behavior:**
1. Count contracts and rules
2. Run enforce silently, count violations
3. Check hook installation
4. Check journey test coverage
5. Output dashboard:
   ```
   Contracts:  7 loaded, 35 rules
   Compliance: 33/35 rules passing (94%)
   Hooks:      installed (commit-msg, PostToolUse)
   Journeys:   3 compiled, 0 tested
   ```

---

## Technical Approach

### File Structure

```
src/
├── cli.js                    # Arg parser, command router, MCP mode detection
├── commands/
│   ├── init.js
│   ├── doctor.js
│   ├── enforce.js
│   ├── update.js
│   ├── compile.js
│   ├── audit.js
│   ├── graph.js
│   └── status.js
├── hooks/
│   ├── post-build-check.js
│   ├── run-journey-tests.js
│   └── check-compliance.js
├── contracts/
│   ├── loader.js             # YAML parse + regex compile
│   ├── scanner.js            # File scanning engine
│   └── reporter.js           # Output formatting
└── utils/
    ├── logger.js             # Colored output + JSON mode
    ├── fs.js                 # File operations helpers
    └── git.js                # Git operations helpers
```

### Dependencies

**Required (already in package.json):**
- `js-yaml` — YAML parsing
- `glob` or `fast-glob` — file pattern matching

**New:**
- `minimist` or none (use Node.js `util.parseArgs`) — arg parsing

**Removed:**
- System `jq` — replaced by `JSON.parse`/`JSON.stringify`

### Migration Path

1. Legacy bash scripts moved to `scripts/legacy/`
2. New Node.js commands in `src/commands/`
3. `bin/specflow.js` updated to route to `src/cli.js`
4. Tests updated to test Node.js implementations
5. Legacy scripts kept for reference but not executed

---

## Acceptance Criteria

- [ ] `specflow init .` creates a working project structure with contracts and hooks
- [ ] `specflow doctor` passes all 13 checks on a freshly initialized project
- [ ] `specflow enforce` detects violations in the demo project
- [ ] `specflow update` installs hooks without `jq`
- [ ] `specflow status` shows accurate compliance summary
- [ ] All 678 tests pass
- [ ] No bash script is executed by any CLI command
- [ ] `--json` flag works on all commands that support it
- [ ] Works on macOS, Linux, and WSL

---

## Simulation Findings (2026-04-04)

The following issues were discovered during a full user-journey simulation of the CLI. Each must be resolved before v1.0 release.

### SIM-CLI-001 (HIGH): `enforce --json` exits 0 on violations

**File:** `ts-src/commands/enforce.ts`
**Severity:** HIGH — CI pipelines using `specflow enforce --json` will silently pass despite violations.

**Problem:** When the `--json` flag is used, `enforce` always exits with code 0, even when violations are found. The non-JSON code path correctly sets `process.exitCode = 1` on violations, but the JSON code path skips this.

**Fix:** Set `process.exitCode = 1` when violations are found, regardless of output mode. The exit code must be determined by the scan result, not the output format. Apply the exit code assignment *before* the output format branch, not inside it.

### SIM-CLI-002 (MEDIUM): Double `init` duplicates CLAUDE.md content

**File:** `ts-src/commands/init.ts`
**Severity:** MEDIUM — running `specflow init .` twice appends Specflow rules a second time.

**Problem:** The idempotency check looks for the string `## Specflow Rules` in existing CLAUDE.md content. However, the template (`CLAUDE-MD-TEMPLATE.md`) contains this heading in multiple places, causing the marker detection to be unreliable. On a second init, content is appended again.

**Fix:** Replace the heading-based marker with a unique HTML comment marker that won't appear naturally in user content:
```
<!-- specflow-rules-start -->
...rules content...
<!-- specflow-rules-end -->
```
Check for `<!-- specflow-rules-start -->` before appending. If found, replace the block between start/end markers instead of appending.

### SIM-CLI-003 (MEDIUM): Custom `testsDir` causes double nesting

**File:** `ts-src/commands/init.ts`
**Severity:** MEDIUM — if a user sets `testsDir` to `tests/e2e`, init creates `tests/e2e/e2e/`.

**Problem:** `init` unconditionally creates both `${testsDir}` and `${testsDir}/e2e`. If `testsDir` already ends with `/e2e`, this produces a redundant `tests/e2e/e2e` directory.

**Fix:** Only create the `e2e` subdirectory if `testsDir` does not already end with `/e2e`:
```typescript
if (!testsDir.endsWith('/e2e') && !testsDir.endsWith('\\e2e')) {
  mkdirSync(path.join(testsDir, 'e2e'), { recursive: true });
}
```

### SIM-CLI-004 (LOW): Help text shows old package name

**File:** `ts-src/cli.ts`
**Severity:** LOW — cosmetic, but confusing for new users.

**Problem:** Help examples still reference `npx @robotixai/specflow-cli` instead of the current package name.

**Fix:** Update all help text examples to use `specflow` (for global install) or `npx specflow-cli` (for npx usage). Search for all occurrences of `@robotixai/specflow-cli` in CLI-facing strings.
