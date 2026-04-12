# Specflow Skill — v1.0

This skill is loaded automatically by Claude Code. It provides the operating framework for Specflow-aware sessions.

---

## Core Operating Loop

Every Specflow session follows this sequence:

```
Spec -> Pre-Flight -> Contract -> Test -> Code -> Verify -> Commit
```

1. **Spec**: Understand the requirement — from an issue, spec doc, or description.
2. **Pre-Flight**: Run `specflow doctor .` to verify setup. Check that contracts are loaded.
3. **Contract**: Ensure YAML contracts exist for the feature. If not, generate them with `specflow generate .` or the contract-generator agent.
4. **Test**: Generate or update contract tests before writing code.
5. **Code**: Implement the feature. Contracts enforce patterns at build time.
6. **Verify**: Run `specflow enforce .` and `npm test`. All contract tests must pass.
7. **Commit**: Commit the changes. If issue tracking is enabled, include the issue reference.

**Never skip steps.** The loop is the trust layer.

---

## Contract YAML Schema

### Top-Level Structure

```yaml
contract_meta:
  id: string              # Unique identifier (e.g. feature_auth, security_defaults)
  version: integer         # Schema version, increment on changes
  created_from_spec: string  # Source reference (issue number, spec doc)
  covers_reqs: string[]    # Requirement IDs this contract covers
  owner: string            # Team or person responsible

llm_policy:
  enforce: boolean         # true = active enforcement
  llm_may_modify_non_negotiables: boolean  # false = LLM cannot override
  override_phrase: string  # Human override command

rules:
  non_negotiable:          # Rules that must always pass
    - id: string           # Rule ID (e.g. SEC-001, ARCH-002)
      title: string        # Human-readable description
      scope: string[]      # Glob patterns for files to check
      behavior:
        forbidden_patterns:
          - pattern: string  # /regex/flags format
            message: string  # Error message when matched
        required_patterns:
          - pattern: string  # /regex/flags format
            message: string  # Error message when NOT matched
        example_violation: string   # Code that would fail
        example_compliant: string   # Code that would pass
      auto_fix:            # Optional — enables heal-loop
        strategy: string   # add_import | remove_pattern | wrap_with | replace_with
        # Strategy-specific fields

  soft:                    # Advisory rules (warnings, not errors)
    - id: string
      title: string
      suggestion: string
      llm_may_bend_if: string[]  # Conditions where bending is acceptable

compliance_checklist:
  before_editing_files:
    - question: string
      if_yes: string

test_hooks:
  tests:
    - file: string
      description: string
```

### Pattern Format

- Regex: `/pattern/flags` (JavaScript regex syntax)
- Flags: `i` (case-insensitive), `g` (global), `m` (multiline)
- Alternation: `/foo|bar/` matches either
- Negated scope: `!src/**/*.test.*` excludes test files

### Scope Glob Syntax

- `src/**/*.ts` — all TypeScript files under src/
- `src/**/*.{ts,tsx}` — TypeScript and TSX files
- `!src/**/*.test.*` — exclude test files
- `supabase/migrations/**/*.sql` — SQL migrations

---

## Security Gates

| ID | Rule | Pattern Description |
|----|------|-------------------|
| SEC-001 | No hardcoded secrets | Detects API keys, tokens, private keys in source |
| SEC-002 | No SQL string concatenation | Detects `query(\`...\${` and string concat in SQL |
| SEC-003 | No unsanitized innerHTML | Detects `dangerouslySetInnerHTML` without sanitizer |
| SEC-004 | No eval or Function constructor | Detects `eval(` and `new Function(` |
| SEC-005 | No path traversal | Detects `readFile`/`writeFile` without `path.join` |

**Scope:** `src/**/*.{ts,js,tsx,jsx}` excluding test files.
**Override:** `override_contract: security_defaults` (human only).

---

## Accessibility Gates

