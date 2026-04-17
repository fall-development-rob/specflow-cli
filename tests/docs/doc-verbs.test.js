/**
 * Tests for the `specflow doc <verb>` lifecycle verb family (PRD-011 S5).
 *
 * Covers:
 *   - accept <id> success and no-op
 *   - supersede with/without successor, forbidden from Superseded
 *   - deprecate with/without --note
 *   - bump: version increments, last_reviewed updated, atomic writer used
 *   - stamp --overdue / --id / --yes
 *   - revive: Deprecated -> Accepted success, Superseded -> Accepted forbidden
 *   - Audit log format (YAML-parseable, one entry per verb call)
 *   - DocumentWriter.writeAtomic is used for every mutation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const yaml = require('js-yaml');

const {
  setDefaultDocumentWriter,
  resetDefaultDocumentWriter,
  FsDocumentWriter,
} = require('../../dist/lib/document-writer');
const { run: runDoc } = require('../../dist/commands/doc');

// ──────────────────────────────────────────────────────────────────────
// Fixture helpers
// ──────────────────────────────────────────────────────────────────────

function makeDoc({
  id,
  type,
  status,
  version = 1,
  date = '2024-01-01',
  lastReviewed = '2024-01-01',
  implementsList = [],
  implementedBy = [],
  supersededBy,
  deprecationNote,
}) {
  const parts = [
    '---',
    `id: ${id}`,
    `title: ${id}`,
    `type: ${type}`,
    `status: ${status}`,
    `version: ${version}`,
    `date: ${date}`,
    `last_reviewed: ${lastReviewed}`,
  ];
  if (implementsList.length > 0) {
    parts.push('implements:');
    implementsList.forEach((i) => parts.push(`  - ${i}`));
  } else {
    parts.push('implements: []');
  }
  if (implementedBy.length > 0) {
    parts.push('implemented_by:');
    implementedBy.forEach((i) => parts.push(`  - ${i}`));
  } else {
    parts.push('implemented_by: []');
  }
  if (supersededBy) parts.push(`superseded_by: ${supersededBy}`);
  if (deprecationNote) parts.push(`deprecation_note: ${deprecationNote}`);
  parts.push('---');
  parts.push('');
  parts.push('# body');
  return parts.join('\n');
}

function subdirFor(type) {
  return type === 'ADR' ? 'adrs' : type === 'PRD' ? 'prds' : 'ddds';
}

function makeProject(docs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-docverbs-'));
  const docsRoot = path.join(root, 'docs', 'architecture');
  ['adrs', 'prds', 'ddds'].forEach((s) => fs.mkdirSync(path.join(docsRoot, s), { recursive: true }));
  for (const d of docs) {
    const file = path.join(docsRoot, subdirFor(d.type), `${d.id}-test.md`);
    fs.writeFileSync(file, makeDoc(d), 'utf-8');
  }
  return root;
}

function readFm(root, type, id) {
  const file = path.join(root, 'docs', 'architecture', subdirFor(type), `${id}-test.md`);
  const content = fs.readFileSync(file, 'utf-8');
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return yaml.load(m[1]);
}

// js-yaml parses bare YYYY-MM-DD tokens to JS Date objects. Normalise.
function dateStr(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function readAuditLog(root) {
  const p = path.join(root, '.specflow', 'audit-log.yml');
  if (!fs.existsSync(p)) return [];
  return yaml.load(fs.readFileSync(p, 'utf-8')) || [];
}

// Silence verb output during tests.
let logSpy, errSpy;
beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  resetDefaultDocumentWriter();
});

// Helper — run the verb and catch process.exit(n>0) so Jest doesn't bail.
async function invoke(args, { dir, yes } = {}) {
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
    const err = new Error(`__exit_${code || 0}__`);
    err._exitCode = code || 0;
    throw err;
  });
  try {
    await runDoc({ dir, args, yes });
    return { exit: 0 };
  } catch (e) {
    if (typeof e._exitCode === 'number') return { exit: e._exitCode };
    throw e;
  } finally {
    exitSpy.mockRestore();
  }
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

describe('specflow doc accept', () => {
  test('transitions Draft -> Accepted and updates last_reviewed', async () => {
    const root = makeProject([
      { id: 'ADR-200', type: 'ADR', status: 'Draft' },
    ]);
    const res = await invoke(['accept', 'ADR-200'], { dir: root });
    expect(res.exit).toBe(0);
    const fm = readFm(root, 'ADR', 'ADR-200');
    expect(fm.status).toBe('Accepted');
    const today = new Date().toISOString().slice(0, 10);
    expect(dateStr(fm.last_reviewed)).toBe(today);
  });

  test('no-ops (exit 0) on an already-Accepted doc', async () => {
    const root = makeProject([
      { id: 'ADR-201', type: 'ADR', status: 'Accepted' },
    ]);
    const before = readFm(root, 'ADR', 'ADR-201');
    const res = await invoke(['accept', 'ADR-201'], { dir: root });
    expect(res.exit).toBe(0);
    const after = readFm(root, 'ADR', 'ADR-201');
    // Same-status is a no-op: status unchanged, version untouched, no audit entry.
    expect(after.status).toBe('Accepted');
    expect(after.version).toBe(before.version);
    const log = readAuditLog(root);
    expect(log.length).toBe(0);
  });

  test('unknown id exits 2 with a suggestion', async () => {
    const root = makeProject([
      { id: 'ADR-202', type: 'ADR', status: 'Draft' },
    ]);
    const res = await invoke(['accept', 'ADR-203'], { dir: root });
    expect(res.exit).toBe(2);
  });
});

describe('specflow doc supersede', () => {
  test('A --by B sets A.status Superseded and mirrors B.implemented_by', async () => {
    const root = makeProject([
      { id: 'ADR-210', type: 'ADR', status: 'Accepted' },
      { id: 'ADR-211', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['supersede', 'ADR-210', '--by', 'ADR-211'], { dir: root });
    expect(res.exit).toBe(0);
    const a = readFm(root, 'ADR', 'ADR-210');
    const b = readFm(root, 'ADR', 'ADR-211');
    expect(a.status).toBe('Superseded');
    expect(a.superseded_by).toBe('ADR-211');
    expect(b.implemented_by).toContain('ADR-210');
  });

  test('--note is appended to the audit entry reason', async () => {
    const root = makeProject([
      { id: 'ADR-212', type: 'ADR', status: 'Accepted' },
      { id: 'ADR-213', type: 'ADR', status: 'Accepted' },
    ]);
    await invoke(['supersede', 'ADR-212', '--by', 'ADR-213', '--note', 'scope change'], { dir: root });
    const log = readAuditLog(root);
    const entry = log.find((e) => e.verb === 'supersede' && e.id === 'ADR-212');
    expect(entry).toBeDefined();
    expect(entry.reason).toBe('scope change');
    expect(entry.by).toBe('ADR-213');
  });

  test('successor does not exist -> exit 2', async () => {
    const root = makeProject([
      { id: 'ADR-214', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['supersede', 'ADR-214', '--by', 'ADR-999'], { dir: root });
    expect(res.exit).toBe(2);
    const fm = readFm(root, 'ADR', 'ADR-214');
    expect(fm.status).toBe('Accepted'); // unchanged on error
  });

  test('already-Superseded source -> forbidden (exit 2)', async () => {
    const root = makeProject([
      { id: 'ADR-220', type: 'ADR', status: 'Superseded', supersededBy: 'ADR-221' },
      { id: 'ADR-221', type: 'ADR', status: 'Accepted' },
      { id: 'ADR-222', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['supersede', 'ADR-220', '--by', 'ADR-222'], { dir: root });
    expect(res.exit).toBe(2);
  });

  test('successor not Accepted -> MissingSuccessorError (exit 2)', async () => {
    const root = makeProject([
      { id: 'ADR-230', type: 'ADR', status: 'Accepted' },
      { id: 'ADR-231', type: 'ADR', status: 'Draft' },
    ]);
    const res = await invoke(['supersede', 'ADR-230', '--by', 'ADR-231'], { dir: root });
    expect(res.exit).toBe(2);
  });
});

describe('specflow doc deprecate', () => {
  test('A --note "reason" moves A to Deprecated and records the note', async () => {
    const root = makeProject([
      { id: 'ADR-240', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['deprecate', 'ADR-240', '--note', 'no longer relevant'], { dir: root });
    expect(res.exit).toBe(0);
    const fm = readFm(root, 'ADR', 'ADR-240');
    expect(fm.status).toBe('Deprecated');
    expect(fm.deprecation_note).toBe('no longer relevant');
  });

  test('missing --note -> exit 2', async () => {
    const root = makeProject([
      { id: 'ADR-241', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['deprecate', 'ADR-241'], { dir: root });
    expect(res.exit).toBe(2);
  });
});

describe('specflow doc bump', () => {
  test('increments version and stamps last_reviewed', async () => {
    const root = makeProject([
      { id: 'ADR-250', type: 'ADR', status: 'Accepted', version: 3, lastReviewed: '2024-01-01' },
    ]);
    const res = await invoke(['bump', 'ADR-250'], { dir: root });
    expect(res.exit).toBe(0);
    const fm = readFm(root, 'ADR', 'ADR-250');
    expect(fm.version).toBe(4);
    const today = new Date().toISOString().slice(0, 10);
    expect(dateStr(fm.last_reviewed)).toBe(today);
  });

  test('two bumps in a row take version from N to N+2', async () => {
    const root = makeProject([
      { id: 'ADR-251', type: 'ADR', status: 'Accepted', version: 5 },
    ]);
    await invoke(['bump', 'ADR-251'], { dir: root });
    await invoke(['bump', 'ADR-251'], { dir: root });
    const fm = readFm(root, 'ADR', 'ADR-251');
    expect(fm.version).toBe(7);
  });

  test('bump writes via DocumentWriter.writeAtomic', async () => {
    const root = makeProject([
      { id: 'ADR-252', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const realWriter = new FsDocumentWriter();
    const calls = [];
    setDefaultDocumentWriter({
      writeAtomic(filePath, content) {
        calls.push({ filePath, size: content.length });
        realWriter.writeAtomic(filePath, content);
      },
    });
    await invoke(['bump', 'ADR-252'], { dir: root });
    // One call for the doc, one for the audit log.
    const docCall = calls.find((c) => c.filePath.endsWith('ADR-252-test.md'));
    const auditCall = calls.find((c) => c.filePath.endsWith('audit-log.yml'));
    expect(docCall).toBeDefined();
    expect(auditCall).toBeDefined();
  });
});

describe('specflow doc stamp', () => {
  test('--overdue with --yes stamps only overdue docs', async () => {
    const root = makeProject([
      { id: 'ADR-260', type: 'ADR', status: 'Accepted', date: '2020-01-01', lastReviewed: '2020-01-01' },  // overdue
      { id: 'ADR-261', type: 'ADR', status: 'Accepted', lastReviewed: new Date().toISOString().slice(0, 10) }, // current
    ]);
    const beforeCurrent = readFm(root, 'ADR', 'ADR-261');
    const res = await invoke(['stamp', '--overdue'], { dir: root, yes: true });
    expect(res.exit).toBe(0);
    const overdue = readFm(root, 'ADR', 'ADR-260');
    const current = readFm(root, 'ADR', 'ADR-261');
    const today = new Date().toISOString().slice(0, 10);
    expect(dateStr(overdue.last_reviewed)).toBe(today);
    expect(dateStr(current.last_reviewed)).toBe(dateStr(beforeCurrent.last_reviewed));
  });

  test('--id A,B stamps only A and B', async () => {
    const root = makeProject([
      { id: 'ADR-270', type: 'ADR', status: 'Accepted', lastReviewed: '2024-01-01' },
      { id: 'ADR-271', type: 'ADR', status: 'Accepted', lastReviewed: '2024-01-01' },
      { id: 'ADR-272', type: 'ADR', status: 'Accepted', lastReviewed: '2024-01-01' },
    ]);
    await invoke(['stamp', '--id', 'ADR-270,ADR-272'], { dir: root, yes: true });
    const today = new Date().toISOString().slice(0, 10);
    expect(dateStr(readFm(root, 'ADR', 'ADR-270').last_reviewed)).toBe(today);
    expect(dateStr(readFm(root, 'ADR', 'ADR-271').last_reviewed)).toBe('2024-01-01');
    expect(dateStr(readFm(root, 'ADR', 'ADR-272').last_reviewed)).toBe(today);
  });

  test('non-TTY without --yes refuses to run', async () => {
    const root = makeProject([
      { id: 'ADR-280', type: 'ADR', status: 'Accepted', date: '2020-01-01', lastReviewed: '2020-01-01' },
    ]);
    const origTty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      const res = await invoke(['stamp', '--overdue'], { dir: root, yes: false });
      expect(res.exit).toBe(2);
      // Doc untouched.
      expect(dateStr(readFm(root, 'ADR', 'ADR-280').last_reviewed)).toBe('2020-01-01');
    } finally {
      process.stdin.isTTY = origTty;
    }
  });

  test('both --overdue and --id -> exit 2', async () => {
    const root = makeProject([
      { id: 'ADR-281', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['stamp', '--overdue', '--id', 'ADR-281'], { dir: root, yes: true });
    expect(res.exit).toBe(2);
  });
});

describe('specflow doc revive', () => {
  test('Deprecated -> Accepted clears deprecation_note and bumps version', async () => {
    const root = makeProject([
      {
        id: 'ADR-290',
        type: 'ADR',
        status: 'Deprecated',
        version: 2,
        deprecationNote: 'old',
      },
    ]);
    const res = await invoke(['revive', 'ADR-290'], { dir: root });
    expect(res.exit).toBe(0);
    const fm = readFm(root, 'ADR', 'ADR-290');
    expect(fm.status).toBe('Accepted');
    expect(fm.deprecation_note).toBeUndefined();
    expect(fm.version).toBe(3);
  });

  test('Superseded -> Accepted is forbidden (exit 2)', async () => {
    const root = makeProject([
      { id: 'ADR-291', type: 'ADR', status: 'Superseded', supersededBy: 'ADR-292' },
      { id: 'ADR-292', type: 'ADR', status: 'Accepted' },
    ]);
    const res = await invoke(['revive', 'ADR-291'], { dir: root });
    expect(res.exit).toBe(2);
    const fm = readFm(root, 'ADR', 'ADR-291');
    expect(fm.status).toBe('Superseded');
  });
});

describe('audit log', () => {
  test('one entry per verb invocation; yaml-parseable', async () => {
    const root = makeProject([
      { id: 'ADR-300', type: 'ADR', status: 'Draft' },
      { id: 'ADR-301', type: 'ADR', status: 'Accepted' },
      { id: 'ADR-302', type: 'ADR', status: 'Accepted' },
    ]);
    await invoke(['accept', 'ADR-300'], { dir: root });
    await invoke(['bump', 'ADR-301'], { dir: root });
    await invoke(['supersede', 'ADR-301', '--by', 'ADR-302'], { dir: root });

    const log = readAuditLog(root);
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBe(3);
    expect(log[0]).toMatchObject({ verb: 'accept', id: 'ADR-300', from: 'Draft', to: 'Accepted', actor: 'cli' });
    expect(log[1]).toMatchObject({ verb: 'bump', id: 'ADR-301', from: null, to: null, actor: 'cli' });
    expect(log[2]).toMatchObject({ verb: 'supersede', id: 'ADR-301', from: 'Accepted', to: 'Superseded', by: 'ADR-302', actor: 'cli' });
    // Timestamps are ISO-8601 UTC.
    for (const e of log) expect(e.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });
});

describe('atomic writes', () => {
  test('every verb mutates through DocumentWriter.writeAtomic (mock confirms call)', async () => {
    const root = makeProject([
      { id: 'ADR-310', type: 'ADR', status: 'Draft' },
    ]);
    const real = new FsDocumentWriter();
    const seen = new Set();
    setDefaultDocumentWriter({
      writeAtomic(filePath, content) {
        seen.add(path.basename(filePath));
        real.writeAtomic(filePath, content);
      },
    });
    await invoke(['accept', 'ADR-310'], { dir: root });
    expect(Array.from(seen)).toEqual(expect.arrayContaining(['ADR-310-test.md', 'audit-log.yml']));
  });
});
