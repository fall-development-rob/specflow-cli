# Specflow CLAUDE.md Template

This is appended to a project's CLAUDE.md by `specflow init`.
It tells the LLM how to work with contracts in this project.

---

## Specflow Rules

### Contracts

This project uses **Specflow contracts** — YAML files that define patterns your code must follow. Violations fail the build.

```bash
specflow enforce .              # Check all contracts against source code
specflow enforce --staged       # Check only staged files
specflow status .               # Compliance dashboard
specflow contract list          # Available templates
specflow contract create        # Create a new contract
specflow generate .             # Re-detect stack and regenerate contracts
```

Contracts live in `.specflow/contracts/*.yml`. Each contract defines:
- **Scope** — which files it applies to (glob patterns)
- **Forbidden patterns** — regexes that must NOT appear
- **Required patterns** — regexes that MUST appear

### Checking Contracts Before Changes

Before modifying protected files, check applicable contracts:

1. Run `specflow enforce .` to check current compliance
2. Read the relevant contract YAML (source of truth)
3. Check the compliance checklist in the contract
4. Only proceed if the change is allowed

#### Contract Violation Example

If you violate a contract:
```
CONTRACT VIOLATION: SEC-001
File: src/services/auth.ts
Forbidden pattern matched: /(password|secret)\s*[:=]\s*['"][^'"]{8,}['"]/i
Message: Hardcoded secret detected — use environment variable
See .specflow/contracts/security_secrets.yml
```

The build will FAIL and the PR will be BLOCKED.

### Contract Overrides

Only the human user can override non-negotiable rules. To override, user must say:

```
override_contract: <contract_id>
```

When overriding:
1. Explain why this violates the contract
2. Warn about potential consequences
3. Ask if the contract should be updated permanently

### Writing Contracts

Contracts MUST be YAML files in `.specflow/contracts/`. Never write contract rules in markdown files.

```
Right: .specflow/contracts/feature_auth.yml
Wrong: docs/auth-rules.md
```

### Hooks

Specflow hooks run automatically in Claude Code:
- **Write/Edit** — compliance check against contracts
- **Bash (build/commit)** — post-build verification

### Quick Reference

| Goal | Command |
|------|---------|
| Health check | `specflow doctor .` |
| Run contracts | `specflow enforce .` |
| Compliance dashboard | `specflow status .` |
| Generate contracts | `specflow generate .` |
| Create contract | `specflow contract create --template <name>` |
| List agents | `specflow agent list` |

---

<!-- OPTIONAL SECTIONS BELOW — include only if your project uses these features -->

## Issue Tracking (Optional)

> Include this section if your project requires issue numbers in commits
> and uses a project board for work tracking.

### No Ticket = No Code

All work requires a tracked issue before writing any code.

### Commits Must Reference an Issue

**NEVER run `git commit` without a `#<issue-number>` in the message.**

If you don't know the issue number, **ASK** before committing. Do not guess, do not omit it.

```bash
# Good — hooks find #375 and can run its journey tests
git commit -m "feat: add signup validation (#375)"

# Bad — hooks find nothing, no tests run, no enforcement
git commit -m "feat: add signup validation"
```

Without an issue number, hooks cannot find the journey contract and tests are silently skipped.

### Supported Project Boards

| Board | CLI | Install | Auth |
|-------|-----|---------|------|
| GitHub Issues | `gh` | `brew install gh` | `gh auth login` |
| Jira | `jira` | `brew install jira-cli` | `jira init` |
| Linear | `linear` | `npm i -g @linear/cli` | `linear auth` |
| Shortcut | `sc` | `brew install shortcut-cli` | API token env var |
| Notion | MCP server | MCP config | API key |

---

## Journey Verification (Optional)

> Include this section if your project uses E2E journey testing
> with Specflow hooks.

### Trigger Points

| Trigger | Environment | Action |
|---------|-------------|--------|
| PRE-BUILD | Local | Run baseline E2E tests |
| POST-BUILD | Local | Run E2E tests, compare to baseline |
| POST-COMMIT | Production | Wait for deploy, verify production |

### Test Reporting

Claude MUST report for EVERY test run:

1. **WHERE** — "Tests passed against LOCAL/PRODUCTION (URL)"
2. **WHICH** — "Ran: signup.spec.ts, login.spec.ts, ..."
3. **HOW MANY** — "12/12 passed (0 failed, 0 skipped)"
4. **SKIPPED explained** — Every skip needs a reason

```
Bad:  "Tests passed"
Good: "Tests passed against PRODUCTION (https://yourapp.com)
       Ran: signup.spec.ts, login.spec.ts
       Results: 12/12 passed (0 failed, 0 skipped)"
```

### Journey Gates

| Gate | Scope | Blocks | When |
|------|-------|--------|------|
| Tier 1: Issue | J-* tests from one issue | Issue closure | After implementing issue |
| Tier 2: Wave | All J-* tests from wave | Next wave | After all issues pass Tier 1 |
| Tier 3: Regression | Full E2E suite vs baseline | Merge to main | After wave passes Tier 2 |

Deferrals: `.claude/.defer-journal` (scoped by J-ID with tracking issue).
Baseline: `.specflow/baseline.json` (updated only on clean Tier 3 pass).

