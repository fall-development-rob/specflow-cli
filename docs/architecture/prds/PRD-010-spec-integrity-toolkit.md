---
id: PRD-010
title: Spec Integrity Toolkit
type: PRD
status: Accepted
version: 2
date: '2026-04-16'
last_reviewed: '2026-04-17'
implements:
  - DDD-001
  - ADR-008
  - ADR-015
---

# PRD-010: Spec Integrity Toolkit

**Status:** Proposed
**Date:** 2026-04-16
**Phase:** 12
**Depends on:** Phase 2 (CLI Rewrite), DDD-001 (Contract Engine), ADR-008 (Incremental Enforcement)
**Implements:** —
**Implemented By:** ADR-010, ADR-011, ADR-012, DDD-007

---

## Overview

The Spec Integrity Toolkit makes documentation a first-class enforceable artefact in Specflow. It introduces a new contract type (`spec_coupling`), a documentation frontmatter schema with lifecycle states, bidirectional link validation, a release-time snapshot mechanism, and a quarterly review command. Together these mechanisms operationalise practices 1–7 of the spec-maintenance discipline:

| # | Practice | Mechanism |
|---|---|---|
| 1 | Code changes require spec edits | `spec_coupling` contract, enforced by `specflow enforce` |
| 2 | Status with Superseded-by | Frontmatter schema (ADR-011) + `specflow doctor --docs` |
| 3 | Contracts are source of truth | Truth hierarchy in `CLAUDE-MD-TEMPLATE.md`; `specflow status` banner |
| 4 | Bidirectional links | `implements`/`implemented_by` reciprocity in `specflow doctor --docs` |
| 5 | Snapshot on ship | `Version:` field + `specflow snapshot --on-ship` writing `versions.yml` |
| 6 | Quarterly review | `Last-Reviewed:` field + `specflow review` |
| 7 | Soft-delete unused docs | `Status: Deprecated` / `Status: Superseded`; nothing is removed from disk |

See ADR-010 for the architectural shift, ADR-011 for the lifecycle/schema, ADR-012 for link reciprocity, and DDD-007 for the domain model.

---

## Goals

1. **Make spec decay visible** — staleness becomes a CI signal, not a silent rot.
2. **Preserve everything** — no doc is ever deleted; soft-delete via lifecycle states.
3. **Cheap to adopt** — frontmatter migration is a one-shot scripted command.
4. **Cheap to maintain** — link reciprocity has an `--fix` mode; review cadence is just a date stamp.

## Non-Goals

1. **AST-diff coupling** — path-based coupling is the v1; semantic diff is deferred.
2. **Replacing the contract engine** — `spec_coupling` is a new contract category, evaluated against git diff state.
3. **Auto-deprecation** — `specflow review` reports orphans but never sets `Status: Deprecated` itself; humans decide.

---

## New Contract Type: `spec_coupling`

A new YAML contract category that maps source globs to required doc globs. Lives in `.specflow/contracts/` like any other contract.

### Schema

```yaml
contract_meta:
  id: spec_coupling_core
  type: spec_coupling          # New contract type
  version: "1.0.0"

llm_policy:
  severity: error
  auto_fixable: false
  instructions: |
    When this contract fails, the PR has changed source code in a coupled
    directory but has not updated the matching documentation. Either update
    the doc, or use override_contract: spec_coupling with justification.

rules:
  couplings:
    - id: COUPLE-001
      description: "Domain code changes must update the matching DDD"
      source_globs:
        - "packages/core/src/domain/**/*.ts"
      required_doc_globs:
        - "docs/architecture/ddds/DDD-*-*.md"
      exclude_globs:
        - "**/*.test.ts"
        - "**/*.spec.ts"

    - id: COUPLE-002
      description: "Schema changes must update the schema PRD or DDD"
      source_globs:
        - "packages/db/src/schema/**/*.ts"
      required_doc_globs:
        - "docs/architecture/prds/PRD-*-schema*.md"
        - "docs/architecture/ddds/DDD-*-schema*.md"

    - id: COUPLE-003
      description: "Contract YAML changes must update the contract index"
      source_globs:
        - ".specflow/contracts/*.yml"
      required_doc_globs:
        - ".specflow/contracts/CONTRACT_INDEX.yml"
      exclude_globs:
        - ".specflow/contracts/CONTRACT_INDEX.yml"
```

