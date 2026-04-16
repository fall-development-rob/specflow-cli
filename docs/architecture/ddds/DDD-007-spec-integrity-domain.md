# DDD-007: Spec Integrity Domain Design

**Status:** Proposed
**Date:** 2026-04-16
**Depends on:** DDD-001 (Contract Engine), DDD-002 (Enforcement Pipeline), ADR-010, ADR-011, ADR-012

---

## Domain Overview

The Spec Integrity domain models documentation as a first-class enforceable artefact. It introduces three new aggregates — **Document**, **Coupling Rule**, and **Review Report** — and extends the existing Contract aggregate with a backward link to the docs that define it. The domain is consumed by `specflow enforce` (for `spec_coupling`), `specflow doctor --docs` (for schema and link validation), `specflow review` (for the quarterly sweep), and `specflow snapshot` (for release-time stamping).

The contract engine itself is unchanged. This domain layers on top: it loads frontmatter, walks the link graph, evaluates coupling rules against git diff state, and produces reports.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Document** | A markdown file under `docs/architecture/` with YAML frontmatter (per ADR-011). |
| **Frontmatter** | The YAML block at the top of a Document containing id, status, version, links, etc. |
| **Status** | The lifecycle state of a Document: Draft, Accepted, Superseded, or Deprecated. |
| **Soft Delete** | Marking a Document as Superseded or Deprecated. The file is not removed from the repo. |
| **Coupling Rule** | A `spec_coupling` rule mapping source globs to required doc globs. |
| **Coupling Violation** | A diff in which source files matching a coupling change without matching docs in the same diff. |
| **Link Graph** | The bidirectional graph defined by `implements` and `implemented_by` frontmatter fields. |
| **Reciprocity** | The invariant that every `implements: [B]` in A has a matching `implemented_by: [A]` in B. |
| **Inbound Reference** | A link to a Document from anywhere: another Document, a contract, source code, an agent. |
| **Orphan** | An Accepted Document with no inbound references. |
| **Overdue Document** | An Accepted Document with `last_reviewed` more than 90 days ago. |
| **Snapshot** | An entry in `versions.yml` pinning a release tag to the version of every Document at that moment. |
| **Truth Hierarchy** | The ordering: contracts > ADRs > PRDs/DDDs. Codified in CLAUDE.md. |

---

## Value Objects

### DocumentFrontmatter

```typescript
interface DocumentFrontmatter {
  id: string;                          // e.g., "ADR-011"
  title: string;
  type: 'ADR' | 'PRD' | 'DDD';
  status: 'Draft' | 'Accepted' | 'Superseded' | 'Deprecated';
  version: number;                     // Monotonic integer, bumped on material edits
  date: string;                        // ISO date — original authorship
  last_reviewed: string;               // ISO date — most recent review
  implements: string[];                // IDs of docs this implements
  implemented_by: string[];            // IDs of docs that implement this
  superseded_by?: string;              // Required iff status === 'Superseded'
  deprecation_note?: string;           // Required iff status === 'Deprecated'
  references?: string[];               // External (non-Specflow) references
}
```

**Invariants:**
- `id` matches the pattern `(ADR|PRD|DDD)-\d{3}`.
- `version >= 1`.
- `last_reviewed` is on or after `date`.
- `superseded_by` is present iff `status === 'Superseded'`.
- `deprecation_note` is present iff `status === 'Deprecated'`.

### CouplingRule

```typescript
interface CouplingRule {
  id: string;                          // e.g., "COUPLE-001"
  description: string;
  source_globs: string[];
  required_doc_globs: string[];
  exclude_globs: string[];
  severity: 'error' | 'warning';
}
```

**Invariants:**
- `source_globs` and `required_doc_globs` non-empty.
- All globs are valid glob patterns.

### CouplingViolation

```typescript
interface CouplingViolation {
  ruleId: string;
  changedSourceFiles: string[];        // Source files matching source_globs
  expectedDocGlobs: string[];          // Doc globs that should have a matching change
  actualDocChanges: string[];          // Doc changes that occurred (may be empty)
  severity: 'error' | 'warning';
  overrideJustification?: string;      // Set if override_contract was applied
}
```

