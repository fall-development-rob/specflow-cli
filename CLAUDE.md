# CLAUDE.md

This file provides guidance to Claude Code when working with the Specflow repository.

---

## Project Context

**Repository:** fall-development-rob/specflow-cli
**Project Board:** GitHub Issues
**Board CLI:** gh (must be installed and authenticated)
**Tech Stack:** TypeScript (CLI, hooks, MCP server), Rust/NAPI-RS (contract engine), Jest (tests)
**Primary Focus:** Specflow methodology framework — contracts, agents, hooks, templates

### Repository Structure

```
ts-src/                 # TypeScript CLI source
  cli.ts                # Entry point, command routing
  commands/             # init, doctor, enforce, update, status, compile, audit, graph, agent
  hooks/                # post-build-check, check-compliance, run-journey-tests
  mcp/                  # MCP stdio server (protocol, server, tools)
  lib/                  # native bindings, reporter, logger, fs-utils
rust/                   # Rust NAPI-RS native contract engine
  src/lib.rs            # YAML parsing, regex compilation, file scanning
bin/specflow.js         # npm package entry point → dist/cli.js
dist/                   # Compiled TypeScript output (gitignored)
agents/                 # 26 agent prompt templates (markdown + YAML frontmatter)
docs/                   # Guides, reference, architecture (ADRs/PRDs/DDDs), contracts
templates/contracts/    # Default contract templates (YAML)
templates/ci/           # GitHub Actions workflow templates
tests/                  # Jest test suites (contracts, hooks, schema, compile)
scripts/                # Install script, Node.js compile/verify helpers
```

### Building

```bash
npx tsc                            # compile TypeScript → dist/
cd rust && cargo build --release   # compile Rust native module (optional)
npm test                           # run all 678 tests
node dist/cli.js doctor            # verify setup
```

After `npm install -g @colmbyrne/specflow`, the CLI is available as `specflow` in PATH.

---

## Specflow Rules

### Rule 1: No Ticket = No Code

All work requires a GitHub issue before writing any code.

### Rule 2: Commits Must Reference an Issue

**NEVER run `git commit` without a `#<issue-number>` in the message.**

If you don't know the issue number, **ASK** before committing.

```bash
# Good
git commit -m "feat: add agent validation (#42)"

# Bad — hooks find nothing, no tests run
git commit -m "feat: add agent validation"
```

### Rule 3: Contracts Are Non-Negotiable

Check `docs/contracts/` before modifying protected files.

```bash
specflow enforce .       # Contract enforcement
npm test -- contracts    # Jest contract tests
```

Violation = build fails = PR blocked.

### Rule 4: Tests Must Pass Before Closing

```bash
npm test                 # All Jest tests (650+)
npm test -- contracts    # Contract tests only
npm test -- hooks        # Hook tests only
npm test -- schema       # Schema validation only
npm test -- compile      # Compiler tests only
npx tsc                  # Compile TypeScript
```

Work is NOT complete if tests fail.

### Rule 5: Contracts Are YAML, Not Markdown

**NEVER write contract content (invariants, forbidden patterns, required patterns) into .md files.**

Contracts MUST be YAML files in `docs/contracts/`:
- Feature contracts: `docs/contracts/feature_*.yml`
- Journey contracts: `docs/contracts/journey_*.yml`
- Default contracts: `docs/contracts/*_defaults.yml`

Wrong: `docs/specflow/my-feature-invariants.md`
Right: `docs/contracts/feature_my_feature.yml`

### Contract Locations

| Type | Location |
|------|----------|
| Project contracts | `docs/contracts/*.yml` |
| Template contracts | `templates/contracts/*.yml` |
| Contract tests | `tests/contracts/*.test.js` |
| Schema tests | `tests/schema/*.test.js` |
| Hook tests | `tests/hooks/*.test.js` |
| Compiler tests | `tests/compile/*.test.js` |

### Active Contracts

| Contract | Protects | Rules |
|----------|----------|-------|
| `feature_preflight` | Board-auditor compliance | ARCH-001 through ARCH-008 |
| `feature_specflow_project` | Project structure & code quality | PROJ-001 through PROJ-004 |
| `security_defaults` | OWASP baseline patterns | SEC-001 through SEC-005 |
| `test_integrity_defaults` | Test quality and anti-mock rules | TEST-001 through TEST-005 |
| `accessibility_defaults` | WCAG AA baseline patterns | A11Y-001 through A11Y-004 |
| `production_readiness_defaults` | Production hygiene patterns | PROD-001 through PROD-003 |
| `component_library_defaults` | UI library composition patterns | COMP-001 through COMP-004 |

### Override Protocol

Only humans can override. User must say:
```
override_contract: <contract_id>
```

---

## NEW SESSION ONBOARDING (For Other Projects)

**If you are using Specflow in a DIFFERENT project and don't know the project context, ASK FIRST:**

