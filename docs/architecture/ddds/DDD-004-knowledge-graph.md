---
id: DDD-004
title: Knowledge Graph Domain Design
type: DDD
status: Accepted
version: 1
date: '2026-04-04'
last_reviewed: '2026-04-17'
implements:
  - DDD-001
  - DDD-002
  - DDD-003
---

# DDD-004: Knowledge Graph Domain Design

**Status:** Proposed
**Date:** 2026-04-04
**Depends on:** DDD-001 (Contract Engine), DDD-002 (Enforcement Pipeline), DDD-003 (Agent Registry)

---

## Domain Overview

The knowledge graph is Specflow's persistent memory layer. It stores the relationships between contracts, rules, files, violations, fixes, and agents as a graph, enabling the system to learn from enforcement outcomes and suggest fixes based on history. Powered by sql.js (WASM SQLite), stored in `.specflow/knowledge.db`. See [ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md) for the architectural decision and amendment.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Node** | A vertex in the knowledge graph representing a domain entity (Contract, Rule, File, Violation, etc.). |
| **Edge** | A directed relationship between two nodes (has_rule, violated_in, fixed_by, etc.). |
| **Memory** | A cognitive memory pattern stored in the knowledge graph — episodic, semantic, procedural, or skill-based. |
| **Skill** | A learned, reusable fix pattern extracted from repeated successful fixes. Has a confidence score. |
| **Episode** | A complete record of one enforcement run — violations found, fixes attempted, outcomes. |
| **Violation Record** | A node recording a specific violation: which rule, which file, which line, when detected. |
| **Fix Record** | A node recording a fix attempt: which violation, what method, what agent, success or failure. |
| **Causal Link** | An edge tracking that one event caused another (e.g., relaxing a rule scope caused new violations). |
| **Knowledge Database** | The `.specflow/knowledge.db` SQLite file that stores the entire graph. |

---

## Node Types

### Contract

```
Contract
├── id: string              # e.g., "security_defaults"
├── version: string         # e.g., "1.0.0"
├── status: string          # "active" | "draft" | "deprecated"
├── path: string            # e.g., ".specflow/contracts/security_defaults.yml"
├── rule_count: number      # Number of rules in this contract
└── last_indexed: timestamp # When this contract was last synced to the graph
```

### Rule

```
Rule
├── id: string              # e.g., "SEC-001"
├── contract_id: string     # Parent contract
├── description: string     # Human-readable description
├── severity: string        # "error" | "warning" | "info"
├── scope: string[]         # Glob patterns for target files
├── pattern_count: number   # Number of forbidden + required patterns
├── violation_count: number # Total violations ever recorded
└── last_violated: timestamp
```

### Pattern

```
Pattern
├── regex: string           # The regex string (e.g., "/innerHTML/g")
├── type: string            # "forbidden" | "required"
├── message: string         # Violation message
├── rule_id: string         # Parent rule
└── match_count: number     # Times this pattern matched
```

### File

```
File
├── path: string            # Relative path from project root
├── hash: string            # Content hash for change detection
├── last_scanned: timestamp # When this file was last scanned
├── violation_count: number # Current active violations
└── language: string        # Detected language (ts, js, html, etc.)
```

### Agent

```
Agent
├── name: string            # e.g., "heal-loop"
├── category: string        # e.g., "remediation"
├── trigger: string         # When to invoke
├── fix_count: number       # Total fixes attempted
├── success_rate: number    # Fix success ratio (0.0 - 1.0)
└── last_invoked: timestamp
```

### Journey

```
Journey
├── id: string              # e.g., "J-LOGIN-FLOW"
├── csv_path: string        # Source CSV file
├── test_path: string       # Compiled test file
├── step_count: number      # Number of steps
└── last_passed: timestamp  # Last time all tests passed
```

### Issue

```
Issue
├── number: number          # GitHub issue number
├── title: string           # Issue title
├── journey_ids: string[]   # Associated journey IDs
├── status: string          # "open" | "closed"
└── last_synced: timestamp
```

### Violation

```
Violation
├── id: string              # Unique violation ID (auto-generated)
├── rule_id: string         # Which rule was violated
├── file: string            # Which file
├── line: number            # Line number
├── match: string           # Matched text
├── message: string         # Violation message
├── timestamp: timestamp    # When detected
├── status: string          # "active" | "fixed" | "deferred"
└── episode_id: string      # Which enforcement run detected this
```

