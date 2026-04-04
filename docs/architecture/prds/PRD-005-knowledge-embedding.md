# PRD-005: Knowledge Embedding

**Status:** Proposed
**Date:** 2026-04-04
**Phase:** 9
**Depends on:** Phase 5 (Agent System), Phase 3 (MCP Server), Phase 8 (Simulation Fixes)

---

## Overview

Convert 20+ removed static documentation files into living system components: a Claude Code skill, two MCP tools, one new agent, four enriched agents, and enhanced hook coverage. See [ADR-006](../adrs/ADR-006-knowledge-as-components.md) for the architectural rationale.

---

## Component 1: Claude Code Skill

**File:** `.claude/skills/specflow.md`
**Source knowledge:** SKILL.md (core operating loop, pre-flight gates, security patterns)

### Contents

The skill file must include:

1. **Core operating loop** — the sequence every Specflow-aware session follows (check board → pick issue → verify contracts → implement → test → enforce → commit)
2. **Pre-flight gates** — what to check before writing code (issue exists, contracts loaded, doctor passes)
3. **Security patterns** — OWASP-aligned rules that apply to all generated code
4. **Agent behaviors** — when to invoke which agent (e.g., contract-generator for new features, heal-loop for violations)
5. **Model routing guidance** — which tasks benefit from which model tier
6. **Command quick reference** — all `specflow` CLI commands with one-line descriptions

### Delivery Mechanism

- File is included in `package.json` `files` array so it ships with `npm install`
- `specflow init` copies it to `<project>/.claude/skills/specflow.md`
- If the file already exists, `init` checks for a version marker comment and only overwrites if the shipped version is newer
- Claude Code automatically loads files from `.claude/skills/` as ambient context

### Acceptance Criteria

- [ ] `.claude/skills/specflow.md` exists in the package
- [ ] `specflow init .` copies it to the target project
- [ ] Second `init` does not duplicate or corrupt the file
- [ ] Claude Code loads the skill and applies its guidance in sessions

---

## Component 2: MCP Tools

### 2a. `specflow_get_schema`

**Source knowledge:** CONTRACT-SCHEMA.md, CONTRACTS-README.md

| Field | Value |
|-------|-------|
| Tool name | `specflow_get_schema` |
| Description | Returns the complete YAML contract schema specification |
| Inputs | `section` (optional): `"full"` (default), `"fields"`, `"patterns"`, `"examples"` |
| Output | Markdown-formatted schema documentation |
| Implementation | `ts-src/mcp/tools.ts` — new handler |

**Behavior:**
- `section: "full"` — returns complete schema with all fields, types, and descriptions
- `section: "fields"` — returns only the field reference (name, type, required, description)
- `section: "patterns"` — returns pattern syntax guide with regex examples
- `section: "examples"` — delegates to `specflow_get_example`

The schema content is defined inline in the tool handler (not read from a file), so it stays in sync with the parser.

### 2b. `specflow_get_example`

**Source knowledge:** Example contracts scattered across removed docs

| Field | Value |
|-------|-------|
| Tool name | `specflow_get_example` |
| Description | Returns an annotated example contract |
| Inputs | `type` (optional): `"feature"` (default), `"journey"`, `"security"`, `"defaults"` |
| Output | YAML contract with inline comments explaining each field |
| Implementation | `ts-src/mcp/tools.ts` — new handler |

**Behavior:**
- Returns a complete, valid YAML contract of the requested type
- Every field has an inline `# comment` explaining its purpose
- The example is hardcoded in the tool (not read from templates/) to ensure annotations are always present

### Acceptance Criteria

- [ ] Both tools appear in `specflow mcp tools` output
- [ ] `specflow_get_schema` returns accurate, complete schema documentation
- [ ] `specflow_get_example` returns valid, annotated YAML for each type
- [ ] Schema matches the actual contract parser behavior

---

## Component 3: New Agent — adoption-advisor

**Source knowledge:** MID-PROJECT-ADOPTION.md, adoption strategy guidance

### Frontmatter

```yaml
---
name: adoption-advisor
description: Guides teams through adopting Specflow in existing projects — from first contract to full enforcement
category: lifecycle
trigger: Adopt Specflow in an existing project
inputs:
  - Current project tech stack
  - Existing test framework
  - Team size and workflow
  - Current pain points
outputs:
  - Phased adoption plan
  - Starter contracts tailored to the project
  - Hook installation guide
  - Risk assessment
contracts:
  - feature_specflow_project
---
```

### Prompt Content

The agent prompt must cover:

1. **Assessment phase** — what to audit in the existing project (test coverage, CI setup, code structure)
2. **Contract selection** — which default contracts to start with based on the tech stack
3. **Phased rollout** — start with security_defaults (least disruptive), then add feature contracts
4. **Hook installation** — how to install without disrupting existing CI
5. **Team onboarding** — how to introduce contracts to developers who haven't used them
6. **Escape hatches** — how to defer rules during adoption (`specflow defer`)

### Acceptance Criteria

- [ ] `agents/adoption-advisor.md` exists with valid frontmatter
- [ ] `specflow agent list` includes it in the lifecycle category
- [ ] `specflow agent show adoption-advisor` returns the full prompt
- [ ] Content covers all 6 sections above

---

## Component 4: Agent Enrichment

### 4a. waves-controller

**Added knowledge:** PROTOCOL.md (TeammateTool usage), WORKFLOW.md (state machine)

Add to the agent prompt body:

