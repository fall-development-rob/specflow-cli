/**
 * LinkReciprocityValidator — validates implements/implemented_by reciprocity
 * and detects dangling references. Implements DDD-007 LinkReciprocityValidator.
 */

import {
  Document,
  DocumentRepository,
} from './document-repository';
import { DocumentFrontmatter, serialize, extractFrontmatterBlock, parseFile } from './frontmatter';
import { getDefaultDocumentWriter } from './document-writer';
import * as fs from 'fs';

export interface MissingReciprocal {
  from: string;
  to: string;
  direction: 'implements' | 'implemented_by';
}

export interface DanglingReference {
  from: string;
  missingTarget: string;
  field: 'implements' | 'implemented_by' | 'superseded_by';
}

export interface ReciprocityReport {
  missingReciprocals: MissingReciprocal[];
  danglingReferences: DanglingReference[];
}

export function validate(repo: DocumentRepository): ReciprocityReport {
  const missing: MissingReciprocal[] = [];
  const dangling: DanglingReference[] = [];

  for (const doc of repo.all()) {
    for (const targetId of doc.frontmatter.implements) {
      const target = repo.get(targetId);
      if (!target) {
        dangling.push({ from: doc.id, missingTarget: targetId, field: 'implements' });
        continue;
      }
      if (!target.frontmatter.implemented_by.includes(doc.id)) {
        missing.push({ from: doc.id, to: targetId, direction: 'implements' });
      }
    }
    for (const targetId of doc.frontmatter.implemented_by) {
      const target = repo.get(targetId);
      if (!target) {
        dangling.push({ from: doc.id, missingTarget: targetId, field: 'implemented_by' });
        continue;
      }
      if (!target.frontmatter.implements.includes(doc.id)) {
        missing.push({ from: doc.id, to: targetId, direction: 'implemented_by' });
      }
    }
    if (doc.frontmatter.superseded_by) {
      const target = repo.get(doc.frontmatter.superseded_by);
      if (!target) {
        dangling.push({ from: doc.id, missingTarget: doc.frontmatter.superseded_by, field: 'superseded_by' });
      }
    }
  }

  return { missingReciprocals: missing, danglingReferences: dangling };
}

export interface FixResult {
  fixed: MissingReciprocal[];
  refused: { reciprocal: MissingReciprocal; reason: string }[];
}

export function fix(repo: DocumentRepository): FixResult {
  const report = validate(repo);
  const fixed: MissingReciprocal[] = [];
  const refused: { reciprocal: MissingReciprocal; reason: string }[] = [];

  for (const m of report.missingReciprocals) {
    // m.direction 'implements' means A.implements has B, but B.implemented_by lacks A.
    // We need to update B by adding A to B.implemented_by.
    const targetDoc = m.direction === 'implements' ? repo.get(m.to) : repo.get(m.to);
    const sourceId = m.from;
    if (!targetDoc) {
      refused.push({ reciprocal: m, reason: 'target not in repository' });
      continue;
    }
    if (targetDoc.frontmatter.status === 'Superseded' || targetDoc.frontmatter.status === 'Deprecated') {
      refused.push({ reciprocal: m, reason: `target is ${targetDoc.frontmatter.status}; manual fix required` });
      continue;
    }

    const fieldToUpdate: 'implements' | 'implemented_by' =
      m.direction === 'implements' ? 'implemented_by' : 'implements';
    const list = targetDoc.frontmatter[fieldToUpdate];
    if (!list.includes(sourceId)) {
      list.push(sourceId);
      list.sort();
    }
    writeDoc(targetDoc);
    fixed.push(m);
  }

  return { fixed, refused };
}

function writeDoc(doc: Document): void {
  const content = fs.readFileSync(doc.filePath, 'utf-8');
  const block = extractFrontmatterBlock(content);
  if (!block) return;
  const newBlock = serialize(doc.frontmatter);
  const trailing = block.body.startsWith('\n') ? block.body : '\n' + block.body;
  getDefaultDocumentWriter().writeAtomic(doc.filePath, newBlock + trailing);
}
