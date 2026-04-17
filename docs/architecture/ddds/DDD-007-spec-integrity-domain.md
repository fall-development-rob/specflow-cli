---
id: DDD-007
title: Spec Integrity Domain Design
type: DDD
status: Accepted
version: 2
date: '2026-04-16'
last_reviewed: '2026-04-17'
implements:
  - DDD-001
  - DDD-002
  - ADR-010
  - ADR-011
  - ADR-012
  - ADR-013
---

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
| **DiffScope** | Value object describing a set of repo-relative file changes and the range that produced them (ADR-013). |
| **DiffRange** | Discriminated union describing how a `DiffScope` was resolved: `staged`, `two-dot`, `symmetric`, `first-parent`, `full-tree`. |
| **DocumentWriter** | Injectable port providing atomic `writeAtomic(path, content)` semantics for every domain mutation. |
| **SignedOverride** | Provenance record written to `.specflow/override-log.jsonl` whenever a rule-scoped override fires. |
| **Rule-Scoped Override** | An `override_contract: <contractId>:<ruleId>` directive that disables exactly one rule, leaving siblings in force. |

---

## Value Objects

### DiffScope

Introduced by ADR-013 D13-1 as the canonical boundary type for every code path that reasons about git-observed changes. Absolute paths are forbidden; all paths are repo-relative POSIX-style strings.

```typescript
interface DiffScope {
  readonly repoRoot: string;            // Absolute path, used only by adapters at the FS boundary
  readonly changedFiles: string[];      // Repo-relative, forward-slash-separated, no leading "/"
  readonly renames: RenameRecord[];     // Parsed from `git diff --name-status -M`
  readonly commitMessages: string[];    // One entry per commit in the range
  readonly range: DiffRange;            // Structured description of how this scope was resolved
}

interface RenameRecord {
  readonly from: string;                // Repo-relative
  readonly to: string;                  // Repo-relative
  readonly score: number;               // Similarity index 0-100
}

type DiffRange =
  | { kind: 'staged' }
  | { kind: 'two-dot'; base: string; head: string }          // A..HEAD
  | { kind: 'symmetric'; base: string; head: string }        // A...HEAD, explicit opt-in
  | { kind: 'first-parent'; commit: string }                 // HEAD^1..HEAD (merge commits)
  | { kind: 'full-tree'; reason: 'initial-commit' | 'shallow-clone-allowed' };
```

**Factory:**

```typescript
namespace DiffScope {
  function fromGit(cwd: string, opts: { diff?: string; staged?: boolean }): Result<DiffScope, DiffError>;
}
```

**Invariants:**
- Every entry in `changedFiles` is repo-relative: does not start with `/`, does not contain `..` segments, does not contain a drive letter.
- Every entry uses forward slashes regardless of host OS.
- `repoRoot` is derived from `git rev-parse --show-toplevel`; it is present but never concatenated into `changedFiles`.
- `commitMessages` is empty when `range.kind === 'staged'` and no `COMMIT_EDITMSG` context is active (ADR-013 E13-7).
- Construction fails loudly per ADR-013 D13-3: shallow-clone without opt-in is an error, not an empty scope.

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

Evaluates `spec_coupling` rules against a `DiffScope`.

```
CouplingEnforcer (Aggregate Root)
├── rules: CouplingRule[]
├── repository: DocumentRepository
│
├── evaluate(diff: DiffScope): CouplingViolation[]
├── matchSourceFiles(rule: CouplingRule, diff: DiffScope): string[]
├── matchDocChanges(rule: CouplingRule, diff: DiffScope): string[]
├── filterByEnforceability(matches: string[]): string[]   # Only Accepted docs satisfy
└── findOverride(diff: DiffScope, contractId: string, ruleId: string): SignedOverride | null
```

**Invariants (original):**
- A coupling is satisfied only if matched doc changes correspond to Accepted docs.
- Doc-only diffs never produce violations.
- Override directives in commit messages are respected.

