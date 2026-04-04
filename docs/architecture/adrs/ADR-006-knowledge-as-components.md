# ADR-006: Knowledge as Hooks, Agents, and Skills Instead of Static Docs

**Status:** Proposed
**Date:** 2026-04-04
**Depends on:** ADR-005 (Agent Registry), ADR-004 (MCP Server Design)

---

## Context

During the legacy cleanup (Phase 1), 20+ documentation files were removed from the repository root and `docs/` directories. A gap analysis revealed that while the _content_ of these files is valuable, the _format_ (static markdown) was the wrong delivery mechanism:

- Static docs go stale — no enforcement that they match the code
- Developers don't read docs at the right time — they read them _before_ or _after_ the moment of need
- Much of the content is procedural knowledge that should be delivered contextually (e.g., contract schema when writing contracts, security rules when generating code)

The removed files fall into 7 categories:

| Category | Files | Why Static Docs Failed |
|----------|-------|----------------------|
| Core operating loop | SKILL.md | Too long for developers to internalize; needs to be ambient |
| Contract schema | CONTRACT-SCHEMA.md, CONTRACTS-README.md | Schema is better queried than read |
| Pipeline compliance | (implicit — no single file) | Compliance gaps need automated detection, not documentation |
| Agent coordination | PROTOCOL.md, WORKFLOW.md, team-names.md | Coordination knowledge belongs in the agents that coordinate |
| User guides | SPEC-FORMAT.md, USER-JOURNEY-CONTRACTS.md, MID-PROJECT-ADOPTION.md | Guides are better delivered as agent advice at point of use |
| Schema extensions | CONTRACT-SCHEMA-EXTENSIONS.md | Extension knowledge belongs in the agents that use extensions |
| Examples | (scattered inline) | Examples are better served on demand than embedded in docs |

---

## Decision

**Embed knowledge into the system components that use it**, rather than restoring static documentation files.

Each category maps to a specific component type:

### 1. SKILL.md → Claude Code Skill

Create `.claude/skills/specflow.md` containing the core operating loop, pre-flight gates, security patterns, agent behaviors, model routing guidance, and command reference.

- Shipped inside the npm package
- `specflow init` copies it to the user's `.claude/skills/` directory
- Claude Code loads it automatically as ambient context
- Replaces a static doc the developer would need to find and read

### 2. Contract Schema → MCP Tool + Agent Context

Add `specflow_get_schema` MCP tool that returns the full YAML contract schema specification on demand.

- Inject the schema into the contract-generator agent's `contracts` field
- Users ask Claude "show me the contract schema" and get it via MCP, always current
- Agents that generate contracts have the schema in context automatically

### 3. Pipeline Compliance → Hook Enhancement

Enhance the existing `check-compliance.ts` hook with:

- **Orphan detection:** test file without matching contract, contract without matching test
- **Uncompiled CSV detection:** journey CSV without compiled contract + test stubs
- Aligns with simulation Edge 5 fix (Phase 8)

### 4. Agent Coordination → Agent Prompt Enrichment

Embed coordination knowledge directly in agent prompts:

- PROTOCOL.md (TeammateTool usage) → waves-controller agent prompt body
- WORKFLOW.md (state machine) → waves-controller and sprint-executor agent prompts
- Team names and aliases → agent frontmatter `aliases` field

### 5. User Guides → Agents

Map guides to the agents that provide equivalent advice:

- Spec writing guide → specflow-writer agent (already exists)
- Journey contract guide → journey-tester agent (already exists)
- Adoption strategy → new **adoption-advisor** agent

### 6. Schema Extensions → Agent Context

Inject extension knowledge (soft rules, `auto_fix`, custom severity) into the agents that use it:

- contract-generator agent — needs to know about extensions when creating contracts
- heal-loop agent — needs to know about `auto_fix` when remediating violations

### 7. Examples → MCP Tool

Add `specflow_get_example` MCP tool that returns an annotated example contract.

- Always reflects the current schema (generated, not static)
- Better than a static file that drifts from reality

---

## Consequences

### Positive

- **Knowledge at point of use:** Developers get contract schema when writing contracts, security rules when generating code, coordination protocol when orchestrating agents — without needing to find and read a doc
- **Self-maintaining:** Skills, agents, and MCP tools are tested and exercised regularly; static docs rot silently
- **Less maintenance burden:** No separate documentation to keep in sync with code changes
- **Discoverability:** `specflow agent search adoption` finds the adoption-advisor; a static doc in `docs/guides/` requires knowing it exists

### Negative

- **Higher implementation cost:** Building MCP tools and enriching agents is more work than restoring markdown files
- **Knowledge is distributed:** No single place to read all Specflow knowledge — it's spread across skills, agents, and tools (mitigated: the MASTER-PLAN and this ADR serve as the map)
- **Debugging is harder:** If an agent gives wrong advice, the source is embedded in the agent prompt rather than a standalone doc

### Neutral

- The static docs remain in git history for reference if needed
- This approach is consistent with Specflow's philosophy: contracts enforce at build time, not in documentation

---

## Alternatives Considered

### 1. Restore the static docs

Rejected. This restores the original problem: docs that go stale, aren't read at the right time, and create a maintenance burden separate from the code.

### 2. Generate docs from code

Considered but deferred. Auto-generating schema docs from the YAML parser is viable but doesn't address the delivery problem — the doc still sits in a `docs/` directory waiting to be found. May be added later as a complement to MCP tools.

### 3. In-CLI help pages

Partially adopted via `specflow agent show` and MCP tools, but not sufficient for ambient context like the core operating loop, which is better served as a Claude Code skill.

---

## AgentDB as Storage and Query Layer

[ADR-007](ADR-007-agentdb-knowledge-graph.md) introduces AgentDB as the persistent storage and query layer that powers the component approach described above. The relationship:

- **ADR-006** defines *what* knowledge is embedded and *where* it goes (skills, agents, MCP tools, hooks)
- **ADR-007** defines *how* that knowledge becomes persistent, queryable, and learning

### How AgentDB Powers Each Component

| Component | ADR-006 Delivery | ADR-007 Storage/Query Layer |
|-----------|-----------------|---------------------------|
| Skills | `.claude/skills/specflow.md` — static operating loop | AgentDB skill library — learned fix patterns with confidence scores |
| Agent context | Contract bindings in frontmatter | Agent nodes in graph with performance metrics and fix history |
| MCP tools | `specflow_get_schema`, `specflow_get_example` | `specflow_query_graph`, `specflow_get_fix_suggestion`, `specflow_get_impact` |
| Hooks | `check-compliance.ts` — real-time scanning | Violations recorded in graph; fix suggestions included in hook output |

### Key Integration Points

- **Skills** live in the AgentDB skill library as Skill nodes, discovered automatically from fix patterns
- **Agent knowledge** is represented as graph nodes — agents, contracts, rules, and the edges between them
- **MCP tools** query the graph using Cypher, exposing the full knowledge graph to Claude Code
- **Hook enforcement** records violations in real-time and queries the skill library for fix suggestions

The static components (skill file, agent prompts, schema tools) provide the framework. AgentDB adds the learning layer — turning one-shot knowledge delivery into a system that improves with use.
