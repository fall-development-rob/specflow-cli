# PRD-006: Knowledge Graph Integration

**Status:** Proposed
**Date:** 2026-04-04
**Phase:** 10
**Depends on:** Phase 8 (Simulation Fixes), Phase 9 (Knowledge Embedding), Phase 5 (Agent System), Phase 3 (MCP Server)

---

## Overview

Integrate AgentDB as a persistent knowledge graph into Specflow's enforcement pipeline. This makes enforcement stateful and learning: violations are recorded, fixes are tracked, patterns are extracted as reusable skills, and the system suggests fixes based on history. See [ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md) for the architectural decision and [DDD-004](../ddds/DDD-004-knowledge-graph.md) for the domain model.

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

Add `agentdb@^3.0.0-alpha.11` to `package.json` dependencies. This adds ~5.2MB to the installed package and zero native dependencies.

---

## Feature Specifications

### Feature A: Graph Initialization

**Command:** `specflow init` (enhanced)

When `specflow init` runs, in addition to existing behavior:

1. Create `.specflow/knowledge.rvf` if it doesn't exist
2. Index all contracts from `.specflow/contracts/` as Contract + Rule + Pattern nodes
3. Index all agents from `agents/` as Agent nodes
4. Resolve all scope globs to File nodes with scopes_to edges
5. If `.rvf` already exists, sync: add new nodes, update changed ones, deprecate removed ones

**Acceptance Criteria:**

- [ ] `specflow init .` creates `.specflow/knowledge.rvf`
- [ ] Running init twice is idempotent (no duplicate nodes)
- [ ] All contracts and agents appear as graph nodes
- [ ] Scope globs are resolved to File nodes
- [ ] `.specflow/knowledge.rvf` is added to `.gitignore` template

### Feature B: Violation Recording

**Command:** `specflow enforce` (enhanced)

After the contract scanner produces violations:

1. Start a new Episode record
2. For each violation: create or update Violation node + violated_in edge
3. Deduplicate: if same rule + file + line already exists, update `last_seen` and increment count
4. End episode with summary metadata (timestamp, file count, violation count, duration)

**Acceptance Criteria:**

- [ ] Each `specflow enforce` run creates an Episode record
- [ ] Violations are recorded as graph nodes
- [ ] Duplicate violations are deduplicated (count incremented, not duplicated)
- [ ] `specflow enforce` performance is not degraded by more than 10% with graph recording
- [ ] Violations can be queried after the run completes

### Feature C: Fix Tracking

**Trigger:** heal-loop agent (or manual fix followed by re-enforce)

When a fix is attempted:

1. Create Fix node linked to the Violation
2. Record method (skill, heuristic, manual, auto_fix), agent, code before/after
3. After re-enforce: record outcome (success if violation is gone, failure if still present)
4. Update agent's success_rate metric

**Acceptance Criteria:**

- [ ] Fix attempts are recorded with method and agent
- [ ] Re-enforce after fix updates the outcome field
- [ ] Agent success rates are calculated correctly
- [ ] Fix history is queryable per rule

### Feature D: Skill Discovery

**Trigger:** Nightly consolidation or manual `specflow learn`

After N successful fixes of the same pattern (default N=3):

1. Group fixes by rule + pattern similarity
2. Extract common fix template
3. Calculate confidence = successes / total attempts
4. If confidence >= 0.7: promote to Skill node
5. Low-confidence skills (< 0.3) are pruned

**Acceptance Criteria:**

- [ ] Skills are automatically discovered after 3+ successful fixes of the same pattern
- [ ] Skill confidence is calculated correctly
- [ ] Skills below 0.3 confidence are pruned
- [ ] `specflow skills list` shows discovered skills

### Feature E: Fix Suggestions

**Command:** `specflow enforce` output (enhanced)

When violations are found:

1. For each violation, query the skill library for matching skills
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
| Description | Execute a Cypher query against the Specflow knowledge graph |
| Inputs | `query` (string): Cypher query; `params` (object, optional): query parameters |
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
- [ ] `specflow_query_graph` executes Cypher and returns results
- [ ] `specflow_get_fix_suggestion` returns skills or "no suggestion"
- [ ] `specflow_get_impact` returns impact analysis
- [ ] Tools handle malformed input gracefully (no crashes)

### Feature I: Nightly Consolidation

**Trigger:** `specflow learn` (manual) or cron job

Background job that consolidates learning:

1. **Pattern discovery:** Group similar violations, extract common fixes → new Skills
2. **Confidence update:** Recalculate skill confidence from recent outcomes
3. **Pruning:** Remove violations older than retention period (default 90 days), prune low-confidence skills
4. **Causal discovery:** Correlate contract changes with violation spikes → Causal Links
5. **GNN attention update:** Recalculate attention weights to prioritize likely violation areas

**Acceptance Criteria:**

- [ ] `specflow learn` runs consolidation and reports results
- [ ] New skills are discovered from fix patterns
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

- [ADR-007: AgentDB as Knowledge Graph](../adrs/ADR-007-agentdb-knowledge-graph.md)
- [DDD-004: Knowledge Graph Domain Design](../ddds/DDD-004-knowledge-graph.md)
- [PRD-005: Knowledge Embedding](PRD-005-knowledge-embedding.md)
- [ADR-006: Knowledge as Components](../adrs/ADR-006-knowledge-as-components.md)
- [MASTER-PLAN Phase 10](../plan/MASTER-PLAN.md)