### Evaluation Semantics

- Asymmetric: only fails when source paths in a coupling change without matching doc paths in the same diff.
- Diff-scoped: respects existing `--staged` and `--diff <range>` flags from ADR-008.
- Doc-only or unrelated source-only commits never fail.
- Only Accepted docs (per ADR-011) count as satisfying a coupling. Editing a Draft doc does not satisfy.

### Acceptance Criteria

- [ ] `spec_coupling` contracts load via the existing contract loader.
- [ ] `specflow enforce --diff origin/main..HEAD` flags coupled source changes without matching doc changes.
- [ ] `specflow enforce --staged` works in pre-commit hooks.
- [ ] `exclude_globs` correctly excludes test/generated files.
- [ ] Override protocol (`override_contract: spec_coupling`) is respected.
- [ ] Draft docs do not satisfy coupling; only Accepted docs do.

---

## New Command: `specflow review`

Reports on documentation health for the quarterly sweep.

```bash
specflow review                  # Full report
specflow review --overdue        # Only docs with last_reviewed > 90 days
specflow review --orphans        # Only docs with no inbound references
specflow review --json           # Machine-readable output
```

### Behaviour

1. Walk `docs/architecture/**/*.md`.
2. Parse YAML frontmatter (per ADR-011).
3. Classify each Accepted doc:
   - **Current**: `last_reviewed` within 90 days, has inbound references.
   - **Overdue**: `last_reviewed` > 90 days. Suggest re-stamping.
   - **Orphaned**: No code citations, no agent references, no other Accepted doc links to it. Suggest reviewer evaluate for `Status: Deprecated`.
   - **Stale link**: Has links to Superseded/Deprecated docs. Suggest re-pointing to successor.
4. Report grouped by classification with file paths and last-reviewed dates.
5. Never modifies files. Reporting only.

### Sample Output

```
Specflow Review Report — 2026-04-16

ACCEPTED DOCS: 28
  Current:        24
  Overdue:         3 (last_reviewed > 90 days)
  Orphaned:        1 (no inbound references)
  Stale links:    2 (link to Superseded/Deprecated)

OVERDUE
  docs/architecture/adrs/ADR-003-cli-architecture.md   last_reviewed: 2025-12-10 (127 days ago)
  docs/architecture/prds/PRD-002-mcp-server.md         last_reviewed: 2025-11-22 (145 days ago)
  docs/architecture/ddds/DDD-002-enforcement-pipeline.md  last_reviewed: 2025-11-30 (137 days ago)

ORPHANED (no inbound references)
  docs/architecture/prds/PRD-005-knowledge-embedding.md
    Suggestion: review and consider Status: Deprecated

STALE LINKS
  docs/architecture/adrs/ADR-007-agentdb-knowledge-graph.md
    implements: [PRD-006] — PRD-006 is Superseded by PRD-009
  docs/architecture/ddds/DDD-004-knowledge-graph.md
    implements: [PRD-006] — PRD-006 is Superseded by PRD-009

SOFT-DELETED (not subject to enforcement)
  Superseded:  3 docs
  Deprecated:  1 doc
```

### Acceptance Criteria

- [ ] Lists overdue Accepted docs with last-reviewed age.
- [ ] Identifies orphans by walking inbound link/citation graph.
- [ ] Flags stale links to Superseded/Deprecated docs.
- [ ] Reports counts of soft-deleted docs separately.
- [ ] `--json` produces parseable output for CI dashboards.
- [ ] Never writes to disk.

---

## New Command: `specflow snapshot`

Stamps the current docs against a release tag.

