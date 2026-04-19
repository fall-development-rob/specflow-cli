---
id: PRD-006
title: Knowledge Graph Integration
type: PRD
status: Accepted
version: 1
date: '2026-04-04'
last_reviewed: '2026-04-17'
---

# PRD-006: Knowledge Graph Integration

**Phase:** 10

---

## Overview

Integrate a persistent knowledge graph (via sql.js / WASM SQLite) into Specflow's enforcement pipeline. This makes enforcement stateful and learning: violations are recorded, fixes are tracked, patterns are extracted as reusable skills, and the system suggests fixes based on history. See [ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md) for the architectural decision (amended: sql.js instead of AgentDB) and [DDD-004](../ddds/DDD-004-knowledge-graph.md) for the domain model.

---

## Goals

1. **Make enforcement stateful** — violations, fixes, and outcomes are recorded persistently
2. **Enable learning from violations** — the system improves its suggestions over time
3. **Provide fix suggestions** — `specflow enforce` output includes actionable suggestions from the skill library
4. **Enable impact analysis** — predict which files, tests, and agents are affected by contract changes

## Non-Goals

1. **Replace YAML as source of truth** — contracts are authored and stored as YAML; the graph is derived
2. **Require internet** — all graph operations are local and offline
3. **Change existing CLI UX** — existing commands behave the same; new features are additive
4. **Replace the contract engine** — the Rust/NAPI-RS scanner remains the enforcement engine; the graph adds memory on top

---

## Dependency

Add `sql.js` to `package.json` dependencies. sql.js is a WASM build of SQLite — zero native dependencies, works everywhere Node.js runs. Adds ~2MB to the installed package.

