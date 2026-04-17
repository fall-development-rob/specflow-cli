---
id: PRD-011
title: Spec Integrity Toolkit v1.1 — Correctness, Verbs, and Reach
type: PRD
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-016
  - ADR-017
implemented_by: []
---

# PRD-011: Spec Integrity Toolkit v1.1 — Correctness, Verbs, and Reach

**Status:** Accepted
**Date:** 2026-04-17
**Phase:** 12.1
**Depends on:** PRD-010 (Spec Integrity Toolkit v1), ADR-016, ADR-017
**Implements:** ADR-016, ADR-017 (ADR-013, ADR-014, ADR-015 referenced below once authored by sibling lanes)
**Implemented By:** —

---

## Overview

PRD-010 landed the v1 Spec Integrity Toolkit: frontmatter schema, link
reciprocity, `spec_coupling`, `review`, `snapshot`, and `doctor --docs`.
The reviewer synthesis that followed the v1 release identified ten
follow-up items grouped into three themes:

1. **Correctness** (ADR-013) — pathing, diff scope, and atomic-write
   gaps in the v1 implementation that cause false negatives.
2. **Entity refactor and lifecycle verbs** (ADR-014, ADR-015) — a
   unified `Document` entity and a verb family (`accept`, `supersede`,
   `deprecate`, `revive`) that compress common workflows.
3. **Reach and safety** (ADR-016, ADR-017) — upward traceability,
   typed links, HTML review site, owners, and YAML-parsing security.

This PRD bundles all ten items into a single v1.1 release with explicit
sequencing: correctness first (so subsequent layers sit on a correct
foundation), then the entity refactor (so verbs have a coherent model
to operate on), then verbs (so typed links and HTML have a well-defined
lifecycle to render), then reach (which depends on all of the above).

---

## Goals

1. **Close the correctness gaps** from v1 (path handling, diff scope,
   atomic ledger writes) so no false negatives remain.
2. **Unify the in-memory model** around a single `Document` entity so
   every command reads the same source of truth.
3. **Compress common workflows** (accept a Draft, supersede a doc,
   deprecate a doc, revive a Deprecated doc) into first-class verbs
   with idempotent behaviour and schema validation.
4. **Deliver the reach features** that bring Specflow to parity with
   Log4brains / sphinx-needs while preserving its unique
   contract-root position.
5. **Harden YAML parsing** across all untrusted inputs (frontmatter,
   ledger) so Specflow cannot be used to exfiltrate or crash CI.
6. **Preserve backward compatibility** for every existing doc — no
   hard-required migration; every new field is optional.
7. **Ship the whole bundle in one sequenced release** so reviewers
   adopt the full workflow rather than a fragmented subset.

## Non-Goals

1. **No full CMS.** Specflow is not a document management system;
   docs remain markdown files on disk.
2. **No graph database.** The link graph is materialised from
   frontmatter at runtime; persistence stays file-backed.
3. **No auto-deprecation.** Verbs require a human invocation; the
   review command still reports and suggests without writing.
4. **No semantic diff.** AST-level coupling analysis is explicitly
   deferred to v1.2. Path-based coupling remains the v1.1 mechanism.

---

## Commands

This PRD introduces and extends commands across the five ADRs. Items
marked *new* did not exist in PRD-010; items marked *extended*
modify existing v1 commands.

| Command | Status | Owner ADR |
|---------|--------|-----------|
| `specflow enforce --diff <scope>` | extended (S2) | ADR-013 |
| `specflow snapshot --on-ship` | extended (S3) | ADR-013 |
| `specflow doctor --docs` | extended (S4, S6) | ADR-014, ADR-017 |
| `specflow accept <id>` | new (S5) | ADR-015 |
| `specflow supersede <old> <new>` | new (S5) | ADR-015 |
| `specflow deprecate <id> --note "<reason>"` | new (S5) | ADR-015 |
| `specflow revive <id>` | new (S5) | ADR-015 |
| `specflow audit --contract <id>` | new (S7) | ADR-016 |
| `specflow review --html` | extended (S7) | ADR-016 |
| `specflow review --owner @team` | extended (S7) | ADR-016 |
| `specflow review --by-owner` | extended (S7) | ADR-016 |

Detailed command specs are owned by their respective ADRs. This PRD
captures the delivery slicing and overall acceptance.

---

## Delivery Slices

Each slice is scoped so it can be merged independently, has its own
tests, and does not break earlier slices. Slices must land in order;
each depends only on what precedes it.

### S1 — Path Fix + Minimatch

**Scope.** Fix path-handling bugs identified in ADR-013:
back-slashed Windows paths, symlinked `docs/architecture/` roots,
and globs that fail to match absolute vs relative file paths.

**Files touched.**
- `ts-src/lib/native.ts` (path normalisation shim)
- `ts-src/commands/enforce.ts` (diff-file path handling)
- `ts-src/commands/doctor.ts` (doc walker normalisation)
- `tests/enforce/path-normalisation.test.js` (new)

