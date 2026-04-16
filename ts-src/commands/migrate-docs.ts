/**
 * specflow migrate-docs [dir] [--dry-run]
 * Converts legacy header-style docs to YAML frontmatter per ADR-011.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildFrontmatterFromLegacy,
  hasFrontmatter,
  injectFrontmatter,
  serialize,
  DocumentFrontmatter,
} from '../lib/frontmatter';
import { DocumentRepository } from '../lib/document-repository';
import { fix as fixReciprocity } from '../lib/link-validator';
import { bold, green, yellow, dim, cyan } from '../lib/logger';

interface MigrateOptions {
  dir?: string;
  dryRun?: boolean;
  json?: boolean;
}

interface MigrationAction {
  filePath: string;
  id: string;
  action: 'migrate' | 'skip';
  reason?: string;
  frontmatter?: DocumentFrontmatter;
}

export async function run(options: MigrateOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');
  if (!fs.existsSync(docsRoot)) {
    console.error(`No docs directory at ${docsRoot}`);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const files = walkMarkdown(docsRoot);
  const actions: MigrationAction[] = [];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (hasFrontmatter(content)) {
      actions.push({ filePath, id: inferId(filePath), action: 'skip', reason: 'already has frontmatter' });
      continue;
    }
    const fm = buildFrontmatterFromLegacy(content, filePath, today);
    if (!fm) {
      actions.push({ filePath, id: inferId(filePath), action: 'skip', reason: 'could not infer id' });
      continue;
    }
    actions.push({ filePath, id: fm.id, action: 'migrate', frontmatter: fm });
  }

  if (options.json) {
    console.log(JSON.stringify({
      dryRun: !!options.dryRun,
      actions: actions.map(a => ({
        filePath: path.relative(projectRoot, a.filePath),
        id: a.id,
        action: a.action,
        reason: a.reason,
      })),
    }, null, 2));
  } else {
    printHuman(actions, projectRoot, !!options.dryRun);
  }

  if (options.dryRun) return;

  // Apply migrations
  let migrated = 0;
  for (const action of actions) {
    if (action.action !== 'migrate' || !action.frontmatter) continue;
    const content = fs.readFileSync(action.filePath, 'utf-8');
    const updated = injectFrontmatter(content, action.frontmatter);
    fs.writeFileSync(action.filePath, updated, 'utf-8');
    migrated++;
  }

  if (migrated === 0) {
    if (!options.json) console.log(dim('  No files needed migration.'));
    return;
  }

  // Populate reciprocal links by loading and running the fixer.
  const repo = new DocumentRepository();
  repo.load(docsRoot);
  const fixResult = fixReciprocity(repo);

  if (!options.json) {
    console.log('');
    console.log(green(`  Migrated ${migrated} file(s).`));
    if (fixResult.fixed.length > 0) {
      console.log(green(`  Backfilled ${fixResult.fixed.length} reciprocal link(s).`));
    }
    if (fixResult.refused.length > 0) {
      console.log(yellow(`  ${fixResult.refused.length} reciprocal(s) could not be auto-fixed (Superseded/Deprecated target).`));
    }
  }
}

function printHuman(actions: MigrationAction[], projectRoot: string, dryRun: boolean): void {
  console.log('');
  console.log(bold(`Specflow migrate-docs${dryRun ? ' (dry-run)' : ''}`));
  console.log('');

  const migrate = actions.filter(a => a.action === 'migrate');
  const skip = actions.filter(a => a.action === 'skip');

  console.log(`  ${green(String(migrate.length))} file(s) to migrate, ${dim(String(skip.length))} to skip`);
  console.log('');

  if (migrate.length > 0) {
    console.log(bold('  MIGRATE'));
    for (const a of migrate) {
      const rel = path.relative(projectRoot, a.filePath);
      console.log(`    ${cyan(a.id)}  ${dim(rel)}`);
    }
    console.log('');
  }

  if (skip.length > 0) {
    console.log(bold('  SKIP'));
    for (const a of skip) {
      const rel = path.relative(projectRoot, a.filePath);
      console.log(`    ${dim(rel)}  (${a.reason})`);
    }
    console.log('');
  }
}

function inferId(filePath: string): string {
  const basename = path.basename(filePath);
  const match = basename.match(/(ADR|PRD|DDD)-\d{3}/);
  return match ? match[0] : basename;
}

function walkMarkdown(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}
