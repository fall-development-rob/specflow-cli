/**
 * Tests for the Document entity (post-S4 promotion) and the central
 * DocumentTypeRegistry (ts-src/lib/document-types.ts).
 *
 * Covers:
 *   - The lifecycle transition matrix (every allowed / forbidden pair).
 *   - The `transitionTo` entity behaviour (throws TransitionError on forbidden).
 *   - Classification parity between Document.classify and the old DocumentRepository
 *     aggregate queries (findOverdue, stale-links, orphans).
 *   - The "adding a new type touches only document-types.ts" property that is
 *     the whole point of the refactor.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  DOCUMENT_TYPES,
  DOCUMENT_STATUSES,
  LIFECYCLE_TRANSITIONS,
  TransitionError,
  ID_PATTERN,
  ARCH_DOC_FILE_PATTERN,
  isValidType,
  isValidStatus,
  isValidTransition,
  isArchitectureDocFile,
} = require('../../dist/lib/document-types');

const { Document, DocumentRepository, loadFromString } =
  require('../../dist/lib/document-repository');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDoc({
  id,
  type,
  status,
  lastReviewed = '2026-04-16',
  implementsList = [],
  implementedBy = [],
  supersededBy,
  deprecationNote,
}) {
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

function makeEntity(overrides) {
  const id = overrides.id || 'ADR-900';
  const fm = {
    id,
    title: id,
    type: id.split('-')[0],
    status: 'Draft',
    version: 1,
    date: '2024-01-01',
    last_reviewed: overrides.lastReviewed || '2024-01-01',
    implements: overrides.implementsList || [],
    implemented_by: overrides.implementedBy || [],
    superseded_by: overrides.supersededBy,
    deprecation_note: overrides.deprecationNote,
  };
  Object.assign(fm, { status: overrides.status || 'Draft' });
  return new Document(overrides.filePath || `/tmp/${id}.md`, fm, '');
}

function makeTempRepo(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-entity-'));
  for (const d of docs) {
    const sub = path.join(dir, d.type.toLowerCase() + 's');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, `${d.id}.md`), makeDoc(d), 'utf-8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('DocumentTypeRegistry', () => {
  test('DOCUMENT_TYPES contains exactly ADR/PRD/DDD', () => {
    expect([...DOCUMENT_TYPES].sort()).toEqual(['ADR', 'DDD', 'PRD']);
  });

  test('DOCUMENT_STATUSES contains exactly the four lifecycle states', () => {
    expect([...DOCUMENT_STATUSES].sort()).toEqual(['Accepted', 'Deprecated', 'Draft', 'Superseded']);
  });

  test('ID_PATTERN is anchored and built from DOCUMENT_TYPES', () => {
    for (const t of DOCUMENT_TYPES) expect(ID_PATTERN.test(`${t}-001`)).toBe(true);
    expect(ID_PATTERN.test('XYZ-001')).toBe(false);
    expect(ID_PATTERN.test(' ADR-001 ')).toBe(false); // anchored
  });

  test('ARCH_DOC_FILE_PATTERN matches real filenames', () => {
    expect(ARCH_DOC_FILE_PATTERN.test('ADR-014-type-registry.md')).toBe(true);
    expect(ARCH_DOC_FILE_PATTERN.test('README.md')).toBe(false);
  });

  test('isValidType / isValidStatus type-guard correctly', () => {
    expect(isValidType('ADR')).toBe(true);
    expect(isValidType('RFC')).toBe(false);
    expect(isValidStatus('Accepted')).toBe(true);
    expect(isValidStatus('Proposed')).toBe(false);
  });

  test('isArchitectureDocFile works on abs path and on plain basename', () => {
    expect(isArchitectureDocFile('/a/b/ADR-014-thing.md')).toBe(true);
    expect(isArchitectureDocFile('a\\b\\PRD-002-foo.md')).toBe(true);
    expect(isArchitectureDocFile('MASTER-PLAN.md')).toBe(false);
  });

  test('adding a new type is a one-file change: document-types.ts is the only module that lists the types inline', () => {
    // This test encodes the whole point of ADR-014. If it fails it means a
    // new hand-rolled `(ADR|PRD|DDD)` union has crept back into the lib/.
    const grepRoots = [
      path.join(__dirname, '..', '..', 'ts-src', 'lib'),
      path.join(__dirname, '..', '..', 'ts-src', 'commands'),
    ];
    const offenders = [];
    const allowed = new Set([
      path.resolve(grepRoots[0], 'document-types.ts'), // the single source of truth
    ]);
    for (const root of grepRoots) {
      for (const f of walk(root)) {
        if (allowed.has(path.resolve(f))) continue;
        const body = fs.readFileSync(f, 'utf-8');
        // Strip string literals in error messages / doc comments — they are
        // human text, not code branches. We only care about regex literals
        // and union types that hard-code the three types together.
        if (/\/\(?\??:?ADR\|PRD\|DDD\)/.test(body)) {
          offenders.push(path.relative(path.join(__dirname, '..', '..'), f));
        }
        if (/'ADR'\s*\|\s*'PRD'\s*\|\s*'DDD'/.test(body)) {
          offenders.push(path.relative(path.join(__dirname, '..', '..'), f));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transition matrix
// ---------------------------------------------------------------------------

describe('Document.transitionTo — allowed transitions', () => {
  test.each([
    ['Draft', 'Accepted'],
    ['Accepted', 'Superseded'],
    ['Accepted', 'Deprecated'],
    ['Deprecated', 'Accepted'],
  ])('%s -> %s mutates frontmatter in place', (from, to) => {
    const doc = makeEntity({ id: 'ADR-700', status: from });
    doc.transitionTo(to);
    expect(doc.frontmatter.status).toBe(to);
  });
});

describe('Document.transitionTo — forbidden transitions throw TransitionError', () => {
  const forbidden = [
    // Superseded is terminal — no revival, no switching lanes.
    ['Superseded', 'Accepted'],
    ['Superseded', 'Draft'],
    ['Superseded', 'Deprecated'],
    // Deprecated -> Superseded is forbidden (pick a lane).
    ['Deprecated', 'Superseded'],
    ['Deprecated', 'Draft'],
    // Draft -> {Superseded, Deprecated} skips the Accepted step.
    ['Draft', 'Superseded'],
    ['Draft', 'Deprecated'],
    // Accepted -> Draft is a backwards move that the matrix disallows.
    ['Accepted', 'Draft'],
  ];

  test.each(forbidden)('%s -> %s is rejected', (from, to) => {
    const doc = makeEntity({ id: 'ADR-701', status: from });
    let err;
    try { doc.transitionTo(to); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TransitionError);
    expect(err.from).toBe(from);
    expect(err.to).toBe(to);
    expect(err.code).toBe('forbidden');
    // The frontmatter must not have moved.
    expect(doc.frontmatter.status).toBe(from);
  });
});

describe('Document.transitionTo — self-loop is a no-op error', () => {
  test.each(DOCUMENT_STATUSES.map((s) => [s]))(
    'rejects %s -> %s as a no-op (per DDD-008 and ADR-014)',
    (status) => {
      const doc = makeEntity({ id: 'ADR-702', status });
      let err;
      try { doc.transitionTo(status); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(TransitionError);
      expect(err.code).toBe('no-op');
      expect(doc.frontmatter.status).toBe(status);
    }
  );
});

describe('LIFECYCLE_TRANSITIONS and isValidTransition stay in sync', () => {
  test('isValidTransition agrees with the matrix for every pair', () => {
    for (const from of DOCUMENT_STATUSES) {
      for (const to of DOCUMENT_STATUSES) {
        const allowedByMatrix =
          from !== to && (LIFECYCLE_TRANSITIONS[from] || []).includes(to);
        expect(isValidTransition(from, to)).toBe(allowedByMatrix);
      }
    }
  });

  test('ADR-011 E11-6 rule holds: Superseded is terminal', () => {
    expect(LIFECYCLE_TRANSITIONS.Superseded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Classification parity: entity method vs. the old repository query
// ---------------------------------------------------------------------------

describe('Document.classify — parity with the old DocumentRepository logic', () => {
  test('findOverdue via entity matches the aggregate helper on the same fixture', () => {
    const dir = makeTempRepo([
      { id: 'ADR-200', type: 'ADR', status: 'Accepted', lastReviewed: '2025-01-01' }, // overdue
      { id: 'ADR-201', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-15' }, // fresh
      { id: 'ADR-202', type: 'ADR', status: 'Draft', lastReviewed: '2024-01-01' },    // draft skipped
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    const now = new Date('2026-04-16');

    const viaAggregate = repo.findOverdue(now).map((d) => d.id).sort();
    const viaEntity = repo.all()
      .filter((d) => d.classify(now, repo) === 'overdue')
      .map((d) => d.id)
      .sort();

    expect(viaAggregate).toEqual(viaEntity);
    expect(viaAggregate).toEqual(['ADR-200']);
  });

  test('orphan classification requires inbound refs and only applies to Accepted docs', () => {
    const dir = makeTempRepo([
      { id: 'ADR-210', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16' }, // no inbound
      { id: 'ADR-211', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16' }, // has inbound
      { id: 'ADR-212', type: 'ADR', status: 'Draft',    lastReviewed: '2026-04-16' }, // draft — 'current'
      { id: 'ADR-213', type: 'ADR', status: 'Deprecated', lastReviewed: '2026-04-16', deprecationNote: 'x' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    repo.setInboundReferences([
      { sourceType: 'document', sourcePath: '/x', targetId: 'ADR-211' },
    ]);
    const now = new Date('2026-04-16');

    expect(repo.get('ADR-210').classify(now, repo)).toBe('orphaned');
    expect(repo.get('ADR-211').classify(now, repo)).toBe('current');
    expect(repo.get('ADR-212').classify(now, repo)).toBe('current');
    expect(repo.get('ADR-213').classify(now, repo)).toBe('soft_deleted');
  });

  test('stale_links wins over orphaned when implements points at soft-deleted', () => {
    const dir = makeTempRepo([
      { id: 'ADR-220', type: 'ADR', status: 'Accepted', lastReviewed: '2026-04-16', implementsList: ['PRD-220'] },
      { id: 'PRD-220', type: 'PRD', status: 'Superseded', lastReviewed: '2026-04-16', supersededBy: 'PRD-221' },
      { id: 'PRD-221', type: 'PRD', status: 'Accepted', lastReviewed: '2026-04-16' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    repo.setInboundReferences([
      { sourceType: 'document', sourcePath: '/x', targetId: 'ADR-220' },
      { sourceType: 'document', sourcePath: '/x', targetId: 'PRD-221' },
    ]);
    expect(repo.get('ADR-220').classify(new Date('2026-04-16'), repo)).toBe('stale_links');
  });

  test('overdue wins over orphaned when the Accepted doc is also stale', () => {
    const dir = makeTempRepo([
      { id: 'ADR-230', type: 'ADR', status: 'Accepted', lastReviewed: '2025-01-01' },
    ]);
    const repo = new DocumentRepository();
    repo.load(dir);
    // No inbound refs — but overdue takes precedence over orphaned.
    expect(repo.get('ADR-230').classify(new Date('2026-04-16'), repo)).toBe('overdue');
  });
});

// ---------------------------------------------------------------------------
// Entity behaviour: isEnforceable, ageInDays, loadFromString
// ---------------------------------------------------------------------------

describe('Document — isEnforceable and ageInDays', () => {
  test('isEnforceable is true only for Accepted', () => {
    for (const s of DOCUMENT_STATUSES) {
      const doc = makeEntity({ id: 'ADR-800', status: s });
      expect(doc.isEnforceable()).toBe(s === 'Accepted');
    }
  });

  test('ageInDays returns whole-days gap between last_reviewed and now', () => {
    const doc = makeEntity({ id: 'ADR-801', status: 'Accepted', lastReviewed: '2026-04-01' });
    expect(doc.ageInDays(new Date('2026-04-16T00:00:00Z'))).toBe(15);
  });

  test('loadFromString hydrates a Document with inbound refs defaulted', () => {
    const raw = makeDoc({ id: 'ADR-810', type: 'ADR', status: 'Accepted' });
    const doc = loadFromString('ADR-810', '/tmp/ADR-810.md', raw);
    expect(doc).not.toBeNull();
    expect(doc.id).toBe('ADR-810');
    expect(doc.inboundReferences).toEqual([]);
    expect(doc.isEnforceable()).toBe(true);
  });
});
