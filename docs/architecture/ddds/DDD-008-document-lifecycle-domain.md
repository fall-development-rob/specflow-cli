---
id: DDD-008
title: Document Lifecycle Domain Design
type: DDD
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-014
  - ADR-015
implemented_by: []
---

# DDD-008: Document Lifecycle Domain Design

---

## Domain Overview

The Document Lifecycle domain is the behavioural layer that sits on top of DDD-007's Spec Integrity domain. DDD-007 models documents, links, coupling rules, and reports — a classification and enforcement surface. DDD-008 models the **mutations** that move documents through their lifecycle: accept, supersede, deprecate, bump, stamp, revive. It owns the entity-level invariants, the transition matrix, the audit trail, and the verb-to-transition mapping exposed by the `specflow doc` command family (ADR-015).

The two domains share the same bounded context. `DocumentRegistry` in this DDD is a specialisation of DDD-007's `DocumentRepository` aggregate — same root, richer behaviour, additional invariants. Nothing in DDD-007 is replaced; behaviour promoted from free functions into entities, and new aggregates added for orchestration and audit.

The domain is consumed by:

- `specflow doc <verb>` — the primary client (ADR-015).
- `specflow doctor --docs` — reads the transition matrix to surface lifecycle-integrity errors (ADR-014 E14-6).
- `specflow review` — calls `Document.classify()` rather than hosting its own classification logic.
- `specflow enforce` — calls `Document.isEnforceable()` for coupling decisions.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Entity** | A `Document` with identity, behaviour, and invariants — not a plain record. Every classification and transition is an entity method call. |
| **Type Registry** | The single module (`document-types.ts`) owning the allowlist of `DocumentType`, `DocumentStatus`, required-field-per-status, and the transition matrix. |
| **Transition** | A named, validated move from one `DocumentStatus` to another. Expressed as a `StatusTransition` value object. |
| **Verb** | A user-facing command in the `specflow doc` family (`accept`, `supersede`, `deprecate`, `bump`, `stamp`, `revive`). Maps 1:1 to a transition or a non-status mutation. |
| **Mutation** | Any change to a Document that must be recorded: a status transition, a version bump, or a `last_reviewed` re-stamp. |
| **Atomic Write** | A write through the `DocumentWriter` port (ADR-013) that either fully succeeds or leaves the file unchanged. Reciprocal-link updates are part of the same atomic batch. |
| **Audit Entry** | A single append-only record in `.specflow/audit-log.yml` capturing when, what, who, and why for every mutation. |
| **Reciprocal Mirror** | The cross-document update performed alongside a transition — e.g., `supersede ADR-007 --by ADR-018` updates ADR-018's `implemented_by` in the same atomic batch. |
| **Lifecycle Integrity** | The property that the current state of every doc is reachable from a legal predecessor via the transition matrix. Checked by `specflow doctor --docs`. |

---

## Value Objects

### DocumentType

```typescript
type DocumentType = 'ADR' | 'PRD' | 'DDD';
// Canonical list in DocumentTypeRegistry.TYPES; adding a type is a one-file change.
```

**Invariants:**

- Non-empty string.
- Member of `DocumentTypeRegistry.TYPES`.
- Must match the directory under `docs/architecture/` (`adrs` / `prds` / `ddds`).

### DocumentStatus

```typescript
type DocumentStatus = 'Draft' | 'Accepted' | 'Superseded' | 'Deprecated';
// Canonical list in DocumentTypeRegistry.STATUSES; adding a status requires a registry edit plus transition-matrix extension.
```

**Invariants:**

- Non-empty string.
- Member of `DocumentTypeRegistry.STATUSES`.
- Required-fields-per-status constraint holds: e.g., `Superseded` implies `superseded_by` is set.

### StatusTransition

```typescript
interface StatusTransition {
  from: DocumentStatus;
  to: DocumentStatus;
  validator: (doc: Document, ctx: TransitionContext) => Result<void, TransitionError>;
}
```

**Invariants:**

- `from !== to` (no-op transitions rejected at a higher level).
- `(from, to)` pair appears in `DocumentTypeRegistry.TRANSITIONS`.
- `validator` is a pure function of the Document and context; no I/O.

### AuditEntry