### LinkEdge

```typescript
interface LinkEdge {
  from: string;                        // Document id
  to: string;                          // Document id (or contract id)
  direction: 'implements' | 'implemented_by';
}
```

### ReviewClassification

```typescript
type ReviewClassification =
  | 'current'        // Accepted, last_reviewed within 90 days, has inbound refs
  | 'overdue'        // Accepted, last_reviewed > 90 days
  | 'orphaned'       // Accepted, no inbound references
  | 'stale_links'    // Accepted, links to Superseded/Deprecated docs
  | 'soft_deleted';  // Superseded or Deprecated
```

### SnapshotEntry

```typescript
interface SnapshotEntry {
  tag: string;                         // e.g., "v1.2.0"
  commit: string;                      // Git SHA at snapshot time
  date: string;                        // ISO date
  docs: Record<string, number>;        // doc id → version at snapshot
}
```

---

## Entities

### Document

```
Document (Entity)
├── path: string                       # docs/architecture/adrs/ADR-011-...md
├── frontmatter: DocumentFrontmatter
├── body: string                       # Markdown content
├── inboundReferences: Reference[]     # Discovered from link walk
├── classify(): ReviewClassification
├── isEnforceable(): boolean           # true iff status === 'Accepted'
└── transitionTo(newStatus): Result<void, TransitionError>
```

**Invariants:**
- `path` matches `docs/architecture/(adrs|prds|ddds)/(ADR|PRD|DDD)-\d{3}-.+\.md`.
- `frontmatter.id` matches the path's id segment.
- Status transitions follow the lifecycle (ADR-011): Draft → Accepted → {Superseded, Deprecated}; Deprecated → Accepted is allowed; Superseded → Accepted is forbidden.

### Reference

```
Reference (Entity)
├── sourceType: 'document' | 'contract' | 'source_code' | 'agent'
├── sourcePath: string
├── targetId: string                   # The referenced Document id
└── lineNumber?: number
```

References are discovered, not stored persistently. The walker rebuilds them on every run.

---

## Aggregates

### DocumentRepository (Aggregate Root)

The root aggregate managing all Documents and their link graph.

```
DocumentRepository (Aggregate Root)
├── documents: Map<string, Document>          # id → Document
├── linkGraph: LinkEdge[]                     # All implements/implemented_by edges
├── orphanIndex: Set<string>                  # Document ids with no inbound refs
│
├── load(rootDir: string): void               # Walk filesystem and parse frontmatter
├── validate(): ValidationReport              # Schema + reciprocity + dangling
├── findOrphans(): Document[]
├── findOverdue(asOf: Date): Document[]
├── findStaleLinks(): { doc: Document; staleLinks: string[] }[]
├── walkLinks(fromId: string): Document[]     # BFS through link graph
└── getEnforceableDocs(): Document[]          # Only Accepted docs
```

**Invariants:**
- All Documents in the repository have unique ids.
- The link graph is consistent: every edge has both endpoints existing in `documents` (validated, not enforced — dangling links are reported as errors).
- `getEnforceableDocs()` returns only docs with `status === 'Accepted'`.

### CouplingEnforcer (Aggregate Root)

Evaluates `spec_coupling` rules against a diff scope.

```
CouplingEnforcer (Aggregate Root)
├── rules: CouplingRule[]
├── repository: DocumentRepository
│
├── evaluate(diff: GitDiff): CouplingViolation[]
├── matchSourceFiles(rule: CouplingRule, diff: GitDiff): string[]
├── matchDocChanges(rule: CouplingRule, diff: GitDiff): string[]
└── filterByEnforceability(matches: string[]): string[]   # Only Accepted docs satisfy
```

**Invariants:**
- A coupling is satisfied only if matched doc changes correspond to Accepted docs.
- Doc-only diffs never produce violations.
- Override directives in commit messages are respected.

### ReviewReporter (Aggregate Root)

Generates the periodic review report.