### Fix

```
Fix
├── id: string              # Unique fix ID (auto-generated)
├── violation_id: string    # Which violation this fixes
├── method: string          # "skill" | "heuristic" | "manual" | "auto_fix"
├── agent: string           # Which agent performed the fix (if any)
├── code_before: string     # Code before fix (snippet)
├── code_after: string      # Code after fix (snippet)
├── outcome: string         # "success" | "failure" | "partial"
├── timestamp: timestamp
└── re_enforce_passed: boolean  # Did enforce pass after this fix?
```

### Skill

```
Skill
├── id: string              # Unique skill ID
├── pattern: string         # The violation pattern this fixes (regex or description)
├── rule_ids: string[]      # Rules this skill applies to
├── fix_template: string    # Template for the fix (code pattern or instruction)
├── confidence: number      # 0.0 - 1.0, based on success rate
├── uses: number            # Times this skill has been applied
├── successes: number       # Times the fix worked
├── failures: number        # Times the fix failed
├── discovered: timestamp   # When this skill was first extracted
└── last_used: timestamp
```

---

## Edge Types

### has_rule

```
Contract --has_rule--> Rule
├── position: number        # Order within the contract
```

### scopes_to

```
Rule --scopes_to--> File
├── glob: string            # The glob pattern that matched
├── resolved: timestamp     # When this scope was last resolved
```

### violated_in

```
Rule --violated_in--> File
├── count: number           # Number of violations of this rule in this file
├── first_seen: timestamp
├── last_seen: timestamp
```

### fixed_by

```
Violation --fixed_by--> Fix
├── timestamp: timestamp
```

### tested_by

```
Journey --tested_by--> File
├── test_type: string       # "playwright" | "jest" | "manual"
```

### maps_to

```
Issue --maps_to--> Journey
```

### caused_by

```
Violation --caused_by--> Violation
├── intervention: string    # What change caused the cascade (e.g., "relaxed SEC-003 scope")
├── confidence: number      # Causal confidence (0.0 - 1.0)
```

### deferred

```
Rule --deferred--> File
├── reason: string          # Why the deferral was granted
├── issue: number           # Tracking issue
├── expires: timestamp      # When the deferral expires
├── granted_by: string      # Who granted it
```

---

## SQL Schema

The knowledge graph is stored in `.specflow/knowledge.db` using two core tables:

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relation TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_edges_source ON edges(source);
CREATE INDEX idx_edges_target ON edges(target);
CREATE INDEX idx_edges_relation ON edges(relation);
CREATE INDEX idx_nodes_type ON nodes(type);
```

Node and edge properties are stored as JSON in the `properties` column, accessed via `json_extract()` in queries. This schema is implementation-agnostic — it can be migrated to AgentDB or another graph backend without changing the data model.

---

## Domain Services

### GraphBuilder

**Responsibility:** Materialize YAML contracts and agent files into graph nodes and edges.

```
GraphBuilder
  .initialize(dbPath) → Database        # Create or open .specflow/knowledge.db, run DDL
  .indexContracts(contractDir) → void   # Sync contracts to graph nodes (INSERT INTO nodes/edges)
  .indexAgents(agentsDir) → void        # Sync agents to graph nodes (INSERT INTO nodes)
  .resolveScopes(contracts) → void      # Resolve scope globs → File nodes + scopes_to edges
  .sync() → SyncReport                  # Full re-index, report additions/removals/changes
```

**Invariants:**
- Contract and Rule nodes are always in sync with the YAML source files
- Stale nodes (contracts/rules that no longer exist in YAML) are marked deprecated, not deleted
- File nodes are created lazily during scope resolution, not eagerly for the entire project

### ViolationRecorder

**Responsibility:** Record enforcement results as Violation nodes and violated_in edges.

```
ViolationRecorder
  .startEpisode() → Episode             # INSERT INTO nodes (type='episode')
  .recordViolation(violation) → Node    # INSERT INTO nodes (type='violation') + INSERT INTO edges (relation='violated_in')
  .endEpisode(summary) → void          # UPDATE nodes SET properties=... WHERE id=episode_id
  .getActiveViolations(file?) → Violation[]  # SELECT from nodes WHERE type='violation'
```

**Algorithm:**
```
For each violation from ContractScanner:
  1. Check if identical violation already exists (same rule, file, line)
     - If yes: update last_seen timestamp, increment count
     - If no: create new Violation node
  2. Create/update violated_in edge (Rule → File)
  3. Link to current Episode
