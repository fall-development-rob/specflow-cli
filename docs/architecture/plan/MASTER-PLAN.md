# Specflow v1.0 — Master Execution Plan

**Goal:** Transform Specflow from a repository of bash scripts and documentation into a standalone, installable CLI tool that any developer can adopt in under 5 minutes.

**Success criteria:** A developer runs `npm install -g @colmbyrne/specflow && specflow init . --wizard && specflow doctor` and has contract enforcement working in their project.

---

## Current State

Specflow v0.1.7 is a contract-driven development framework that enforces architectural rules via YAML contracts and journey tests. The core contract engine works well (425 pattern tests passing), but the delivery mechanism is fragile:

- CLI is a 154-line Node.js dispatcher that shells out to 3 large bash scripts
- Hook installer requires `jq` and fails on most systems (26 test failures)
- No MCP server (can't integrate natively with Claude Code)
- 13 markdown files in root, sample apps with node_modules, a stray supabase directory
- Agents are undiscoverable markdown files with no frontmatter or runner
- No install script for one-line setup
- No `doctor` command for self-diagnosis

## Target State

Specflow v1.0 is a Node.js CLI tool that:

1. Installs globally via npm or curl one-liner
2. Scaffolds contract enforcement into any project with `specflow init`
3. Self-diagnoses with `specflow doctor`
4. Integrates with Claude Code as an MCP server
5. Runs contract tests directly with `specflow enforce`
6. Has zero bash dependencies for core functionality
7. Ships a clean, focused package with no sample apps or project-specific files

---

## Phase 1: Clean the Foundation

**Duration:** 1-2 days
**Objective:** Remove clutter, reorganize files, establish the structure everything else builds on.

### Tasks

1.1. Remove non-framework content from repo
  - Delete `sample apps/` (move to `specflow-examples` repo or archive branch)
  - Delete `supabase/` (project-specific)
  - Delete `ruflo/` (dev tooling artifact)
  - Merge useful content from `context/` into `docs/`, delete `context/`

1.2. Move root markdown sprawl to `docs/`
  - Move to `docs/guides/`: QUICKSTART.md, MID-PROJECT-ADOPTION.md, PUSH-TO-GITHUB.md, PROMPT-TEMPLATE.md, SPEC-FORMAT.md, USER-JOURNEY-CONTRACTS.md, README_FRONTIER.md, FRONTIER_IMPROVEMENTS.md
  - Move to `docs/reference/`: CONTRACT-SCHEMA.md, CONTRACT-SCHEMA-EXTENSIONS.md, CONTRACTS-README.md, LLM-MASTER-PROMPT.md
  - Keep in root: README.md, CLAUDE.md, SKILL.md, CLAUDE-MD-TEMPLATE.md, CI-INTEGRATION.md, LICENSE

1.3. Move root bash scripts to `scripts/legacy/`
  - `setup-project.sh`, `install-hooks.sh`, `verify-setup.sh`, `extract-to-project.sh`
  - These become reference implementations for the Node.js rewrites

1.4. Update `package.json` files array to match new structure

1.5. Verify all 652 passing tests still pass after restructure

**Exit criteria:** Clean root, all passing tests still pass, `npm pack` produces a focused package.

**Related documents:**
- [ADR-001: Repository Structure](../adrs/ADR-001-repository-structure.md)

---

## Phase 2: Rewrite CLI Core in Node.js

**Duration:** 3-5 days
**Objective:** Replace bash scripts with Node.js commands. Zero system dependencies beyond Node.js 20+.

### Tasks

2.1. Design CLI command router
  - Parse args, route to command modules in `src/commands/`
  - Support `--help`, `--version`, `--json` (machine-readable output) flags
  - Detect MCP mode (stdin not TTY) vs CLI mode

2.2. Rewrite `init` command (`src/commands/init.js`)
  - Replace `setup-project.sh` (636 lines of bash)
  - Interactive wizard mode (`--wizard`): ask repo, board type, tech stack
  - Non-interactive mode with flags for CI usage
  - Scaffold: contracts, tests, hooks, CLAUDE.md, jest config, git hook
  - Use Node.js `fs` for all file operations (no `cp`, `mkdir`, `jq`)

2.3. Rewrite `doctor` command (`src/commands/doctor.js`)
  - Replace `verify-setup.sh` (763 lines of bash)
  - 13 health checks with pass/warn/fail output
  - `--fix` flag to auto-remediate common issues
  - Machine-readable JSON output with `--json`

2.4. Rewrite `update` command (`src/commands/update.js`)
  - Replace `install-hooks.sh` (313 lines of bash)
  - Install Claude Code hooks via Node.js JSON manipulation (no `jq`)
  - Install git commit-msg hook
  - Optionally install CI workflows (`--ci`)

2.5. Add `enforce` command (`src/commands/enforce.js`)
  - Run contract pattern tests directly (no `npm test` indirection)
  - Load contracts from `docs/contracts/`, compile patterns, scan target files
  - Output: which rules pass/fail, which files violate, suggested fixes
  - Exit code 0 (clean) or 1 (violations found)

2.6. Wire existing commands into new CLI
  - `compile` → wraps `specflow-compile.cjs`
  - `audit` → existing audit logic from `bin/specflow.js`
  - `graph` → wraps `verify-graph.cjs`

2.7. Add `status` command (`src/commands/status.js`)
  - Show contract compliance summary
  - Count passing/failing rules
  - Show journey test coverage
  - Show hook installation status

2.8. Rewrite hook scripts in Node.js
  - `src/hooks/post-build-check.js` — replaces bash version
  - `src/hooks/run-journey-tests.js` — replaces bash version
  - `src/hooks/check-compliance.js` — replaces bash version
  - All read JSON from stdin (Claude Code hook protocol), no `jq`

2.9. Update all tests to cover new Node.js implementations

**Exit criteria:** `specflow init . && specflow doctor && specflow enforce` works. 678/678 tests pass. No bash dependency for any core command.

**Related documents:**
- [ADR-002: Node.js Over Bash](../adrs/ADR-002-nodejs-over-bash.md)
- [ADR-003: CLI Architecture](../adrs/ADR-003-cli-architecture.md)
- [PRD-001: CLI Rewrite](../prds/PRD-001-cli-rewrite.md)
- [DDD-001: Contract Engine](../ddds/DDD-001-contract-engine.md)
- [DDD-002: Enforcement Pipeline](../ddds/DDD-002-enforcement-pipeline.md)

---

## Phase 3: MCP Server

**Duration:** 2-3 days
**Objective:** Make Claude Code contract-aware by exposing Specflow's engine as MCP tools.

### Tasks

3.1. Implement stdio MCP server (`src/mcp/server.js`)
  - JSON-RPC 2.0 over stdin/stdout
  - Protocol: initialize, tools/list, tools/call, ping
  - Mode detection in `bin/specflow.js`: if stdin is not TTY → MCP mode

3.2. Expose contract tools
  - `specflow_list_contracts` — list all contracts with rule counts and status
  - `specflow_check_code` — test a code snippet against contract patterns
  - `specflow_get_violations` — scan a file or directory against all contracts
  - `specflow_validate_contract` — validate a YAML contract's schema
  - `specflow_audit_issue` — audit a GitHub issue for compliance markers
  - `specflow_compile_journeys` — compile CSV to contracts + test stubs
  - `specflow_verify_graph` — run contract graph integrity checks
  - `specflow_defer_journey` — add/remove journey deferrals

3.3. Registration command
  - `specflow mcp register` → runs `claude mcp add specflow -- specflow mcp start`
  - `specflow mcp unregister` → removes MCP registration

3.4. Test MCP server with Claude Code end-to-end

**Exit criteria:** `claude mcp add specflow -- specflow mcp start` works. Claude Code can call `specflow_check_code` and get contract violation results.

**Related documents:**
- [ADR-004: MCP Server Design](../adrs/ADR-004-mcp-server-design.md)
- [PRD-002: MCP Server](../prds/PRD-002-mcp-server.md)

---

## Phase 4: Install Script & Packaging

**Duration:** 1-2 days
**Objective:** One-line install that works on macOS and Linux.

### Tasks

4.1. Write `scripts/install.sh`
  - Check Node.js >= 20, npm >= 9
  - `npm install -g @colmbyrne/specflow`
  - Run `specflow doctor` to verify
  - Optionally register MCP server
  - Colored output, clear error messages

4.2. Host on CDN
  - jsDelivr: `https://cdn.jsdelivr.net/gh/Hulupeep/Specflow@main/scripts/install.sh`
  - Test the full `curl | bash` flow

4.3. Update `package.json`
  - Ensure `files` array matches new structure
  - Verify `bin` entry works after global install
  - Add `engines: { node: ">=20" }`
  - Update version to 1.0.0

4.4. Publish to npm
  - Test with `npm pack` + `npm install -g ./specflow-1.0.0.tgz`
  - Publish `@colmbyrne/specflow@1.0.0`

**Exit criteria:** `curl -fsSL <url> | bash` installs Specflow globally and `specflow doctor` passes.

**Related documents:**
- [PRD-003: Installation & Packaging](../prds/PRD-003-installation-packaging.md)

---

## Phase 5: Agent System

**Duration:** 2-3 days
**Objective:** Make the 32 agent prompts discoverable, indexable, and invocable.

### Tasks

5.1. Add YAML frontmatter to all 32 agent `.md` files
  - Fields: name, description, trigger, inputs, outputs, category
  - Categories: orchestration, compliance, testing, generation, lifecycle

5.2. Create agent registry (`src/agents/registry.js`)
  - Scan `agents/` directory, parse frontmatter
  - Build searchable index
  - Cache for performance

5.3. Add CLI commands
  - `specflow agent list` — table of all agents with category, trigger
  - `specflow agent show <name>` — print full agent prompt
  - `specflow agent search <query>` — fuzzy search agents by description/trigger

5.4. Add MCP tools for agents
  - `specflow_list_agents` — machine-readable agent index
  - `specflow_get_agent` — retrieve agent prompt by name

5.5. Update agent prompts to inject contract context
  - Agents that generate code should reference active contracts
  - Agents that audit should know about contract rules

**Exit criteria:** `specflow agent list` shows all 32 agents. `specflow agent show waves-controller` prints the prompt. MCP tools return agent data.

**Related documents:**
- [ADR-005: Agent Registry Design](../adrs/ADR-005-agent-registry.md)
- [PRD-004: Agent System](../prds/PRD-004-agent-system.md)
- [DDD-003: Agent Registry](../ddds/DDD-003-agent-registry.md)

---

## Phase 6: Documentation & Polish

**Duration:** 1-2 days
**Objective:** README reflects reality. Docs are accurate. Demo works.

### Tasks

6.1. Rewrite README.md
  - Lead with install + init + doctor (the 3-command experience)
  - Accurate feature descriptions (no overclaiming)
  - MCP integration section
  - Clear distinction: contracts = YAML rules, agents = prompt templates

6.2. Update CLAUDE.md for the new structure

6.3. Update demo to use new CLI commands

6.4. Write CHANGELOG.md for v1.0.0

6.5. Update CI-INTEGRATION.md for new hook system

**Exit criteria:** README matches reality. New user can follow it end-to-end.

---

## Dependency Graph

```
Phase 1 (Clean)
    ↓
Phase 2 (CLI Rewrite)
    ↓          ↓
Phase 3      Phase 4
(MCP)        (Install)
    ↓          ↓
Phase 5 (Agents)
    ↓
Phase 6 (Docs)
```

Phases 3 and 4 can run in parallel after Phase 2 completes.

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bash→Node.js rewrite breaks existing adopters | HIGH | Keep legacy scripts in `scripts/legacy/`, document migration path |
| MCP protocol changes | MEDIUM | Pin to MCP spec version, abstract protocol layer |
| Contract loader regex performance on large codebases | MEDIUM | Add file glob filtering, lazy loading, benchmark in Phase 2 |
| Agent frontmatter breaks existing agent consumers | LOW | Frontmatter is ignored by markdown renderers |
| Sample app removal upsets contributors | LOW | Archive to separate repo with redirect in README |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| Test suite | 678/678 passing (100%) |
| Install time | < 60 seconds |
| `specflow init` time | < 10 seconds |
| `specflow doctor` checks | 13+ all passing on fresh init |
| `specflow enforce` on demo project | Correctly catches all violations |
| MCP tools | 8 tools, all functional |
| Package size (`npm pack`) | < 500KB (excluding node_modules) |
| Root directory files | <= 8 (down from 20+) |

---

## Phase 8: Simulation Fixes (Blocking v1.0)

**Duration:** 2-3 days
**Objective:** Fix the 7 edge cases discovered during full user-journey simulation (2026-04-04). All are blocking v1.0 release.
**Depends on:** Phase 2 (CLI Rewrite), Phase 3 (MCP Server)
**Report:** [SIMULATION-REPORT.md](../SIMULATION-REPORT.md)

### Tasks

| # | Severity | Edge Case | File | Fix |
|---|----------|-----------|------|-----|
| 8.1 | CRITICAL | MCP `check_code` returns 0 rules | `ts-src/mcp/tools.ts` | `checkSnippet` must load contracts, compile patterns, scan code against ALL rules when no file path provided |
| 8.2 | HIGH | `enforce --json` exits 0 on violations | `ts-src/commands/enforce.ts` | Set `process.exitCode = 1` when violations found, before output formatting |
| 8.3 | HIGH | Compliance hook is a no-op | `ts-src/hooks/check-compliance.ts` | Hook must load contracts, scan file_path from stdin JSON, exit 2 on violations |
| 8.4 | MEDIUM | SEC-003 scope too narrow | `templates/contracts/security_defaults.yml` | Expand scope from `src/**/*.{tsx,jsx}` to `src/**/*.{ts,tsx,js,jsx}` + `**/*.html` |
| 8.5 | MEDIUM | Double init duplicates CLAUDE.md | `ts-src/commands/init.ts` | Use `<!-- specflow-rules-start -->` marker instead of heading-based detection |
| 8.6 | MEDIUM | Custom testsDir double nesting | `ts-src/commands/init.ts` | Only create `/e2e` subdir if testsDir doesn't already end with `/e2e` |
| 8.7 | LOW | Help text shows old package name | `ts-src/cli.ts` | Replace `@colmbyrne/specflow` with `specflow` / `npx specflow-cli` in help strings |

### Updated Dependency Graph

```
Phase 1 (Clean)
    ↓
Phase 2 (CLI Rewrite)
    ↓          ↓
Phase 3      Phase 4
(MCP)        (Install)
    ↓          ↓
Phase 5 (Agents)
    ↓
Phase 6 (Docs)
    ↓
Phase 7 (Rust Native Engine) ← if applicable
    ↓
Phase 8 (Simulation Fixes) ← BLOCKING v1.0
    ↓
v1.0 Release
```

### Exit Criteria

- All 7 simulation edge cases have passing regression tests
- `specflow enforce --json` exits 1 on violations
- MCP `check_code` tool correctly detects violations in code snippets
- Compliance hook blocks violating edits with exit 2
- `specflow init .` is idempotent (second run produces no changes)
- All 678+ tests pass

---

## Phase 9: Knowledge Embedding

**Duration:** 3-4 days
**Objective:** Convert the 20+ static documentation files removed during cleanup into living system components — skills, agents, MCP tools, and hooks — so knowledge is delivered at point of use instead of sitting in unread markdown files.
**Depends on:** Phase 8 (Simulation Fixes), Phase 5 (Agent System), Phase 3 (MCP Server)

### Background

A gap analysis of the legacy cleanup (Phase 1) identified 20+ removed documentation files. Rather than restoring them as static docs, each piece of knowledge maps naturally to an existing system component that delivers it contextually.

### Tasks

| # | Source Knowledge | Becomes | Component |
|---|-----------------|---------|-----------|
| 9.1 | SKILL.md (core loop, gates, security, model routing, command ref) | Claude Code skill | `.claude/skills/specflow.md` — shipped in npm package, `specflow init` copies to user's `.claude/skills/`, loaded automatically by Claude Code |
| 9.2 | CONTRACT-SCHEMA.md, CONTRACTS-README.md | MCP tool + agent context | `specflow_get_schema` MCP tool returns full YAML schema spec; schema injected into contract-generator agent's `contracts` field |
| 9.3 | Pipeline compliance gaps | Hook enhancement | Enhance `check-compliance.ts`: orphan detection (test without contract, contract without test), uncompiled CSV detection |
| 9.4 | PROTOCOL.md (TeammateTool), WORKFLOW.md (state machine), team-names.md | Agent prompt enrichment | Protocol → waves-controller body; workflow → waves-controller + sprint-executor; team names → agent frontmatter `aliases` field |
| 9.5 | User guides (spec format, journeys, adoption) | Agents | Spec writing → specflow-writer agent (existing); journeys → journey-tester (existing); adoption strategy → new adoption-advisor agent |
| 9.6 | CONTRACT-SCHEMA-EXTENSIONS.md (soft rules, auto_fix) | Agent context | Inject into contract-generator and heal-loop agent `contracts` fields |
| 9.7 | Example contracts | MCP tool | `specflow_get_example` MCP tool returns annotated example contract on demand |

### Exit Criteria

- `.claude/skills/specflow.md` exists in package and is copied by `specflow init`
- `specflow_get_schema` and `specflow_get_example` MCP tools return correct content
- `adoption-advisor` agent exists with valid frontmatter
- waves-controller, sprint-executor, contract-generator, and heal-loop agents enriched with embedded knowledge
- `check-compliance.ts` hook detects orphan tests/contracts and uncompiled CSVs
- All 678+ tests pass

### Related Documents

- [ADR-006: Knowledge as Components](../adrs/ADR-006-knowledge-as-components.md)
- [PRD-005: Knowledge Embedding](../prds/PRD-005-knowledge-embedding.md)

### Updated Dependency Graph

```
Phase 1 (Clean)
    ↓
Phase 2 (CLI Rewrite)
    ↓          ↓
Phase 3      Phase 4
(MCP)        (Install)
    ↓          ↓
Phase 5 (Agents)
    ↓
Phase 6 (Docs)
    ↓
Phase 7 (Rust Native Engine) ← if applicable
    ↓
Phase 8 (Simulation Fixes) ← BLOCKING v1.0
    ↓
Phase 9 (Knowledge Embedding)
    ↓
Phase 10 (Knowledge Graph)
    ↓
v1.0 Release
```

---

## Phase 10: Knowledge Graph via sql.js

**Duration:** 3-5 days
**Objective:** Integrate a persistent knowledge graph via sql.js (WASM SQLite), making enforcement stateful. The system records violations, tracks fixes, extracts reusable skills via frequency-based pattern extraction, and suggests fixes based on history.
**Depends on:** Phase 8 (Simulation Fixes), Phase 9 (Knowledge Embedding)

### Background

Phases 1-9 deliver a working CLI with contract enforcement, MCP integration, agents, and knowledge embedding. But enforcement is still stateless — every `specflow enforce` run starts fresh. Phase 10 adds persistent memory via sql.js, storing the graph in `.specflow/knowledge.db`.

> **Note:** AgentDB (`agentdb@3.0.0-alpha.11`) was evaluated but its core APIs are broken in alpha (see [ADR-007 Amendment](../adrs/ADR-007-agentdb-knowledge-graph.md#amendment-2026-04-04)). sql.js is what AgentDB uses internally — stable, proven, zero native deps. When AgentDB reaches a stable release, it becomes a migration target. The schema is designed to be implementation-agnostic.

### Scope

Phase 10 focuses on the **structured graph with basic SQL querying**: nodes, edges, violation recording, fix tracking, frequency-based skill discovery, and SQL-based suggestions. **No ML, RL, GNN, or self-learning features in this phase.** Those are deferred to a future AgentDB migration.

### Tasks

| # | Task | Component |
|---|------|-----------|
| 10.1 | Add `sql.js` dependency to `package.json` | package.json |
| 10.2 | Create SQL schema (nodes, edges, indexes) | `ts-src/lib/graph-schema.ts` |
| 10.3 | Create GraphBuilder service — materializes YAML contracts + agents into graph nodes via INSERT | `ts-src/lib/graph-builder.ts` |
| 10.4 | Integrate GraphBuilder into `specflow init` — create `.specflow/knowledge.db` | `ts-src/commands/init.ts` |
| 10.5 | Create ViolationRecorder service — records enforce results via INSERT | `ts-src/lib/violation-recorder.ts` |
| 10.6 | Integrate ViolationRecorder into `specflow enforce` — record violations after scan | `ts-src/commands/enforce.ts` |
| 10.7 | Create FixTracker service — records fix attempts and outcomes via INSERT/UPDATE | `ts-src/lib/fix-tracker.ts` |
| 10.8 | Create SkillDiscovery service — frequency-based pattern extraction via SQL GROUP BY | `ts-src/lib/skill-discovery.ts` |
| 10.9 | Add fix suggestions to `specflow enforce` output (SQL ranking, not self-learning) | `ts-src/commands/enforce.ts` |
| 10.10 | Add MCP tools: `specflow_query_graph` (SQL), `specflow_get_fix_suggestion`, `specflow_get_impact` | `ts-src/mcp/tools.ts` |
| 10.11 | Add `specflow impact` command (recursive CTE queries) | `ts-src/commands/impact.ts` |
| 10.12 | Add `specflow status --history` for compliance trending (GROUP BY date) | `ts-src/commands/status.ts` |
| 10.13 | Add `specflow learn` command for consolidation (DELETE old, UPDATE confidence, VACUUM) | `ts-src/commands/learn.ts` |
| 10.14 | Integrate graph queries into heal-loop agent workflow | Agent prompt + MCP tools |
| 10.15 | Update hooks to record violations in real-time | `ts-src/hooks/check-compliance.ts` |
| 10.16 | Add regression tests for all graph features | `tests/graph/*.test.js` |

### Future: AgentDB Migration Path

When AgentDB reaches a stable release:
1. Replace sql.js initialization with AgentDB initialization
2. Replace raw SQL queries with AgentDB cognitive memory APIs
3. Gain self-learning search, RL algorithms, GNN attention, witness chain for free
4. No schema changes required — same node/edge model

### Exit Criteria

- `specflow init` creates `.specflow/knowledge.db` with indexed contracts and agents
- `specflow enforce` records violations in the graph and shows fix suggestions
- `specflow status --history` shows violation trends over time
- `specflow impact` predicts effects of contract changes
- MCP tools expose graph queries (SQL) to Claude Code
- heal-loop agent queries skill library before attempting fixes
- All 678+ tests pass, plus new graph-specific tests

### Related Documents

- [ADR-007: Knowledge Graph (Amended)](../adrs/ADR-007-agentdb-knowledge-graph.md)
- [DDD-004: Knowledge Graph Domain Design](../ddds/DDD-004-knowledge-graph.md)
- [PRD-006: Knowledge Graph Integration](../prds/PRD-006-knowledge-graph.md)

---

## Phase 11: Best-in-Class Features

**Duration:** 6-8 weeks
**Objective:** Five features that make Specflow competitive with commercial contract enforcement tools: incremental enforcement, fix suggestions, contract creation, PR compliance reports, and shareable contract packages.
**Depends on:** Phase 10 (Knowledge Graph)
**Simulation Report:** [SIMULATION-REPORT-2.md](../SIMULATION-REPORT-2.md) — 38 edge cases identified and resolved

### Sub-phases

#### Phase 11a: Incremental Enforcement (`enforce --staged` + `enforce --diff`)

**Duration:** 1-2 weeks
**Priority:** 1 (foundation for 11b and 11d)

| # | Task | Component |
|---|------|-----------|
| 11a.1 | Implement `GitIntegrationService` — `getStagedFiles()`, `getDiffFiles()`, `getMergeBase()` | `ts-src/lib/git-integration.ts` |
| 11a.2 | Implement `FileFilterPipeline` — status filter, path resolution, binary filter, scope filter | `ts-src/lib/file-filter.ts` |
| 11a.3 | Add `--staged` flag to enforce command | `ts-src/commands/enforce.ts` |
| 11a.4 | Add `--diff <branch>` flag to enforce command | `ts-src/commands/enforce.ts` |
| 11a.5 | Handle all 8 edge cases (E1-1 through E1-8) | Error handling throughout |
| 11a.6 | Add regression tests for incremental enforcement | `tests/enforce/*.test.js` |

**Edge cases:** E1-1 (relative paths), E1-2 (deleted files), E1-3 (binary files), E1-4 (renamed files), E1-5 (not in git repo), E1-6 (branch not found), E1-7 (no common ancestor), E1-8 (empty diff)

**Exit criteria:** `specflow enforce --staged` and `specflow enforce --diff main` work correctly. All 8 edge cases have passing regression tests.

**Related documents:**
- [ADR-008: Incremental Enforcement](../adrs/ADR-008-incremental-enforcement.md)
- [DDD-005: Incremental Enforcement Domain Design](../ddds/DDD-005-incremental-enforcement.md)
- [PRD-007: Incremental Enforcement & PR Compliance](../prds/PRD-007-incremental-enforcement.md)

#### Phase 11b: Auto-Fix Suggestions (`enforce --suggest`)

**Duration:** 1 week
**Priority:** 2 (leverages Phase 10 knowledge graph)

| # | Task | Component |
|---|------|-----------|
| 11b.1 | Seed knowledge graph with `example_compliant` patterns from contracts | `ts-src/lib/graph-builder.ts` |
| 11b.2 | Add `--suggest` flag to enforce command | `ts-src/commands/enforce.ts` |
| 11b.3 | Batch graph queries by unique rule ID | `ts-src/lib/fix-tracker.ts` |
| 11b.4 | Display suggestions grouped by rule with "X/Y successful" confidence | `ts-src/lib/reporter.ts` |
| 11b.5 | Add `specflow learn --mark-failed` feedback command | `ts-src/commands/learn.ts` |
| 11b.6 | Add regression tests | `tests/enforce/*.test.js` |

**Edge cases:** E2-1 (no history), E2-2 (seed data), E2-3 (wrong suggestion), E2-4 (confidence display), E2-5 (dedup per rule), E2-6 (opt-in), E2-7 (batch queries)

**Exit criteria:** `specflow enforce --suggest` shows relevant fix suggestions. Fresh projects show seed suggestions from contract examples.

#### Phase 11c: Contract Creation (`specflow contract create`)

**Duration:** 1-2 weeks
**Priority:** 4

| # | Task | Component |
|---|------|-----------|
| 11c.1 | Create 6 pre-built contract templates | `templates/contract-templates/*.yml` |
| 11c.2 | Implement template mode (`--template`) with interactive picker | `ts-src/commands/contract-create.ts` |
| 11c.3 | Implement AI mode (`--ai`) with Claude CLI integration | `ts-src/commands/contract-create.ts` |
| 11c.4 | Implement validation pipeline (regex, scope, examples, uniqueness) | `ts-src/lib/contract-validator.ts` |
| 11c.5 | Implement interactive review (y/n/edit) | `ts-src/commands/contract-create.ts` |
| 11c.6 | Auto-run enforcement after creation | `ts-src/commands/contract-create.ts` |
| 11c.7 | Add regression tests | `tests/contract-create/*.test.js` |

**Edge cases:** E3-1 through E3-10 (see PRD-008)

**Exit criteria:** Both `--template` and `--ai` modes create valid, validated contracts. Interactive review works. 6 templates ship.

**Related documents:**
- [PRD-008: Contract Creation](../prds/PRD-008-contract-creation.md)

#### Phase 11d: PR Compliance Report

**Duration:** 1 week
**Priority:** 3 (builds on 11a `--diff --json`)

| # | Task | Component |
|---|------|-----------|
| 11d.1 | Implement `BaselineComparisonService` for new vs existing violations | `ts-src/lib/baseline-comparison.ts` |
| 11d.2 | Add `specflow report post --github` command | `ts-src/commands/report.ts` |
| 11d.3 | Implement comment update logic (find by HTML marker) | `ts-src/lib/github-reporter.ts` |
| 11d.4 | Add `.specflow/config.json` support for `ci.onViolation` | `ts-src/lib/config.ts` |
| 11d.5 | Handle large report truncation (60KB limit) | `ts-src/lib/github-reporter.ts` |
| 11d.6 | Add regression tests | `tests/report/*.test.js` |

**Edge cases:** E4-1 through E4-8 (see PRD-007)

**Exit criteria:** `specflow enforce --diff main --json | specflow report post --github` posts a PR comment. Comments are updated, not duplicated. Block/warn mode configurable.

#### Phase 11e: Contract Packages (`specflow add/remove/publish`)

**Duration:** 2 weeks
**Priority:** 5

| # | Task | Component |
|---|------|-----------|
| 11e.1 | Implement `PackageDiscoveryService` | `ts-src/lib/package-discovery.ts` |
| 11e.2 | Implement `PackageInstallerService` | `ts-src/lib/package-installer.ts` |
| 11e.3 | Implement `ConflictResolutionService` | `ts-src/lib/conflict-resolution.ts` |
| 11e.4 | Extend contract loader to scan `.specflow/packages/` | `ts-src/lib/contract-loader.ts` |
| 11e.5 | Add `specflow add <package>` command | `ts-src/commands/add.ts` |
| 11e.6 | Add `specflow remove <package>` command | `ts-src/commands/remove.ts` |
| 11e.7 | Add `specflow update-packages` command | `ts-src/commands/update-packages.ts` |
| 11e.8 | Add `specflow publish` command | `ts-src/commands/publish.ts` |
| 11e.9 | Add `.specflow/packages.json` lock file management | `ts-src/lib/package-lock.ts` |
| 11e.10 | Add doctor checks for package integrity | `ts-src/commands/doctor.ts` |
| 11e.11 | Add regression tests | `tests/packages/*.test.js` |

**Edge cases:** E5-1 through E5-11 (see PRD-009)

**Exit criteria:** Full package lifecycle works: add, enforce, update, remove, publish. Rule ID conflicts detected. Doctor validates integrity.

**Related documents:**
- [ADR-009: Contract Packages](../adrs/ADR-009-contract-packages.md)
- [DDD-006: Contract Packages Domain Design](../ddds/DDD-006-contract-packages.md)
- [PRD-009: Contract Packages](../prds/PRD-009-contract-packages.md)

### Updated Dependency Graph

```
Phase 1 (Clean)
    ↓
Phase 2 (CLI Rewrite)
    ↓          ↓
Phase 3      Phase 4
(MCP)        (Install)
    ↓          ↓
Phase 5 (Agents)
    ↓
Phase 6 (Docs)
    ↓
Phase 7 (Rust Native Engine) ← if applicable
    ↓
Phase 8 (Simulation Fixes) ← BLOCKING v1.0
    ↓
Phase 9 (Knowledge Embedding)
    ↓
Phase 10 (Knowledge Graph)
    ↓
Phase 11 (Best-in-Class Features)
    ├── 11a: Incremental Enforcement (--staged, --diff)
    │     ↓
    ├── 11b: Auto-Fix Suggestions (--suggest)
    │     ↓
    ├── 11d: PR Compliance Report
    │
    ├── 11c: Contract Creation
    │
    └── 11e: Contract Packages
    ↓
v1.0 Release
```

### Implementation Priority

| Priority | Sub-phase | Reason |
|----------|-----------|--------|
| 1 | 11a: --staged + --diff | Foundation for 11b and 11d |
| 2 | 11b: --suggest | Leverages Phase 10 knowledge graph, low effort |
| 3 | 11d: PR compliance report | Builds on 11a --diff --json output |
| 4 | 11c: Contract creation | Independent feature, no dependencies on 11a |
| 5 | 11e: Contract packages | Largest scope, can be done last |