| ID | Rule | Pattern Description |
|----|------|-------------------|
| A11Y-001 | Images must have alt text | Detects `<img>` without `alt` attribute |
| A11Y-002 | Buttons must have labels | Detects icon-only buttons without `aria-label` |
| A11Y-003 | Inputs must have labels | Detects `<input>` without `aria-label`/`aria-labelledby`/`id` |
| A11Y-004 | No positive tabindex | Detects `tabIndex={N}` where N > 0 |

**Scope:** `src/**/*.{tsx,jsx}`.
**Override:** `override_contract: accessibility_defaults` (human only).

---

## Agent Quick Reference

### Orchestration
| Agent | Description |
|-------|-------------|
| waves-controller | Master wave execution orchestrator coordinating all agents through 8 phases |
| sprint-executor | Sprint execution coordinator for parallel implementation waves |
| dependency-mapper | Builds dependency graphs and calculates wave execution order |

### Generation
| Agent | Description |
|-------|-------------|
| contract-generator | Transforms specs into executable YAML contracts |
| contract-test-generator | Creates Jest tests from YAML contracts |
| specflow-writer | Writes issue specs with Gherkin scenarios and acceptance criteria |
| migration-builder | Creates database migration files from issue specs |
| edge-function-builder | Creates edge functions from issue specs |
| frontend-builder | Creates frontend components, hooks, and pages |
| playwright-from-specflow | Generates Playwright E2E tests from contract specs |

### Validation
| Agent | Description |
|-------|-------------|
| contract-validator | Validates contract YAML for correctness and completeness |
| quality-gate | Runs quality gates: contract tests, journey tests, regression |
| journey-gate | Three-tier journey test gate (unit, wave, regression) |
| journey-enforcer | Verifies journey test coverage meets thresholds |
| e2e-test-auditor | Audits E2E tests for completeness and quality |
| board-auditor | Audits project board issues for specflow compliance markers |
| pre-flight-simulator | Runs pre-flight simulation across wave tickets |

### Remediation
| Agent | Description |
|-------|-------------|
| heal-loop | Self-healing fix agent for contract violations |
| test-runner | Executes test suites and reports results |

### Lifecycle
| Agent | Description |
|-------|-------------|
| issue-lifecycle | Full issue lifecycle: spec, contract, implement, test, close |
| ticket-closer | Verifies DOD and closes issues with documentation |
| adoption-advisor | Guides teams through adopting Specflow in existing projects |

### Coordination
| Agent | Description |
|-------|-------------|
| db-coordinator | Coordinates database migrations across parallel agents |
| journey-tester | Creates and runs journey-level integration tests |

### Documentation
| Agent | Description |
|-------|-------------|
| specflow-uplifter | Uplifts existing projects to Specflow methodology |
| readme-audit | Audits README files for completeness and accuracy |
| readme-restructure | Restructures README files for clarity |

---

## Command Reference

| Command | Description |
|---------|-------------|
| `specflow init [dir]` | Initialize Specflow in a project (interactive) |
| `specflow doctor [dir]` | Health check — verify setup and dependencies |
| `specflow enforce [dir]` | Run all contracts against the codebase |
| `specflow status [dir]` | Compliance dashboard showing contract/test coverage |
| `specflow audit <issue>` | Audit a GitHub issue for specflow compliance markers |
| `specflow compile <csv>` | Compile journey CSV into contracts and test stubs |
| `specflow graph [dir]` | Verify contract graph integrity |
| `specflow update [dir]` | Update hooks and settings |
| `specflow agent list` | List all available agents with metadata |
| `specflow agent search <q>` | Search agents by keyword |
| `specflow agent show <name>` | Show full agent prompt and metadata |
| `specflow mcp register` | Register MCP server with Claude Code |

### Flags

