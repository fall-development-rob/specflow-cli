/**
 * DocumentRepository — loads all docs under docs/architecture/ and builds the
 * bidirectional link graph. Implements DDD-007 DocumentRepository aggregate.
 *
 * After ADR-014 / S4: `Document` is a real entity with behaviour. Classification
 * (`current` / `overdue` / `orphaned` / `stale_links` / `soft_deleted`) lives on
 * the entity; the repository only aggregates. Type/status vocabulary and the
 * lifecycle transition matrix live in `./document-types` — the single source of
 * truth for every consumer.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DocumentFrontmatter,
  ParseResult,
  parseFile,
  parseString,
} from './frontmatter';
import {
  ARCH_DOC_FILE_PATTERN,
  DOCUMENT_STATUSES,
  DocumentStatus,
  LIFECYCLE_TRANSITIONS,
  TransitionError,
  isArchitectureDocFile as _isArchitectureDocFile,
  isValidTransition,
} from './document-types';

// Re-export for the small number of existing callers that imported from here.
export { isArchitectureDocFile } from './document-types';

export interface Reference {
  sourceType: 'document' | 'contract' | 'source_code' | 'agent';
  sourcePath: string;
  targetId: string;
  lineNumber?: number;
}

export interface ParseError {
  filePath: string;
  error: string;
  errors?: string[];
}

/**
 * Shape used by Document.classify() to look up link targets. The live
 * DocumentRepository satisfies it, and tests can stub a minimal get() if they
 * want to exercise classify in isolation.
 */
export interface DocumentLookup {
  get(id: string): Document | undefined;
}

export type ReviewClassification =
  | 'current'
  | 'overdue'
  | 'orphaned'
  | 'stale_links'
  | 'soft_deleted';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGE_DAYS = 90;

/**
 * Document — entity with identity + behaviour (ADR-014, DDD-008).
 *
 * `frontmatter` is intentionally mutable: callers apply a validated status
 * transition via `transitionTo` and then persist the change atomically through
 * the DocumentWriter port (ADR-013). The entity itself never writes to disk.
 */
export class Document {
  public inboundReferences: Reference[] = [];

  constructor(
    public readonly filePath: string,
    public frontmatter: DocumentFrontmatter,
    public readonly body: string
  ) {}

  /** Id convenience accessor so existing `doc.id` read-sites keep working. */
  get id(): string {
    return this.frontmatter.id;
  }

  /** True iff this doc is part of the enforceable surface (ADR-011). */
  isEnforceable(): boolean {
    return this.frontmatter.status === 'Accepted';
  }

  /** True iff any Reference points at this doc. */
  hasInboundReferences(): boolean {
    return this.inboundReferences.length > 0;
  }

  /** Whole days between `last_reviewed` and `now`. Invalid dates = Infinity. */
  ageInDays(now: Date): number {
    const iso = this.frontmatter.last_reviewed;
    if (!iso) return Number.MAX_SAFE_INTEGER;
    const t = Date.parse(iso + 'T00:00:00Z');
    if (Number.isNaN(t)) return Number.MAX_SAFE_INTEGER;
    return Math.floor((now.getTime() - t) / MS_PER_DAY);
  }

  /**
   * Classify this document for the quarterly review sweep. Single source of
   * truth — DocumentRepository's aggregate helpers (findOverdue, etc.) and
   * ReviewReporter both go through here.
   *
   * `lookup` is any `{ get(id) }`; in practice it is the DocumentRepository
   * that loaded this entity. When a stale-link target cannot be resolved the
   * method treats it as not stale (dangling references are reported
   * separately by LinkReciprocityValidator).
   */
  classify(
    now: Date,
    lookup: DocumentLookup,
    maxAgeDays: number = DEFAULT_MAX_AGE_DAYS
  ): ReviewClassification {
    const status = this.frontmatter.status;
    if (status === 'Superseded' || status === 'Deprecated') return 'soft_deleted';
    if (status !== 'Accepted') return 'current'; // Draft etc. are "current work"
    if (this.ageInDays(now) > maxAgeDays) return 'overdue';
    if (!this.hasInboundReferences()) return 'orphaned';
    for (const targetId of this.frontmatter.implements) {
      const target = lookup.get(targetId);
      if (!target) continue;
      const ts = target.frontmatter.status;
      if (ts === 'Superseded' || ts === 'Deprecated') return 'stale_links';
    }
    return 'current';
  }