```typescript
interface AuditEntry {
  timestamp: string;          // ISO 8601, UTC
  verb: string;               // 'accept' | 'supersede' | 'deprecate' | 'bump' | 'stamp' | 'revive'
  id: string;                 // Document id mutated
  fromStatus: DocumentStatus | null;  // null for non-status mutations (bump, stamp)
  toStatus: DocumentStatus | null;
  reason?: string;            // --note payload or auto-populated reason
  successor?: string;         // Populated for 'supersede'
  actor: 'cli' | 'agent' | 'hook';
}
```

**Invariants:**

- `timestamp` is ISO 8601 UTC.
- `verb` ∈ the verb allowlist.
- For status-changing verbs, `fromStatus` and `toStatus` both set and `(fromStatus, toStatus)` is a legal transition.
- For `bump` / `stamp`, `fromStatus === toStatus === null`.

---

## Entities

### Document (Entity, promoted from DDD-007 record)

```
Document (Entity)
├── path: string                       # docs/architecture/adrs/ADR-014-...md
├── frontmatter: DocumentFrontmatter   # Value object
├── body: string
├── inboundReferences: Reference[]     # Populated by DocumentRegistry on load
│
├── classify(now: Date): ReviewClassification
├── isEnforceable(): boolean           # status === 'Accepted'
├── ageInDays(now: Date): number       # days since last_reviewed
└── transitionTo(newStatus, ctx): Result<Document, TransitionError>
```

**Behaviour details:**

- `classify()` reads `status`, `last_reviewed`, `inboundReferences`, and the outbound link targets. Returns `current | overdue | orphaned | stale_links | soft_deleted`. Single source of truth — DocumentRegistry and ReviewReporter both call this.
- `isEnforceable()` is the gate for `spec_coupling` (DDD-007) — only Accepted docs satisfy a coupling.
- `ageInDays()` is used by classifiers and by `specflow doc stamp --overdue` to select the sweep set.
- `transitionTo(newStatus, ctx)`:
  1. Looks up `(this.status, newStatus)` in `DocumentTypeRegistry.TRANSITIONS`.
  2. If missing, returns `Err(TransitionError.Forbidden)`.
  3. Runs the transition's `validator` (e.g., `Superseded` requires a valid `successor` in ctx).
  4. On success, returns `Ok(newDocument)` with status updated, version incremented, `last_reviewed` stamped to `ctx.now`, and transition-dependent fields populated/cleared.
  5. Never mutates `this`; never writes to disk.

**Invariants:**

- `path` matches `docs/architecture/(adrs|prds|ddds)/(ADR|PRD|DDD)-\d{3}-.+\.md`.
- `frontmatter.id` matches the id segment in `path`.
- `frontmatter.status` ∈ `DocumentTypeRegistry.STATUSES`.
- Required-fields-per-status hold (enforced on hydration and on every transition).

### Reference

Unchanged from DDD-007. Re-documented here only to note that DocumentRegistry populates `Document.inboundReferences` from Reference[] before classify() can return accurate orphan status.

---

## Aggregates

### DocumentRegistry (Aggregate Root)

The root aggregate for this domain. Owns the map of id → Document, the link graph, and the type/status vocabulary.

```
DocumentRegistry (Aggregate Root)
├── documents: Map<string, Document>
├── linkGraph: LinkEdge[]
├── typeRegistry: DocumentTypeRegistry        # Injected
├── writer: DocumentWriter                    # Port from ADR-013
│
├── load(rootDir: string): void               # Walks filesystem, hydrates entities via DocumentTypeRegistry
├── get(id: string): Result<Document, UnknownIdError>
├── updateAtomic(mutations: DocumentMutation[]): Result<void, WriteError | ConcurrentMutationError>
├── findOverdue(now: Date): Document[]        # Delegates to doc.classify()
├── findOrphans(): Document[]                 # Delegates to doc.classify()
├── getEnforceableDocs(): Document[]          # Delegates to doc.isEnforceable()
└── walkLinks(fromId: string): Document[]     # BFS through link graph
```

**Invariants:**

- Every Document in `documents` has been hydrated through `DocumentTypeRegistry.hydrate()`; no half-valid entities.
- `updateAtomic()` acquires per-file locks (one per mutated Document) before writing and releases them after. Failure at any step rolls back all writes in the batch.
- `load()` populates `inboundReferences` on every Document before returning, so classification is immediately accurate.

### LifecycleOrchestrator (Aggregate Root)

Executes verb transitions end-to-end. One orchestrator instance per command invocation.

