# Specflow v1.0 — Planning Documents

This directory contains the planning, architecture, and design documents for transforming Specflow from a repository of scripts into a standalone, installable CLI tool.

**Start here:** [Master Execution Plan](plan/MASTER-PLAN.md)

---

## Document Index

### Plan

| Document | Description |
|----------|-------------|
| [MASTER-PLAN.md](plan/MASTER-PLAN.md) | Top-level execution plan with 6 phases, dependencies, risks, and success metrics |

### PRDs (Product Requirement Documents)

| Document | Phase | Description |
|----------|-------|-------------|
| [PRD-001: CLI Rewrite](prds/PRD-001-cli-rewrite.md) | 2 | Replace bash scripts with Node.js CLI commands |
| [PRD-002: MCP Server](prds/PRD-002-mcp-server.md) | 3 | Stdio MCP server exposing contract tools to Claude Code |
| [PRD-003: Installation & Packaging](prds/PRD-003-installation-packaging.md) | 4 | One-line install, clean npm package, global CLI |
| [PRD-004: Agent System](prds/PRD-004-agent-system.md) | 5 | Agent frontmatter, registry, CLI commands, MCP tools |
| [PRD-005: Knowledge Embedding](prds/PRD-005-knowledge-embedding.md) | 9 | Skill, MCP tools, new agent, agent enrichment, hook enhancement |
| [PRD-006: Knowledge Graph](prds/PRD-006-knowledge-graph.md) | 10 | sql.js knowledge graph, violation recording, fix tracking, skill discovery, MCP graph tools |
| [PRD-007: Incremental Enforcement & PR Compliance](prds/PRD-007-incremental-enforcement.md) | 11a/b/d | --staged, --diff, --suggest flags, PR compliance reports |
| [PRD-008: Contract Creation](prds/PRD-008-contract-creation.md) | 11c | specflow contract create with template and AI modes |
| [PRD-009: Contract Packages](prds/PRD-009-contract-packages.md) | 11e | Shareable contract packages via npm: add, remove, publish |
| [PRD-010: Spec Integrity Toolkit](prds/PRD-010-spec-integrity-toolkit.md) | 12 | spec_coupling contracts, frontmatter schema, review/snapshot/migrate-docs commands |

### ADRs (Architecture Decision Records)

| Document | Decision |
|----------|----------|
| [ADR-001: Repository Structure](adrs/ADR-001-repository-structure.md) | Clean root, move docs, remove sample apps |
| [ADR-002: Node.js Over Bash](adrs/ADR-002-nodejs-over-bash.md) | Rewrite all bash scripts in Node.js, eliminate jq dependency |
| [ADR-003: CLI Architecture](adrs/ADR-003-cli-architecture.md) | Single entry point, mode detection, no CLI framework dependency |
| [ADR-004: MCP Server Design](adrs/ADR-004-mcp-server-design.md) | Stdio JSON-RPC, minimal protocol, reuse contract engine |
| [ADR-005: Agent Registry](adrs/ADR-005-agent-registry.md) | YAML frontmatter on agent files, runtime index, no manifest file |
| [ADR-006: Knowledge as Components](adrs/ADR-006-knowledge-as-components.md) | Embed knowledge in skills, agents, MCP tools, and hooks instead of static docs |
| [ADR-007: Knowledge Graph (Amended)](adrs/ADR-007-agentdb-knowledge-graph.md) | Use sql.js (WASM SQLite) as knowledge graph storage layer; AgentDB deferred to future stable release |
| [ADR-008: Incremental Enforcement](adrs/ADR-008-incremental-enforcement.md) | Add --staged and --diff flags to enforce command for git-scoped scanning |
| [ADR-009: Contract Packages](adrs/ADR-009-contract-packages.md) | Contract packages distributed via npm with specflow field in package.json |
| [ADR-010: Specs as Enforced Artefacts](adrs/ADR-010-specs-as-enforced-artefacts.md) | Documentation becomes a first-class enforceable category via spec_coupling |
| [ADR-011: Document Lifecycle and Frontmatter Schema](adrs/ADR-011-document-lifecycle-and-frontmatter.md) | YAML frontmatter, status lifecycle (Draft/Accepted/Superseded/Deprecated), version snapshots |
| [ADR-012: Bidirectional Document Linking](adrs/ADR-012-bidirectional-document-linking.md) | implements/implemented_by reciprocity, validated and auto-fixed by doctor |

### DDDs (Domain Design Documents)

| Document | Domain |
|----------|--------|
| [DDD-001: Contract Engine](ddds/DDD-001-contract-engine.md) | YAML loading, regex compilation, file scanning, violation reporting |
| [DDD-002: Enforcement Pipeline](ddds/DDD-002-enforcement-pipeline.md) | Git/build/edit/CI gates, hook protocol, journey enforcement, deferrals |
| [DDD-003: Agent Registry](ddds/DDD-003-agent-registry.md) | Agent discovery, search, contract context injection |
| [DDD-004: Knowledge Graph](ddds/DDD-004-knowledge-graph.md) | Graph model, domain services, SQL query patterns, sql.js integration |
| [DDD-005: Incremental Enforcement](ddds/DDD-005-incremental-enforcement.md) | Git integration, file filter pipeline, baseline comparison, domain model |
| [DDD-006: Contract Packages](ddds/DDD-006-contract-packages.md) | Package lifecycle, conflict resolution, registry interaction, domain model |
| [DDD-007: Spec Integrity Domain](ddds/DDD-007-spec-integrity-domain.md) | Document entity, lifecycle state machine, link graph, coupling enforcement, snapshot ledger |

---

### Simulation Reports

| Document | Features | Edge Cases |
|----------|----------|------------|
| [SIMULATION-REPORT.md](SIMULATION-REPORT.md) | Phase 8 — Full user journey | 7 edge cases |
| [SIMULATION-REPORT-2.md](SIMULATION-REPORT-2.md) | Phase 11 — 5 new features | 38 edge cases |

---

## Phase Dependencies

```
Phase 1: Clean Foundation (ADR-001)
    |
    v
Phase 2: CLI Rewrite (PRD-001, ADR-002, ADR-003, DDD-001, DDD-002)
    |           |
    v           v
Phase 3:     Phase 4:
MCP Server   Install Script
(PRD-002,    (PRD-003)
 ADR-004)
    |           |
    v           v
Phase 5: Agent System (PRD-004, ADR-005, DDD-003)
    |
    v
Phase 6: Documentation & Polish
    |
    v
Phase 7: Rust Native Engine (if applicable)
    |
    v
Phase 8: Simulation Fixes (BLOCKING v1.0)
    |
    v
Phase 9: Knowledge Embedding (PRD-005, ADR-006)
    |
    v
Phase 10: Knowledge Graph via sql.js (PRD-006, ADR-007 Amended, DDD-004)
    |
    v
Phase 11: Best-in-Class Features (PRD-007/008/009, ADR-008/009, DDD-005/006)
    |-- 11a: Incremental Enforcement (--staged, --diff)
    |-- 11b: Auto-Fix Suggestions (--suggest)
    |-- 11c: Contract Creation
    |-- 11d: PR Compliance Report
    |-- 11e: Contract Packages
    |
    v
v1.0 Release
```
