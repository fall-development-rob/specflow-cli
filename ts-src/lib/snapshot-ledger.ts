/**
 * SnapshotLedger — manages docs/architecture/versions.yml for release-time
 * version stamping. Implements DDD-007 SnapshotLedger aggregate.
 *
 * Writes go through DocumentWriter (ADR-013 D13-5 / ADR-011 E11-8) so that
 * a crash mid-write cannot truncate the ledger. Concurrent snapshot calls
 * serialise via a sibling `.snapshot.lock` file; a failed acquisition
 * surfaces as ConcurrentSnapshotError so parallel release pipelines cannot
 * race and silently drop history.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentRepository } from './document-repository';
import { DocumentWriter, getDefaultDocumentWriter } from './document-writer';

const yaml = require('js-yaml');

export interface SnapshotEntry {
  tag: string;
  commit: string;
  date: string;
  docs: Record<string, number>;
}

export interface LedgerFile {
  version?: number;
  entries?: Record<string, Omit<SnapshotEntry, 'tag'>>;
}

export class DuplicateSnapshotError extends Error {
  constructor(tag: string) {
    super(`Snapshot already exists for tag ${tag}`);
    this.name = 'DuplicateSnapshotError';
  }
}

export class ConcurrentSnapshotError extends Error {
  constructor(lockPath: string) {
    super(
      `Could not acquire snapshot lock at ${lockPath}. ` +
      `Another snapshot is in progress, or a previous run crashed and left the lock behind. ` +
      `If no other process is running, remove the lock file manually.`,
    );
    this.name = 'ConcurrentSnapshotError';
  }
}

const DEFAULT_LOCK_TIMEOUT_MS = 500;
const LOCK_POLL_INTERVAL_MS = 25;

export class SnapshotLedger {
  private readonly writer: DocumentWriter;
  private readonly lockPath: string;

  constructor(
    public readonly ledgerPath: string,
    writer?: DocumentWriter,
  ) {
    this.writer = writer ?? getDefaultDocumentWriter();
    this.lockPath = path.join(path.dirname(ledgerPath), '.snapshot.lock');
  }

  load(): LedgerFile {
    if (!fs.existsSync(this.ledgerPath)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
    if (!raw.trim()) return { version: 1, entries: {} };
    const parsed = yaml.load(raw) as LedgerFile | null;
    if (!parsed || typeof parsed !== 'object') return { version: 1, entries: {} };
    if (!parsed.entries) parsed.entries = {};
    return parsed;
  }

  hasEntry(tag: string): boolean {
    const file = this.load();
    return !!(file.entries && file.entries[tag]);
  }

  list(): SnapshotEntry[] {
    const file = this.load();
    if (!file.entries) return [];
    return Object.entries(file.entries).map(([tag, entry]) => ({
      tag,
      commit: entry.commit,
      date: entry.date,
      docs: entry.docs,
    }));
  }

  snapshot(
    tag: string,
    commit: string,
    repo: DocumentRepository,
    date: string = new Date().toISOString().slice(0, 10),
  ): SnapshotEntry {
    const lockFd = this.acquireLock(DEFAULT_LOCK_TIMEOUT_MS);
    try {
      const file = this.load();
      if (file.entries && file.entries[tag]) {
        throw new DuplicateSnapshotError(tag);
      }

      const docs: Record<string, number> = {};
      for (const doc of repo.all()) {
        docs[doc.id] = doc.frontmatter.version;
      }

      const entry = { commit, date, docs };
      if (!file.entries) file.entries = {};
      file.entries[tag] = entry;
      if (!file.version) file.version = 1;

      this.write(file);

      return { tag, ...entry };
    } finally {
      this.releaseLock(lockFd);
    }
  }

  diff(tagA: string, tagB: string): { docId: string; from: number | null; to: number | null }[] {
    const file = this.load();
    const a = file.entries?.[tagA];
    const b = file.entries?.[tagB];
    if (!a) throw new Error(`Tag not found: ${tagA}`);
    if (!b) throw new Error(`Tag not found: ${tagB}`);

    const allIds = new Set([...Object.keys(a.docs), ...Object.keys(b.docs)]);
    const deltas: { docId: string; from: number | null; to: number | null }[] = [];
    for (const id of allIds) {
      const from = a.docs[id] ?? null;
      const to = b.docs[id] ?? null;
      if (from !== to) deltas.push({ docId: id, from, to });
    }
    deltas.sort((x, y) => x.docId.localeCompare(y.docId));
    return deltas;
  }

  /**
   * Acquire an exclusive lock by creating `.snapshot.lock` with O_EXCL.
   * Polls up to `timeoutMs` waiting for a concurrent holder to release.
   */
  private acquireLock(timeoutMs: number): number {
    const dir = path.dirname(this.lockPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const deadline = Date.now() + timeoutMs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        // Record the pid so an operator can diagnose a stale lock.
        try {
          fs.writeFileSync(fd, `${process.pid}\n`, 'utf-8');
        } catch {
          // Non-fatal; the lock's existence is what matters.
        }
        return fd;
      } catch (err: any) {
        if (err && err.code === 'EEXIST') {
          if (Date.now() >= deadline) {
            throw new ConcurrentSnapshotError(this.lockPath);
          }
          // Busy-wait a short tick. Node lacks a sync sleep; use Atomics.
          this.sleepSync(LOCK_POLL_INTERVAL_MS);
          continue;
        }
        throw err;
      }
    }
  }

  private releaseLock(fd: number): void {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(this.lockPath); } catch { /* ignore */ }
  }

  private sleepSync(ms: number): void {
    // Atomics.wait on a throwaway Int32Array is the simplest portable sync sleep.
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, ms);
  }

  private write(file: LedgerFile): void {
    const out = yaml.dump(file, { lineWidth: 120, noRefs: true });
    this.writer.writeAtomic(this.ledgerPath, out);
  }
}
