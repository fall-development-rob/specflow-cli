---
id: ADR-016
title: Contract-Root Traceability, Typed Links, HTML Review Site, Owners
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-010
  - ADR-012
implemented_by:
  - PRD-011
---

# ADR-016: Contract-Root Traceability, Typed Links, HTML Review Site, Owners

**Status:** Accepted
**Date:** 2026-04-17
**Depends on:** ADR-010 (Specs as Enforced Artefacts), ADR-012 (Bidirectional Document Linking)

---

## Context

A reviewer survey of the adjacent tooling space (Log4brains, sphinx-needs,
ADR-tools, Backstage TechDocs, Kubernetes KEPs) confirmed a simple finding:
**no other tool treats executable contracts as the authoritative root of
lineage.** Every competitor treats narrative documents as the primary
artefact and code as the leaf. Specflow is the inverse — contracts are
continuously verified against running code, and narrative docs orbit them.

Today Specflow's link graph flows only downward:

```
PRD → ADR → DDD → contract
```

A reviewer looking at an active rule (for example `SEC-003`) cannot ask
"which decisions authorise this rule and when were they last reviewed?"
without manual grep. There is no upward walk from a contract to the docs
that decided it, and no single view that renders the full lineage with
freshness inlined.

Beyond the missing upward walk, the survey identified four other gaps
relative to best-in-class tools:

1. **No typed link semantics.** Only `implements` / `implemented_by` exist.
   sphinx-needs distinguishes `tests`, `blocks`, `contradicts`, etc.
2. **No static HTML review site.** Log4brains' static-site generator is
   the single most-praised feature of that tool; reviewers browse without
   installing anything.
3. **No ownership field.** Backstage and CODEOWNERS expose ownership; a
   reviewer today cannot filter overdue docs to "my team's docs".
4. **No graph visualisation.** The link graph exists in memory during
   `doctor --docs` but is never rendered.

The defensible, uniquely-Specflow capability in this list is **upward
contract traceability** — the thing no competitor can implement because
no competitor has a live rule engine to walk upward from. The HTML site,
typed links, and ownership field are table-stakes parity; contract-root
traceability is the moat.

This ADR records the decision to close all four gaps in one coordinated
release (PRD-011), with contract-root traceability as the headline
feature.

---

## Decision

Four capabilities are added to the Spec Integrity domain. Each is
designed to degrade gracefully on docs/contracts that do not adopt the
new fields, so migration is incremental.

### 1. Upward Traceability via `specflow audit --contract <id>`

A new form of the existing `audit` command walks from a contract id
upward through the link graph, inverting the existing downward walk.

```
$ specflow audit --contract SEC-003
SEC-003 — No innerHTML with unsanitized dynamic content
  declared in: .specflow/contracts/security_defaults.yml
  last_reviewed: 2026-04-17 (0 days ago)

Upstream authorisation chain:
  security_defaults.yml
    ← DDD-007  Spec Integrity Domain Design           v1  Accepted  reviewed 0d
    ← ADR-010  Specs as Enforced Artefacts            v1  Accepted  reviewed 0d
    ← ADR-012  Bidirectional Document Linking         v1  Accepted  reviewed 0d
    ← PRD-010  Spec Integrity Toolkit                 v1  Accepted  reviewed 0d
```

The walker inverts the `implements` / `implemented_by` graph. Starting
from the contract id it follows `implements` edges upward, rendering each
visited node with id, title, version, status, and `last_reviewed` age
inlined. Cycles terminate the walk at the first re-visit. Nodes with
missing or stale frontmatter are rendered with a `[stale]` marker, not
silently dropped.

A contract does not need its own frontmatter to be walked — the
`rules[].id` -> contract-file mapping is sufficient for discovery. The
walker then follows any doc whose `implemented_by` list contains either
the contract file id or the rule id.

### 2. Typed Links in Frontmatter

Frontmatter gains four optional typed link fields alongside the existing
`implements`:

```yaml
implements:   [PRD-010]              # unchanged — default semantic
tests:        [SEC-003]              # this doc describes tests for a rule
blocks:       [ADR-014]              # this doc is a blocker for another
contradicts:  [ADR-007]              # this doc contradicts another (hazard)
owned_by:     ['@team-platform']     # see section 4
```

Rules:

- Every typed list is optional. Older docs without any of these fields
  are fully valid.
- Each typed field participates in reciprocity independently. `tests: [X]`
  on doc A requires `tested_by: [A]` on target X if X is a doc (not a
  contract or rule id).
- `contradicts` is intentionally one-way. The listed doc is not required
  to backref. `doctor --docs` surfaces contradicts edges as warnings so
  reviewers see hazards.
- Typed-link fallback: if a doc omits all typed fields, it behaves
  exactly as today (backward-compatible).
- The contract walker honours `tests` as an alternative upstream edge:
  a contract cited by `tests: [SEC-003]` on a DDD shows that DDD in the
  upward chain, labelled `(tests)`.

### 3. `specflow review --html` — Static Review Site

A new flag on the existing `review` command emits a self-contained
static site under `.specflow/review/`:

```
.specflow/review/
├── index.html                 # Landing page with per-classification panels
├── graph.html                 # Force-directed link graph (D3 or cytoscape)
├── lineage/<id>.html          # Per-rule / per-doc lineage pages
├── data/
│   ├── documents.json         # Embedded frontmatter for all docs
│   ├── contracts.json         # Contract ids + rule ids + sources
│   └── edges.json             # All typed link edges
└── assets/
    └── review.js              # Single minified script (no build step)
```

The site renders:

- The four classification panels (current / overdue / orphaned / stale
  links) already computed by `specflow review`.
- A force-directed link graph coloured by type (`implements`, `tests`,
  `contradicts`, etc).
- Per-rule lineage pages (one per contract rule id) showing the upward
  walk defined in section 1.
- Ownership filters (section 4) — query-string filterable
  (`?owner=@team-platform`).

Constraint: **no build step**. The site is plain HTML + embedded JSON +
one hand-written script. It can be opened by `file://` without a server.
CI publishes it to the repo's static host (for example GitHub Pages) by
copying the directory.

### 4. `owners:` Frontmatter Field

Frontmatter gains an optional `owners:` list of team handles. Teams are
free-form strings starting with `@`; validation is syntactic only.

```yaml
owners:
  - '@team-platform'
  - '@team-docs'
```

Consumers:

- `specflow review --owner @team-platform` filters the report to docs
  whose `owners` list contains the given handle.
- The overdue report can be split per-team (`review --by-owner`),
  enabling per-team summary dispatch to Slack/email from CI.
- The HTML site's filter bar filters by owner as a first-class facet.

Ownership is advisory — no rule requires it. Docs without `owners` are
reported under `owner: unassigned` in team-filtered views.

---

## Edge Cases and Resolutions

### E16-1: Contract Referenced by No Doc (Rootless Leaf)

**Problem:** A contract rule exists but no ADR/PRD/DDD has it in
`implemented_by`. The upward walk returns an empty chain.

**Resolution:** `audit --contract` still prints the contract row,
followed by `Upstream authorisation chain: (none)`. `doctor --docs`
adds an informational check "contracts with no upstream authorisation"
that lists rootless rules. Not an error — greenfield contracts start
here — but visible.

### E16-2: Cyclic Backward Walks

**Problem:** Typed links could create cycles — A `implements` B, B
`tests` A.

**Resolution:** The walker maintains a visited set keyed by doc id.
First re-visit terminates that branch with `(cycle)` marker. The report
does not fail; cycles are a frontmatter authoring issue surfaced by
`doctor --docs` as a warning.

### E16-3: Unauthorised Owners Syntax

**Problem:** A user writes `owners: [team-platform]` (no `@`) or
`owners: "team-platform"` (string instead of list).

**Resolution:** Schema validation in `doctor --docs` enforces:
- `owners` must be a list.
- Each entry must be a string matching `/^@[a-z0-9][a-z0-9-_\/]*$/i`.

Validation failure is a warning (not an error) in v1 so owners adoption
is frictionless; promoted to error in a later release once adoption is
complete.

### E16-4: `--html` Regeneration Idempotence

**Problem:** Re-running `review --html` should not accumulate stale
files or leave mixed versions if a doc is deleted between runs.

**Resolution:** `review --html` writes to a temp directory and
atomic-renames it over `.specflow/review/`. Directory is fully replaced
on each run. Any `.specflow/review/` contents from a previous run are
discarded. The site therefore always reflects exactly the current
filesystem state.

### E16-5: Contracts With No `implements:` Metadata

**Problem:** Existing contract YAMLs do not have an `implements:` field
at the top level — only doc-side `implemented_by` drives the link.

**Resolution:** The walker accepts both directions as discovery sources.
It builds the upstream chain by finding every doc with the contract id
(or rule id) in its `implemented_by`. Contracts gain an optional
top-level `implements: [<doc-id>]` field (already envisaged by ADR-012)
but it is not required for `audit --contract` to function.

### E16-6: Typed-Link Fallback on Older Frontmatter

**Problem:** Many existing docs pre-date typed links. Asking the walker
to honour `tests` / `blocks` / `contradicts` must not break on docs
that never carried those fields.

**Resolution:** All typed-link fields are optional. A missing field is
treated as an empty list. Reciprocity checks only fire against docs
that opted in by declaring the typed field. Zero migration is required.

---

## Consequences

### Positive

- Reviewers gain a single command (`audit --contract`) that answers
  "why does this rule exist?" — a question that today requires manual
  grep and tribal knowledge.
- Typed links close the semantic gap with sphinx-needs without forcing
  every doc to adopt them.
- The static HTML site matches Log4brains' reviewer UX and is
  deployable on any static host with zero build tooling.
- Ownership unlocks per-team review dispatch and overdue alerts.
- Specflow's unique position — contracts as root — becomes legible to
  new contributors in the first minute of using the tool.

### Negative

- Four new concepts land in one release; authors will encounter them in
  various combinations. Mitigated by each being optional and
  backward-compatible.
- The HTML site introduces an output directory that must be gitignored
  or committed deliberately.
- Typed links double the number of reciprocity checks `doctor --docs`
  performs; performance remains O(edges) but the constant grows.

### Neutral

- `audit --contract` reuses the existing `audit` command surface, so no
  new top-level verb is required.
- Ownership syntax intentionally matches CODEOWNERS (`@team-name`) for
  easy interop with existing GitHub workflows.
- The HTML emitter and the graph are both optional — a project that
  wants only the text `review` output loses nothing.
