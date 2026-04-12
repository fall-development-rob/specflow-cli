# Simulation Report: Specflow CLI User Journey

**Date:** 2026-04-04
**Branch:** `cleanup/remove-legacy-artifacts`
**Status:** All findings documented — code fixes pending

---

## Methodology

A full end-to-end simulation of the specflow-cli user journey was performed, covering:

1. **Fresh install** — `npm install -g @robotixai/specflow-cli`
2. **Project initialization** — `specflow init .` with default and custom configurations
3. **Double initialization** — running `specflow init .` twice on the same project
4. **Contract enforcement** — `specflow enforce .` in both human and JSON output modes
5. **MCP server integration** — registering the MCP server and using `specflow_check_code` via Claude Code
6. **Hook enforcement** — triggering PostToolUse hooks via Write/Edit operations with violating code
7. **CI pipeline simulation** — using `specflow enforce --json` as a CI gate
8. **Contract coverage audit** — reviewing default contract scopes against common file types

The simulation tested both happy paths and edge cases, focusing on scenarios where enforcement could silently fail.

---

## Findings

### Finding 1: SEC-003 Scope Too Narrow

| Field | Value |
|-------|-------|
| **ID** | SIM-001 |
| **Severity** | MEDIUM |
| **Component** | Contract Templates |
| **File** | `templates/contracts/security_defaults.yml` |
| **Rule** | SEC-003 (innerHTML/XSS detection) |

**Description:** SEC-003 only scans files matching `src/**/*.{tsx,jsx}`. Users with `.js`, `.ts`, or `.html` files get no XSS protection from this rule. The regex pattern itself works correctly — the scope is simply too restrictive.

**Reproduction:**
1. Run `specflow init .`
2. Create `src/app.ts` with `element.innerHTML = userInput`
3. Run `specflow enforce .`
4. Observe: no SEC-003 violation reported

**Fix:** Expand SEC-003 scope in `templates/contracts/security_defaults.yml`:
```yaml
scope:
  - "src/**/*.{ts,tsx,js,jsx}"
  - "**/*.html"
  - "!node_modules/**"
  - "!dist/**"
```

**Affected docs:** [DDD-001-contract-engine.md](ddds/DDD-001-contract-engine.md)

---

### Finding 2: `enforce --json` Exits 0 on Violations

| Field | Value |
|-------|-------|
| **ID** | SIM-002 |
| **Severity** | HIGH |
| **Component** | CLI — enforce command |
| **File** | `ts-src/commands/enforce.ts` |

**Description:** When the `--json` flag is passed, `specflow enforce` always exits with code 0, even when violations are found. The non-JSON code path correctly exits 1. CI pipelines using `specflow enforce --json` will never fail.

**Reproduction:**
1. Create a file with a known contract violation (e.g., hardcoded secret)
2. Run `specflow enforce . --json`
3. Observe: output JSON shows violations, but `echo $?` returns 0
4. Run `specflow enforce .` (without --json)
5. Observe: `echo $?` returns 1

**Fix:** In `ts-src/commands/enforce.ts`, set `process.exitCode = 1` when violations are found, *before* the output format branch. The exit code is determined by the scan result, not the output format.

**Affected docs:** [PRD-001-cli-rewrite.md](prds/PRD-001-cli-rewrite.md), [ADR-003-cli-architecture.md](adrs/ADR-003-cli-architecture.md), [DDD-002-enforcement-pipeline.md](ddds/DDD-002-enforcement-pipeline.md)

---

### Finding 3: MCP `check_code` Tool Doesn't Actually Scan

| Field | Value |
|-------|-------|
| **ID** | SIM-003 |
| **Severity** | CRITICAL |
| **Component** | MCP Server |
| **File** | `ts-src/mcp/tools.ts` — `handleCheckCode` function |

**Description:** The `specflow_check_code` MCP tool returns `rules_checked: 0` and `clean: true` for ALL input code, including code with obvious violations. The `checkSnippet()` function is called but does not load contracts, compile patterns, or scan the code string. This is the most dangerous bug: the tool designed to prevent violations is itself broken, giving Claude Code a false "all clear" signal.

**Reproduction:**
1. Register MCP server: `specflow mcp register`
2. In Claude Code, call `specflow_check_code` with code: `const password = 'hunter2'`
3. Observe response: `{ clean: true, violations: [], rules_checked: 0 }`
4. Expected: SEC-001 violation for hardcoded secret

**Fix:** `checkSnippet` in the contract scanner must:
1. Accept contracts as a parameter (or load them from the project directory)
2. Compile all regex patterns from loaded contracts
3. When no `file_path` is provided, apply ALL rules (no scope filtering)
4. When `file_path` is provided, filter rules by scope
5. Scan the code string against all applicable forbidden/required patterns
6. Return the full violation list with rules_checked count

**Affected docs:** [PRD-002-mcp-server.md](prds/PRD-002-mcp-server.md), [DDD-001-contract-engine.md](ddds/DDD-001-contract-engine.md)

---

### Finding 4: Double Init Duplicates CLAUDE.md Content

| Field | Value |
|-------|-------|
| **ID** | SIM-004 |
| **Severity** | MEDIUM |
| **Component** | CLI — init command |
| **File** | `ts-src/commands/init.ts` |