  /**
   * Transition this document's status in place, after validating against the
   * central LIFECYCLE_TRANSITIONS matrix. Throws TransitionError on a forbidden
   * transition (including no-op self-loops). Persistence is the caller's
   * responsibility — use DocumentWriter to flush the new frontmatter to disk.
   */
  transitionTo(newStatus: DocumentStatus): void {
    const from = this.frontmatter.status;
    if (from === newStatus) {
      throw new TransitionError(
        from,
        newStatus,
        'self-loop transitions are rejected (nothing to do)',
        'no-op'
      );
    }
    if (!(DOCUMENT_STATUSES as readonly string[]).includes(newStatus)) {
      throw new TransitionError(
        from,
        newStatus,
        `unknown status "${newStatus}"`,
        'unknown-status'
      );
    }
    if (!isValidTransition(from, newStatus)) {
      const allowed = LIFECYCLE_TRANSITIONS[from];
      throw new TransitionError(
        from,
        newStatus,
        allowed.length === 0
          ? `"${from}" is terminal; no transitions allowed (write a new doc instead)`
          : `"${from}" may only transition to: ${allowed.join(', ')}`
      );
    }
    this.frontmatter.status = newStatus;
  }
}

export class DocumentRepository implements DocumentLookup {
  private docs: Map<string, Document> = new Map();
  private parseErrors: ParseError[] = [];
  private rootDir: string = '';

  load(rootDir: string): void {
    this.rootDir = rootDir;
    this.docs.clear();
    this.parseErrors = [];

    if (!fs.existsSync(rootDir)) return;

    const files = this.walkMarkdown(rootDir);
    for (const filePath of files) {
      // Only consider files that look like architecture docs (ADR/PRD/DDD-NNN-*.md).
      // Files like README.md, MASTER-PLAN.md, SIMULATION-REPORT.md are skipped entirely.
      if (!_isArchitectureDocFile(filePath)) continue;

      const result = parseFile(filePath);
      if (!result.ok) {
        this.parseErrors.push({ filePath, error: result.error, errors: result.errors });
        continue;
      }
      const doc = new Document(filePath, result.frontmatter, result.body);
      this.docs.set(doc.id, doc);
    }
  }

  getRootDir(): string {
    return this.rootDir;
  }

  get(id: string): Document | undefined {
    return this.docs.get(id);
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  all(): Document[] {
    return Array.from(this.docs.values());
  }

  getEnforceableDocs(): Document[] {
    return this.all().filter(d => d.isEnforceable());
  }

  getErrors(): ParseError[] {
    return [...this.parseErrors];
  }

  setInboundReferences(refs: Reference[]): void {
    for (const doc of this.docs.values()) {
      doc.inboundReferences = [];
    }
    for (const ref of refs) {
      const doc = this.docs.get(ref.targetId);
      if (doc) {
        doc.inboundReferences.push(ref);
      }
    }
  }

  /**
   * Aggregate query. Delegates to Document.classify so the repo and the
   * ReviewReporter give identical answers.
   */
  findOverdue(asOf: Date, maxAgeDays = DEFAULT_MAX_AGE_DAYS): Document[] {
    return this.all().filter(d => d.classify(asOf, this, maxAgeDays) === 'overdue');
  }

  /**
   * Aggregate status histogram. Always returns every status key, even if 0.
   */
  statusCounts(): Record<DocumentStatus, number> {
    const counts = Object.fromEntries(
      DOCUMENT_STATUSES.map(s => [s, 0])
    ) as Record<DocumentStatus, number>;
    for (const d of this.docs.values()) {
      counts[d.frontmatter.status] = (counts[d.frontmatter.status] || 0) + 1;
    }
    return counts;
  }

  private walkMarkdown(dir: string): string[] {
    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkMarkdown(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
    return results;
  }
}

/**
 * Hydrate a Document from an in-memory string (used by tests and a few
 * migration paths). Returns null if the content has no valid frontmatter.
 */
export function loadFromString(id: string, filePath: string, content: string): Document | null {
  const result: ParseResult = parseString(content);
  if (!result.ok) return null;
  // `id` is a fallback only — real id comes from the frontmatter.
  return new Document(filePath, result.frontmatter, result.body);
}
