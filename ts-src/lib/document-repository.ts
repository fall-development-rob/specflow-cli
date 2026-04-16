/**
 * DocumentRepository — loads all docs under docs/architecture/ and builds the
 * bidirectional link graph. Implements DDD-007 DocumentRepository aggregate.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DocumentFrontmatter,
  ParseResult,
  parseFile,
  parseString,
} from './frontmatter';

export interface Document {
  id: string;
  filePath: string;
  frontmatter: DocumentFrontmatter;
  body: string;
  inboundReferences: Reference[];
}

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

export class DocumentRepository {
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
      const result = parseFile(filePath);
      if (!result.ok) {
        this.parseErrors.push({ filePath, error: result.error, errors: result.errors });
        continue;
      }
      const doc: Document = {
        id: result.frontmatter.id,
        filePath,
        frontmatter: result.frontmatter,
        body: result.body,
        inboundReferences: [],
      };
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
    return this.all().filter(d => d.frontmatter.status === 'Accepted');
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

  findOrphans(): Document[] {
    return this.all().filter(d => {
      if (d.frontmatter.status !== 'Accepted') return false;
      return d.inboundReferences.length === 0;
    });
  }

  findOverdue(asOf: Date, maxAgeDays = 90): Document[] {
    const cutoff = new Date(asOf);
    cutoff.setDate(cutoff.getDate() - maxAgeDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return this.all().filter(d => {
      if (d.frontmatter.status !== 'Accepted') return false;
      return d.frontmatter.last_reviewed < cutoffStr;
    });
  }

  findStaleLinks(): { doc: Document; staleLinks: { targetId: string; targetStatus: string }[] }[] {
    const result: { doc: Document; staleLinks: { targetId: string; targetStatus: string }[] }[] = [];
    for (const doc of this.docs.values()) {
      if (doc.frontmatter.status !== 'Accepted') continue;
      const stale: { targetId: string; targetStatus: string }[] = [];
      for (const targetId of doc.frontmatter.implements) {
        const target = this.docs.get(targetId);
        if (target && (target.frontmatter.status === 'Superseded' || target.frontmatter.status === 'Deprecated')) {
          stale.push({ targetId, targetStatus: target.frontmatter.status });
        }
      }
      if (stale.length > 0) result.push({ doc, staleLinks: stale });
    }
    return result;
  }

  statusCounts(): Record<string, number> {
    const counts: Record<string, number> = { Draft: 0, Accepted: 0, Superseded: 0, Deprecated: 0 };
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

export function loadFromString(id: string, filePath: string, content: string): Document | null {
  const result: ParseResult = parseString(content);
  if (!result.ok) return null;
  return {
    id: result.frontmatter.id || id,
    filePath,
    frontmatter: result.frontmatter,
    body: result.body,
    inboundReferences: [],
  };
}
