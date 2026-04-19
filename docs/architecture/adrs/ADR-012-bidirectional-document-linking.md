---
id: ADR-012
title: Bidirectional Document Linking
type: ADR
status: Accepted
version: 1
date: '2026-04-16'
last_reviewed: '2026-04-17'
implements:
  - ADR-011
implemented_by:
  - ADR-013
  - ADR-014
  - ADR-016
  - DDD-007
---

# ADR-012: Bidirectional Document Linking

---

## Context

Today, ADRs cite the PRDs they decide on (`Depends on: PRD-001`), but PRDs do not list the ADRs that decide them. A reader looking at PRD-001 has no way to know ADR-002 was written about it without grepping. When one doc is edited, there is no way to discover which other docs need attention.

Bidirectional links are common in knowledge-graph systems (Roam, Obsidian, Foam). Manually maintaining them is tedious; auto-validating reciprocity from one direction is trivial.

This ADR makes the link graph a first-class, machine-checked structure.

---

## Decision

Use the `implements:` and `implemented_by:` frontmatter fields (defined in ADR-011) as the canonical link graph. `specflow doctor --docs` enforces reciprocity:

> If doc A has `implements: [B]`, then doc B must have `implemented_by: [A]`.

Authors edit either side; `specflow doctor --docs --fix` auto-mirrors the edit to the other side. Manual maintenance of both sides is not required.

### Link Semantics

| Field | Meaning |
|-------|---------|
| `implements: [PRD-001]` | This doc operationalises or makes a decision about PRD-001 |
| `implemented_by: [DDD-001]` | This doc is operationalised by DDD-001 |
| `superseded_by: ADR-015` | This doc has been replaced by ADR-015 (one-way; ADR-015 needn't backref) |
| `references: [https://owasp.org/...]` | External (non-Specflow) references; not subject to reciprocity |

### Typical Link Chain

```
PRD-010 ──implemented_by──▶ ADR-010 ──implemented_by──▶ DDD-007 ──implemented_by──▶ spec_coupling.yml
   ▲                            ▲                          ▲                           │
   └────── implements ──────────┴──── implements ──────────┴──── implements ───────────┘
```

Each step has both directions. Reviewers editing any node see all incident edges.

### Cross-Type Links

Contracts (`.specflow/contracts/*.yml`) participate in the link graph. The contract YAML schema gains an optional `implements: [<doc-id>]` field. `specflow doctor --docs` validates the reciprocal direction: if a doc lists a contract in `implemented_by`, the contract must list the doc in `implements`.

---

## Edge Cases and Resolutions

### E12-1: Many-to-Many Links

**Problem:** One ADR may implement multiple PRDs; one PRD may have multiple ADRs.

**Resolution:** Both fields are arrays. Reciprocity check requires every entry in A's `implements` to have A in its `implemented_by`. No cardinality constraints.

### E12-2: Cross-Type Links to Contracts

**Problem:** Can a contract YAML appear in a doc's `implemented_by`?

**Resolution:** Yes. Contract files carry an `id:` field; docs list them in `implemented_by`. The contract's existing schema gains an `implements:` field for the reciprocal direction.

### E12-3: Stale Links After Soft-Delete

**Problem:** Doc B is Superseded; doc A still has `implements: [B]`.

**Resolution:** `specflow doctor --docs` warns when an Accepted doc links to a Superseded/Deprecated doc, suggesting the user link to the successor (`B.superseded_by`). Warning, not error — bridge-period staleness is fine; long-term staleness is not.

### E12-4: External References

**Problem:** A doc references an external standard (RFC, OWASP guideline, blog post URL).

**Resolution:** Use a separate `references:` field for external links. Strings are interpreted as URLs or non-Specflow IDs. Not subject to reciprocity.

### E12-5: Auto-Fix Conflicts

**Problem:** `--fix` auto-mirrors a link, but the target doc is read-only (e.g., Superseded).

**Resolution:** `--fix` refuses to edit Superseded/Deprecated docs and reports a manual-fix-required error. Author must update the link to point to the successor instead.

### E12-6: Migration of Existing Links

**Problem:** Existing `Depends on:` lines in current docs are free-text, not structured.

**Resolution:** `specflow migrate-docs` (introduced in ADR-011) parses `Depends on:` lines, extracts referenced IDs (`ADR-XXX`, `PRD-XXX`, `DDD-XXX`), and populates `implements` on the source doc. Reciprocal `implemented_by` entries are auto-generated on the targets in the same pass.

### E12-7: Link to a Non-Existent Doc

**Problem:** A typo in `implements: [ADR-099]` references a doc that doesn't exist.

**Resolution:** `specflow doctor --docs` errors on dangling references — every ID in `implements`/`implemented_by` must resolve to a real doc.

---

## Consequences

### Positive

- A reviewer editing one doc immediately sees all incident edges.
- The link graph is queryable for impact analysis (`specflow audit <issue>` could later use it).
- Auto-fix mode keeps reciprocity costless to maintain.
- Dangling-reference detection catches typos and rename-without-update.

### Negative

- Cross-doc edits required when adding new links (mitigated by `--fix`).
- Authors must learn the link semantics (mitigated by a brief CLAUDE.md section).

### Neutral

- The link graph naturally feeds future visualisation (`specflow graph` could render it).
- Reciprocity is a strong invariant — easy to validate, hard to silently violate.