```bash
specflow snapshot --on-ship --tag v1.2.0    # Stamp at release time
specflow snapshot --list                     # Show release-to-doc-version mapping
specflow snapshot --diff v1.0.0 v1.2.0       # Show which docs changed between releases
```

### Behaviour (`--on-ship`)

1. Read all docs in `docs/architecture/`.
2. For each: extract `version` from frontmatter.
3. Append a release entry to `docs/architecture/versions.yml`:
   ```yaml
   v1.2.0:
     commit: <git rev-parse HEAD>
     date: 2026-05-20
     docs:
       ADR-010: 2
       ADR-011: 1
       PRD-010: 1
   ```
4. Idempotent — re-running for the same tag is a no-op (or warns and refuses).

### Acceptance Criteria

- [ ] `--on-ship --tag <tag>` writes a versions.yml entry.
- [ ] Captures the current commit SHA at snapshot time.
- [ ] `--list` reads versions.yml and prints the mapping.
- [ ] `--diff <a> <b>` reports docs whose version changed between two releases.
- [ ] Idempotent — re-running for the same tag does not duplicate entries.

---

## New Command Family: `specflow doc`

The `specflow doc` verb family turns every lifecycle operation the toolkit reports into a first-class command. Every verb routes through `Document.transitionTo` (ADR-014), writes atomically via the `DocumentWriter` port, mirrors reciprocal links where applicable, and appends a one-line entry to `.specflow/audit-log.yml`. See ADR-015 for the behavioural contract and DDD-008 for the domain model.

### `specflow doc accept`

```bash
specflow doc accept <id>
specflow doc accept ADR-014 --yes
```

Behaviour:

- Transitions `Draft → Accepted` via `transitionTo`.
- Validates required Accepted-status fields (title, date, version ≥ 1).
- Stamps `last_reviewed: <today>` and bumps `version` to 1 if it was 0.
- Mirrors reciprocal `implemented_by` entries onto docs listed in `implements`.
- Appends an audit entry with `verb: accept, from: Draft, to: Accepted`.

Acceptance criteria:

- [ ] `accept` on a Draft doc succeeds and writes atomically.
- [ ] `accept` on an already-Accepted doc exits 0 as a no-op.
- [ ] Missing required fields cause the verb to exit 2 with a structured error.
- [ ] Reciprocal `implemented_by` entries appear on linked docs in the same commit.
- [ ] An audit entry is appended on success and absent on failure.
- [ ] `--dry-run` prints the planned mutation without writing.

### `specflow doc supersede`

```bash
specflow doc supersede <id> --by <newId> [--note <s>]
specflow doc supersede ADR-007 --by ADR-018 --note "Replaced after scope change"
```

Behaviour:

- Transitions `Accepted → Superseded` atomically.
- Verifies `<newId>` exists and is Accepted (or Draft with `--allow-draft-successor`).
- Sets `superseded_by: <newId>` on the old doc.
- Appends the old doc's id to `<newId>.implemented_by` as part of the same atomic batch.
- Refuses circular chains (`CircularSupersessionError`).

Acceptance criteria:

- [ ] `supersede` requires `--by` and fails when the flag is absent.
- [ ] `supersede` fails fast when `<newId>` is unknown or not Accepted.
- [ ] Reciprocal mirror lands in the same atomic write as the primary mutation.
- [ ] Circular supersession chains are detected before any write.
- [ ] Audit entry captures `verb, from, to, successor, reason`.

### `specflow doc deprecate`

```bash
specflow doc deprecate <id> --note <s>
specflow doc deprecate PRD-005 --note "Superseded by knowledge graph; no direct successor."
```

Behaviour:

- Transitions `Accepted → Deprecated` (or updates the note on an already-Deprecated doc).
- `--note` is required — deprecation without a reason is forbidden.
- Sets `deprecation_note`, bumps `version`, stamps `last_reviewed`.

Acceptance criteria:

- [ ] `deprecate` without `--note` exits 2.
- [ ] Running `deprecate` on a Deprecated doc updates the note and bumps version.
- [ ] `deprecate` is forbidden on a Superseded doc (lifecycle matrix rejects).
- [ ] Audit entry records the note verbatim.

### `specflow doc bump`

```bash
specflow doc bump <id>
specflow doc bump ADR-011 --force
```

Behaviour:

- Increments `version` and stamps `last_reviewed: <today>`.
- No status change.
- Refuses on a doc with no uncommitted git changes unless `--force` is given.
- Audit entry records `verb: bump`, `fromStatus: null`, `toStatus: null`.

Acceptance criteria:

- [ ] `bump` on an unmodified doc exits 2 without `--force`.
- [ ] `bump` on a modified doc increments `version` and stamps `last_reviewed`.
- [ ] `bump` never changes status.
- [ ] `--force` usage is recorded in the audit entry.

### `specflow doc stamp`

```bash
specflow doc stamp --overdue
specflow doc stamp --id ADR-003 --id ADR-004 --yes
```

Behaviour:

- Re-dates `last_reviewed` across a selected set; does not bump `version`.
- `--overdue` selects every doc whose `ageInDays(now) > 90`.
- `--id <id>` selects named docs; may be repeated.
- Interactive by default: prints the affected set as a diff and prompts for confirmation.
- In non-TTY contexts without `--yes`, refuses to run.

Acceptance criteria:

- [ ] `stamp --overdue` with no overdue docs exits 0 as a no-op.
- [ ] `stamp` prints the impacted doc list before writing, even with `--yes`.
- [ ] `stamp` refuses in non-interactive shells without `--yes`.
- [ ] One audit entry is emitted per stamped doc.
- [ ] `stamp` never alters status or version.
- [ ] There is no `--all` flag; `--overdue` or explicit `--id` is required.

### `specflow doc revive`

```bash
specflow doc revive <id>
specflow doc revive PRD-005
```

Behaviour:

- Transitions `Deprecated → Accepted`.
- Clears `deprecation_note`, bumps `version`, stamps `last_reviewed`.
- Rejects Superseded docs (forbidden by the transition matrix).

Acceptance criteria:

- [ ] `revive` on a Deprecated doc transitions it back to Accepted.
- [ ] `revive` on a Superseded doc exits 2 with `TransitionError.Forbidden`.
- [ ] `deprecation_note` is cleared on success.
- [ ] Audit entry records `from: Deprecated, to: Accepted`.

---

## Extended Command: `specflow doctor --docs`

Adds a documentation-validation surface to the existing `doctor` command.

### Checks

| Check | Pass | Warn | Fail |
|-------|------|------|------|
| Frontmatter present | YAML block at top of every doc | — | Missing frontmatter |
| Required fields | All required fields present per status | — | Missing required field |
| Status transitions | Valid (per ADR-011 lifecycle) | — | Invalid (e.g., Superseded with no `superseded_by`) |
| Link reciprocity | Every `implements` has matching `implemented_by` | — | Missing reciprocal entry |
| Dangling links | All link targets exist | — | Link to non-existent ID |
| Stale links | No links to Superseded/Deprecated | Warn on stale links | — |
| Inbound to soft-deleted | Soft-deleted doc has no inbound references | Warn if Accepted doc links to it | — |

### Auto-Fix Mode

`specflow doctor --docs --fix` automatically:
- Mirrors `implements` ↔ `implemented_by` entries.
- Refuses to modify Superseded/Deprecated docs (reports manual-fix-required).

### Acceptance Criteria

- [ ] `specflow doctor --docs` validates frontmatter schema for all docs.
- [ ] Detects dangling references in `implements` / `implemented_by`.
- [ ] Detects missing reciprocal links.
- [ ] `--fix` mirrors links automatically and is idempotent.
- [ ] CI integration: non-zero exit on schema/dangling errors; zero exit on warnings.

---

## New Command: `specflow migrate-docs`