> **Note:** AgentDB (`agentdb@3.0.0-alpha.11`) was evaluated but its core APIs are broken in alpha (see [ADR-007 Amendment](../adrs/ADR-007-agentdb-knowledge-graph.md#amendment-2026-04-04)). sql.js is what AgentDB uses internally. When AgentDB reaches a stable release, it becomes a migration target.

---

## Feature Specifications

### Feature A: Graph Initialization

**Command:** `specflow init` (enhanced)

When `specflow init` runs, in addition to existing behavior:

1. Create `.specflow/knowledge.db` if it doesn't exist (sql.js creates SQLite database)
2. Run CREATE TABLE and CREATE INDEX statements (nodes, edges, indexes)
3. Index all contracts from `.specflow/contracts/` as Contract + Rule + Pattern nodes (INSERT statements)
4. Index all agents from `agents/` as Agent nodes (INSERT statements)
5. Resolve all scope globs to File nodes with scopes_to edges
6. If `.db` already exists, sync: add new nodes, update changed ones, deprecate removed ones

**Acceptance Criteria:**

- [ ] `specflow init .` creates `.specflow/knowledge.db`
- [ ] Running init twice is idempotent (no duplicate nodes — uses INSERT OR REPLACE)
- [ ] All contracts and agents appear as graph nodes
- [ ] Scope globs are resolved to File nodes
- [ ] `.specflow/knowledge.db` is added to `.gitignore` template

### Feature B: Violation Recording

**Command:** `specflow enforce` (enhanced)

After the contract scanner produces violations:

1. Start a new Episode record (INSERT INTO nodes with type='episode')
2. For each violation: INSERT Violation node + violated_in edge
3. Deduplicate: if same rule + file + line already exists, UPDATE `last_seen` and increment count
4. End episode with summary metadata (UPDATE episode node properties)

**Acceptance Criteria:**

- [ ] Each `specflow enforce` run creates an Episode record
- [ ] Violations are recorded as graph nodes
- [ ] Duplicate violations are deduplicated (count incremented, not duplicated)
- [ ] `specflow enforce` performance is not degraded by more than 10% with graph recording
- [ ] Violations can be queried after the run completes

### Feature C: Fix Tracking

**Trigger:** heal-loop agent (or manual fix followed by re-enforce)

When a fix is attempted:

1. INSERT Fix node linked to the Violation (INSERT INTO nodes + INSERT INTO edges with relation='fixed_by')
2. Record method (skill, heuristic, manual, auto_fix), agent, code before/after in properties JSON
3. After re-enforce: UPDATE outcome (success if violation is gone, failure if still present)
4. UPDATE agent node's success_rate metric

**Acceptance Criteria:**

- [ ] Fix attempts are recorded with method and agent
- [ ] Re-enforce after fix updates the outcome field
- [ ] Agent success rates are calculated correctly
- [ ] Fix history is queryable per rule

### Feature D: Skill Discovery

**Trigger:** Nightly consolidation or manual `specflow learn`

After N successful fixes of the same pattern (default N=3):

1. Aggregate query: group fixes by rule + pattern (no ML — frequency-based pattern extraction via SQL GROUP BY)
2. Extract common fix template
3. Calculate confidence = successes / total attempts
4. If confidence >= 0.7: INSERT or UPDATE Skill node
5. Low-confidence skills (< 0.3) are pruned (DELETE FROM nodes WHERE type='skill' AND confidence < 0.3)

**Acceptance Criteria:**

- [ ] Skills are automatically discovered after 3+ successful fixes of the same pattern
- [ ] Skill confidence is calculated correctly
- [ ] Skills below 0.3 confidence are pruned
- [ ] `specflow skills list` shows discovered skills

### Feature E: Fix Suggestions

**Command:** `specflow enforce` output (enhanced)

When violations are found:

1. For each violation, SELECT from skill nodes with confidence ordering (no self-learning search — just SQL ranking)
2. If a skill with confidence >= 0.7 exists, include it in the output:
   ```
   SEC-003 violation in src/auth.ts:42 — innerHTML usage
     Suggested fix (confidence: 0.85): wrap in DOMPurify.sanitize()
   ```
3. In `--json` mode, include `suggested_fix` field in violation objects

**Acceptance Criteria:**

- [ ] Violations with matching skills show suggested fixes
- [ ] Suggestions include confidence score
- [ ] `--json` mode includes `suggested_fix` field
- [ ] Violations without matching skills show no suggestion (no noise)

### Feature F: Impact Analysis

**Command:** `specflow impact <contract-change>`

New command that predicts the impact of a contract change:

```bash
specflow impact security_defaults --expand-scope SEC-003
```

Output:
```
Impact analysis for: expand SEC-003 scope

Files newly in scope:      12
  src/utils/dom.ts
  src/legacy/render.js
  ...

Predicted new violations:  ~4 (based on historical patterns)
Tests affected:            2 journey tests
Agents affected:           heal-loop, code-reviewer

Historical note: Last scope expansion for SEC-003 (2026-03-15)
  caused 6 new violations, resolved in 2 days.
```

**Acceptance Criteria:**

- [ ] `specflow impact` shows files newly in scope
- [ ] Predicted violation count is based on historical data
- [ ] Affected tests and agents are listed
- [ ] Historical context is shown if available

### Feature G: Compliance Trending

**Command:** `specflow status --history`

Show violations over time:

```bash
specflow status --history --since 30d
```

Output:
```
Compliance trend (last 30 days):

  Violations  ▁▂▃▅▇▅▃▂▁▁  (peak: 15 on Mar 20, current: 2)

  Most improved:  SEC-001 (12 → 0)
  Most violated:  SEC-003 (8 total violations across 4 files)
  New skills:     2 (innerHTML → DOMPurify, eval → Function)
```

**Acceptance Criteria:**

- [ ] `specflow status --history` shows violation trend
- [ ] `--since` parameter filters by time range
- [ ] Most improved and most violated rules are identified
- [ ] New skills discovered in the period are listed

### Feature H: MCP Graph Tools

Three new MCP tools for Claude Code integration:

#### H1. `specflow_query_graph`

| Field | Value |
|-------|-------|
| Tool name | `specflow_query_graph` |
| Description | Execute a SQL query against the Specflow knowledge graph |
| Inputs | `query` (string): SQL query; `params` (array, optional): query parameters |
| Output | Query results as JSON |

#### H2. `specflow_get_fix_suggestion`

| Field | Value |
|-------|-------|
| Tool name | `specflow_get_fix_suggestion` |
| Description | Get a suggested fix for a contract violation |
| Inputs | `rule_id` (string): the violated rule; `file` (string, optional): the file with the violation; `match` (string, optional): the matched text |
| Output | Suggested fix with confidence score, or "no suggestion available" |

#### H3. `specflow_get_impact`

| Field | Value |
|-------|-------|
| Tool name | `specflow_get_impact` |
| Description | Predict the impact of a contract change |
| Inputs | `contract_id` (string): contract to analyze; `change_type` (string): "add_rule", "remove_rule", "expand_scope", "narrow_scope"; `details` (object): change-specific parameters |
| Output | Impact report with affected files, predicted violations, affected tests/agents |

**Acceptance Criteria:**

- [ ] All three tools appear in `specflow mcp tools` output
- [ ] `specflow_query_graph` executes SQL and returns results
- [ ] `specflow_get_fix_suggestion` returns skills or "no suggestion"
- [ ] `specflow_get_impact` returns impact analysis
- [ ] Tools handle malformed input gracefully (no crashes)

### Feature I: Nightly Consolidation

**Trigger:** `specflow learn` (manual) or cron job

Background job that consolidates learning:

1. **Pattern discovery:** Aggregate SQL query grouping similar violations, extract common fixes → new Skills
2. **Confidence update:** Recalculate skill confidence from recent outcomes (UPDATE skill confidence)
3. **Pruning:** DELETE violations older than retention period (default 90 days), DELETE low-confidence skills
4. **Causal discovery:** Correlate contract changes with violation spikes → INSERT causal edges
5. **Database maintenance:** VACUUM to reclaim space

> **Note:** Self-learning search, GNN attention, and RL features are deferred to a future AgentDB migration. Phase 10 implements the structured graph with SQL. Learning features will be added when a stable graph/learning library is available.

**Acceptance Criteria:**

- [ ] `specflow learn` runs consolidation and reports results
- [ ] New skills are discovered from fix patterns (frequency-based, not ML)
- [ ] Old violations are pruned (configurable retention)
- [ ] Causal correlations are detected and recorded
- [ ] Consolidation completes in < 30 seconds for projects with < 10,000 violation records

---

## Implementation Priority

| Priority | Feature | Rationale |
|----------|---------|-----------|
| P0 | A (Graph Init) | Foundation — everything else depends on nodes existing |
| P0 | B (Violation Recording) | Core value — makes enforce stateful |
| P1 | C (Fix Tracking) | Enables learning — must come before skill discovery |
| P1 | E (Fix Suggestions) | Primary UX improvement — users see value immediately |
| P1 | H (MCP Tools) | Claude Code integration — primary interaction point |
| P2 | D (Skill Discovery) | Automated learning — builds on fix tracking |
| P2 | G (Compliance Trending) | Visibility — useful but not blocking |
| P2 | I (Nightly Consolidation) | Maintenance — needed as data grows |
| P3 | F (Impact Analysis) | Advanced — requires significant history to be useful |

---

## Related Documents

- [ADR-007: Knowledge Graph (Amended)](../adrs/ADR-007-agentdb-knowledge-graph.md)
- [DDD-004: Knowledge Graph Domain Design](../ddds/DDD-004-knowledge-graph.md)
- [PRD-005: Knowledge Embedding](PRD-005-knowledge-embedding.md)
- [ADR-006: Knowledge as Components](../adrs/ADR-006-knowledge-as-components.md)
- [MASTER-PLAN Phase 10](../plan/MASTER-PLAN.md)
