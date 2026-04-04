# DDD-004: Knowledge Graph Domain Design

**Status:** Proposed
**Date:** 2026-04-04
**Depends on:** DDD-001 (Contract Engine), DDD-002 (Enforcement Pipeline), DDD-003 (Agent Registry)

---

## Domain Overview

The knowledge graph is Specflow's persistent memory layer. It stores the relationships between contracts, rules, files, violations, fixes, and agents as a graph, enabling the system to learn from enforcement outcomes and suggest fixes based on history. Powered by AgentDB (see [ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md)).

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Node** | A vertex in the knowledge graph representing a domain entity (Contract, Rule, File, Violation, etc.). |
| **Edge** | A directed relationship between two nodes (has_rule, violated_in, fixed_by, etc.). |
| **Memory** | A cognitive memory pattern stored in AgentDB — episodic, semantic, procedural, reflexion, skill, or working. |
| **Skill** | A learned, reusable fix pattern extracted from repeated successful fixes. Has a confidence score. |
| **Episode** | A complete record of one enforcement run — violations found, fixes attempted, outcomes. |
| **Violation Record** | A node recording a specific violation: which rule, which file, which line, when detected. |
| **Fix Record** | A node recording a fix attempt: which violation, what method, what agent, success or failure. |
| **Causal Link** | An edge tracking that one event caused another (e.g., relaxing a rule scope caused new violations). |
| **Cognitive Container** | The `.rvf` file that stores the entire graph — AgentDB's single-file storage format. |
| **Witness Chain** | Cryptographic audit trail proving that enforcement occurred and what results it produced. |

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

## Domain Services

### GraphBuilder

**Responsibility:** Materialize YAML contracts and agent files into graph nodes and edges.

```
GraphBuilder
  .initialize(rvfPath) → Graph          # Create or open .rvf file
  .indexContracts(contractDir) → void   # Sync contracts to graph nodes
  .indexAgents(agentsDir) → void        # Sync agents to graph nodes
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
  .startEpisode() → Episode             # Begin a new enforcement run record
  .recordViolation(violation) → Node    # Create Violation node + edges
  .endEpisode(summary) → void          # Finalize episode with metadata
  .getActiveViolations(file?) → Violation[]  # Query active violations
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
  .recordOutcome(fixId, outcome, reEnforcePassed) → void
  .getFixHistory(ruleId) → Fix[]       # All fix attempts for a rule
  .getSuccessRate(ruleId) → number     # Success ratio for fixes of this rule
```

### SkillDiscovery

**Responsibility:** Extract reusable fix patterns from successful fixes and promote them to Skills.

```
SkillDiscovery
  .analyze() → Skill[]                  # Discover new skills from fix history
  .promoteToSkill(pattern, fixTemplate) → Skill
  .getSuggestion(violation) → Skill?   # Find a skill that matches this violation
  .updateConfidence(skillId) → void    # Recalculate from recent outcomes
  .prune(minConfidence) → number       # Remove skills below threshold
```

**Promotion algorithm:**
```
1. Group fixes by rule_id + pattern similarity
2. For each group with >= N successful fixes (default N=3):
   a. Extract common fix template
   b. Calculate confidence = successes / (successes + failures)
   c. If confidence >= threshold (default 0.7):
      Create or update Skill node
```

### CausalAnalyzer

**Responsibility:** Track cause-and-effect relationships between contract changes and violations.

```
CausalAnalyzer
  .recordIntervention(change, timestamp) → void   # Record a contract/scope change
  .correlate() → CausalLink[]                     # Find correlations between changes and violation spikes
  .getImpact(contractChange) → ImpactReport       # Predict impact of a proposed change
```

**Correlation algorithm:**
```
1. After a contract change (scope expansion, rule addition, etc.):
   a. Record the intervention with timestamp
   b. Compare violation counts before/after (within a time window)
   c. If significant increase: create caused_by edge with confidence
2. For impact prediction:
   a. Find similar past interventions
   b. Aggregate their outcomes
   c. Report expected violation count change
```

---

## Query Patterns

### 1. Scope Resolution

Find all files that a rule applies to:

```cypher
MATCH (r:Rule {id: 'SEC-001'})-[:SCOPES_TO]->(f:File)
RETURN f.path
```

### 2. Fix Suggestion

Find the best fix for a violation:

```cypher
MATCH (s:Skill)
WHERE s.rule_ids CONTAINS 'SEC-003'
  AND s.confidence >= 0.7
RETURN s.fix_template, s.confidence, s.uses
ORDER BY s.confidence DESC
LIMIT 1
```

### 3. Impact Analysis

Show what would be affected by changing a contract:

```cypher
MATCH (c:Contract {id: 'security_defaults'})-[:HAS_RULE]->(r:Rule)-[:SCOPES_TO]->(f:File)
OPTIONAL MATCH (r)-[:VIOLATED_IN]->(vf:File)
RETURN r.id, collect(DISTINCT f.path) AS scoped_files,
       collect(DISTINCT vf.path) AS violated_files
```

### 4. Compliance Trending

Show violation counts over time:

```cypher
MATCH (v:Violation)
WHERE v.timestamp > $since
RETURN date(v.timestamp) AS day, count(v) AS violations
ORDER BY day
```

### 5. Agent Routing

Find the best agent for a violation type:

```cypher
MATCH (a:Agent)-[:FIXED]->(f:Fix)-[:FIXED_BY]-(v:Violation)
WHERE v.rule_id = $ruleId AND f.outcome = 'success'
RETURN a.name, count(f) AS successful_fixes, a.success_rate
ORDER BY a.success_rate DESC
```

### 6. Most Violated Rules

```cypher
MATCH (r:Rule)-[:VIOLATED_IN]->(f:File)
RETURN r.id, r.description, count(f) AS file_count
ORDER BY file_count DESC
LIMIT 10
```

### 7. Violation Cascade Detection

```cypher
MATCH (v1:Violation)-[:CAUSED_BY]->(v2:Violation)
RETURN v1.rule_id, v2.rule_id, v1.file, v2.file
```

### 8. Deferred Rules

```cypher
MATCH (r:Rule)-[d:DEFERRED]->(f:File)
WHERE d.expires > datetime()
RETURN r.id, f.path, d.reason, d.expires
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
- Cypher queries return correct results for each query pattern
- MCP tools return graph data in expected format

### Property Tests

- Every violation recorded has a corresponding violated_in edge
- Skill confidence is always between 0.0 and 1.0
- Graph node counts match YAML source counts after sync
