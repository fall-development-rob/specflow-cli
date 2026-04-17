---
id: ADR-014
title: Document Entity and Type Registry
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-011
  - ADR-012
implemented_by:
  - ADR-015
  - DDD-008
---

# ADR-014: Document Entity and Type Registry

**Status:** Proposed
**Date:** 2026-04-17
**Depends on:** ADR-011 (Document Lifecycle and Frontmatter Schema), ADR-012 (Bidirectional Document Linking)

---

## Context

The Spec Integrity Toolkit (PRD-010) shipped with `Document` as a plain record — a bag of frontmatter fields with no behaviour. Classification logic (`current` / `overdue` / `orphaned` / `stale_links` / `soft_deleted`) lives on `DocumentRepository.findOverdue()`, `findOrphans()`, `findStaleLinks()`, and independently on `ReviewReporter.classify()`. The two implementations are not wired to each other; they agree today by convention and will drift.

The `DocumentType` and `DocumentStatus` unions are redeclared in at least seven places: `frontmatter.ts`, `document-repository.ts`, `review-reporter.ts`, `link-validator.ts`, `snapshot-ledger.ts`, `coupling-enforcer.ts`, and the hand-maintained validator table. Adding a new status (e.g., `Approved`) or type (e.g., `RFC`) requires touching each file and hoping nothing is missed.

DDD-007 declares a status lifecycle (Draft → Accepted → {Superseded, Deprecated}; Deprecated → Accepted allowed; Superseded → Accepted forbidden), but no code enforces it. The `Document.transitionTo()` method documented in DDD-007 does not exist. Hand-edits to frontmatter YAML bypass every invariant silently — a reviewer can flip `status: Superseded` to `status: Accepted` in vim and `specflow doctor --docs` will not object unless the required successor-field cleanup is also botched.

The three problems compound: duplicated enums make the lifecycle ambiguous; a behaviour-less entity has nowhere to host the lifecycle; no enforcement means the declared rules are aspirational.

---

## Decision

### 1. Promote `Document` to a Real Entity

`Document` becomes an entity with behaviour. Every classification, enforceability check, age computation, and status mutation goes through the entity — not through a free function in a reporter or a repository.

```typescript
class Document {
  constructor(
    private readonly path: string,
    private readonly frontmatter: DocumentFrontmatter,
    private readonly body: string,
    private readonly inboundReferences: Reference[]
  ) {}

  classify(now: Date): ReviewClassification;        // current | overdue | orphaned | stale_links | soft_deleted
  isEnforceable(): boolean;                         // true iff status === 'Accepted'
  ageInDays(now: Date): number;                     // days since last_reviewed
  transitionTo(newStatus: DocumentStatus, ctx: TransitionContext): Result<Document, TransitionError>;
}
```

`DocumentRepository` and `ReviewReporter` become orchestrators — they load entities, ask entities to classify themselves, and aggregate the answers. Neither holds classification rules.

### 2. Central `DocumentTypeRegistry`

A new module `ts-src/lib/document-types.ts` is the single allowlist for `DocumentType` and `DocumentStatus`. Every other module imports from it. The registry also owns:

- The list of valid types (`ADR`, `PRD`, `DDD`).
- The list of valid statuses (`Draft`, `Accepted`, `Superseded`, `Deprecated`).
- Per-status required fields (e.g., `Superseded` requires `superseded_by`).
- The allowed-transition matrix (consumed by `Document.transitionTo`).

Adding `RFC` as a new type, or `Approved` as a new status, becomes a one-file change. The parser, validator, enforcer, and reporter all pick up the addition without edits.

### 3. Lifecycle Enforced at the Entity Boundary

`Document.transitionTo(newStatus, ctx)`:

- Returns `Result<Document, TransitionError>`. Forbidden transitions never mutate and never throw; the caller handles the error.
- On an authorised transition, returns a new `Document` with `status` updated, `version` incremented, and `last_reviewed` stamped to `ctx.now`. The original entity is not mutated (immutable-value semantics).
- Populates or clears transition-dependent fields atomically: `superseded_by` is set on `→ Superseded` and cleared on `→ Accepted` (for a revived doc); `deprecation_note` is set on `→ Deprecated` and cleared on revival.
- Does not write to disk. Persistence is delegated to the `DocumentWriter` port (ADR-013) so the entity stays free of I/O.

