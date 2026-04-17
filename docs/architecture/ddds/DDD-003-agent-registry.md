---
id: DDD-003
title: Agent Registry Domain Design
type: DDD
status: Accepted
version: 1
date: '2026-04-02'
last_reviewed: '2026-04-17'
implemented_by:
  - DDD-004
---

# DDD-003: Agent Registry Domain Design

**Status:** Proposed
**Date:** 2026-04-02

---

## Domain Overview

The agent registry manages Specflow's collection of 32 agent prompts. Agents are markdown documents with YAML frontmatter that define specialized roles for LLM-assisted development. The registry makes them discoverable, searchable, and retrievable — by CLI commands, MCP tools, and other agents.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Agent** | A markdown document defining a specialized LLM role with instructions, inputs, outputs, and process steps. |
| **Frontmatter** | YAML metadata block at the top of an agent file, delimited by `---`. |
| **Category** | Classification of agent purpose: orchestration, compliance, testing, generation, lifecycle, remediation, documentation. |
| **Trigger** | Natural language phrase that describes when to invoke this agent (e.g., "Run board audit"). |
| **Contract Binding** | List of contract IDs whose rules should be injected as context when the agent is retrieved. |
| **Agent Index** | In-memory map of agent name → metadata, built by scanning the agents directory. |

---

## Aggregates

### Agent (root aggregate)

```
Agent
├── name: string                # Unique identifier (e.g., "board-auditor")
├── description: string         # One-line summary
├── category: Category          # Enum: orchestration | compliance | testing | generation | lifecycle | remediation | documentation
├── trigger: string             # When to invoke (natural language)
├── inputs: string[]            # What the agent needs
├── outputs: string[]           # What the agent produces
├── contracts: string[]         # Contract IDs for context injection
├── filePath: string            # Absolute path to .md file
└── content: string             # Full markdown body (loaded on demand)
```

### Category (value object / enum)

```
orchestration   — Coordinate multi-agent workflows
compliance      — Audit and enforce standards
testing         — Generate and run tests
generation      — Create code, contracts, tests
lifecycle       — Manage issue and project lifecycle
remediation     — Fix problems and violations
documentation   — Audit and improve documentation
```

---

## Domain Services

### AgentRegistry

**Responsibility:** Scan agent files, parse frontmatter, build index, serve queries.

```
AgentRegistry
  .initialize(agentsDir) → void       # Scan directory, build index
  .list(category?) → AgentSummary[]   # List all or by category
  .get(name) → Agent                  # Full agent with content + contract context
  .search(query) → AgentSummary[]     # Fuzzy search across fields
  .categories() → CategorySummary[]   # List categories with counts
```

### AgentSummary (read model for list/search)

```
AgentSummary
├── name: string
├── description: string
├── category: string
└── trigger: string
```

Excludes content and contract context — lightweight for listing.

### Contract Context Injection

When `get(name)` is called and the agent has `contracts: ["security_defaults"]`:

1. Load `security_defaults` contract via ContractLoader (from DDD-001)
2. Extract rule IDs and descriptions
3. Append to agent content:

```markdown
---

## Active Contract Context

Your output must comply with the following active contracts.

### security_defaults
| Rule | Description |
|------|-------------|
| SEC-001 | No hardcoded secrets |
| SEC-002 | No SQL injection |
| SEC-003 | No XSS via innerHTML |
| SEC-004 | No eval() |
| SEC-005 | No path traversal |
```

This is appended at retrieval time, never stored in the file.

---

## Agent Discovery Algorithm

```
1. Glob agents/*.md (exclude README.md, PROTOCOL.md, WORKFLOW.md, agentlist.md, agentnames.md, team-names.md)
2. For each file:
   a. Read first 50 lines
   b. Check for --- delimiter on line 1
   c. Find closing --- delimiter
   d. Parse YAML between delimiters
   e. Validate required fields: name, description, category
   f. If valid: add to index
   g. If no frontmatter: log warning, skip (graceful degradation)
3. Build name → AgentSummary map
```

### Graceful Degradation

If an agent file has no frontmatter or invalid frontmatter:
- `list` excludes it but logs a warning
- `doctor` reports it as a warning ("agent board-auditor.md missing frontmatter")
- The file still works as a manual prompt — frontmatter is optional for human use

---

## Search Algorithm

Simple ranked search across agent fields:

```
score(agent, query):
  tokens = query.toLowerCase().split(/\s+/)
  score = 0
  for each token:
    if agent.name.includes(token): score += 3      # Name match is strongest
    if agent.trigger.includes(token): score += 2   # Trigger match is strong
    if agent.description.includes(token): score += 1
    if agent.category === token: score += 2         # Exact category match
  return score

search(query):
  return agents
    .map(a => ({ agent: a, score: score(a, query) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
```

No external search library needed. 32 agents is a trivially small corpus.

