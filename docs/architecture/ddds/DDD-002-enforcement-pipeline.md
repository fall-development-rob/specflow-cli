---
id: DDD-002
title: Enforcement Pipeline Domain Design
type: DDD
status: Accepted
version: 1
date: '2026-04-02'
last_reviewed: '2026-04-17'
implemented_by:
  - ADR-008
  - ADR-009
  - ADR-010
  - DDD-004
  - DDD-005
  - DDD-006
  - DDD-007
---

# DDD-002: Enforcement Pipeline Domain Design

**Status:** Proposed
**Date:** 2026-04-02

---

## Domain Overview

The enforcement pipeline is the sequence of checkpoints that prevent non-compliant code from shipping. It operates at three layers: git (commit time), build (test time), and Claude Code (tool use time). Each layer is independent — if one fails or is absent, the others still enforce.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Enforcement Point** | A moment in the development workflow where contracts are checked. |
| **Gate** | An enforcement point that blocks progress on failure (exit code != 0). |
| **Check** | An enforcement point that reports but doesn't block (warning). |
| **Commit Gate** | Git commit-msg hook. Rejects commits without `#issue-number`. |
| **Build Gate** | Post-build hook. Runs journey tests for issues in recent commits. |
| **Edit Check** | PostToolUse hook on Write/Edit. Scans changed file against contracts. |
| **CI Gate** | GitHub Actions workflow. Blocks PR merge if contract tests fail. |
| **MCP Check** | MCP tool call. Claude checks code before writing it. |
| **Journey** | A user flow defined in CSV, compiled to contract + Playwright test. |
| **Deferral** | Temporary exemption from a journey gate, logged with reason and issue. |
| **Baseline** | Snapshot of contract compliance state at a point in time. |

---

## Pipeline Architecture

```
Developer writes code
        │
        ▼
┌─ MCP Check (proactive) ──────────────────────┐
│  Claude calls specflow_check_code before      │
│  writing. Avoids violations before they exist.│
│  NOT a gate — advisory only.                  │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ Edit Check (reactive) ───────────────────────┐
│  PostToolUse hook fires after Write/Edit.     │
│  Scans changed file against all contracts.    │
│  Exit 2 = show error to Claude (soft gate).   │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ Commit Gate ─────────────────────────────────┐
│  git commit-msg hook.                         │
│  Rejects if no #issue-number in message.      │
│  Exit 1 = commit rejected (hard gate).        │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ Build Gate ──────────────────────────────────┐
│  PostToolUse hook fires after Bash.           │
│  Detects build/commit success.                │
│  Extracts issues from recent commits.         │
│  Maps issues → journeys → test files.         │
│  Runs Playwright tests.                       │
│  Exit 2 = show error to Claude (soft gate).   │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ CI Gate ─────────────────────────────────────┐
│  GitHub Actions on pull_request.              │
│  Runs: specflow enforce                       │
│  Posts compliance report as PR comment.        │
│  Blocks merge if violations found.            │
└───────────────────────────────────────────────┘
```

---

## Hook Protocol

Claude Code hooks receive JSON on stdin and communicate via exit codes:

### Input (from Claude Code)

```json
{
  "tool_name": "Write",
  "tool_input": {
    "file_path": "/path/to/file.ts",
    "content": "..."
  },
  "tool_output": "File written successfully"
}
```

### Output (exit codes)

| Exit Code | Meaning | Effect |
|-----------|---------|--------|
| 0 | Pass (or not applicable) | Continue silently |
| 1 | Script error | Claude Code reports error |
| 2 | Enforcement failure | Error shown to model, model should fix |

### Hook Types Used

| Claude Code Hook | Specflow Handler | Purpose |
|-----------------|------------------|---------|
| `PostToolUse` matcher `Write\|Edit` | `check-compliance.js` | Scan changed file against contracts |
| `PostToolUse` matcher `Bash` | `post-build-check.js` | Detect build success → run journey tests |
| `PostToolUse` matcher `Bash` | (future) `post-push-ci.js` | Poll CI after push |

---

## Journey Enforcement Flow

The most complex enforcement path:

