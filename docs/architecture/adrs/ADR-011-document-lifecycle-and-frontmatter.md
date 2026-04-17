---
id: ADR-011
title: Document Lifecycle and Frontmatter Schema
type: ADR
status: Accepted
version: 2
date: '2026-04-16'
last_reviewed: '2026-04-17'
implements:
  - ADR-010
implemented_by:
  - ADR-012
  - ADR-013
  - ADR-014
  - ADR-015
  - ADR-017
  - DDD-007
---

# ADR-011: Document Lifecycle and Frontmatter Schema

**Status:** Proposed
**Date:** 2026-04-16
**Depends on:** ADR-010 (Specs as Enforced Artefacts)

---

## Context

Today, ADRs/PRDs/DDDs use a `Status:` line that flips between `Draft` and `Accepted`. There is no way to:

- Mark a doc as **Superseded** by a specific newer doc.
- **Soft-delete** a doc that is no longer load-bearing without removing it from the repo.
- Record **when a doc was last reviewed** so the quarterly sweep is auditable.
- **Snapshot which version** of an ADR matched a shipped commit.

Narrative docs decay; the question is whether the decay is visible. The user has explicitly asked that nothing be deleted from the repo — stale docs should be marked, not removed. The terminal states need to be browseable so a future reader can tell at a glance: "this doc is history, not current truth."

This ADR defines the substrate. ADR-012 (link reciprocity) and PRD-010 (`specflow review`) consume it.

---

## Decision

### YAML Frontmatter Schema

Every doc in `docs/architecture/` carries a YAML frontmatter block:

```yaml
---
id: ADR-011
title: Document Lifecycle and Frontmatter Schema
type: ADR                    # ADR | PRD | DDD
status: Accepted             # Draft | Accepted | Superseded | Deprecated
version: 1                   # Monotonic integer; bumped on material edits
last_reviewed: 2026-04-16    # ISO date; updated by quarterly review
date: 2026-04-16             # Original authorship date
implements: [PRD-010]        # IDs this doc operationalises (see ADR-012)
implemented_by: [DDD-007]    # IDs that operationalise this doc (see ADR-012)
superseded_by: ADR-015       # Required iff status: Superseded
deprecation_note: "Replaced by inline contract docs"  # Required iff status: Deprecated
---
```

### Status Lifecycle

```
   Draft ──accept──▶ Accepted ──supersede──▶ Superseded
                            ╲
                             ╲──deprecate──▶ Deprecated
```

| Status | Meaning | Enforcement Treatment |
|--------|---------|----------------------|
| **Draft** | Work in progress | Excluded from `spec_coupling`; visible to humans only |
| **Accepted** | Live, authoritative | Subject to all checks (coupling, link reciprocity, review cadence) |
| **Superseded** | Replaced by a specific newer doc; `superseded_by` required | Excluded from enforcement; remains in repo for history |
| **Deprecated** | No longer load-bearing, no replacement; `deprecation_note` required | Excluded from enforcement; remains in repo |

Both `Superseded` and `Deprecated` are **soft deletes** — the file is never removed from the repo. The terminal states keep history browseable while removing the doc from the active enforcement surface.

### Version Field

`version` is a monotonic integer (`1`, `2`, ...) that authors bump on material edits. On a tagged release, `specflow snapshot --on-ship` walks docs touched in the release and writes a sidecar:

```yaml
# docs/architecture/versions.yml
v1.0.0:
  commit: abc123
  date: 2026-04-16
  docs:
    ADR-010: 1
    ADR-011: 1
    PRD-010: 1
v1.1.0:
  commit: def456
  date: 2026-05-20
  docs:
    ADR-010: 2     # Bumped
    PRD-010: 1
```

A reader can reconstruct what any doc said at any release without git archaeology.

### Last-Reviewed Field

A reviewer sets `last_reviewed: <ISO date>` during the quarterly sweep. `specflow review` (PRD-010) flags any Accepted doc with `last_reviewed` >90 days old.

---

## Edge Cases and Resolutions

### E11-1: Migrating Existing Docs

**Problem:** ~25 existing docs use a header-block style, not YAML frontmatter.