```

### FixTracker

**Responsibility:** Record fix attempts and their outcomes.

```
FixTracker
  .recordFix(violation, method, agent, codeBefore, codeAfter) → Fix
      # INSERT INTO nodes (type='fix') + INSERT INTO edges (relation='fixed_by')
  .recordOutcome(fixId, outcome, reEnforcePassed) → void
      # UPDATE nodes SET properties=json_set(properties, '$.outcome', ?) WHERE id=?
  .getFixHistory(ruleId) → Fix[]       # SELECT from nodes/edges WHERE type='fix'
  .getSuccessRate(ruleId) → number     # Aggregate query on fix outcomes
```

### SkillDiscovery

**Responsibility:** Extract reusable fix patterns from successful fixes and promote them to Skills.

```
SkillDiscovery
  .analyze() → Skill[]                  # SELECT from edges WHERE relation='fixed_by' GROUP BY pattern HAVING count > N
  .promoteToSkill(pattern, fixTemplate) → Skill   # INSERT INTO nodes (type='skill')
  .getSuggestion(violation) → Skill?   # SELECT with confidence ordering
  .updateConfidence(skillId) → void    # UPDATE based on recent success/failure ratio
  .prune(minConfidence) → number       # DELETE FROM nodes WHERE type='skill' AND confidence < ?
```

**Promotion algorithm:**
```
1. Group fixes by rule_id + pattern similarity:
   SELECT json_extract(f.properties, '$.pattern') as pattern,
          count(*) as fixes,
          sum(CASE WHEN json_extract(f.properties, '$.outcome')='success' THEN 1 ELSE 0 END) as successes
   FROM nodes f WHERE f.type='fix' GROUP BY pattern HAVING fixes >= 3
2. For each group with >= N successful fixes (default N=3):
   a. Extract common fix template
   b. Calculate confidence = successes / total
   c. If confidence >= threshold (default 0.7):
      INSERT or UPDATE Skill node
```

### CausalAnalyzer

**Responsibility:** Track cause-and-effect relationships between contract changes and violations via recursive edge traversal.

```
CausalAnalyzer
  .recordIntervention(change, timestamp) → void   # INSERT INTO nodes (type='intervention') + edges
  .correlate() → CausalLink[]                     # Recursive CTE traversal of caused_by edges
  .getImpact(contractChange) → ImpactReport       # Predict impact via historical edge patterns
```

**Correlation algorithm (SQL CTE):**
```sql
WITH RECURSIVE impact AS (
  SELECT target as node_id, 1 as depth
  FROM edges WHERE source = ? AND relation = 'caused_by'
  UNION ALL
  SELECT e.target, i.depth + 1
  FROM edges e JOIN impact i ON e.source = i.node_id
  WHERE e.relation = 'caused_by' AND i.depth < 10
)
SELECT * FROM impact;
```

---

## Query Patterns

### 1. Scope Resolution

Find all files that a rule applies to:

```sql
SELECT n.* FROM nodes n
  JOIN edges e ON n.id = e.target
  WHERE e.source = ? AND e.relation = 'scopes_to'
```

### 2. Fix Suggestion

Find the best fix for a violation:

```sql
SELECT f.* FROM nodes f
  JOIN edges e ON f.id = e.source
  WHERE e.target = ? AND e.relation = 'fixed_by'
    AND json_extract(f.properties, '$.confidence') >= 0.7
  ORDER BY json_extract(f.properties, '$.confidence') DESC
  LIMIT 1
```

### 3. Impact Analysis

Show what would be affected by changing a contract (recursive CTE):

```sql
WITH RECURSIVE impact AS (
  SELECT e.target as node_id, 1 as depth, e.relation
  FROM edges e WHERE e.source = ? AND e.relation IN ('has_rule', 'scopes_to')
  UNION ALL
  SELECT e2.target, i.depth + 1, e2.relation
  FROM edges e2 JOIN impact i ON e2.source = i.node_id
  WHERE i.depth < 5
)
SELECT n.*, i.depth FROM nodes n JOIN impact i ON n.id = i.node_id
```

### 4. Compliance Trending

Show violation counts over time:

```sql
SELECT date(created_at, 'unixepoch') as day, count(*) as violations
  FROM nodes
  WHERE type = 'violation'
    AND json_extract(properties, '$.timestamp') > ?
  GROUP BY day
  ORDER BY day