Before doing any work, you MUST know:

1. **Repository** - Which repo are we working in?
2. **Project Board** - Where are issues/stories tracked?
3. **Board CLI** - What tool manipulates the board?
4. **Current focus** - What wave/milestone/issues should I work on?
5. **Tech stack** - What framework/language is this project?

**If any of this is missing from your CLAUDE.md context, ASK the user.**

### Supported Project Boards

| Board | CLI | Install | Auth Required |
|-------|-----|---------|---------------|
| GitHub Issues | `gh` | `brew install gh` | `gh auth login` |
| Jira | `jira` | `brew install jira-cli` | `jira init` |
| Linear | `linear` | `npm i -g @linear/cli` | `linear auth` |
| Shortcut | `sc` | `brew install shortcut-cli` | API token env var |
| Notion | MCP server | MCP config | API key |

### Commit Message Format (Critical for Hooks)

**RULE: NEVER run `git commit` without a `#<issue-number>` in the message.**

If you don't know the issue number, **ASK** before committing. Do not guess, do not omit it.

```bash
# GOOD - hooks find #375 and run its journey tests
git commit -m "feat: add signup validation (#375)"

# GOOD - bare number works too
git commit -m "feat: add signup validation #375"

# BAD - hooks find nothing, no tests run, no enforcement
git commit -m "feat: add signup validation"
```

After `specflow hook post-build` or `git commit`, hooks automatically:
1. Extract issue numbers from recent commits
2. Fetch each issue for journey contract (`J-SIGNUP-FLOW`)
3. Run only relevant Playwright tests
4. Block on failure (exit 2)

**Without an issue number, journey tests are silently skipped — the commit succeeds but nothing is verified.**

**Install hooks:** `specflow update .` or `bash scripts/install.sh`

**DO NOT assume or guess.** Different projects have different boards, contracts, and conventions.

---

## Using Specflow In Another Project

This repository is the source of truth for the reusable Specflow kit. When you are
applying Specflow to another repository, copy the relevant assets from here rather
than inventing a fresh layout.

### Recommended Adoption Paths

1. **Project CLAUDE setup:** Use [CLAUDE-MD-TEMPLATE.md](CLAUDE-MD-TEMPLATE.md) when a target repo needs a full, project-specific `CLAUDE.md`.
2. **CLI install:** Run `npm install -g specflow-cli` then `specflow init .` to scaffold contracts and hooks.

### What To Copy Into A Target Repository

| Asset | Destination in target repo | Purpose |
|------|----------|---------|
| `agents/` | `scripts/agents/` | Subagent library for orchestration and execution |
| `templates/contracts/*.yml` | `docs/contracts/` | Reusable default contracts |
| `hooks/` via `specflow update` | `.claude/hooks/` and `.git/hooks/` | Local enforcement and journey verification |
| `templates/ci/*.yml` | `.github/workflows/` | PR and post-merge contract enforcement |
| `CLAUDE-MD-TEMPLATE.md` | `CLAUDE.md` | Project-specific operating instructions |

### Source Repo Maintenance Notes

- Keep the contracts listed in `docs/contracts/CONTRACT_INDEX.yml` aligned with the files in `docs/contracts/`.
- Keep `templates/contracts/` as the canonical default-contract source, and mirror the active defaults into `docs/contracts/` for verifier coverage and documentation.
- Update `CLAUDE.md` and the CI templates together when the operating model changes so downstream repos receive a coherent kit.

## About This Repository

This is the **Specflow methodology repository** containing:
- TypeScript CLI (`specflow`) with 11 commands, Rust native contract engine, and MCP server
- 26 agents with YAML frontmatter for automated execution
- YAML contract templates and enforcement
- Jest test suites (650+ tests)
- Demo proving contracts catch what unit tests miss

### Quick Start with CLI

```bash
specflow init .           # scaffold in current project
specflow doctor .         # verify setup
specflow enforce .        # run contracts
specflow agent list       # see available agents
specflow mcp register     # connect to Claude Code
```

### Quick Commands

| Goal | Command |
|------|---------|
| Health check | `specflow doctor .` |
| Run contracts | `specflow enforce .` |
| Compliance dashboard | `specflow status .` |
| Audit an issue | `specflow audit 500` |
| List agents | `specflow agent list` |
| Search agents | `specflow agent search testing` |
| Register MCP | `specflow mcp register` |

### Key Docs

| Doc | Purpose |
|-----|---------|
| [README.md](README.md) | Full documentation |
| [CLAUDE-MD-TEMPLATE.md](CLAUDE-MD-TEMPLATE.md) | Complete CLAUDE.md template |
| [agents/waves-controller.md](agents/waves-controller.md) | Master orchestrator |
| [docs/CI-INTEGRATION.md](docs/CI-INTEGRATION.md) | CI/CD integration guide |