---

## File Layout

### Before (current)

```
agents/
├── README.md                    # Meta documentation
├── PROTOCOL.md                  # Agent protocol
├── WORKFLOW.md                  # Workflow guide
├── agentlist.md                 # Flat list
├── agentnames.md                # Names and aliases
├── team-names.md                # Team coordination
├── board-auditor.md             # Agent (no frontmatter)
├── contract-generator.md        # Agent (no frontmatter)
└── ... (26 more agents)
```

### After

```
agents/
├── README.md                    # Updated with frontmatter instructions
├── PROTOCOL.md                  # Unchanged
├── WORKFLOW.md                  # Unchanged
├── board-auditor.md             # Agent (with frontmatter)
├── contract-generator.md        # Agent (with frontmatter)
└── ... (30 more agents)
```

Meta files (`agentlist.md`, `agentnames.md`, `team-names.md`) are removed — the registry replaces them. Their content (aliases, team groupings) is captured in frontmatter fields.

---

## Validation Rules (for `specflow doctor`)

| Check | Severity |
|-------|----------|
| Agent file exists but has no frontmatter | WARNING |
| Frontmatter missing required field (name, description, category) | WARNING |
| Category not in allowed enum | WARNING |
| Duplicate agent names across files | ERROR |
| Contract binding references non-existent contract | WARNING |

---

## Contract Context Injection

When an agent's frontmatter includes a `contracts` field, the registry injects active contract rules into the agent's content at retrieval time. This ensures agents always work with current rules without manual synchronization.

### Injection Protocol

```
AgentRegistry.get(name):
  1. Load agent file, parse frontmatter
  2. If agent.contracts is non-empty:
     a. For each contract ID in agent.contracts:
        i.  Load contract via ContractLoader (DDD-001)
        ii. Extract: rule IDs, descriptions, patterns, severity, scope
     b. Build "Active Contract Context" markdown section
     c. Append to agent content (after the prompt body, before any closing notes)
  3. Return agent with injected context
```

### Injection Format

The injected section is appended as markdown so it's readable by both humans and LLMs:

```markdown
---

## Active Contract Context

Your output must comply with the following active contracts.

### <contract_id>
| Rule | Description | Severity | Scope |
|------|-------------|----------|-------|
| SEC-001 | No hardcoded secrets | error | src/**/*.{ts,tsx,js,jsx} |
| SEC-002 | No SQL injection | error | src/**/*.{ts,tsx,js,jsx} |
```

### When to Use Contract Bindings

| Agent Role | Contract Bindings | Reason |
|------------|------------------|--------|
| contract-generator | Full schema + extensions | Needs to know all valid fields and patterns |
| heal-loop | security_defaults, auto_fix extensions | Needs to know what to fix and how |
| specflow-writer | feature_specflow_project | Needs to know project structure rules |
| code agents (general) | security_defaults | All generated code must pass security contracts |

### Schema and Extension Injection

For agents that need schema knowledge (contract-generator, heal-loop), the injection goes beyond rule lists to include:

- **Field reference:** all YAML contract fields with types and descriptions
- **Pattern syntax:** supported regex features, escape rules, common patterns
- **Extension fields:** `severity`, `auto_fix`, `soft`, custom metadata
- **Scope syntax:** glob pattern syntax for file targeting

This is sourced from the same data that powers the `specflow_get_schema` MCP tool, ensuring consistency.

---

## Agent Knowledge Embedding

Agents serve as carriers of domain knowledge, not just task prompts. This is a deliberate design decision (see [ADR-006](../adrs/ADR-006-knowledge-as-components.md)): knowledge that was previously stored in static documentation is embedded directly in the agents that use it.

### Knowledge Types

| Type | Description | Example |
|------|-------------|---------|
| **Procedural** | Step-by-step processes and protocols | TeammateTool protocol in waves-controller |
| **Structural** | System models and state machines | Issue state machine in sprint-executor |
| **Reference** | Schemas, field definitions, syntax | Contract schema in contract-generator |
| **Strategic** | Decision frameworks and heuristics | Adoption strategy in adoption-advisor |

### Embedding Locations

Knowledge is embedded in two places within an agent file:

1. **Frontmatter fields** — structured data used by the registry:
   - `contracts`: contract IDs for rule injection
   - `aliases`: team names and alternative identifiers (replaces team-names.md)
   - `inputs`/`outputs`: what the agent needs and produces

2. **Prompt body** — unstructured knowledge used by the LLM:
   - Protocols and procedures (how to coordinate, what steps to follow)
   - State machines and transitions (valid states, who can transition)
   - Decision trees (when to escalate, when to retry, when to fail)

### Agent Enrichment Map