```
ReviewReporter (Aggregate Root)
├── repository: DocumentRepository
├── now: Date
│
├── classify(doc: Document): ReviewClassification
├── generate(): ReviewReport
└── toJSON(): string
```

### SnapshotLedger (Aggregate Root)

Manages the `versions.yml` ledger.

```
SnapshotLedger (Aggregate Root)
├── ledgerPath: string                        # docs/architecture/versions.yml
├── entries: SnapshotEntry[]
│
├── snapshot(tag: string, commit: string, repository: DocumentRepository): void
├── list(): SnapshotEntry[]
├── diff(tagA: string, tagB: string): { docId: string; from: number; to: number }[]
└── hasEntry(tag: string): boolean
```

**Invariants:**
- Tags are unique in the ledger.
- Snapshot for tag T captures the version of every Accepted/Superseded/Deprecated doc at the moment T was tagged.

---

## Domain Services

### FrontmatterParser

```typescript
interface FrontmatterParser {
  parse(filePath: string): Result<DocumentFrontmatter, ParseError>;
  validate(fm: DocumentFrontmatter): Result<void, ValidationError[]>;
  serialize(fm: DocumentFrontmatter): string;
}
```

### LinkReciprocityValidator

```typescript
interface LinkReciprocityValidator {
  validate(repo: DocumentRepository): ReciprocityReport;
  fix(repo: DocumentRepository): FixResult;   // Applies missing reciprocal links
}

interface ReciprocityReport {
  missingReciprocals: { from: string; to: string; direction: 'implements' | 'implemented_by' }[];
  danglingReferences: { from: string; missingTarget: string }[];
}
```

**Algorithm:**
1. For each Document A and each id B in A.implements:
   - If B not in `repo.documents`: dangling reference.
   - If A not in B.implemented_by: missing reciprocal.
2. Symmetric for `implemented_by`.

### ReferenceWalker

```typescript
interface ReferenceWalker {
  walkAll(rootDir: string, repo: DocumentRepository): Reference[];
  walkSourceCode(srcDir: string): Reference[];   // Greps for ADR-XXX/PRD-XXX/DDD-XXX patterns
  walkContracts(contractDir: string): Reference[];
  walkAgents(agentDir: string): Reference[];
}
```

References are discovered via regex (`(ADR|PRD|DDD)-\d{3}`) and frontmatter `implements` field. The walker is intentionally permissive — it errs toward finding references rather than missing them.

### CouplingMatcher

```typescript
interface CouplingMatcher {
  match(rule: CouplingRule, diff: GitDiff): {
    matchedSource: string[];
    matchedDocs: string[];
    excluded: string[];
  };
  satisfies(rule: CouplingRule, matchedDocs: string[], repo: DocumentRepository): boolean;
}
```

`satisfies()` filters matched docs through `repo.getEnforceableDocs()` — only Accepted docs count.

### MigrationService

One-shot migration from legacy header-block style to YAML frontmatter.

```typescript
interface MigrationService {
  migrate(rootDir: string, opts: { dryRun: boolean }): MigrationReport;
  parseLegacyHeader(content: string): Partial<DocumentFrontmatter>;
  injectFrontmatter(content: string, fm: DocumentFrontmatter): string;
  populateReciprocals(repo: DocumentRepository): void;
}
```

---

## Status Lifecycle State Machine

```
                ┌──────────┐
                │  Draft   │
                └─────┬────┘
                      │ accept (manual)
                      ▼
                ┌──────────┐
        ┌───────┤ Accepted ├────────┐
        │       └─────┬────┘        │
        │             │             │
        │ supersede   │ deprecate   │ revive (from Deprecated only)
        ▼             ▼             │
  ┌──────────┐  ┌──────────┐        │
  │Superseded│  │Deprecated│────────┘
  └──────────┘  └──────────┘
```

Transitions are validated by `Document.transitionTo()`. Forbidden transitions (e.g., `Superseded → Accepted`) return a TransitionError; the document file is not modified.

---

## Coupling Evaluation Pipeline