```
LifecycleOrchestrator (Aggregate Root)
├── registry: DocumentRegistry
├── auditLog: AuditLog
├── mirror: ReciprocalMirrorService
│
├── accept(id): Result<AuditEntry, TransitionError | UnknownIdError>
├── supersede(id, byId, note?): Result<AuditEntry, ...>
├── deprecate(id, note): Result<AuditEntry, ...>
├── bump(id): Result<AuditEntry, ...>
├── stamp(ids: string[]): Result<AuditEntry[], ...>
└── revive(id): Result<AuditEntry, ...>
```

**Behaviour:**

- Each verb method: loads the entity, calls `transitionTo` (where applicable), computes reciprocal mirrors, batches writes through `registry.updateAtomic`, and appends an `AuditEntry` through `auditLog.append`.
- A failure at any step aborts the whole verb: no partial writes, no orphaned audit entries.

**Invariants:**

- Every successful verb call produces exactly one `AuditEntry` (or N entries for batch `stamp`).
- Every verb call either produces audit entries and writes, or produces an error and neither.
- Reciprocal mirrors are part of the same `updateAtomic` batch as the primary mutation.

### AuditLog (Aggregate Root)

Append-only record of mutations.

```
AuditLog (Aggregate Root)
├── path: string                              # .specflow/audit-log.yml
├── entries: AuditEntry[]                     # In-memory view; loaded on demand
│
├── append(entry: AuditEntry): void           # Atomic append; fsync
├── listForDoc(id: string): AuditEntry[]
├── listInRange(from: Date, to: Date): AuditEntry[]
└── exportJson(): string
```

**Invariants:**

- Append-only. No edit, no delete. (A future `--prune` may rotate the file, but it never edits entries in place.)
- `path` is set in `.gitignore`-free state — the file is committed alongside the docs it audits.
- `append()` is atomic: `fs.appendFileSync` with an `fsync` barrier. Partial writes impossible.

---

## Domain Services

### DocumentTypeRegistry

The single source of truth for the vocabulary and the transition matrix.

```typescript
interface DocumentTypeRegistry {
  readonly TYPES: readonly DocumentType[];
  readonly STATUSES: readonly DocumentStatus[];
  readonly TRANSITIONS: readonly StatusTransition[];
  readonly REQUIRED_FIELDS: Record<DocumentStatus, readonly string[]>;

  isValidType(s: string): s is DocumentType;
  isValidStatus(s: string): s is DocumentStatus;
  findTransition(from: DocumentStatus, to: DocumentStatus): StatusTransition | null;
  requiredFieldsFor(status: DocumentStatus): readonly string[];
  hydrate(frontmatter: unknown): Result<Document, HydrationError>;
}
```

**Algorithm for `hydrate`:**

1. Validate the raw frontmatter against the canonical schema (id pattern, date pattern, enum values).
2. Check required-fields-per-status.
3. Return `Ok(new Document(...))` or `Err(HydrationError)` with a structured list of violations.

### LifecycleValidator

Runs the per-transition validator (`StatusTransition.validator`) and the lifecycle-integrity check for `specflow doctor --docs`.

```typescript
interface LifecycleValidator {
  validateTransition(doc: Document, to: DocumentStatus, ctx: TransitionContext): Result<void, TransitionError>;
  validateCurrentState(doc: Document): Result<void, LifecycleIntegrityError>;
  auditReachability(history: AuditEntry[], current: DocumentStatus): boolean;
}
```

`auditReachability` walks the doc's audit history and verifies the current status is reachable via the transition matrix from the doc's first recorded state.

### ReciprocalMirrorService

Computes the companion mutations that must land atomically alongside a primary transition.

```typescript
interface ReciprocalMirrorService {
  mirrorsFor(primary: DocumentMutation, registry: DocumentRegistry): DocumentMutation[];
}
```

**Cases:**

- `supersede <id> --by <newId>`: returns a mutation adding `<id>` to `<newId>.implemented_by` (if not present) and bumping `<newId>.version`.
- `accept <id>`: returns mutations adding `<id>` to `implemented_by` of every doc listed in `<id>.implements`, where missing.
- `deprecate`, `bump`, `stamp`, `revive`: return `[]` — no reciprocal mirror required.

---

## State Machine