| Agent | Embedded Knowledge | Source |
|-------|-------------------|--------|
| waves-controller | TeammateTool protocol, issue state machine, team coordination | PROTOCOL.md, WORKFLOW.md, team-names.md |
| sprint-executor | Execution sequence, failure handling, progress reporting | WORKFLOW.md |
| contract-generator | Full YAML schema, extension fields, pattern syntax | CONTRACT-SCHEMA.md, CONTRACT-SCHEMA-EXTENSIONS.md |
| heal-loop | auto_fix protocol, severity handling, remediation strategy | CONTRACT-SCHEMA-EXTENSIONS.md |
| adoption-advisor | Phased rollout, team onboarding, escape hatches | MID-PROJECT-ADOPTION.md |
| specflow-writer | Spec format rules, journey structure | SPEC-FORMAT.md |
| journey-tester | Journey contract structure, CSV compilation | USER-JOURNEY-CONTRACTS.md |

### Freshness Guarantee

Unlike static docs, embedded knowledge stays current because:

- Agent tests verify frontmatter validity (`specflow doctor`)
- Contract injection pulls from the live contract engine, not cached copies
- Agent prompts are versioned in git alongside the code they reference
- Breaking changes to the contract engine or CLI will cause agent tests to fail

---

## Testing Strategy

### Unit Tests

- Parse frontmatter from sample agent files
- Registry builds correct index
- Search returns ranked results
- Contract context injection appends correct content
- Graceful handling of files without frontmatter

### Integration Tests

- `specflow agent list` produces correct output
- `specflow agent show <name>` returns full content
- `specflow agent search <query>` finds relevant agents
- MCP tools return matching data

---

## Agent Graph Integration

With the knowledge graph ([DDD-004](DDD-004-knowledge-graph.md), [ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md)), agents become graph nodes with edges to the contracts they fix and performance metrics tracked over time.

### Agents as Graph Nodes

When `specflow init` indexes agents, each agent becomes a node in the knowledge graph:

```
Agent (graph node)
├── name: string            # From frontmatter
├── category: string        # From frontmatter
├── trigger: string         # From frontmatter
├── fix_count: number       # Total fixes attempted (tracked by graph)
├── success_rate: number    # Fix success ratio (calculated from Fix nodes)
└── last_invoked: timestamp # When this agent last performed a fix
```

Edges connect agents to the contracts they work with:

```
Agent --binds_to--> Contract     # From frontmatter contracts field
Agent --fixed--> Fix             # When agent performs a fix
Agent --specializes_in--> Rule   # Derived from fix history
```

### heal-loop and Skill Library

The heal-loop agent gains access to the skill library before attempting fixes:

```
heal-loop receives a violation
    │
    ▼
1. Query skill library:
   MATCH (s:Skill) WHERE $ruleId IN s.rule_ids AND s.confidence >= 0.7
   RETURN s ORDER BY s.confidence DESC LIMIT 1
    │
    ├── Skill found → apply skill's fix_template
    │
    └── No skill → fall back to heuristic fix (existing behavior)
    │
    ▼
2. Record Fix node:
   - violation_id, method ("skill" or "heuristic"), agent ("heal-loop")
   - code_before, code_after
    │
    ▼
3. Re-enforce to verify fix
    │
    ▼
4. Record outcome (success/failure)
   - Update agent's fix_count and success_rate
   - If skill was used: update skill's uses/successes/failures
```

### Agent Routing via Graph

The graph enables intelligent agent routing — selecting the best agent for a violation based on historical performance:

```cypher
MATCH (a:Agent)-[:FIXED]->(f:Fix)-[:FIXED_BY]-(v:Violation)
WHERE v.rule_id = 'SEC-003' AND f.outcome = 'success'
RETURN a.name, count(f) AS wins, a.success_rate
ORDER BY a.success_rate DESC
```

This allows the system to route violations to the agent most likely to fix them successfully, rather than always defaulting to heal-loop.

### Reflexion Memory

Agent outcomes are recorded for reflexion memory — a cognitive pattern where the agent learns from its own failures:

| Outcome | Graph Action | Effect |
|---------|-------------|--------|
| Fix succeeded | Record success, increment skill confidence | Agent tries this approach again |
| Fix failed | Record failure, decrement skill confidence | Agent avoids this approach next time |
| Fix caused new violation | Record causal link | Agent learns to check for side effects |

The reflexion cycle:

```
1. Agent attempts fix
2. Outcome recorded in graph
3. Next time agent faces similar violation:
   a. Query: "what did I try last time?"
   b. Filter out methods with outcome = "failure"
   c. Prefer methods with outcome = "success"
```

### Agent Performance Dashboard

`specflow agent list --stats` can show agent performance from the graph:

```
Name              Category      Fixes   Success Rate   Last Active
heal-loop         remediation   45      0.82           2h ago
contract-gen      generation    12      0.91           1d ago
code-reviewer     compliance    8       0.75           3d ago
```
