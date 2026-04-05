# Specflow

**Specs that enforce themselves.**

LLMs drift. You write a rule; three iterations later the model ignores it. Specflow turns your specs into contract tests that break the build when violated — so drift can't ship.

```bash
specflow init .          # scaffold contracts, hooks, skill
specflow doctor .        # check everything is wired up
specflow enforce .       # run contract enforcement
```

Nothing goes in your project root except `CLAUDE.md`. Contracts, tests, and config live in `.specflow/` and `.claude/`.

---

## Install

```bash
npm install -g specflow-cli
```

Or via install script:

```bash
curl -sSL https://raw.githubusercontent.com/fall-development-rob/specflow-cli/main/scripts/install.sh | bash
```

---

## What You Get

After `specflow init .`:

```
.specflow/
  contracts/          5 default YAML contracts (security, accessibility, etc.)
  tests/e2e/          journey test stubs
  config.json         your path preferences
  knowledge.db        knowledge graph (violations, fixes, trends)
  baseline.json       compliance snapshot
.claude/
  settings.json       Claude Code hook config
  skills/specflow.md  Specflow skill for Claude Code
  .defer-journal      journey deferrals
.git/hooks/commit-msg  rejects commits without #issue
CLAUDE.md              appended, never overwritten
```

Init is interactive — asks where you want contracts and tests. Use `-y` for defaults.

---

## CLI Commands

| Command | What it does |
|---------|-------------|
| `specflow init [dir]` | Scaffold contracts, hooks, skill, knowledge graph |
| `specflow doctor [dir]` | 14 health checks across contracts, hooks, graph |
| `specflow enforce [dir]` | Run contracts against source code, record violations |
| `specflow status [dir] [--history]` | Compliance dashboard with trends and hotspots |
| `specflow impact <contract-id>` | Show blast radius of a contract change |
| `specflow update [dir]` | Update hooks and settings |
| `specflow audit <issue>` | Audit a GitHub issue (11 compliance markers) |
| `specflow compile <csv>` | Compile journey CSV to YAML contracts + test stubs |
| `specflow graph [dir]` | Validate contract cross-references |
| `specflow agent list` | List all 28 agents by category |
| `specflow agent show <name>` | Show an agent's full prompt |
| `specflow agent search <query>` | Search agents |
| `specflow mcp start` | Start MCP server for Claude Code |
| `specflow mcp register` | Register as Claude Code MCP server |

---

## How It Works

**Contracts** are YAML files that define rules your code must follow:

```yaml
- id: SEC-001
  scope:
    - "src/**/*.{ts,js}"
  behavior:
    forbidden_patterns:
      - pattern: /(password|secret|token)\s*[:=]\s*['"][^'"]{8,}['"]/i
        message: "Hardcoded secret — use environment variable"
```

Break a rule → build fails. `specflow enforce` scans source code against all contract patterns.

**Hooks** fire automatically in Claude Code:
- **Write/Edit** → compliance check against contracts
- **Bash (build/commit)** → journey test trigger
- **commit-msg** → rejects commits without `#issue`

**Knowledge graph** (`.specflow/knowledge.db`) tracks violations over time:
- `specflow status --history` shows compliance trends
- `specflow impact` shows blast radius of contract changes
- Fix suggestions based on what worked before

---

## Agents

28 prompt-template agents across 7 categories:

| Category | Count | Examples |
|----------|-------|----------|
| Compliance | 7 | `board-auditor`, `contract-validator`, `quality-gate` |
| Generation | 9 | `contract-generator`, `specflow-writer`, `ci-builder` |
| Orchestration | 5 | `waves-controller`, `sprint-executor`, `dependency-mapper` |
| Documentation | 3 | `readme-audit`, `readme-restructure`, `adoption-advisor` |
| Remediation | 2 | `heal-loop`, `specflow-uplifter` |
| Testing | 1 | `test-runner` |
| Lifecycle | 1 | `ticket-closer` |

```bash
specflow agent list              # see all agents
specflow agent show heal-loop    # read full prompt
specflow agent search testing    # find by category
```

Agents are markdown files with YAML frontmatter. They are prompt templates — use them with Claude Code or any LLM.

---

## MCP Integration

Register Specflow as a [Model Context Protocol](https://modelcontextprotocol.io) server:

```bash
specflow mcp register
```

Exposes 14 tools to Claude Code:

| Tool | Purpose |
|------|---------|
| `specflow_list_contracts` | List contracts with rule counts |
| `specflow_check_code` | Check a code snippet against contracts |
| `specflow_get_violations` | Scan files for violations |
| `specflow_validate_contract` | Validate a YAML contract |
| `specflow_audit_issue` | Audit a GitHub issue |
| `specflow_compile_journeys` | Compile journey CSV |
| `specflow_verify_graph` | Verify contract cross-references |
| `specflow_list_agents` | List agents |
| `specflow_get_agent` | Get agent prompt |
| `specflow_defer_journey` | Defer/undefer journeys |
| `specflow_get_schema` | Get contract YAML schema |
| `specflow_get_example` | Get annotated example contract |
| `specflow_query_graph` | Query knowledge graph (trends, hotspots, impact) |
| `specflow_get_fix_suggestion` | Get fix suggestion for a rule |

---

## CI Integration

Instead of static templates, Specflow includes a `ci-builder` agent that inspects your project and generates a tailored CI pipeline:

```bash
specflow agent show ci-builder
```

Supports GitHub Actions, GitLab CI, Azure Pipelines, CircleCI, and Bitbucket.

---

## FAQ

**Isn't this just more testing?** No. Tests verify behaviour. Contracts verify architecture. "No localStorage in service workers" survives any refactor.

**What if I don't have a perfect spec?** Start with the 5 default contracts. Your first custom contract can be: whatever we're doing now, don't break it.

**Can LLMs actually follow contracts?** Even if they don't, `specflow enforce` catches it. You don't need the LLM to behave. You need it to be checkable.

---

## Links

| | |
|---|---|
| [Architecture Docs](docs/architecture/README.md) | ADRs, PRDs, DDDs, master plan |
| [CI Integration](docs/CI-INTEGRATION.md) | CI pipeline setup via agent |
| [Issues](https://github.com/fall-development-rob/specflow-cli/issues) | Bugs and ideas |