| Flag | Commands | Description |
|------|----------|-------------|
| `--yes` / `-y` | init | Accept all defaults without prompting |
| `--json` | init, enforce, status | Output JSON instead of human-readable |
| `--contracts-dir` | init | Override contracts directory path |
| `--tests-dir` | init | Override tests directory path |

---

## Hook Behavior

### PostToolUse — Write/Edit

**Fires:** After any file is created or modified via Claude Code's Write or Edit tools.

**Action:** Runs `specflow hook compliance` which:
1. Loads all contracts from `.specflow/contracts/`
2. Scans the modified file against applicable contracts (by scope glob)
3. Reports violations immediately (before the next tool call)
4. Does NOT block — violations are reported as warnings

### PostToolUse — Bash

**Fires:** After any Bash command completes in Claude Code.

**Action:** Runs `specflow hook post-build` which:
1. Extracts issue numbers from recent git commits
2. Fetches each issue for journey contract IDs (J-*)
3. Runs relevant Playwright/Jest tests for those journeys
4. Blocks on test failure (exit 2)

### commit-msg (Git Hook — Optional)

**Fires:** During `git commit`, before the commit is finalized. Only installed if issue tracking is enabled during `specflow init`.

**Action:**
1. Reads the commit message
2. Checks for `#<issue-number>` pattern
3. Rejects commits without issue references

---

## Pre-Flight System

Pre-flight checks catch broken specs before code is written.

### What Gets Checked (6 Lenses)

1. **Spec Completeness** — Does the requirement have acceptance criteria?
2. **Contract Coverage** — Do YAML contracts exist for the feature area?
3. **Schema Consistency** — Do referenced database tables/columns exist?
4. **Dependency Resolution** — Are dependencies resolved?
5. **Test Readiness** — Do test stubs exist for the contracts?

### Simulation Status Values

| Status | Meaning | Gate Action |
|--------|---------|-------------|
| `passed` | All lenses clear | Proceed |
| `passed_with_warnings` | Non-blocking findings | Proceed (P2 logged) |
| `blocked` | Critical findings | STOP — fix before proceeding |
| `stale` | Ticket edited since last sim | STOP — re-run simulation |
| `override:<reason>` | Human override | Proceed (logged) |

---

## Model Routing Guidance

| Task Type | Recommended Model | Reason |
|-----------|------------------|--------|
| Orchestration (waves-controller, sprint-executor) | sonnet | Coordination logic, not deep reasoning |
| Code generation (migration-builder, frontend-builder) | sonnet | Standard code generation |
| Contract generation (contract-generator) | sonnet | Structured YAML output |
| Fix generation (heal-loop) | opus | Deep reasoning for minimal fixes |
| Pre-flight simulation | sonnet | Analysis across multiple tickets |
| Test generation (playwright-from-specflow) | sonnet | Pattern-based test creation |
| Issue lifecycle (full cycle) | sonnet | Coordination with some code |
| Validation (contract-validator, quality-gate) | haiku | Quick pass/fail checks |

---

## Quality Gates

All of these must pass before work is considered complete:

1. **Contracts pass**: `specflow enforce .` exits 0
2. **Tests pass**: `npm test` exits 0 (all test suites)
3. **No hardcoded secrets**: Security contract rules clean
4. **Issue referenced** (if enabled): Commits include `#<issue-number>`

---

## Contract Override Protocol

Only humans can override contracts. The LLM must never bypass enforcement.

```
override_contract: <contract_id>
```

This must be typed by the user in the conversation. The LLM acknowledges and proceeds without enforcing that specific contract for the current task.

---

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| `specflow doctor` fails | Check Node.js version, run `npm install` |
| Contract violation on clean code | Check scope globs — file may not match |
| Journey tests skipped | Commit message missing `#<issue-number>` |
| Pre-flight blocks wave | Read the CRITICAL findings, fix the spec |
| Heal-loop escalates | Manual fix needed — contract lacks `auto_fix` hint |
| Agent not found | Run `specflow agent list` to see available agents |