```
GitDiff (source: enforce --diff or --staged)
    │
    ▼
For each CouplingRule:
    │
    ├──▶ CouplingMatcher.match() ──▶ matchedSource, matchedDocs, excluded
    │
    ├──▶ Filter matchedDocs through DocumentRepository.getEnforceableDocs()
    │       (only Accepted docs satisfy)
    │
    ├──▶ If matchedSource non-empty AND filteredDocs empty:
    │       ──▶ Emit CouplingViolation
    │
    └──▶ If override_contract directive present in commit message:
            ──▶ Mark violation as overridden, demote to warning
    │
    ▼
CouplingViolation[] returned to enforce command
```

---

## Integration Points

| Component | Integration |
|-----------|-------------|
| Contract loader | Recognises `type: spec_coupling` and routes to CouplingEnforcer |
| `enforce` command | Wires CouplingEnforcer alongside existing rule evaluators |
| `doctor --docs` | Calls FrontmatterParser, LinkReciprocityValidator, ReferenceWalker |
| `review` command | Calls ReviewReporter |
| `snapshot` command | Calls SnapshotLedger |
| `migrate-docs` command | Calls MigrationService |
| `init` command | Adds `versions.yml` skeleton; adds truth-hierarchy section to CLAUDE.md |
| `status` command | Displays soft-delete counts and overdue summary |
| Knowledge graph (DDD-004) | Documents and their links indexed as nodes; coupling rules as edges |
| `audit <issue>` | Uses link graph for impact analysis (which docs touch the affected area) |

---

## Error Types

| Error | Trigger | Resolution |
|-------|---------|------------|
| `FrontmatterParseError` | Invalid YAML in frontmatter | Report file and line; doctor exits non-zero |
| `MissingRequiredFieldError` | e.g., Superseded without `superseded_by` | Report field; doctor exits non-zero |
| `DanglingReferenceError` | `implements: [ADR-099]` where ADR-099 doesn't exist | Report dangling id; doctor exits non-zero |
| `MissingReciprocalError` | A.implements has B but B.implemented_by lacks A | `--fix` resolves; otherwise doctor exits non-zero |
| `InvalidStatusTransitionError` | e.g., Superseded → Accepted | Refuse transition; report explanation |
| `StaleLinkWarning` | Link to Superseded/Deprecated doc | Warning, not error; doctor still passes |
| `OrphanedDocWarning` | Accepted doc with no inbound refs | Warning surfaced by `review` |
| `OverdueReviewWarning` | last_reviewed > 90 days | Warning surfaced by `review` |
| `CouplingViolationError` | Source change without matching doc change | enforce exits non-zero unless overridden |
| `DuplicateSnapshotError` | `snapshot --on-ship --tag T` when T already in ledger | Refuse; user must explicitly delete |

---

## Soft-Delete Semantics

A core design constraint: **no Document is ever removed from disk** by Specflow commands. The terminal states are visible markers:

- **Superseded** — the doc was replaced by a specific successor; reader follows `superseded_by`.
- **Deprecated** — the doc is no longer load-bearing but kept for history; reader sees `deprecation_note`.

Both states:
- Exclude the doc from `spec_coupling` enforcement (it can no longer satisfy a coupling).
- Exclude the doc from link reciprocity errors (Accepted docs linking to it get a warning, not an error).
- Are reported by `specflow review` under "soft-deleted" so they don't pollute the active set.
- Remain searchable, browseable, and snapshottable in `versions.yml`.

The reverse transition `Deprecated → Accepted` is allowed (decisions can become relevant again). `Superseded → Accepted` is forbidden — supersession implies a successor; if circumstances change, write a new ADR rather than reviving an old one.

---

## Open Questions

- Should `spec_coupling` support per-PR overrides via PR labels (e.g., `spec-coupling-override:formatting`) in addition to commit-message overrides?
- Should the link graph support typed edges (e.g., `decided_by`, `tested_by`) or remain a single `implements`/`implemented_by` pair?
- Should `snapshot` be triggered automatically by a git hook on tag creation, or remain explicit?

These are deferred to post-v1 of the Spec Integrity Toolkit.