**Invariants added by ADR-013:**
- `evaluate` receives a `DiffScope` value object only. Raw `GitDiff` shapes and absolute-path arrays are rejected at the aggregate boundary (D13-1).
- All glob matching delegates to `GlobMatcher` (D13-2). The aggregate does not construct regexes itself.
- Pre-flight invariants on `DiffScope.fromGit` (D13-3) must be satisfied before `evaluate` runs. In practice this is enforced at the `enforce` command: if `DiffScope.fromGit` returns a `DiffError`, the command exits non-zero before constructing the enforcer.
- Override matching is **rule-scoped** (D13-5). `findOverride(diff, contractId, ruleId)` looks for `override_contract: <contractId>[:<ruleId>]` with the following rules:
  - A directive without a rule suffix overrides every rule in the named contract.
  - A directive with `:<ruleId>` overrides only that rule.
  - Bare `override_contract: spec_coupling` (contract family name, no contract id) **does not match**. A deprecation warning is emitted for two releases.
  - The regex anchors to start-of-line after newline and rejects matches inside fenced code blocks (E13-8).
- Every matched override emits a `SignedOverride` record to `.specflow/override-log.jsonl`:
  ```typescript
  interface SignedOverride {
    contractId: string;
    ruleId: string | null;          // null => whole-contract override
    author: string;                  // git author of the commit containing the directive
    commit: string;                  // SHA
    justification: string;
    timestamp: string;               // ISO
  }
  ```
  The log is append-only; the aggregate never mutates or removes prior entries.

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
- All writes to `versions.yml` go through `DocumentWriter.writeAtomic` (ADR-013 D13-5). A crash, signal, or ENOSPC mid-write must never leave a truncated or partially-serialised ledger on disk.
- Concurrent `snapshot` invocations are serialised by a `.specflow/versions.yml.lock` advisory file-lock acquired before the read-modify-write cycle. Last-rename-wins ordering is acceptable; torn or interleaved entries are not.

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

### GlobMatcher

Renamed from `CouplingMatcher` in ADR-013 D13-2 to reflect its broader responsibility: it is the single glob-matching implementation for the Spec Integrity domain, used by `CouplingEnforcer`, `ReferenceWalker`, and `DocumentRepository.load()`.

```typescript
interface GlobMatcher {
  match(rule: CouplingRule, diff: DiffScope): {
    matchedSource: string[];
    matchedDocs: string[];
    excluded: string[];
  };
  satisfies(rule: CouplingRule, matchedDocs: string[], repo: DocumentRepository): boolean;
  test(pattern: string, path: string): boolean;
}
```

`satisfies()` filters matched docs through `repo.getEnforceableDocs()` — only Accepted docs count.

**Canonical implementation:** `minimatch@^10`, configured with:

| Flag | Value | Rationale |
|------|-------|-----------|
| `dot` | `true` | Coupling rules target `.specflow/contracts/` and other dot-prefixed directories. |
| `nobrace` | `false` | `*.{ts,tsx}` expands correctly. |
| `matchBase` | `false` | A path-qualified pattern never matches a bare basename. |
| `nocase` | `false` | Portable, case-sensitive across platforms. |
| `noglobstar` | `false` | `**` spans path segments. |

**Supported glob syntax:** `*`, `?`, `**` (path-segment spanning), character classes `[abc]`, brace expansion `{a,b,c}`, extglob `?(x)` `*(x)` `+(x)` `@(x)` `!(x)`, leading `!` for negation in rule `exclude_globs`. All paths are compared after `DiffScope` normalisation, so patterns and inputs both use forward slashes.

**Deprecation:** the home-rolled `globToRegex` previously exported from `ts-src/lib/coupling-enforcer.ts` is removed. Any code path importing it must switch to `GlobMatcher.test` or `minimatch` directly.

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

All file mutations inside `MigrationService` go through the `DocumentWriter` port below — direct `fs.writeFileSync` calls on frontmatter-bearing files are forbidden.

---

## Ports

### DocumentWriter

Introduced by ADR-013 D13-5 as the single filesystem adapter for every mutation path in the Spec Integrity domain. Injectable; production implementation writes to disk, test doubles write to an in-memory map.

```typescript
interface DocumentWriter {
  writeAtomic(absolutePath: string, content: string): Promise<void>;
  readText(absolutePath: string): Promise<string>;
  exists(absolutePath: string): Promise<boolean>;
  mkdirp(absoluteDir: string): Promise<void>;
}
```

**`writeAtomic` contract:**

