# ADR-007: AgentDB as Knowledge Graph and Learning Memory Layer

**Status:** Proposed
**Date:** 2026-04-04
**Depends on:** ADR-006 (Knowledge as Components), ADR-005 (Agent Registry), ADR-004 (MCP Server Design)

---

## Context

Specflow is stateless today. Every `specflow enforce` run starts from scratch — it loads contracts, scans files, reports violations, and exits. There is no memory of previous runs, no record of which fixes worked, no way to ask "what happened last time SEC-001 was violated?"

A gap analysis during Phase 9 (Knowledge Embedding) showed that while embedding knowledge into agents, skills, and MCP tools solves the *delivery* problem, it doesn't solve the *learning* problem. The system cannot:

- Suggest fixes based on what worked before
- Track which contract changes caused downstream violations
- Remember that an agent tried a fix and it failed
- Show compliance trends over time
- Prove cryptographically that contracts were enforced

This requires a persistent knowledge layer — a graph database with learning capabilities.

### Requirements

1. Store relationships between contracts, rules, files, violations, fixes, and agents
2. Query by graph traversal (e.g., "which files violate rules in this contract?")
3. Learn from enforcement outcomes (which fixes work, which fail)
4. Integrate with the existing MCP server for Claude Code access
5. Zero native dependencies (Specflow must remain easy to install)
6. Single-file storage (portable, no database server)
7. Work offline (no internet required)

---

## Decision

**Use AgentDB (`agentdb@3.0.0-alpha.11`) as the knowledge graph and learning memory layer.** Store the graph in `.specflow/knowledge.rvf` (a single portable file).

### Why AgentDB

AgentDB is an npm package (MIT license, by ruvnet) that provides:

- **Zero native deps** — uses sql.js (WASM SQLite) internally
- **Single .rvf file** — "Cognitive Container" format, portable and git-friendly
- **Cypher graph queries** — familiar graph query language
- **6 cognitive memory patterns** — episodic, semantic, procedural, reflexion, skill, working
- **Self-learning search** — improves retrieval with usage
- **9 reinforcement learning algorithms** — Decision Transformer, Q-Learning, SARSA, Actor-Critic, etc.
- **41 MCP tools** — ready-made integration points
- **GNN attention** — graph neural network for prioritizing scans
- **COW branching** — copy-on-write for safe experimentation
- **Witness chain** — cryptographic audit trail for compliance proof
- **TypeScript** — works in Node.js, browser, and edge runtimes
- **5.2MB unpacked** — minimal footprint

---

## Feature Mappings

Each AgentDB capability maps to a specific Specflow use case:

| # | AgentDB Feature | Specflow Use Case |
|---|----------------|-------------------|
| 1 | Self-learning search | "Last 5 times SEC-001 was violated, what fix worked?" → suggest best fix |
| 2 | Reflexion memory | Agent tried a fix, it failed → remember not to try that again |
| 3 | Skill library | heal-loop discovers "for innerHTML, wrap in DOMPurify" → stores as reusable skill |
| 4 | Causal graph | "Relaxing SEC-003 scope caused 4 XSS violations" → tracks cause/effect |
| 5 | Episodic memory | Full history of every enforce run, violation, fix attempt per project |
| 6 | Vector search | Find contracts similar to a new rule, find code patterns similar to violations |
| 7 | MCP integration | Claude asks "what worked before?" and gets an answer from memory |
| 8 | Nightly learner | Background consolidation of fix patterns, pruning, causal discovery |
| 9 | GNN attention | Focus on likely violations first when scanning large codebases |
| 10 | Cypher queries | `MATCH (c:Contract)-[:HAS_RULE]->(r:Rule)-[:VIOLATED_IN]->(f:File) RETURN f` |
| 11 | COW branching | Try contract changes in a branch, see what breaks, before committing |
| 12 | Witness chain | Cryptographic proof contracts were enforced — auditable compliance |

---

## Graph Model

### Node Types

| Node | Properties | Description |
|------|-----------|-------------|
| Contract | id, version, status, path | A YAML contract file |
| Rule | id, description, severity, scope | A single enforceable constraint |
| Pattern | regex, type (forbidden/required), message | A compiled pattern within a rule |
| File | path, hash, last_scanned | A source file in the project |
| Agent | name, category, trigger | An agent prompt template |
| Journey | id, csv_path, test_path | A user journey definition |
| Issue | number, title, journey_ids | A GitHub issue |
| Violation | rule_id, file, line, match, timestamp | A detected violation |
| Fix | violation_id, method, outcome, agent | A fix attempt |
| Skill | pattern, fix_template, confidence, uses | A learned reusable fix |

### Edge Types

| Edge | From → To | Properties | Description |
|------|-----------|-----------|-------------|
| has_rule | Contract → Rule | position | Contract contains this rule |
| scopes_to | Rule → File | glob | Rule applies to this file |
| violated_in | Rule → File | count, last_seen | Rule was violated in this file |
| fixed_by | Violation → Fix | timestamp | Violation was fixed by this attempt |
| tested_by | Journey → File | test_type | Journey is verified by this test file |
| maps_to | Issue → Journey | | Issue maps to this journey |
| caused_by | Violation → Violation | intervention | One violation caused another |
| deferred | Rule → File | reason, issue, expires | Rule is temporarily deferred for this file |

---

## Lifecycle Integration

### `specflow init`

Creates `.specflow/knowledge.rvf` if it doesn't exist. Indexes all contracts and agents as graph nodes:

```
1. Create .rvf file with AgentDB
2. For each contract in .specflow/contracts/:
   a. Create Contract node
   b. For each rule: create Rule node + has_rule edge
   c. For each scope glob: resolve files, create File nodes + scopes_to edges
3. For each agent in agents/:
   a. Create Agent node
   b. For each contract binding: create edges to Contract nodes
```