```
                  ┌──────────┐
                  │  Draft   │
                  └─────┬────┘
                        │ accept
                        ▼
                  ┌──────────┐
           ┌──────┤ Accepted ├──────┐
           │      └─────┬────┘      │
           │            │           │
  supersede│   deprecate│           │ (forbidden: Accepted → Accepted no-op)
           ▼            ▼           │
     ┌──────────┐  ┌──────────┐     │
     │Superseded│  │Deprecated│◀────┘
     └──────────┘  └─────┬────┘
         │               │
         │ (forbidden)   │ revive
         │               ▼
         │          ┌──────────┐
         └────────▶ │ Accepted │      ← Superseded → Accepted is FORBIDDEN
           FORBIDDEN└──────────┘
```

Transition rules (canonical matrix in `DocumentTypeRegistry.TRANSITIONS`):

| From | To | Allowed | Requires |
|------|-----|---------|----------|
| Draft | Accepted | yes | title, date, version≥1 |
| Accepted | Superseded | yes | `superseded_by` (exists, Accepted) |
| Accepted | Deprecated | yes | `deprecation_note` |
| Deprecated | Accepted | yes (revival) | clears `deprecation_note`, bumps version |
| Superseded | Accepted | **no** | — write a new doc instead |
| Superseded | Deprecated | **no** | — already soft-deleted; redundant |
| Deprecated | Superseded | **no** | — pick a lane |
| X | X | no (no-op) | — |

Any pair not listed is forbidden by default.

---

## Error Types

| Error | Trigger | Resolution |
|-------|---------|------------|
| `TransitionError.Forbidden` | `(from, to)` not in transition matrix | Refuse; report allowed transitions for current state |
| `TransitionError.MissingPrerequisite` | Validator fails (e.g., Superseded without successor in ctx) | Refuse; report which field/argument is missing |
| `TransitionError.NoOp` | `from === to` | Exit 0 with a "nothing to do" message |
| `UnknownIdError` | `<id>` not in `DocumentRegistry` | Exit 2; suggest nearest-match id if edit distance ≤ 2 |
| `MissingSuccessorError` | `supersede --by <newId>` where `<newId>` is not Accepted | Refuse unless `--allow-draft-successor` |
| `CircularSupersessionError` | `supersede` walk reveals a cycle | Refuse; name the cycle members in the error |
| `HydrationError` | Raw frontmatter fails schema / required-fields | Surface in `specflow doctor --docs`; entity not constructed |
| `LifecycleIntegrityError` | Current status not reachable from history via matrix | Surface in `specflow doctor --docs`; suggest rebuilding from last legal state |
| `ConcurrentMutationError` | Per-file lock already held | User reruns; no silent clobber |
| `WriteError` | DocumentWriter I/O failure | Abort verb; rollback partial writes; audit entry not appended |
| `AuditAppendError` | AuditLog append fails post-write | Emit stderr warning, rollback primary write if possible, exit 3 |

---

## Integration With DDD-007

DDD-008 does not replace DDD-007. It promotes and extends:

| DDD-007 concept | DDD-008 change |
|-----------------|----------------|
| `Document` (record) | Promoted to Entity with `classify`, `isEnforceable`, `ageInDays`, `transitionTo` |
| `DocumentRepository` (aggregate) | Renamed `DocumentRegistry`; adds `updateAtomic`, delegates classification to entities |
| `ReviewClassification` (value object) | Unchanged; computed by `Document.classify()` instead of `ReviewReporter.classify()` |
| `FrontmatterParser` (service) | Unchanged for parse; validation moves to `DocumentTypeRegistry.hydrate()` |
| (new) | `DocumentTypeRegistry`, `LifecycleOrchestrator`, `AuditLog`, `LifecycleValidator`, `ReciprocalMirrorService` |

`CouplingEnforcer` and `SnapshotLedger` (DDD-007 aggregates) are unchanged; they continue to consume `DocumentRegistry.getEnforceableDocs()` via the same interface.

---

## Open Questions

- Should the audit log support signed entries (for tamper-evidence in regulated environments)? Deferred; current YAML format is forward-compatible.
- Should `stamp --overdue` have a per-type threshold (e.g., ADRs = 180 days, PRDs = 90 days)? Deferred to a follow-up if one-size-fits-all proves too coarse.
- Should `transitionTo` emit domain events for a future event-sourced persistence layer? Interesting but premature; current file-based writes are simpler and sufficient.