**Description:** Running `specflow init .` twice on the same project appends Specflow rules to CLAUDE.md a second time. The idempotency check looks for the string `## Specflow Rules`, but this heading appears in multiple places in the template content, making detection unreliable.

**Reproduction:**
1. Run `specflow init .` — CLAUDE.md created with Specflow rules
2. Run `specflow init .` again
3. Observe: CLAUDE.md now contains the Specflow rules section twice

**Fix:** Replace the heading-based marker with unique HTML comment markers:
```
<!-- specflow-rules-start -->
...rules content...
<!-- specflow-rules-end -->
```
On subsequent init runs, check for `<!-- specflow-rules-start -->`. If found, replace the content between start/end markers. If not found, append with markers.

**Affected docs:** [PRD-001-cli-rewrite.md](prds/PRD-001-cli-rewrite.md)

---

### Finding 5: Compliance Hook Doesn't Scan Content

| Field | Value |
|-------|-------|
| **ID** | SIM-005 |
| **Severity** | HIGH |
| **Component** | Hooks — check-compliance |
| **File** | `ts-src/hooks/check-compliance.ts` |

**Description:** The `check-compliance.ts` PostToolUse hook exits 0 regardless of what code was written. It reads the stdin JSON from Claude Code but does not run the contract scanner against the file content. When Claude Code writes violating code via Write/Edit, the hook passes silently.

**Reproduction:**
1. Run `specflow init .` and `specflow update .` to install hooks
2. In Claude Code, use the Write tool to create a file with a hardcoded secret
3. Observe: PostToolUse hook fires, exits 0, no violation reported
4. Expected: hook should exit 2 with SEC-001 violation message

**Fix:** The hook must:
1. Parse stdin JSON to extract `tool_input.file_path`
2. Skip (exit 0) if `tool_name` is not `Write` or `Edit`
3. Load contracts from `.specflow/contracts/` (or `docs/contracts/`)
4. Filter rules to those whose scope matches the file path
5. Read the file content from disk
6. Scan content against matching rules using ContractScanner
7. If violations found: write violation details to stderr, exit 2
8. If clean: exit 0

**Affected docs:** [DDD-002-enforcement-pipeline.md](ddds/DDD-002-enforcement-pipeline.md)

---

### Finding 6: Custom `testsDir` Causes Double Nesting

| Field | Value |
|-------|-------|
| **ID** | SIM-006 |
| **Severity** | MEDIUM |
| **Component** | CLI — init command |
| **File** | `ts-src/commands/init.ts` |

**Description:** The `init` command creates both `${testsDir}` and `${testsDir}/e2e`. If a user configures `testsDir` as `tests/e2e`, the command creates `tests/e2e/` AND `tests/e2e/e2e/` — a redundant nested directory.

**Reproduction:**
1. Run `specflow init . --testsDir tests/e2e`
2. Observe directory structure: `tests/e2e/e2e/` exists

**Fix:** Only create the `e2e` subdirectory if `testsDir` does not already end with `/e2e`:
```typescript
if (!testsDir.endsWith('/e2e') && !testsDir.endsWith('\\e2e')) {
  mkdirSync(path.join(testsDir, 'e2e'), { recursive: true });
}
```

**Affected docs:** [PRD-001-cli-rewrite.md](prds/PRD-001-cli-rewrite.md)

---

### Finding 7: Help Text Shows Old Package Name

| Field | Value |
|-------|-------|
| **ID** | SIM-007 |
| **Severity** | LOW |
| **Component** | CLI — help text |
| **File** | `ts-src/cli.ts` |

**Description:** The CLI help examples still reference `npx @robotixai/specflow-cli`, which is the old package name. The current package name is `specflow-cli`.

**Reproduction:**
1. Run `specflow --help`
2. Observe: examples show `npx @robotixai/specflow-cli`

**Fix:** Replace all occurrences of `@robotixai/specflow-cli` in CLI help strings with `specflow` (global install) or `npx specflow-cli` (npx usage).

**Affected docs:** [PRD-001-cli-rewrite.md](prds/PRD-001-cli-rewrite.md)

---

## Summary

| ID | Severity | Component | Status |
|----|----------|-----------|--------|
| SIM-001 | MEDIUM | Contract scope (SEC-003) | Documented — fix pending |
| SIM-002 | HIGH | enforce --json exit code | Documented — fix pending |
| SIM-003 | CRITICAL | MCP check_code broken | Documented — fix pending |
| SIM-004 | MEDIUM | Double init CLAUDE.md | Documented — fix pending |
| SIM-005 | HIGH | Compliance hook no-op | Documented — fix pending |
| SIM-006 | MEDIUM | testsDir double nesting | Documented — fix pending |
| SIM-007 | LOW | Stale help text | Documented — fix pending |

**Critical path:** SIM-003 (MCP check_code) is the highest priority — it silently disables the proactive enforcement layer. SIM-002 and SIM-005 are next — they disable CI gating and edit-time enforcement respectively. Together, these three findings mean that all three enforcement layers (proactive, reactive, CI) can silently pass despite violations.

**All findings are blocking v1.0 release.** See [MASTER-PLAN.md Phase 8](plan/MASTER-PLAN.md) for the fix schedule.