- **TeammateTool protocol:** how to spawn sub-agents, pass context, collect results, handle failures
- **State machine:** issue states (open → in-progress → review → done), transition rules, who can transition
- **Team coordination:** which agents form teams, team names, escalation paths

### 4b. sprint-executor

**Added knowledge:** WORKFLOW.md (state machine, execution sequence)

Add to the agent prompt body:

- **Execution sequence:** for each issue in a sprint — check contracts → implement → test → enforce → commit → move issue
- **Failure handling:** what to do when enforce fails (invoke heal-loop), when tests fail (debug before retrying)
- **Progress reporting:** how to report sprint progress back to the orchestrator

### 4c. contract-generator

**Added knowledge:** CONTRACT-SCHEMA.md (full schema), CONTRACT-SCHEMA-EXTENSIONS.md (soft rules, auto_fix)

Add to agent's `contracts` field or prompt body:

- **Complete field reference:** all YAML fields, types, required/optional, valid values
- **Extension fields:** `severity` (error/warning/info), `auto_fix` (regex replacement), `soft` (advisory-only rules)
- **Pattern syntax:** regex features supported, common patterns, escape rules
- **Scope syntax:** glob patterns for file targeting

### 4d. heal-loop

**Added knowledge:** CONTRACT-SCHEMA-EXTENSIONS.md (auto_fix patterns)

Add to agent's `contracts` field or prompt body:

- **auto_fix protocol:** how `auto_fix` regex replacements work, when to apply them vs. manual fix
- **Severity handling:** errors block, warnings advise, info is silent
- **Remediation strategy:** fix violations in order of severity, re-run enforce after each batch

### Acceptance Criteria

- [ ] waves-controller prompt includes TeammateTool protocol and state machine
- [ ] sprint-executor prompt includes execution sequence and failure handling
- [ ] contract-generator has full schema and extension knowledge in context
- [ ] heal-loop has auto_fix and severity knowledge in context
- [ ] All enriched agents still have valid frontmatter after changes

---

## Component 5: Hook Enhancement

**File:** `ts-src/hooks/check-compliance.ts`
**Source knowledge:** Pipeline compliance gaps, simulation Edge 5

### New Checks

#### 5a. Orphan Test Detection

Scan for test files that don't have a matching contract:

```
For each file in tests/**/*.test.{js,ts}:
  Extract the feature/journey name from the filename
  Check if a matching contract exists in .specflow/contracts/
  If no match: report as orphan test (WARNING)
```

#### 5b. Orphan Contract Detection

Scan for contracts that don't have a matching test:

```
For each file in .specflow/contracts/*.yml:
  Extract the contract name
  Check if a matching test exists in tests/
  If no match: report as orphan contract (WARNING)
```

#### 5c. Uncompiled CSV Detection

Scan for journey CSVs that haven't been compiled to contracts + test stubs:

```
For each file in **/*.csv matching journey pattern:
  Check if a corresponding contract exists in .specflow/contracts/
  Check if a corresponding test stub exists in tests/
  If either missing: report as uncompiled journey (WARNING)
```

### Acceptance Criteria

- [ ] `check-compliance.ts` detects orphan tests and reports them
- [ ] `check-compliance.ts` detects orphan contracts and reports them
- [ ] `check-compliance.ts` detects uncompiled journey CSVs and reports them
- [ ] Warnings don't block the build (exit 0) but are visible in output
- [ ] Integration test covers each detection case

---

## AgentDB as Implementation Layer

With the adoption of AgentDB as the knowledge graph foundation ([ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md), [PRD-006](PRD-006-knowledge-graph.md)), several components specified above gain a persistent, queryable backend:

### Skills → AgentDB Skill Library

The Claude Code skill (Component 1) delivers knowledge as ambient context. AgentDB extends this with a **learned skill library** — reusable fix patterns extracted from enforcement history:

- Skills are stored as Skill nodes in the knowledge graph (`.specflow/knowledge.rvf`)
- Each skill has a confidence score based on success/failure ratio
- The heal-loop agent queries the skill library before attempting fixes
- New skills are discovered automatically after N successful fixes of the same pattern

The static skill file (`.claude/skills/specflow.md`) provides the operating framework; the AgentDB skill library provides learned, project-specific fix patterns.

### Schema Knowledge → Graph Nodes Queryable via MCP

The MCP tools (Component 2) return schema documentation on demand. AgentDB extends this with **graph-backed queries**:

- `specflow_get_schema` — returns static schema documentation (unchanged)
- `specflow_query_graph` — executes Cypher queries against contract/rule/pattern nodes in the graph
- `specflow_get_fix_suggestion` — queries the skill library for a specific violation

Schema knowledge is represented in the graph as Contract + Rule + Pattern nodes, enabling queries like "which rules apply to this file?" or "what patterns does SEC-003 check for?"

### Agent Coordination → Graph Edges Between Agents

Agent enrichment (Component 4) embeds coordination knowledge in prompts. AgentDB extends this with **graph-backed agent relationships**:

- Agents are graph nodes with edges to the contracts they fix
- Agent performance (fix_count, success_rate) is tracked in the graph
- Agent routing queries identify the best agent for a violation type
- Reflexion memory prevents agents from repeating failed approaches

### Examples → Generated from Graph Patterns

The `specflow_get_example` MCP tool (Component 2b) returns hardcoded annotated examples. AgentDB enables **graph-derived examples**:

- Query the graph for the most common violation patterns
- Generate example contracts that address those patterns
- Include real fix suggestions from the skill library as inline annotations

This is a future enhancement — the static examples remain the default until the graph has sufficient history.
