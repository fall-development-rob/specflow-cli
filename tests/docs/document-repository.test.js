/**
 * Tests for DocumentRepository, LinkReciprocityValidator, ReferenceWalker, ReviewReporter.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { DocumentRepository } = require('../../dist/lib/document-repository');
const linkValidator = require('../../dist/lib/link-validator');
const { ReviewReporter } = require('../../dist/lib/review-reporter');
const { walkAll: walkReferences } = require('../../dist/lib/reference-walker');

function makeDoc({ id, type, status, lastReviewed, implementsList = [], implementedBy = [], supersededBy, deprecationNote }) {
  // Ensure date <= lastReviewed so validation passes.
  const date = lastReviewed < '2024-01-01' ? lastReviewed : '2024-01-01';
  const parts = [
    '---',
    `id: ${id}`,
    `title: ${id}`,
    `type: ${type}`,
    `status: ${status}`,
    'version: 1',
    `date: ${date}`,
    `last_reviewed: ${lastReviewed}`,
  ];
  if (implementsList.length > 0) {
    parts.push('implements:');
    for (const i of implementsList) parts.push(`  - ${i}`);
  } else {
    parts.push('implements: []');
  }
  if (implementedBy.length > 0) {
    parts.push('implemented_by:');
    for (const i of implementedBy) parts.push(`  - ${i}`);
  } else {
    parts.push('implemented_by: []');
  }
  if (supersededBy) parts.push(`superseded_by: ${supersededBy}`);
  if (deprecationNote) parts.push(`deprecation_note: ${deprecationNote}`);
  parts.push('---');
  parts.push('');
  parts.push('body');
  return parts.join('\n');
}

function makeTempRepo(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-docs-'));
  const adrDir = path.join(dir, 'adrs');
  const prdDir = path.join(dir, 'prds');
  const dddDir = path.join(dir, 'ddds');
  fs.mkdirSync(adrDir, { recursive: true });
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(dddDir, { recursive: true });

  for (const d of docs) {
    const sub = d.type === 'ADR' ? adrDir : d.type === 'PRD' ? prdDir : dddDir;
    fs.writeFileSync(path.join(sub, `${d.id}.md`), makeDoc(d), 'utf-8');
  }
  return dir;
}

describe('DocumentRepository', () => {
  test('loads and indexes docs', () => {
    const dir = makeTempRepo([
      { id: 'ADR-100', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-100'] },
      { id: 'PRD-100', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-16', implementedBy: ['ADR-100'] },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    expect(repo.all()).toHaveLength(2);
    expect(repo.has('ADR-100')).toBe(true);
    expect(repo.has('PRD-100')).toBe(true);
  });

  test('getEnforceableDocs excludes Superseded and Deprecated', () => {
    const dir = makeTempRepo([
      { id: 'ADR-101', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16' },
      { id: 'ADR-102', type: 'ADR', status: 'Superseded', lastReviewed: '2026-04-16', supersededBy: 'ADR-101' },
      { id: 'ADR-103', type: 'ADR', status: 'Deprecated', lastReviewed: '2026-04-16', deprecationNote: 'gone' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    expect(repo.getEnforceableDocs().map(d => d.id).sort()).toEqual(['ADR-101']);
  });

  test('findOverdue surfaces Accepted docs past 90 days', () => {
    const dir = makeTempRepo([
      { id: 'ADR-110', type: 'ADR', status: 'Accepted', lastReviewed: '2025-01-01' },
      { id: 'ADR-111', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-15' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const overdue = repo.findOverdue(new Date('2026-04-16'));
    expect(overdue.map(d => d.id)).toEqual(['ADR-110']);
  });

  test('findStaleLinks surfaces Accepted docs linking to soft-deleted', () => {
    const dir = makeTempRepo([
      { id: 'ADR-120', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-120'] },
      { id: 'PRD-120', type: 'PRD', status: 'Superseded', lastReviewed: '2026-04-16', supersededBy: 'PRD-121' },
      { id: 'PRD-121', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-16' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const stale = repo.findStaleLinks();
    expect(stale).toHaveLength(1);
    expect(stale[0].doc.id).toBe('ADR-120');
    expect(stale[0].staleLinks[0].targetId).toBe('PRD-120');
  });
});

describe('LinkReciprocityValidator', () => {
  test('detects missing reciprocals', () => {
    const dir = makeTempRepo([
      { id: 'ADR-130', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-130'] },
      { id: 'PRD-130', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-16' }, // no implemented_by
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const report = linkValidator.validate(repo);
    expect(report.missingReciprocals).toHaveLength(1);
    expect(report.missingReciprocals[0].from).toBe('ADR-130');
    expect(report.missingReciprocals[0].to).toBe('PRD-130');
  });

  test('detects dangling references', () => {
    const dir = makeTempRepo([
      { id: 'ADR-140', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-999'] },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const report = linkValidator.validate(repo);
    expect(report.danglingReferences).toHaveLength(1);
    expect(report.danglingReferences[0].missingTarget).toBe('PRD-999');
  });

  test('fix auto-mirrors reciprocal into Accepted targets', () => {
    const dir = makeTempRepo([
      { id: 'ADR-150', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-150'] },
      { id: 'PRD-150', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-16' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const result = linkValidator.fix(repo);
    expect(result.fixed).toHaveLength(1);
    expect(result.refused).toHaveLength(0);

    const repo2 = new DocumentRepository();
    repo2.load(dir);
    const report = linkValidator.validate(repo2);
    expect(report.missingReciprocals).toHaveLength(0);
    expect(repo2.get('PRD-150').frontmatter.implemented_by).toEqual(['ADR-150']);
  });

  test('fix refuses to modify Superseded targets', () => {
    const dir = makeTempRepo([
      { id: 'ADR-160', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-160'] },
      { id: 'PRD-160', type: 'PRD', status: 'Superseded', lastReviewed: '2026-04-16', supersededBy: 'PRD-161' },
      { id: 'PRD-161', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-16' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const result = linkValidator.fix(repo);
    expect(result.fixed).toHaveLength(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toMatch(/Superseded/);
  });
});

describe('ReviewReporter', () => {
  test('classifies docs correctly', () => {
    const dir = makeTempRepo([
      { id: 'ADR-170', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-15', implementedBy: ['PRD-170'] },
      { id: 'PRD-170', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-15' }, // no inbound (no source refs)
      { id: 'ADR-171', type: 'ADR', status: 'Accepted', lastReviewed: '2025-01-01' }, // overdue
      { id: 'ADR-172', type: 'ADR', status: 'Deprecated', lastReviewed: '2026-04-15', deprecationNote: 'x' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    // No inbound references set — orphan detection depends on inboundReferences being populated.
    const reporter = new ReviewReporter(repo, new Date('2026-04-16'));
    const report = reporter.generate();
    const byId = Object.fromEntries(report.items.map(i => [i.id, i]));
    expect(byId['ADR-171'].classification).toBe('overdue');
    expect(byId['ADR-172'].classification).toBe('soft_deleted');
    // ADR-170 has no inbound refs set → classified as orphaned (no refs populated).
    expect(byId['ADR-170'].classification).toBe('orphaned');
  });
});

describe('ReferenceWalker', () => {
  test('finds IDs in source code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-ref-'));
    const srcDir = path.join(dir, 'ts-src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'x.ts'), '// cites ADR-010 and PRD-010\n', 'utf-8');
    const refs = walkReferences(dir, { sourceDir: srcDir, contractsDir: dir + '/none', agentsDir: dir + '/none', docsDir: dir + '/none' });
    const ids = refs.map(r => r.targetId).sort();
    expect(ids).toContain('ADR-010');
    expect(ids).toContain('PRD-010');
  });
});