### `specflow enforce`

Scans files, records violations, queries history for fix suggestions:

```
1. Load contracts (existing behavior)
2. Scan files (existing behavior)
3. NEW: For each violation found:
   a. Create Violation node
   b. Create violated_in edge (Rule → File)
   c. Query skill library: "any known fix for this pattern?"
   d. If skill found: include suggested fix in output
4. NEW: Record scan metadata (timestamp, file count, violation count)
```

### `specflow status`

Queries graph for aggregate compliance:

```
1. MATCH (v:Violation) WHERE v.timestamp > $since RETURN count(v)
2. MATCH (r:Rule)-[:VIOLATED_IN]->(f:File) RETURN r.id, count(f) ORDER BY count(f) DESC
3. Compare current violations to baseline for trend
```

### Hooks

Record violations in real-time, query for fix patterns:

```
check-compliance.ts:
  1. Scan file against contracts (existing)
  2. NEW: Record violations in graph
  3. NEW: Query graph for suggested fix
  4. Include suggestion in error output to Claude
```

### MCP Tools

Expose graph queries to Claude Code:

- `specflow_query_graph` — execute Cypher queries against the knowledge graph
- `specflow_get_fix_suggestion` — query skill library for a specific violation pattern
- `specflow_get_impact` — show what would be affected by a contract change

### heal-loop Agent

Queries skill library for known fixes, records outcomes:

```
1. Receive violation from enforce output
2. Query skill library: MATCH (s:Skill) WHERE s.pattern = $violation_pattern RETURN s
3. If skill found with confidence > threshold: apply fix
4. If no skill: attempt heuristic fix
5. Record Fix node with outcome (success/failure)
6. If success count for this pattern >= N: promote to Skill node
```

### Nightly Consolidation

Background job for pattern discovery and maintenance:

```
1. Discover patterns: group similar violations, extract common fixes
2. Update skill confidence: recalculate based on recent success/failure ratio
3. Prune stale data: remove violations older than retention period
4. Causal discovery: correlate contract changes with violation spikes
5. Update GNN attention weights: prioritize rules/files with frequent violations
```

---

## Storage

- **File:** `.specflow/knowledge.rvf`
- **Format:** AgentDB Cognitive Container (WASM SQLite-backed)
- **Size:** Starts small (~100KB), grows with usage
- **Portability:** Single file, copy to share, git-trackable (binary)
- **Gitignore:** Recommended to add to `.gitignore` (project-specific data), but optional

---

## Alternatives Considered

### 1. Raw sql.js (WASM SQLite)

**Rejected.** Provides the storage layer but not the graph abstraction, learning algorithms, or MCP integration. We'd be reimplementing most of what AgentDB already provides.

### 2. Custom Graph Implementation

**Rejected.** Building a graph database from scratch — even a simple one — is a significant engineering effort. Node/edge storage, query language, indexing, traversal optimization... this is reinventing the wheel when a mature option exists.

### 3. No Graph (Status Quo — Stateless)

**Rejected.** The stateless approach means every enforce run starts fresh. No learning, no fix suggestions, no trend tracking, no impact analysis. This was acceptable for v0.x but blocks the knowledge embedding goals of Phase 9.

### 4. Neo4j / ArangoDB / External Graph DB

**Rejected.** Requires a running database server, adds infrastructure complexity, breaks the "zero dependencies beyond Node.js" principle. Specflow must remain easy to install with `npm install -g`.

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Alpha stability (agentdb@3.0.0-alpha) | MEDIUM | sql.js backend is stable and production-proven; AgentDB's alpha status is about API surface, not data integrity |
| 5.2MB size increase | LOW | Acceptable for the functionality gained; smaller than many common dev dependencies |
| Dependency on ruvnet ecosystem | MEDIUM | MIT license allows forking; sql.js backend is independent; .rvf format is documented |
| .rvf file corruption | LOW | sql.js has WAL journaling; COW branching provides additional safety |
| Performance on large projects | LOW | SQLite handles millions of rows; graph queries are indexed; GNN attention reduces scan scope |

---

## Consequences

### Positive

- **Learning enforcement:** The system gets smarter over time — suggesting fixes that worked before, avoiding fixes that failed
- **Fix suggestions:** `specflow enforce` output includes actionable "suggested fix" from the skill library
- **Impact analysis:** `specflow impact <change>` shows which files, tests, and agents would be affected
- **Compliance audit trail:** Witness chain provides cryptographic proof that contracts were enforced — useful for regulated environments
- **Trend tracking:** `specflow status --history` shows violations over time, identifies improving or degrading areas
- **Causal analysis:** Track which contract changes caused downstream effects
- **Agent memory:** heal-loop and other agents remember what they tried, avoiding repeated failures

### Negative

- **New dependency:** agentdb is added to package.json — increases install footprint by ~5.2MB
- **Alpha status:** API may change before 3.0.0 stable — may require migration work
- **Complexity increase:** The system now has persistent state to manage (init, migrate, prune)
- **Binary storage:** .rvf files are binary, not human-readable (unlike YAML contracts)

---

## Related Documents

- [ADR-006: Knowledge as Components](ADR-006-knowledge-as-components.md) — the delivery layer that AgentDB powers
- [DDD-004: Knowledge Graph Domain Design](../ddds/DDD-004-knowledge-graph.md) — domain model for the graph
- [PRD-006: Knowledge Graph Integration](../prds/PRD-006-knowledge-graph.md) — feature specifications
- [MASTER-PLAN Phase 10](../plan/MASTER-PLAN.md) — execution plan
