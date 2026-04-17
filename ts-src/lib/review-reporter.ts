/**
 * ReviewReporter — aggregates per-document classifications for the
 * quarterly review sweep. Implements DDD-007 ReviewReporter aggregate.
 *
 * After S4 the classification logic lives on `Document.classify()`; this
 * module is thin iteration plus formatting.
 */

import { Document, DocumentRepository, ReviewClassification } from './document-repository';

export { ReviewClassification };

export interface ReviewItem {
  id: string;
  filePath: string;
  status: string;
  classification: ReviewClassification;
  last_reviewed: string;
  ageDays: number;
  staleLinks?: { targetId: string; targetStatus: string }[];
}

export interface ReviewReport {
  generatedAt: string;
  counts: {
    accepted: number;
    current: number;
    overdue: number;
    orphaned: number;
    staleLinks: number;
    softDeleted: number;
  };
  items: ReviewItem[];
}

export class ReviewReporter {
  constructor(
    private readonly repo: DocumentRepository,
    private readonly now: Date = new Date(),
    private readonly maxAgeDays = 90
  ) {}

  /** Kept for backwards compatibility. Delegates to Document.classify. */
  classify(doc: Document): ReviewClassification {
    return doc.classify(this.now, this.repo, this.maxAgeDays);
  }

  generate(): ReviewReport {
    const items: ReviewItem[] = [];
    for (const doc of this.repo.all()) {
      const cls = doc.classify(this.now, this.repo, this.maxAgeDays);
      const item: ReviewItem = {
        id: doc.id,
        filePath: doc.filePath,
        status: doc.frontmatter.status,
        classification: cls,
        last_reviewed: doc.frontmatter.last_reviewed,
        ageDays: doc.ageInDays(this.now),
      };
      if (cls === 'stale_links') {
        item.staleLinks = this.collectStaleLinks(doc);
      }
      items.push(item);
    }

    const counts = {
      accepted: items.filter(i => i.status === 'Accepted').length,
      current: items.filter(i => i.classification === 'current').length,
      overdue: items.filter(i => i.classification === 'overdue').length,
      orphaned: items.filter(i => i.classification === 'orphaned').length,
      staleLinks: items.filter(i => i.classification === 'stale_links').length,
      softDeleted: items.filter(i => i.classification === 'soft_deleted').length,
    };

    return { generatedAt: this.now.toISOString().slice(0, 10), counts, items };
  }

  private collectStaleLinks(doc: Document): { targetId: string; targetStatus: string }[] {
    const stale: { targetId: string; targetStatus: string }[] = [];
    for (const targetId of doc.frontmatter.implements) {
      const target = this.repo.get(targetId);
      if (target && (target.frontmatter.status === 'Superseded' || target.frontmatter.status === 'Deprecated')) {
        stale.push({ targetId, targetStatus: target.frontmatter.status });
      }
    }
    return stale;
  }
}
