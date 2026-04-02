# Specflow

**Specs that enforce themselves.**

LLMs drift. You write a rule; three iterations later the model ignores it. Specflow turns your specs into contract tests that break the build when violated — so drift can't ship.

```bash
specflow init .        # scaffold contracts, hooks, agents
specflow doctor .      # check everything is wired up
specflow enforce .     # run contract enforcement
```

---

## Install

### Via npm

```bash
npm install -g specflow-cli
specflow init .
```

### Via install script

```bash
curl -sSL https://raw.githubusercontent.com/fall-development-rob/specflow-cli/main/scripts/install.sh | bash
```

---

## CLI Commands

| Command | What it does |
|---------|-------------|
| `specflow init <dir>` | Scaffold contracts, hooks, agents, CLAUDE.md |
| `specflow doctor <dir>` | Health check — 8 checks across contracts, hooks, CI, git |
| `specflow enforce <dir>` | Run contract enforcement against source code |
| `specflow status <dir>` | Compliance dashboard |
| `specflow update <dir> [--ci]` | Update hooks; `--ci` installs GitHub Actions workflows |
| `specflow audit <issue>` | Audit a GitHub issue for specflow compliance |
| `specflow compile [args]` | Compile journey CSV to YAML contracts |
| `specflow graph [dir]` | Validate contract cross-references |
| `specflow agent list` | List all 26 agents with categories |
| `specflow agent show <name>` | Show an agent's full prompt and metadata |
| `specflow agent search <query>` | Search agents by name, category, or trigger |
| `specflow mcp start` | Start MCP server (stdio, for Claude Code) |
| `specflow mcp register` | Register with Claude Code as an MCP server |

---

## How It Works

**Contracts** are YAML files in `docs/contracts/` that define rules your code must follow:

```yaml
id: feature_auth
rules:
  - id: AUTH-001
    description: Sessions must use Redis with TTL
    forbidden_patterns:
      - "localStorage\\.setItem"
      - "localStorage\\.getItem"
    required_patterns:
      - "createClient.*redis"
    paths:
      - "src/auth/**"
```

Break a rule and the build fails. Contract tests scan source code — they don't need the app running.

**Journey tests** run Playwright against critical user flows. If a journey doesn't pass, the feature isn't done.

**Hooks** auto-trigger tests on build and commit. Commits without issue numbers are rejected. Contract violations are caught on file edits.

---

## Agents

Specflow includes 26 prompt-template agents across 7 categories for orchestrating development workflows:

| Category | Agents | Examples |
|----------|--------|----------|
| Orchestration | 5 | `waves-controller`, `sprint-executor`, `dependency-mapper` |
| Compliance | 7 | `board-auditor`, `contract-validator`, `quality-gate` |
| Generation | 7 | `contract-generator`, `specflow-writer`, `frontend-builder` |
| Testing | 1 | `test-runner` |
| Remediation | 2 | `heal-loop`, `specflow-uplifter` |
| Documentation | 2 | `readme-audit`, `readme-restructure` |
| Lifecycle | 1 | `ticket-closer` |

```bash
specflow agent list              # see all agents
specflow agent show heal-loop    # read full prompt
specflow agent search testing    # find by category
```

Agents are markdown files with YAML frontmatter in `agents/`. They are prompt templates — not running services. Use them with Claude Code or any LLM that supports agent protocols.

---

## MCP Integration

Register Specflow as a [Model Context Protocol](https://modelcontextprotocol.io) server so Claude Code can use it directly:

```bash
specflow mcp register
```

This exposes 10 tools to Claude Code:

| Tool | Purpose |
|------|---------|
| `specflow_list_contracts` | List contracts with rule counts |
| `specflow_check_code` | Check a code snippet against contracts |
| `specflow_get_violations` | Scan files for violations |
| `specflow_validate_contract` | Validate a YAML contract file |
| `specflow_audit_issue` | Audit a GitHub issue (11 checks) |
| `specflow_compile_journeys` | Compile journey CSV to YAML |
| `specflow_verify_graph` | Verify contract cross-references |
| `specflow_list_agents` | List agents with categories |
| `specflow_get_agent` | Get an agent's full prompt and metadata |
| `specflow_defer_journey` | Defer/undefer journey contracts |

To unregister: `specflow mcp unregister`

---

## Contract Schema

Contracts live in `docs/contracts/` as YAML. See [CONTRACT-SCHEMA.md](CONTRACT-SCHEMA.md) for the full format and [CONTRACT-SCHEMA-EXTENSIONS.md](CONTRACT-SCHEMA-EXTENSIONS.md) for parallel execution extensions.

Default contract templates ship in `templates/contracts/`:
- `security_defaults.yml` — OWASP baseline
- `test_integrity_defaults.yml` — test quality rules
- `accessibility_defaults.yml` — WCAG AA baseline
- `production_readiness_defaults.yml` — production hygiene
- `component_library_defaults.yml` — UI composition patterns

---

## FAQ

**Isn't this just more testing?** No. Tests verify behaviour. Contracts verify architecture. "No localStorage in service workers" survives any refactor.

**What if I don't have a perfect spec?** Start with "document what works today." Your first contract can be: whatever we're doing now, don't break it.

**Can LLMs actually follow contracts?** Even if they don't, tests catch it. You don't need the LLM to behave. You need it to be checkable.

---

## Links

| | |
|---|---|
| [Getting Started](docs/getting-started.md) | Manual paths, updating, SKILL.md |
| [Agent Library](agents/README.md) | 26 agents for wave execution |
| [Contract Schema](docs/reference/CONTRACT-SCHEMA.md) | YAML format for contracts |
| [CI Integration](CI-INTEGRATION.md) | GitHub Actions setup |
| [npm](https://www.npmjs.com/package/specflow-cli) | `specflow-cli` |
| [Issues](https://github.com/fall-development-rob/specflow-cli/issues) | Bugs and ideas |
