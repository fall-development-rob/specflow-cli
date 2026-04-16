/**
 * specflow review [dir] [--overdue] [--orphans] [--json]
 * Documentation health report for the quarterly sweep.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DocumentRepository } from '../lib/document-repository';
import { walkAll as walkReferences } from '../lib/reference-walker';
import { ReviewReporter, ReviewItem } from '../lib/review-reporter';
import { bold, yellow, red, green, dim, cyan } from '../lib/logger';

interface ReviewOptions {
  dir?: string;
  json?: boolean;
  overdue?: boolean;
  orphans?: boolean;
}

export async function run(options: ReviewOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');
  if (!fs.existsSync(docsRoot)) {
    console.error(`No docs directory at ${docsRoot}`);
    process.exit(2);
  }

  const repo = new DocumentRepository();
  repo.load(docsRoot);
  const refs = walkReferences(projectRoot);
  repo.setInboundReferences(refs);

  const reporter = new ReviewReporter(repo, new Date());
  const report = reporter.generate();

  let items = report.items;
  if (options.overdue) items = items.filter(i => i.classification === 'overdue');
  else if (options.orphans) items = items.filter(i => i.classification === 'orphaned');

  if (options.json) {
    console.log(JSON.stringify({ ...report, items }, null, 2));
    return;
  }

  printHuman(items, report, projectRoot);
}

function printHuman(items: ReviewItem[], report: { generatedAt: string; counts: any }, projectRoot: string): void {
  console.log('');
  console.log(bold(`Specflow Review Report — ${report.generatedAt}`));
  console.log('');

  console.log(`  ACCEPTED DOCS: ${report.counts.accepted}`);
  console.log(`    Current:      ${report.counts.current}`);
  console.log(`    Overdue:      ${report.counts.overdue}   ${dim('(last_reviewed > 90 days)')}`);
  console.log(`    Orphaned:     ${report.counts.orphaned}   ${dim('(no inbound references)')}`);
  console.log(`    Stale links:  ${report.counts.staleLinks}   ${dim('(link to Superseded/Deprecated)')}`);
  console.log('');

  const overdue = items.filter(i => i.classification === 'overdue');
  if (overdue.length > 0) {
    console.log(yellow(bold('  OVERDUE')));
    for (const i of overdue) {
      const rel = path.relative(projectRoot, i.filePath);
      console.log(`    ${rel}   last_reviewed: ${i.last_reviewed} (${i.ageDays} days ago)`);
    }
    console.log('');
  }

  const orphaned = items.filter(i => i.classification === 'orphaned');
  if (orphaned.length > 0) {
    console.log(yellow(bold('  ORPHANED (no inbound references)')));
    for (const i of orphaned) {
      const rel = path.relative(projectRoot, i.filePath);
      console.log(`    ${rel}`);
      console.log(`      ${dim('Suggestion: review and consider Status: Deprecated')}`);
    }
    console.log('');
  }

  const stale = items.filter(i => i.classification === 'stale_links');
  if (stale.length > 0) {
    console.log(yellow(bold('  STALE LINKS')));
    for (const i of stale) {
      const rel = path.relative(projectRoot, i.filePath);
      console.log(`    ${rel}`);
      for (const s of i.staleLinks || []) {
        console.log(`      ${dim('implements:')} ${s.targetId} — ${s.targetStatus}`);
      }
    }
    console.log('');
  }

  if (report.counts.softDeleted > 0) {
    console.log(dim(bold('  SOFT-DELETED (not subject to enforcement)')));
    const soft = items.filter(i => i.classification === 'soft_deleted');
    const super_ = soft.filter(i => i.status === 'Superseded').length;
    const depr = soft.filter(i => i.status === 'Deprecated').length;
    console.log(dim(`    Superseded:  ${super_} docs`));
    console.log(dim(`    Deprecated:  ${depr} docs`));
    console.log('');
  }

  if (overdue.length === 0 && orphaned.length === 0 && stale.length === 0) {
    console.log(green('  All Accepted docs are current.'));
    console.log('');
  }
}