1. Ensure parent directory exists (`mkdirp` if necessary).
2. Generate a sibling temp filename in the same directory: `${basename}.${pid}.${monotonic}.tmp`.
3. Write `content` to the temp file via `writeFile`, `fsync` the file descriptor, then close.
4. `rename(tempPath, absolutePath)`. On POSIX filesystems and on NTFS, rename is atomic within a single filesystem.
5. If any step fails, attempt to unlink the temp file and propagate the error — never leave the target path truncated.
6. On concurrent writes to the same target path, last-rename-wins; no torn writes occur, but callers that require ordering must serialise higher up (see `SnapshotLedger` below).

**Consumers:**

| Consumer | Path |
|----------|------|
| `LinkReciprocityValidator.fix` | Every frontmatter edit for `implements`/`implemented_by` reciprocation. |
| `SnapshotLedger.snapshot` | Every `versions.yml` append. |
| `MigrationService.migrate` | Every legacy-header rewrite. |
| Any future command that rewrites a document | Mandatory. |

**Invariant:** no code in `ts-src/lib/` or `ts-src/commands/` belonging to the Spec Integrity domain invokes `fs.writeFileSync` or `fs.promises.writeFile` directly on files under `docs/architecture/**` or `.specflow/**`. Linter-enforced.

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
| `DiffError` | `DiffScope.fromGit` failed pre-flight: shallow clone without opt-in, unresolvable range, or absolute-path output | Exit non-zero with remediation message (ADR-013 D13-3) |
| `InvalidDiffRangeError` | `--diff` argument is not two-dot form, or base is not an ancestor of head | Exit non-zero at parse time (ADR-013 D13-4) |
| `DeprecatedOverrideFormatWarning` | Commit uses bare `override_contract: spec_coupling` | Warning for two releases, then error (ADR-013 D13-5) |
| `AtomicWriteError` | `DocumentWriter.writeAtomic` failed during temp-write or rename | Propagate; temp file cleaned up; target path untouched |

---

## Domain Invariants Introduced by ADR-013

These invariants sit alongside the existing aggregate-level invariants. They are consequences of the five correctness decisions in ADR-013 and are enforced at the domain boundary rather than in individual aggregates.

| # | Invariant | Source | Enforcement Point |
|---|-----------|--------|-------------------|
| I13-1 | Every path entering the domain from git is repo-relative, POSIX-style, and does not escape the repo root. | D13-1 | `DiffScope.fromGit` constructor; rejects absolute or escaping paths. |
| I13-2 | Glob matching uses `minimatch` exclusively; no domain code constructs glob regexes directly. | D13-2 | `GlobMatcher`; static-analysis rule forbids importing `globToRegex`. |
| I13-3 | `DiffScope.fromGit` never returns a silently-empty scope. Shallow clones, initial commits, and merge commits resolve to an explicit `DiffRange` variant or a `DiffError`. | D13-3 | `DiffScope.fromGit` pre-flight checks. |
| I13-4 | `--diff <range>` uses two-dot syntax by default; single-ref input and triple-dot without `--diff-symmetric` are rejected at parse time. | D13-4 | `enforce` command argument parser. |
| I13-5 | Override directives are rule-scoped. The bare form `override_contract: spec_coupling` (family name) does not match; a deprecation warning is logged. | D13-5 | `CouplingEnforcer.findOverride`. |
| I13-6 | Override directives inside fenced code blocks are ignored. | E13-8 | Commit-message pre-processor in `CouplingEnforcer.findOverride`. |
| I13-7 | No domain code writes to files under `docs/architecture/**` or `.specflow/**` except via `DocumentWriter.writeAtomic`. | D13-5 | `DocumentWriter` port; lint rule forbids raw `fs.writeFileSync` in domain modules. |
| I13-8 | Every applied override emits a `SignedOverride` record to the append-only `.specflow/override-log.jsonl`. | D13-5 | `CouplingEnforcer.evaluate`. |
| I13-9 | `SnapshotLedger` mutations are serialised by a file-lock; concurrent callers never produce torn `versions.yml` entries. | D13-5 | `SnapshotLedger.snapshot`. |
| I13-10 | `COMMIT_EDITMSG` is consulted only when an active commit-msg hook is detected; otherwise commit-message sources must be explicit. | E13-7 | `DiffScope.fromGit` under `staged` mode. |

Violation of any I13-* invariant is a domain bug, not a user error. The appropriate failure mode is an assertion or typed error at the boundary — never a silent fallback.

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
