# Changelog

## v1.0.0 (2026-04-02)

First stable release. Specflow is now a native Rust CLI with MCP integration, 26 agents with structured frontmatter, and an install script for one-command setup.

### Phase 1: Repository Cleanup

- Reorganized repository structure with clear separation of concerns
- Moved source code to `src/` (Rust), agents to `agents/`, templates to `templates/`
- Cleaned up legacy files and consolidated documentation

### Phase 2: Rust CLI

Replaced Node.js bash scripts with a native Rust binary (~3,400 lines across 27 files).

**Commands:**
- `specflow init <dir>` — Scaffold contracts, hooks, agents, and CLAUDE.md in a project
- `specflow doctor <dir>` — 8-check health verification (contracts, YAML parsing, patterns, tests, hooks, CI)
- `specflow enforce <dir>` — Run contract enforcement against source code
- `specflow update <dir> [--ci]` — Update hooks and optionally install CI workflows
- `specflow status <dir>` — Compliance dashboard
- `specflow compile [args]` — Compile journey CSV to YAML contracts
- `specflow audit <issue>` — Audit a GitHub issue for specflow compliance (11 checks)
- `specflow graph [dir]` — Validate contract cross-references
- `specflow hook post-build|compliance|journey` — Hook subcommands for CI/git integration

**Dependencies:** clap v4, serde, serde_yaml, serde_json, regex, glob, colored, walkdir, anyhow, atty

### Phase 3: MCP Server

Built a Model Context Protocol (MCP) stdio server for Claude Code integration.

**10 tools exposed:**
- `specflow_list_contracts` — List contracts with rule counts
- `specflow_check_code` — Check code snippet against contracts
- `specflow_get_violations` — Scan file/directory for violations
- `specflow_validate_contract` — Validate YAML contract file
- `specflow_audit_issue` — Audit GitHub issue compliance
- `specflow_compile_journeys` — Compile journey CSV to YAML
- `specflow_verify_graph` — Verify contract cross-references
- `specflow_list_agents` — List agents with categories
- `specflow_get_agent` — Get full agent prompt and metadata
- `specflow_defer_journey` — Defer/undefer journey contracts

**CLI commands:**
- `specflow mcp start` — Start MCP server (stdio)
- `specflow mcp register` — Register with Claude Code
- `specflow mcp unregister` — Unregister from Claude Code

### Phase 4: Install Script and Packaging

- Created `scripts/install.sh` — single-command installation with prerequisite checks
- Supports `--no-mcp` and `--skip-doctor` flags
- Checks for Node.js >= 20 and Rust/Cargo toolchain
- Runs `cargo install` from git, verifies binary, runs doctor, optionally registers MCP
- Updated `Cargo.toml` with release profile (LTO, size-optimized)
- Updated `package.json` with `build:rust` script

### Phase 5: Agent Registry

Added YAML frontmatter to all 26 agents and built a registry system.

**Frontmatter schema:**
```yaml
---
name: agent-name
description: One-line description
category: orchestration|compliance|generation|testing|remediation|documentation|lifecycle
trigger: "User-facing trigger phrase"
inputs: [list]
outputs: [list]
contracts: [contract_ids]
---
```

**26 agents across 7 categories:**
- Orchestration (5): waves-controller, sprint-executor, dependency-mapper, db-coordinator, issue-lifecycle
- Compliance (7): board-auditor, contract-validator, e2e-test-auditor, journey-enforcer, journey-gate, pre-flight-simulator, quality-gate
- Generation (7): contract-generator, contract-test-generator, edge-function-builder, frontend-builder, journey-tester, migration-builder, playwright-from-specflow, specflow-writer
- Testing (1): test-runner
- Remediation (2): heal-loop, specflow-uplifter
- Documentation (2): readme-audit, readme-restructure
- Lifecycle (1): ticket-closer

**CLI commands:**
- `specflow agent list` — List all agents with categories
- `specflow agent show <name>` — Show full agent prompt and metadata
- `specflow agent search <query>` — Search by name, category, trigger, or description

### Phase 6: Documentation

- Rewrote README.md for the Rust CLI experience
- Updated CLAUDE.md with Rust source structure and CLI commands
- Created this CHANGELOG.md
- Updated demo/QUICKSTART.md with CLI references