**Resolution:** Provide `specflow migrate-docs` (one-shot command) that parses the existing header block and writes equivalent YAML frontmatter. Defaults: `status: Accepted`, `version: 1`, `last_reviewed: <today>`. Idempotent — re-runs are safe.

### E11-2: Deprecating a Doc Cited Elsewhere

**Problem:** A user wants to deprecate an ADR still referenced from a contract or another Accepted doc.

**Resolution:** `specflow doctor --docs` warns when a Deprecated/Superseded doc has inbound references from code, contracts, or Accepted docs. Warning, not error — the user may have legitimate reasons, but the warning makes the staleness visible.

### E11-3: Status Transition Validation

**Problem:** Someone marks a doc Superseded without filling `superseded_by`.

**Resolution:** Schema validation in `specflow doctor --docs`. Required fields vary by status:
- `Superseded` requires `superseded_by`.
- `Deprecated` requires `deprecation_note`.
- All statuses require `id`, `title`, `type`, `version`, `date`, `last_reviewed`.

CI fails on schema violation.

### E11-4: Version Sidecar vs Frontmatter

**Problem:** Stamping the release tag into every doc on every release would bloat commits.

**Resolution:** The `version:` field in the doc is hand-bumped by authors on material edits. The release-time mapping (which version of which doc shipped at which release) is recorded in the single sidecar `docs/architecture/versions.yml`. Two distinct concerns, two distinct files.

### E11-5: Draft Docs and Coupling

**Problem:** A Draft doc shouldn't satisfy `spec_coupling` if the code is shipping.

**Resolution:** Coupling enforcement only counts Accepted docs as "satisfying" a coupled change. Editing a Draft doc does not satisfy the rule.

### E11-6: Reviving a Deprecated Doc

**Problem:** A Deprecated decision becomes relevant again.

**Resolution:** Allowed transitions: `Deprecated → Accepted` (with new `last_reviewed` date and version bump). `Superseded → Accepted` is blocked — supersession implies a successor exists; if circumstances change, write a new ADR rather than reviving an old one.

### E11-7: Frontmatter in Non-Architecture Docs

**Problem:** Docs outside `docs/architecture/` (READMEs, guides) don't need this schema.

**Resolution:** Schema enforcement is scoped to `docs/architecture/**/*.md` (configurable). Other docs are unaffected.

### E11-8: Atomic Writes Required for Frontmatter Mutation

**Problem:** Every frontmatter mutation path — `link-validator.fix` (`implements`/`implemented_by` reciprocation), `snapshot-ledger.write` (versions.yml append), and `migrate-docs` (legacy header → YAML frontmatter rewrite) — uses a truncating `fs.writeFileSync`. A crash, SIGTERM, or ENOSPC mid-write truncates the file, corrupting the frontmatter or leaving an invalid YAML block. Concurrent `snapshot` invocations race on `versions.yml` with last-writer-wins and no detection. The toolkit's promise that "no document is ever removed" is violated by a partial-write leaving a file that parses to nothing.

**Resolution:** ADR-013 D13-5 (via DDD-007's new `DocumentWriter` port) mandates `writeAtomic(path, content)` — write to a sibling temp file in the same directory, `fsync`, then `rename` into place. Rename is atomic on POSIX filesystems and on NTFS. Every mutation path in the Spec Integrity domain goes through this port; direct `fs.writeFileSync` calls on frontmatter-bearing files are forbidden at the domain boundary.

---

## Consequences

### Positive

- Soft-delete via Superseded/Deprecated keeps history without misleading readers.
- Machine-readable frontmatter unlocks `doctor`, `review`, and `snapshot` commands.
- Lifecycle states make decay visible rather than silent.
- The version sidecar provides cheap historical reconstruction without git archaeology.

### Negative

- Existing docs need migration (one-shot, scripted).
- More frontmatter discipline required from authors (mitigated by schema validation).

### Neutral

- The status hierarchy mirrors patterns common elsewhere (RFCs, IETF drafts, Kubernetes deprecation policy).
- `versions.yml` becomes a single source of release-time truth, complementing git tags.