```
1. Developer commits with message "feat: auth (#123)"
2. Build succeeds (npm run build)
3. PostToolUse:Bash fires → post-build-check.js
4. post-build-check.js detects build success
   → Calls run-journey-tests.js

5. run-journey-tests.js:
   a. Check .claude/.defer-tests (global defer flag)
   b. Extract #123 from recent commits (git log)
   c. Fetch issue #123 via gh CLI
   d. Extract journey IDs from issue body: J-LOGIN-FLOW
   e. Check .claude/.defer-journal for J-LOGIN-FLOW
   f. Find test file:
      - First: look in journey contract YAML for test_hooks.e2e_test_file
      - Fallback: heuristic: J-LOGIN-FLOW → tests/e2e/journey_login_flow.spec.ts
   g. Run: npx playwright test tests/e2e/journey_login_flow.spec.ts

6. If test passes: exit 0 (continue)
7. If test fails: exit 2 (show error to model)
```

### Deferral System

Deferrals allow temporarily skipping journey gates:

**Global deferral:** `touch .claude/.defer-tests` — skips ALL journey tests.

**Per-journey deferral:** Add entry to `.claude/.defer-journal`:
```
J-LOGIN-FLOW: Waiting on auth service (#456)
```

Deferrals are checked at step 5e. If a journey is deferred, its test is skipped and a message is logged.

---

## Edit-Time Enforcement

The fastest feedback loop — checks contracts as code is written:

```
1. Claude writes/edits a file via Write or Edit tool
2. PostToolUse:Write|Edit fires → check-compliance.js
3. check-compliance.js:
   a. Read tool_input.file_path from stdin JSON
   b. Load all contracts from docs/contracts/
   c. Filter to rules whose scope matches the file path
   d. Scan file content against matching rules
   e. If violations found: exit 2 with violation details
   f. If clean: exit 0

4. Claude sees violation message, self-corrects
```

This is the same contract engine used by `specflow enforce`, just triggered automatically.

---

## Baseline Tracking

`.specflow/baseline.json` stores a compliance snapshot:

```json
{
  "timestamp": "2026-04-02T18:00:00Z",
  "contracts": 7,
  "rules": 35,
  "violations": 2,
  "details": [
    { "rule": "SEC-003", "file": "src/legacy.js", "status": "known" }
  ]
}
```

This allows `specflow status` to show regression (new violations since baseline) vs known issues. The baseline is updated manually with `specflow enforce --update-baseline`.

---

## State Machine: Issue Lifecycle Through Pipeline

```
OPEN (issue created)
  → Code written (MCP check advisory)
  → Code committed (commit gate: has #issue)
  → Build passes (build gate: journey tests pass)
  → PR created (CI gate: contract tests pass)
  → PR merged
  → Issue closed (all gates passed)
```

Each gate is independent. Skipping one doesn't bypass others. The pipeline is defense-in-depth.

---

## Simulation Findings (2026-04-04)

### SIM-ENF-001 (HIGH): Compliance Hook Is a No-Op

**File:** `ts-src/hooks/check-compliance.ts`
**Severity:** HIGH — The Edit Check layer of the enforcement pipeline is completely non-functional.

**Problem:** The `check-compliance.ts` hook exits 0 regardless of what code was written. It reads the stdin JSON from Claude Code's PostToolUse event but does not actually run the contract scanner against the file content. When Claude Code writes violating code via Write or Edit tools, the hook passes silently.

The "Edit-Time Enforcement" section above describes the intended behavior (steps 3a-3f). The current implementation only performs step 3a (read stdin JSON) and then exits 0.

**What the hook MUST do:**

```
1. Read stdin JSON → extract tool_input.file_path
2. If file_path is undefined or tool_name is not Write|Edit → exit 0
3. Load all contracts from .specflow/contracts/ (or docs/contracts/)
4. Filter to rules whose scope matches file_path
5. Read the file content from disk (it was just written)
6. Scan file content against matching rules using ContractScanner
7. If violations found:
   a. Format violation messages to stderr
   b. Exit 2 (tells Claude Code to show error to model)
8. If clean: exit 0
```

