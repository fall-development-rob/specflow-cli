/**
 * SnapshotLedger — manages docs/architecture/versions.yml for release-time
 * version stamping. Implements DDD-007 SnapshotLedger aggregate.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentRepository } from './document-repository';

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

export class SnapshotLedger {
  constructor(public readonly ledgerPath: string) {}

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

  snapshot(tag: string, commit: string, repo: DocumentRepository, date: string = new Date().toISOString().slice(0, 10)): SnapshotEntry {
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

  private write(file: LedgerFile): void {
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const out = yaml.dump(file, { lineWidth: 120, noRefs: true });
    fs.writeFileSync(this.ledgerPath, out, 'utf-8');
  }
}
