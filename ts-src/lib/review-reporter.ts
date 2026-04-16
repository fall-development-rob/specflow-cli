/**
 * ReviewReporter — classifies docs for the quarterly review sweep.
 * Implements DDD-007 ReviewReporter aggregate.
 */

import { Document, DocumentRepository } from './document-repository';

export type ReviewClassification = 'current' | 'overdue' | 'orphaned' | 'stale_links' | 'soft_deleted';

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

  classify(doc: Document): ReviewClassification {
    if (doc.frontmatter.status === 'Superseded' || doc.frontmatter.status === 'Deprecated') {
      return 'soft_deleted';
    }
    if (doc.frontmatter.status !== 'Accepted') {
      return 'current';
    }
    if (this.ageInDays(doc.frontmatter.last_reviewed) > this.maxAgeDays) {
      return 'overdue';
    }
    if (doc.inboundReferences.length === 0) {
      return 'orphaned';
    }
    for (const targetId of doc.frontmatter.implements) {
      const target = this.repo.get(targetId);
      if (target && (target.frontmatter.status === 'Superseded' || target.frontmatter.status === 'Deprecated')) {
        return 'stale_links';
      }
    }
    return 'current';
  }

  generate(): ReviewReport {
    const items: ReviewItem[] = [];
    for (const doc of this.repo.all()) {
      const cls = this.classify(doc);
      const item: ReviewItem = {
        id: doc.id,
        filePath: doc.filePath,
        status: doc.frontmatter.status,
        classification: cls,
        last_reviewed: doc.frontmatter.last_reviewed,
        ageDays: this.ageInDays(doc.frontmatter.last_reviewed),
      };
      if (cls === 'stale_links') {
        const stale: { targetId: string; targetStatus: string }[] = [];
        for (const targetId of doc.frontmatter.implements) {
          const target = this.repo.get(targetId);
          if (target && (target.frontmatter.status === 'Superseded' || target.frontmatter.status === 'Deprecated')) {
            stale.push({ targetId, targetStatus: target.frontmatter.status });
          }
        }
        item.staleLinks = stale;
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

  private ageInDays(dateStr: string): number {
    if (!dateStr) return Number.MAX_SAFE_INTEGER;
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return Number.MAX_SAFE_INTEGER;
    const diffMs = this.now.getTime() - d.getTime();
    return Math.floor(diffMs / (1000 * 60 * 60 * 24));
  }
}
