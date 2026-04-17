/**
 * Tests for SnapshotLedger — versions.yml release-time stamping.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { SnapshotLedger, DuplicateSnapshotError, PrototypeTagError } = require('../../dist/lib/snapshot-ledger');
const { DocumentRepository } = require('../../dist/lib/document-repository');

function makeDoc({ id, type, status, version }) {
  return `---
id: ${id}
title: ${id}
type: ${type}
status: ${status}
version: ${version}
date: 2026-01-01
last_reviewed: 2026-04-16
implements: []
implemented_by: []
---

body
`;
}

function makeRepo(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-snap-'));
  fs.mkdirSync(path.join(dir, 'adrs'), { recursive: true });
  for (const d of docs) {
    fs.writeFileSync(path.join(dir, 'adrs', `${d.id}.md`), makeDoc(d), 'utf-8');
  }
  const repo = new DocumentRepository();
  repo.load(dir);
  return { dir, repo };
}

describe('SnapshotLedger', () => {
  test('writes and reads a snapshot entry', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-200', type: 'ADR', status: 'Accepted', version: 1 },
      { id: 'ADR-201', type: 'ADR', status: 'Accepted', version: 2 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));

    const entry = ledger.snapshot('v1.0.0', 'abc123', repo, '2026-04-16');
    expect(entry.tag).toBe('v1.0.0');
    expect(entry.docs['ADR-200']).toBe(1);
    expect(entry.docs['ADR-201']).toBe(2);

    const list = ledger.list();
    expect(list).toHaveLength(1);
    expect(list[0].tag).toBe('v1.0.0');
  });

  test('refuses duplicate tag', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-210', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));
    ledger.snapshot('v1.0.0', 'abc', repo);
    expect(() => ledger.snapshot('v1.0.0', 'def', repo)).toThrow(DuplicateSnapshotError);
  });

  test('diff identifies version changes', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-220', type: 'ADR', status: 'Accepted', version: 1 },
      { id: 'ADR-221', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));
    ledger.snapshot('v1.0.0', 'a', repo);

    // Bump ADR-220 to version 2
    fs.writeFileSync(
      path.join(dir, 'adrs', 'ADR-220.md'),
      makeDoc({ id: 'ADR-220', type: 'ADR', status: 'Accepted', version: 2 }),
      'utf-8'
    );
    repo.load(dir);
    ledger.snapshot('v1.1.0', 'b', repo);

    const deltas = ledger.diff('v1.0.0', 'v1.1.0');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].docId).toBe('ADR-220');
    expect(deltas[0].from).toBe(1);
    expect(deltas[0].to).toBe(2);
  });

  test('hasEntry reflects ledger state', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-230', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));
    expect(ledger.hasEntry('v1.0.0')).toBe(false);
    ledger.snapshot('v1.0.0', 'a', repo);
    expect(ledger.hasEntry('v1.0.0')).toBe(true);
  });
});

describe('SnapshotLedger prototype-pollution guard (ADR-017 rule 3)', () => {
  test('rejects __proto__ as a tag with PrototypeTagError', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-240', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));
    expect(() => ledger.snapshot('__proto__', 'abc', repo)).toThrow(PrototypeTagError);
  });

  test('rejects constructor and prototype tags', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-241', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));
    expect(() => ledger.snapshot('constructor', 'c', repo)).toThrow(PrototypeTagError);
    expect(() => ledger.snapshot('prototype', 'p', repo)).toThrow(PrototypeTagError);
  });

  test('hasEntry(__proto__) returns false even on an empty ledger', () => {
    const { dir } = makeRepo([
      { id: 'ADR-242', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledger = new SnapshotLedger(path.join(dir, 'versions.yml'));
    // Would have been `true` with a plain `{}` ledger root because of
    // Object.prototype inheritance.
    expect(ledger.hasEntry('__proto__')).toBe(false);
    expect(ledger.hasEntry('constructor')).toBe(false);
    expect(ledger.hasEntry('prototype')).toBe(false);
  });

  test('refuses to load a ledger file that contains a __proto__ tag (defence in depth)', () => {
    const { dir } = makeRepo([
      { id: 'ADR-243', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledgerPath = path.join(dir, 'versions.yml');
    // Hand-craft a ledger file that contains a `__proto__` entry.
    // safe-yaml rejects the parse before Object.prototype can be
    // touched.  This is one layer up from the in-memory Map guard.
    fs.writeFileSync(
      ledgerPath,
      `version: 1
entries:
  __proto__:
    commit: abc
    date: '2026-04-17'
    docs:
      ADR-999: 42
`,
      'utf-8',
    );
    const ledger = new SnapshotLedger(ledgerPath);
    let caught;
    try { ledger.load(); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught.name).toBe('YamlSafetyError');
    expect(caught.code).toBe('PROTOTYPE_KEY');
    // And even though we never completed the load, no Object.prototype
    // pollution has happened.
    expect(({}).commit).toBeUndefined();
  });
});
