/**
 * Tests for SnapshotLedger concurrency + atomic write behaviour
 * (ADR-013 D13-5, ADR-011 E11-8).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  SnapshotLedger,
  ConcurrentSnapshotError,
} = require('../../dist/lib/snapshot-ledger');
const { DocumentRepository } = require('../../dist/lib/document-repository');
const {
  FsDocumentWriter,
  setDefaultDocumentWriter,
  resetDefaultDocumentWriter,
} = require('../../dist/lib/document-writer');

function makeDoc({ id, type, status, version }) {
  return `---\nid: ${id}\ntitle: ${id}\ntype: ${type}\nstatus: ${status}\nversion: ${version}\ndate: 2026-01-01\nlast_reviewed: 2026-04-16\nimplements: []\nimplemented_by: []\n---\n\nbody\n`;
}

function makeRepo(docs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-snap-conc-'));
  fs.mkdirSync(path.join(dir, 'adrs'), { recursive: true });
  for (const d of docs) {
    fs.writeFileSync(path.join(dir, 'adrs', `${d.id}.md`), makeDoc(d), 'utf-8');
  }
  const repo = new DocumentRepository();
  repo.load(dir);
  return { dir, repo };
}

describe('SnapshotLedger concurrency + atomic write', () => {
  afterEach(() => {
    resetDefaultDocumentWriter();
  });

  test('second snapshot throws ConcurrentSnapshotError while lock is held', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-300', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledgerPath = path.join(dir, 'versions.yml');
    const lockPath = path.join(dir, '.snapshot.lock');

    // Simulate a concurrent holder by creating the lock file ourselves.
    const heldFd = fs.openSync(lockPath, 'wx');
    try {
      const ledger = new SnapshotLedger(ledgerPath);
      expect(() => ledger.snapshot('v1.0.0', 'abc', repo)).toThrow(ConcurrentSnapshotError);
    } finally {
      fs.closeSync(heldFd);
      fs.unlinkSync(lockPath);
    }

    // After the lock is released the same ledger can snapshot normally.
    const ledger = new SnapshotLedger(ledgerPath);
    const entry = ledger.snapshot('v1.0.0', 'abc', repo);
    expect(entry.tag).toBe('v1.0.0');
    // Lock must be released after a successful snapshot.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('lock is released even if write throws, so a later call can proceed', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-301', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledgerPath = path.join(dir, 'versions.yml');
    const lockPath = path.join(dir, '.snapshot.lock');

    let failOnce = true;
    const throwingWriter = {
      writeAtomic() {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated write failure');
        }
      },
    };
    setDefaultDocumentWriter(throwingWriter);

    const ledger = new SnapshotLedger(ledgerPath);
    expect(() => ledger.snapshot('v1.0.0', 'abc', repo)).toThrow(/simulated write failure/);

    // Lock must have been released by the finally block.
    expect(fs.existsSync(lockPath)).toBe(false);

    // Ledger file is still empty/missing — the partial state never landed.
    expect(fs.existsSync(ledgerPath)).toBe(false);

    // Restore the real writer and retry.
    resetDefaultDocumentWriter();
    const entry = ledger.snapshot('v1.0.0', 'abc', repo);
    expect(entry.tag).toBe('v1.0.0');
  });

  test('SnapshotLedger writes go through FsDocumentWriter.writeAtomic', () => {
    const { dir, repo } = makeRepo([
      { id: 'ADR-302', type: 'ADR', status: 'Accepted', version: 1 },
    ]);
    const ledgerPath = path.join(dir, 'versions.yml');

    const calls = [];
    const spy = {
      writeAtomic(p, c) {
        calls.push(p);
        fs.writeFileSync(p, c, 'utf-8');
      },
    };
    setDefaultDocumentWriter(spy);

    const ledger = new SnapshotLedger(ledgerPath);
    ledger.snapshot('v1.0.0', 'abc', repo);

    expect(calls).toContain(ledgerPath);
  });

  test('FsDocumentWriter tempfile exists during write and is cleaned up on success', () => {
    // We verify the rename-based atomic pattern by intercepting renameSync
    // to observe the tempfile between the write and the swap.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-temp-'));
    const target = path.join(dir, 'versions.yml');
    fs.writeFileSync(target, 'pre-existing', 'utf-8');

    const writer = new FsDocumentWriter();
    const origRename = fs.renameSync;
    let sawTmp = false;
    let tmpPath = null;
    fs.renameSync = function (from, to) {
      // At rename time, the tempfile must exist on disk with the NEW content,
      // and the target must still have the OLD content.
      if (to === target) {
        tmpPath = from;
        sawTmp = fs.existsSync(from) && fs.readFileSync(from, 'utf-8') === 'fresh';
        expect(fs.readFileSync(target, 'utf-8')).toBe('pre-existing');
      }
      return origRename.call(fs, from, to);
    };

    try {
      writer.writeAtomic(target, 'fresh');
    } finally {
      fs.renameSync = origRename;
    }

    expect(sawTmp).toBe(true);
    expect(fs.readFileSync(target, 'utf-8')).toBe('fresh');
    // Tempfile cleaned up after successful rename.
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});
