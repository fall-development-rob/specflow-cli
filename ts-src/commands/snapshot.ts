/**
 * specflow snapshot [dir] [--on-ship --tag <t>] [--list] [--diff <a> <b>]
 * Release-time version stamping into docs/architecture/versions.yml.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { DocumentRepository } from '../lib/document-repository';
import { SnapshotLedger, DuplicateSnapshotError } from '../lib/snapshot-ledger';
import { bold, green, yellow, red, dim, cyan } from '../lib/logger';

interface SnapshotOptions {
  dir?: string;
  onShip?: boolean;
  list?: boolean;
  diff?: boolean;
  tag?: string;
  tagA?: string;
  tagB?: string;
  json?: boolean;
}

export async function run(options: SnapshotOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');
  const ledgerPath = path.join(docsRoot, 'versions.yml');
  const ledger = new SnapshotLedger(ledgerPath);

  if (options.list) {
    return runList(ledger, options.json);
  }

  if (options.diff) {
    const [a, b] = [options.tagA, options.tagB];
    if (!a || !b) {
      console.error('--diff requires two tag arguments');
      process.exit(2);
    }
    return runDiff(ledger, a, b, options.json);
  }

  if (options.onShip) {
    return runOnShip(ledger, projectRoot, docsRoot, options);
  }

  console.error('Specify one of: --on-ship --tag <t>, --list, --diff <a> <b>');
  process.exit(2);
}

function runOnShip(ledger: SnapshotLedger, projectRoot: string, docsRoot: string, options: SnapshotOptions): void {
  if (!options.tag) {
    console.error('--on-ship requires --tag <tag>');
    process.exit(2);
  }
  if (!fs.existsSync(docsRoot)) {
    console.error(`No docs directory at ${docsRoot}`);
    process.exit(2);
  }

  const commit = getCommit(projectRoot);
  const repo = new DocumentRepository();
  repo.load(docsRoot);

  try {
    const entry = ledger.snapshot(options.tag, commit, repo);
    if (options.json) {
      console.log(JSON.stringify(entry, null, 2));
    } else {
      console.log('');
      console.log(green(bold(`  Snapshotted ${entry.tag} at ${entry.commit.slice(0, 8)}`)));
      console.log(`    Date:  ${entry.date}`);
      console.log(`    Docs:  ${Object.keys(entry.docs).length}`);
      console.log(dim(`    Written to ${ledger.ledgerPath}`));
      console.log('');
    }
  } catch (e: any) {
    if (e instanceof DuplicateSnapshotError) {
      console.error(red(`Snapshot for tag ${options.tag} already exists. Refuses to overwrite.`));
      process.exit(1);
    }
    throw e;
  }
}

function runList(ledger: SnapshotLedger, json?: boolean): void {
  const entries = ledger.list();
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  console.log('');
  console.log(bold('Specflow Snapshot Ledger'));
  console.log('');
  if (entries.length === 0) {
    console.log(dim('  No snapshots recorded.'));
    console.log('');
    return;
  }
  for (const e of entries) {
    console.log(`  ${cyan(e.tag)}  ${dim(e.date)}  ${dim(e.commit.slice(0, 8))}  ${Object.keys(e.docs).length} docs`);
  }
  console.log('');
}

function runDiff(ledger: SnapshotLedger, tagA: string, tagB: string, json?: boolean): void {
  let deltas: { docId: string; from: number | null; to: number | null }[];
  try {
    deltas = ledger.diff(tagA, tagB);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify({ tagA, tagB, deltas }, null, 2));
    return;
  }
  console.log('');
  console.log(bold(`Snapshot diff ${tagA} → ${tagB}`));
  console.log('');
  if (deltas.length === 0) {
    console.log(dim('  No version changes between these snapshots.'));
    console.log('');
    return;
  }
  for (const d of deltas) {
    const from = d.from === null ? 'new' : `v${d.from}`;
    const to = d.to === null ? 'removed' : `v${d.to}`;
    console.log(`  ${cyan(d.docId)}  ${from} → ${to}`);
  }
  console.log('');
}

function getCommit(cwd: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}