**Acceptance.**
- [ ] Path matching works on Windows, macOS, and Linux CI runners.
- [ ] Symlinked `docs/architecture/` roots are walked correctly.
- [ ] `minimatch` globs match identically whether the diff is
      absolute-path or repo-relative.
- [ ] Existing contract tests continue to pass.

### S2 — Harden gitDiffScope

**Scope.** Per ADR-013, the `--diff` flag accepts user-supplied
revision ranges without sanitisation. Harden the parser to reject
shell-metacharacter injection and constrain acceptable inputs to
`<ref>..<ref>`, `<ref>...<ref>`, `--staged`, or a commit SHA.

**Files touched.**
- `ts-src/lib/git-diff.ts` (scope validator)
- `ts-src/commands/enforce.ts`
- `tests/enforce/git-diff-scope.test.js` (new)

**Acceptance.**
- [ ] Inputs containing `;`, `|`, `&&`, backticks, or `$(...)` are
      rejected with a clear error.
- [ ] Valid ranges (`origin/main..HEAD`, `HEAD~3..HEAD`, a bare SHA)
      continue to work.
- [ ] The contract engine's internal `child_process` calls are routed
      through a safe spawn helper with argument arrays, not shell
      strings.

### S3 — Atomic Writes Port

**Scope.** Per ADR-013, `snapshot --on-ship` writes `versions.yml`
with a simple `fs.writeFileSync`. Port the write path to the
established atomic-write helper used elsewhere in the CLI
(write-temp-and-rename).

**Files touched.**
- `ts-src/lib/atomic-write.ts` (existing helper; extended if needed)
- `ts-src/commands/snapshot.ts`
- `ts-src/lib/snapshot-ledger.ts`
- `tests/snapshot/atomic-write.test.js` (new)

**Acceptance.**
- [ ] `versions.yml` is never observed in a partial state by a
      concurrent reader.
- [ ] Crash-during-write leaves either the old or new version intact,
      never a truncated file.
- [ ] Snapshot re-run after a crash is still idempotent.

### S4 — Document Entity + Registry

**Scope.** Per ADR-014, replace the current ad-hoc `{ path, fm, body }`
tuple used across `doctor`, `review`, `snapshot` and `enforce` with a
single `Document` entity and a `DocumentRegistry` aggregate root.

**Files touched.**
- `ts-src/domain/document.ts` (new entity)
- `ts-src/domain/document-registry.ts` (new registry)
- `ts-src/commands/doctor.ts` (migrate to registry)
- `ts-src/commands/review.ts` (migrate to registry)
- `ts-src/commands/snapshot.ts` (migrate to registry)
- `tests/domain/document.test.js` (new)

**Acceptance.**
- [ ] A single load of `docs/architecture/**` produces one registry
      that every command reads from.
- [ ] No command re-walks the filesystem after registry load.
- [ ] Existing test suites pass without change (registry is a
      refactor, not a behaviour change).

### S5 — Lifecycle Verbs

**Scope.** Per ADR-015, add four lifecycle verbs as first-class CLI
commands: `accept`, `supersede`, `deprecate`, `revive`. Each verb
mutates a single doc's frontmatter, validates the transition against
ADR-011's lifecycle state machine, and writes atomically.

**Files touched.**
- `ts-src/commands/accept.ts` (new)
- `ts-src/commands/supersede.ts` (new)
- `ts-src/commands/deprecate.ts` (new)
- `ts-src/commands/revive.ts` (new)
- `ts-src/lib/lifecycle.ts` (transition validator)
- `ts-src/cli.ts` (command routing)
- `tests/commands/lifecycle-verbs.test.js` (new)

**Acceptance.**
- [ ] `specflow accept <id>` Draft -> Accepted, stamps
      `last_reviewed: <today>`.
- [ ] `specflow supersede <old> <new>` sets `old.status: Superseded`,
      `old.superseded_by: <new>`, and inserts the reciprocal link on
      `<new>`.
- [ ] `specflow deprecate <id> --note "<reason>"` sets
      `status: Deprecated` and `deprecation_note`.
- [ ] `specflow revive <id>` Deprecated -> Accepted; refuses on
      Superseded docs per ADR-011 E11-6.
- [ ] Each verb is idempotent when re-run.
- [ ] Invalid transitions exit non-zero with a clear message.

### S6 — YAML Security + Doctor Body Check

**Scope.** Per ADR-017, land the four YAML hardening rules:

1. FAILSAFE schema for frontmatter and ledger parsing.
2. Duplicate-key rejection.
3. `Map`-backed / `Object.create(null)` ledger root with deny-listed
   tag names.
4. Body-consistency check in `doctor --docs` for
   `**Status:**` / `**Date:**` / `**Depends on:**`.