```

### 5. Agent Routing

Find the best agent for a violation type:

```sql
SELECT n.id, n.properties,
       count(e2.id) as successful_fixes
  FROM nodes n
  JOIN edges e ON n.id = e.source AND e.relation = 'performed_fix'
  JOIN nodes fix ON e.target = fix.id AND fix.type = 'fix'
  JOIN edges e2 ON fix.id = e2.source
  WHERE json_extract(fix.properties, '$.outcome') = 'success'
    AND n.type = 'agent'
  GROUP BY n.id
  ORDER BY successful_fixes DESC
```

### 6. Most Violated Rules

```sql
SELECT e.source as rule_id,
       json_extract(n.properties, '$.description') as description,
       count(DISTINCT e.target) as file_count
  FROM edges e
  JOIN nodes n ON e.source = n.id
  WHERE e.relation = 'violated_in'
  GROUP BY e.source
  ORDER BY file_count DESC
  LIMIT 10
```

### 7. Violation Cascade Detection

```sql
SELECT e.source, e.target,
       json_extract(n1.properties, '$.rule_id') as cause_rule,
       json_extract(n2.properties, '$.rule_id') as effect_rule
  FROM edges e
  JOIN nodes n1 ON e.source = n1.id
  JOIN nodes n2 ON e.target = n2.id
  WHERE e.relation = 'caused_by'
```

### 8. Deferred Rules

```sql
SELECT n.id as rule_id,
       e.target as file_id,
       json_extract(e.properties, '$.reason') as reason,
       json_extract(e.properties, '$.expires') as expires
  FROM edges e
  JOIN nodes n ON e.source = n.id
  WHERE e.relation = 'deferred'
    AND json_extract(e.properties, '$.expires') > strftime('%s','now')
```

---

## Integration with Existing Domains

### DDD-001: Contract Engine

The contract engine remains the source of truth for contract definitions. The knowledge graph mirrors contract structure but does not replace YAML:

```
ContractLoader (DDD-001)          GraphBuilder (DDD-004)
       │                                  │
       ▼                                  ▼
  Load YAML files              Index contracts as nodes
  Compile patterns             Create Rule + Pattern nodes
  Validate schema              Resolve scope → File nodes
       │                                  │
       └──────────── both feed ───────────┘
                        │
                        ▼
              ContractScanner (DDD-001)
                        │
                        ▼
                  Violation[]
                        │
                        ▼
              ViolationRecorder (DDD-004)
                        │
                        ▼
                  Graph nodes + edges
```

- `ContractLoader` materializes contracts as graph nodes on `specflow init`
- `ContractScanner` produces Violations → `ViolationRecorder` writes them to the graph
- YAML remains the authoritative source; the graph is a derived, enriched view

### DDD-002: Enforcement Pipeline

The enforcement pipeline gains read/write access to the graph at each gate:

```
Before scanning:  Query graph for known issues, focus areas (GNN attention)
During scanning:  Standard contract engine behavior (unchanged)
After scanning:   Record violations in graph via ViolationRecorder
Before fixing:    Query graph for suggested fixes via SkillDiscovery
After fixing:     Record fix outcome via FixTracker
```

See DDD-002 "Learning Enforcement" section for the enhanced pipeline flow.

### DDD-003: Agent Registry

Agents become graph nodes with edges to the contracts they fix:

- Agent nodes store performance metrics (fix_count, success_rate)
- heal-loop queries the skill library before attempting fixes
- Agent outcomes are recorded for reflexion memory
- Agent routing can be informed by historical success rates

See DDD-003 "Agent Graph Integration" section for details.

---

## Testing Strategy

### Unit Tests

- GraphBuilder creates correct nodes and edges from sample contracts
- ViolationRecorder creates and deduplicates violation records
- FixTracker records outcomes and calculates success rates
- SkillDiscovery promotes patterns after N successful fixes
- CausalAnalyzer correlates interventions with violation changes

### Integration Tests

- Full lifecycle: init → enforce → record violations → fix → record fix → query suggestions
- Graph stays in sync after contract YAML changes
- SQL queries return correct results for each query pattern
- MCP tools return graph data in expected format

### Property Tests

- Every violation recorded has a corresponding violated_in edge
- Skill confidence is always between 0.0 and 1.0
- Graph node counts match YAML source counts after sync