**Impact if not fixed:** The fastest feedback loop in the pipeline (edit-time checking) is disabled. Violations are only caught at commit time (if journey tests cover them) or in CI. This defeats the "defense in depth" principle — the middle layer is missing.

### SIM-ENF-002 (HIGH): Exit Code Contract for `enforce`

**Affected file:** `ts-src/commands/enforce.ts`

**Exit code contract (must hold for ALL output modes):**

| Condition | Exit Code |
|-----------|-----------|
| No violations found | 0 |
| Violations found | 1 |
| Script/runtime error | 1 |

The `--json` flag controls output **format**, not exit **behavior**. Currently, `--json` mode always exits 0. This breaks CI pipelines that use `specflow enforce --json` to get machine-readable output while still gating on violations.

**Fix:** Determine exit code from scan results BEFORE formatting output. Apply `process.exitCode = 1` when violations exist, then format output in the requested mode. The exit code and the output format are independent concerns.

---

## Learning Enforcement

With the knowledge graph integration ([DDD-004](DDD-004-knowledge-graph.md), [ADR-007](../adrs/ADR-007-agentdb-knowledge-graph.md)), the enforcement pipeline becomes stateful. Each gate gains read/write access to the graph, transforming enforce from a one-shot scan into a learning loop.

### Enhanced Pipeline Flow

```
Developer writes code
        │
        ▼
┌─ MCP Check (proactive) ──────────────────────┐
│  Claude calls specflow_check_code             │
│  NEW: Also calls specflow_get_fix_suggestion  │
│  to preemptively avoid known violation patterns│
└───────────────────────────────────────────────┘
        │
        ▼
┌─ Edit Check (reactive) ───────────────────────┐
│  PostToolUse hook fires after Write/Edit       │
│  Scans changed file against all contracts      │
│  NEW: Records violations in graph              │
│  NEW: Includes fix suggestions in error output │
│  Exit 2 = show error + suggestion to Claude    │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ Enforce Gate ────────────────────────────────┐
│  specflow enforce                             │
│  Standard scan (unchanged)                    │
│  NEW: Record violations in graph (Episode)    │
│  NEW: Query skill library for fix suggestions │
│  NEW: Include suggestions in output           │
│  Exit 1 = violations found                    │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ Fix Loop ────────────────────────────────────┐
│  heal-loop agent or manual fix                │
│  NEW: Query graph: "what fix worked before?"  │
│  NEW: Apply known skill if confidence >= 0.7  │
│  NEW: Record fix attempt + outcome in graph   │
│  Re-run enforce to verify fix                 │
└───────────────────────────────────────────────┘
        │
        ▼
┌─ CI Gate ─────────────────────────────────────┐
│  GitHub Actions                               │
│  specflow enforce (same as above)             │
│  NEW: Violations recorded in graph for trend  │
│  Blocks merge if violations found             │
└───────────────────────────────────────────────┘
```

### Graph Reads and Writes at Each Step

| Pipeline Step | Graph Read | Graph Write |
|--------------|------------|-------------|
| MCP Check | Query skill library for preemptive suggestions | None (advisory only) |
| Edit Check | Query skills for fix suggestion on violation | Record violation in graph |
| Enforce | Query skills for suggestions; query attention weights for scan priority | Record Episode + all violations |
| Fix Loop | Query skill library; query fix history for this rule | Record Fix node with outcome |
| CI Gate | (same as Enforce) | (same as Enforce) |

### Learning Cycle

The pipeline forms a closed learning loop:

```
Enforce → finds violations
    ↓
Record violations in graph
    ↓
Fix attempt (heal-loop or manual)
    ↓
Record fix + outcome in graph
    ↓
Re-enforce → verify fix worked
    ↓
If success: increment skill confidence
If failure: record as failed fix → reflexion memory
    ↓
After N successes: promote to Skill
    ↓
Next enforce: suggest this Skill for similar violations
```

### Backward Compatibility

The graph integration is additive. If `.specflow/knowledge.db` doesn't exist:

- `specflow enforce` works exactly as before (no suggestions, no recording)
- Hooks work exactly as before
- CI gates work exactly as before
- No error, no degradation — just no learning

The graph is created by `specflow init` and is opt-in via its presence.