**Files touched.**
- `ts-src/lib/safe-yaml.ts` (new wrapper)
- `ts-src/lib/frontmatter-parser.ts` (switch to wrapper)
- `ts-src/lib/snapshot-ledger.ts` (Map-backed)
- `ts-src/commands/doctor.ts` (body-consistency check)
- `.specflow/contracts/doc_body_consistency.yml` (new — this PRD)
- `.specflow/contracts/yaml_safety.yml` (new — this PRD)
- `tests/security/yaml-hardening.test.js` (new)
- `tests/doctor/body-consistency.test.js` (new)

**Acceptance.**
- [ ] Frontmatter with anchors / aliases fails to parse with a clear
      "FAILSAFE rejects aliases" error.
- [ ] Duplicate top-level keys in frontmatter fail parsing.
- [ ] Ledger tag `__proto__` is rejected with
      `ProtoKeyRejectedError`.
- [ ] Body `**Status:**` that disagrees with frontmatter fails
      `doctor --docs`.
- [ ] `<!-- specflow-ignore:body-drift -->` suppresses the next-line
      check.
- [ ] Existing docs pass `doctor --docs` after one-shot cleanup.

### S7 — Traceability + HTML Review + Typed Links + Owners

**Scope.** Per ADR-016, land the four reach features:

1. `specflow audit --contract <id>` upward walker.
2. Typed link fields (`tests`, `blocks`, `contradicts`, `owned_by`)
   in frontmatter, with independent reciprocity checks.
3. `specflow review --html` static-site emitter.
4. `owners:` field + `review --owner`, `review --by-owner`.

**Files touched.**
- `ts-src/commands/audit.ts` (extend)
- `ts-src/lib/upstream-walker.ts` (new)
- `ts-src/lib/html-review.ts` (new)
- `ts-src/commands/review.ts` (extend)
- `ts-src/domain/document.ts` (typed-link fields)
- `ts-src/lib/link-reciprocity.ts` (typed-edge reciprocity)
- `.specflow/review/` (gitignore entry)
- `tests/audit/contract-upstream.test.js` (new)
- `tests/review/html.test.js` (new)
- `tests/review/owners-filter.test.js` (new)

**Acceptance.**
- [ ] `specflow audit --contract SEC-003` prints the upstream chain
      with version and `last_reviewed` age inlined.
- [ ] `audit --contract` on a rootless contract prints
      `(none)` and exits zero.
- [ ] `tests: [X]` on doc A requires `tested_by: [A]` on X when X
      is a doc.
- [ ] `review --html` writes an idempotent directory replacement
      under `.specflow/review/`.
- [ ] `review --owner @team-platform` filters to owned docs.
- [ ] Docs without `owners` appear under `unassigned` in
      `review --by-owner`.

---

## Edge Cases

The per-feature edge cases are owned by ADR-013, ADR-014, ADR-015,
ADR-016, and ADR-017 (E13-*, E14-*, E15-*, E16-*, E17-*). This PRD
adds two cross-cutting edge cases that only arise when multiple
slices land together.

### E11.1-1: Verb Fires During `--diff` Evaluation

**Problem.** A developer runs `specflow accept ADR-XXX` inside a
pre-commit hook that also runs `specflow enforce --staged`. The
frontmatter mutation races against the coupling evaluation.

**Resolution.** Lifecycle verbs acquire an advisory file lock on
`docs/architecture/.specflow-lock` for the duration of their write.
`enforce` waits on the lock if the verb is in progress. Lock is a
single-writer / many-reader design; the verb never holds the lock
for more than the write+fsync.

### E11.1-2: HTML Site Contains Pre-Migration Contradictions

**Problem.** `review --html` runs while S7 is live but before a
follow-up pass has cleaned up typed-link backfill. The
`contradicts` panel shows noise from unintentional legacy links.

**Resolution.** The HTML panel for `contradicts` is hidden by
default and surfaced via the `?show=contradicts` query string in
v1.1. Upgraded to visible-by-default in v1.2 once backfill is
complete.

---

## Acceptance Criteria (Overall)

- [ ] S1-S7 land in order; each slice passes its own tests before
      the next begins.
- [ ] `specflow doctor .` passes on the Specflow repo itself.
- [ ] `specflow doctor --docs .` passes on the Specflow repo itself
      after the body-consistency cleanup.
- [ ] `specflow enforce --diff origin/main..HEAD` runs cleanly on a
      representative PR without false positives on mechanical
      changes.
- [ ] No v1 doc requires manual re-authoring; typed links and
      `owners` are opt-in.
- [ ] `specflow audit --contract SEC-003` returns the full upstream
      chain for an existing security rule.
- [ ] `specflow review --html` produces a browsable site at
      `.specflow/review/index.html` with no build step.
- [ ] YAML parser rejects aliases, duplicate keys, and `__proto__`
      tags across all surfaces.
- [ ] `doctor --docs` catches frontmatter↔body drift, closing the
      loop on the issue that motivated this PRD.
- [ ] Existing tests pass; new test suites land alongside each
      slice.