The registry's transition matrix is the single source of truth for "allowed":

```
Draft       → Accepted                     allowed
Accepted    → Superseded                   allowed (requires successor)
Accepted    → Deprecated                   allowed (requires note)
Deprecated  → Accepted                     allowed (revival)
Superseded  → Accepted                     forbidden
Superseded  → Deprecated                   forbidden
Deprecated  → Superseded                   forbidden
any         → same status                  rejected as no-op
```

Any transition not in the matrix is forbidden by default.

---

## Edge Cases and Resolutions

### E14-1: Adding a New `DocumentType`

**Problem:** A future wave wants to track RFCs alongside ADRs/PRDs/DDDs.

**Resolution:** Add `'RFC'` to `DocumentTypeRegistry.TYPES` and add the corresponding directory (`docs/architecture/rfcs/`) to the walker. The parser, enforcer, reporter, and frontmatter validator pick it up without further edits. Existing YAML schema still validates because the id regex is extended in one place.

### E14-2: Adding a New `DocumentStatus`

**Problem:** A project wants `Approved` between `Draft` and `Accepted` for heavyweight sign-off.

**Resolution:** Add `'Approved'` to `DocumentTypeRegistry.STATUSES` and add the `Draft → Approved → Accepted` edges to the transition matrix. `isEnforceable()` remains `status === 'Accepted'` by default, or can be extended to `Accepted | Approved` with one registry edit.

### E14-3: Migrating Existing Duplicated Definitions

**Problem:** Seven files currently redeclare the type and status unions.

**Resolution:** A one-shot refactor replaces each inline union with `import { DocumentType, DocumentStatus } from './document-types'`. The refactor is mechanical and covered by existing schema tests; no behaviour change. No data migration is needed because the string values are identical.

### E14-4: Entity Hydration From Broken Frontmatter

**Problem:** A YAML file has `status: Superseded` but no `superseded_by` field.

**Resolution:** `Document.hydrate(frontmatter)` returns `Result<Document, HydrationError>`. Broken frontmatter never produces a half-valid entity that can then be asked to `classify()` or `transitionTo()`. The error is surfaced by `specflow doctor --docs`; downstream consumers see either a valid `Document` or an error, never an inconsistent one.

### E14-5: Entity Without Inbound References

**Problem:** A Document is loaded before the ReferenceWalker has run.

**Resolution:** `inboundReferences` defaults to an empty array; `classify()` with no inbound references on an Accepted doc returns `'orphaned'`. Callers that need accurate orphan status must populate inbound refs before classifying — this is DDD-008's `DocumentRegistry` responsibility, not the entity's.

### E14-6: Hand-Edited YAML Bypassing `transitionTo`

**Problem:** A reviewer edits `docs/architecture/adrs/ADR-007-*.md` directly and flips `status: Superseded` → `status: Accepted`, which `transitionTo` would forbid.

**Resolution:** `specflow doctor --docs` gains a lifecycle-integrity check: for each doc, it reconstructs the latest legal predecessor state from the file's git history and verifies the current state is reachable via the transition matrix. Illegal self-revival is surfaced as an error. This does not block all hand edits — bumps, stamps, and typo fixes are still free — but it prevents the specific bypass this ADR exists to close. The check is advisory in `--warn` mode and error-level by default.

---

## Consequences

### Positive

- One place to change when the type or status vocabulary evolves.
- `specflow review` and `specflow enforce` ask the same entity the same question and get the same answer, by construction.
- Forbidden transitions become impossible to perform through the tool; hand-edits are detectable.
- Entity immutability makes the lifecycle easy to unit-test without filesystem fixtures.

### Negative

- A one-shot refactor touches seven files to remove duplicated unions. Mechanical but noisy in diff.
- Call sites that previously wrote `doc.status = 'Accepted'` must switch to `doc.transitionTo('Accepted', ctx)`. Bounded impact; the codebase has fewer than a dozen such sites.
- The lifecycle-integrity check (E14-6) requires git-history access and is more expensive than current schema-only checks. Gated behind `--docs` to keep `specflow doctor` fast by default.

### Neutral

- `Document` moving from record to entity aligns the implementation with DDD-007's declared shape. No new concepts introduced; existing concepts made load-bearing.
- The registry becomes an obvious extension point for `RFC`, `Approved`, and project-specific lifecycles without further architectural change.
