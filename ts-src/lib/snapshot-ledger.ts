/**
 * SnapshotLedger — manages docs/architecture/versions.yml for release-time
 * version stamping. Implements DDD-007 SnapshotLedger aggregate.
 *
 * Writes go through DocumentWriter (ADR-013 D13-5 / ADR-011 E11-8) so that
 * a crash mid-write cannot truncate the ledger. Concurrent snapshot calls
 * serialise via a sibling `.snapshot.lock` file; a failed acquisition
 * surfaces as ConcurrentSnapshotError so parallel release pipelines cannot
 * race and silently drop history.
 *
 * ADR-017 rule 3: the in-memory entries map is `Object.create(null)` so
 * a bracket-assignment on a caller-supplied tag cannot reach
 * `Object.prototype`.  Tag strings matching the reserved-name regex
 * (`__proto__`, `constructor`, `prototype`) are rejected with a typed
 * `PrototypeTagError` at write-time.  Parses go through `safe-yaml`.
 *
 * Disk format is unchanged — `Object.fromEntries` rebuilds a plain
 * mapping for `yaml.dump` so existing `versions.yml` files keep
 * working.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentRepository } from './document-repository';
import { DocumentWriter, getDefaultDocumentWriter } from './document-writer';
import { loadSafeOrNull } from './safe-yaml';

// `yaml` is only used for `yaml.dump` on the write path.  Parses go
// through safe-yaml (ADR-017 rule 1).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');

/** Deny-list for ledger tag names to prevent prototype pollution. */
const PROTO_TAG_RE = /^(__proto__|constructor|prototype)$/;

/**
 * Raised when a snapshot tag matches the proto deny-list. Prevents
 * `ledger[tag] = entry` from rewriting `Object.prototype`
 * (ADR-017 rule 3).
 */
export class PrototypeTagError extends Error {
  constructor(tag: string) {
    super(
      `Snapshot tag '${tag}' is reserved (prototype-pollution hazard). ` +
      `Use a semantic version or release name — never __proto__, constructor, or prototype.`,
    );
    this.name = 'PrototypeTagError';
  }
}

export interface SnapshotEntry {
  tag: string;
  commit: string;
  date: string;
  docs: Record<string, number>;
}

/**
 * Internal entry shape (no `tag` — that lives on the Map key).  Disk
 * format still writes a plain mapping; this type is runtime-only.
 */
interface StoredEntry {
  commit: string;
  date: string;
  docs: Record<string, number>;
}

export interface LedgerFile {
  version?: number;
  /** Prototype-less map — safe for bracket-indexed tag writes. */
  entries: Record<string, StoredEntry>;
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

function makeEmptyEntries(): Record<string, StoredEntry> {
  // Object.create(null) — no prototype chain, so `entries['__proto__']`
  // writes an own-property instead of polluting Object.prototype.
  return Object.create(null);
}

function sanitiseDocsMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (PROTO_TAG_RE.test(k)) continue; // never copy a reserved key, even from disk
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

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
    if (!fs.existsSync(this.ledgerPath)) {
      return { version: 1, entries: makeEmptyEntries() };
    }
    const raw = fs.readFileSync(this.ledgerPath, 'utf-8');
    if (!raw.trim()) return { version: 1, entries: makeEmptyEntries() };

    const parsed = loadSafeOrNull(raw, { filename: this.ledgerPath }) as
      | { version?: unknown; entries?: Record<string, unknown> }
      | null;
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, entries: makeEmptyEntries() };
    }

    const entries: Record<string, StoredEntry> = makeEmptyEntries();
    const rawEntries = parsed.entries;
    if (rawEntries && typeof rawEntries === 'object') {
      for (const [tag, entry] of Object.entries(rawEntries as Record<string, unknown>)) {
        if (PROTO_TAG_RE.test(tag)) continue; // skip reserved keys from disk
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const commit = typeof e.commit === 'string' ? e.commit : '';
        // Date under FAILSAFE parses as string; coerce defensively.
        const date =
          typeof e.date === 'string'
            ? e.date
            : e.date instanceof Date
            ? e.date.toISOString().slice(0, 10)
            : String(e.date ?? '');
        entries[tag] = {
          commit,
          date,
          docs: sanitiseDocsMap(e.docs),
        };
      }
    }

    const version =
      typeof parsed.version === 'number'
        ? parsed.version
        : parseInt(String(parsed.version || 1), 10) || 1;

    return { version, entries };
  }

  hasEntry(tag: string): boolean {
    if (PROTO_TAG_RE.test(tag)) return false; // reserved keys are never stored
    const file = this.load();
    return Object.prototype.hasOwnProperty.call(file.entries, tag);
  }

  list(): SnapshotEntry[] {
    const file = this.load();
    const out: SnapshotEntry[] = [];
    for (const tag of Object.keys(file.entries)) {
      const entry = file.entries[tag];
      out.push({ tag, commit: entry.commit, date: entry.date, docs: entry.docs });
    }
    return out;
  }

  snapshot(
    tag: string,
    commit: string,
    repo: DocumentRepository,
    date: string = new Date().toISOString().slice(0, 10),
  ): SnapshotEntry {
    if (PROTO_TAG_RE.test(tag)) throw new PrototypeTagError(tag);

    const lockFd = this.acquireLock(DEFAULT_LOCK_TIMEOUT_MS);
    try {
      const file = this.load();
      if (Object.prototype.hasOwnProperty.call(file.entries, tag)) {
        throw new DuplicateSnapshotError(tag);
      }

      const docs: Record<string, number> = Object.create(null);
      for (const doc of repo.all()) {
        docs[doc.id] = doc.frontmatter.version;
      }

      const entry: StoredEntry = { commit, date, docs };
      file.entries[tag] = entry;
      if (!file.version) file.version = 1;

      this.write(file);

      return { tag, commit, date, docs };
    } finally {
      this.releaseLock(lockFd);
    }
  }

  diff(tagA: string, tagB: string): { docId: string; from: number | null; to: number | null }[] {
    const file = this.load();
    const a = file.entries[tagA];
    const b = file.entries[tagB];
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
    // Rebuild a plain mapping for yaml.dump — disk format unchanged
    // (ADR-017 E17-2).  Object.fromEntries produces a standard object;
    // we never write `__proto__` because the Map-level check refused
    // it on insertion.
    const serialisable = {
      version: file.version ?? 1,
      entries: Object.fromEntries(
        Object.keys(file.entries).map((tag) => [tag, file.entries[tag]]),
      ),
    };
    const out = yaml.dump(serialisable, { lineWidth: 120, noRefs: true });
    this.writer.writeAtomic(this.ledgerPath, out);
  }
}