One-shot migration for existing docs from the legacy header-block style to YAML frontmatter.

```bash
specflow migrate-docs            # Migrate all docs in docs/architecture/
specflow migrate-docs --dry-run  # Preview without writing
```

### Behaviour

1. Walk `docs/architecture/**/*.md`.
2. For each doc without YAML frontmatter:
   - Parse the existing `**Status:**`, `**Date:**`, `**Depends on:**` lines.
   - Generate frontmatter with: `status: Accepted`, `version: 1`, `last_reviewed: <today>`, `date: <parsed>`, and `implements: [<parsed depends-on>]`.
3. After all docs are migrated, populate reciprocal `implemented_by` entries.
4. Idempotent — already-migrated docs are skipped.

### Acceptance Criteria

- [ ] Parses existing header conventions and converts to frontmatter.
- [ ] Populates reciprocal links automatically.
- [ ] `--dry-run` shows planned edits without writing.
- [ ] Idempotent.

---

## Truth Hierarchy in `CLAUDE-MD-TEMPLATE.md`

Add a new section to the template:

```markdown
## Spec Truth Hierarchy

When artefacts disagree, the higher-precedence one wins:

1. **Contracts** (`.specflow/contracts/*.yml`) — continuously verified against running code. Authoritative.
2. **ADRs** — document accepted decisions. Authoritative for decisions only.
3. **PRDs/DDDs** — describe a moment in time. Treat as historical context unless `last_reviewed` is recent.

If a narrative doc contradicts a contract, the contract is right. If you find divergence, either fix the code, fix the contract, or open a PR to update the doc — but never assume the narrative.
```

### Acceptance Criteria

- [ ] CLAUDE-MD-TEMPLATE.md gains the truth-hierarchy section.
- [ ] `specflow init` includes the section in the generated CLAUDE.md.
- [ ] `specflow status` displays a one-line banner: `Truth: contracts > ADRs > PRDs/DDDs.`

---

## Doctor Integration Summary

`specflow doctor` (without `--docs`) gains a single summary line for documentation health:

```
Documentation:  28 Accepted, 3 Superseded, 1 Deprecated.  3 overdue, 1 orphaned.  Run 'specflow review' for details.
```

---

## Edge Cases and Resolutions

| ID | Edge Case | Resolution |
|----|-----------|------------|
| E10-1 | Doc-only commits | `spec_coupling` is asymmetric; passes |
| E10-2 | Bulk mechanical refactors | Use `severity: warning` or `override_contract: spec_coupling` |
| E10-3 | New source files with no doc | Wildcard doc-glob; new doc satisfies the rule |
| E10-4 | Generated/vendored code | Use `exclude_globs` |
| E11-1 | Migrating existing docs | `specflow migrate-docs` is idempotent |
| E11-2 | Deprecating a referenced doc | Warning, not error |
| E11-5 | Draft docs and coupling | Only Accepted docs satisfy coupling |
| E12-3 | Stale links after soft-delete | Warning; suggest re-pointing |
| E12-7 | Dangling references | Error in `specflow doctor --docs` |

(Full edge cases are listed in the source ADRs.)

---

## Acceptance Criteria (Overall)

- [ ] `spec_coupling` contract type loads and evaluates against git diff state.
- [ ] `specflow doctor --docs` validates frontmatter, links, and lifecycle.
- [ ] `specflow doctor --docs --fix` mirrors links bidirectionally.
- [ ] `specflow review` reports overdue, orphaned, and stale-link docs.
- [ ] `specflow snapshot --on-ship` writes `versions.yml`.
- [ ] `specflow migrate-docs` migrates legacy header style to YAML frontmatter, idempotently.
- [ ] `CLAUDE-MD-TEMPLATE.md` includes the truth-hierarchy section.
- [ ] No file is deleted by any command in this PRD; soft-delete only.
- [ ] All commands respect existing `--diff` and `--staged` flags.
- [ ] Existing doc set is migrated and the new contracts pass on the current repo.
