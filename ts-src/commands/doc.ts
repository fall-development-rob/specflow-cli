/**
 * specflow doc <verb> — lifecycle verb family.
 *
 * Implements ADR-015 and PRD-011 S5. Subcommands:
 *   - accept <id>
 *   - supersede <id> --by <newId> [--note <s>]
 *   - deprecate <id> --note <s>
 *   - bump <id>
 *   - stamp [--overdue | --id <ids>]
 *   - revive <id>
 *
 * Every verb goes through the same pipeline:
 *   1. Load the DocumentRepository for the project docs dir.
 *   2. Resolve the target document (error with a suggestion if unknown).
 *   3. For status-changing verbs, validate the transition against the
 *      lifecycle matrix.
 *   4. Mutate the frontmatter (version, last_reviewed, status, and
 *      verb-specific fields).
 *   5. Serialise + write atomically via `FsDocumentWriter.writeAtomic`.
 *   6. Mirror reciprocal links where applicable (supersede).
 *   7. Append a one-line audit entry to `.specflow/audit-log.yml`.
 *
 * TODO(s5-integration): S4's `Document.transitionTo` and
 * `DocumentRepository.updateAtomic` are not yet available. The verbs
 * therefore call `isValidTransition` directly and do their own
 * frontmatter-level mutation. When S4 lands, swap the body of each
 * handler to delegate to the entity's method — the command surface
 * (flags, output, audit entries) stays identical.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  DocumentRepository,
  Document,
} from '../lib/document-repository';
import {
  DocumentFrontmatter,
  DocumentStatus,
  serialize,
  extractFrontmatterBlock,
} from '../lib/frontmatter';
import { getDefaultDocumentWriter } from '../lib/document-writer';
import {
  isValidTransition,
  allowedNextStates,
  TransitionError,
} from '../lib/lifecycle';
import {
  AuditLog,
  AuditEntry,
  defaultAuditLogPath,
} from '../lib/audit-log';
import { bold, green, yellow, red, cyan, dim } from '../lib/logger';

// ──────────────────────────────────────────────────────────────────────
// Shared types
// ──────────────────────────────────────────────────────────────────────

export interface DocVerbOptions {
  /** Project root (default: cwd). */
  dir?: string;
  /** Verb name and positional args, including flags. */
  args: string[];
  /** Bypass confirmation prompts (for `stamp`). */
  yes?: boolean;
  /** JSON mode — machine-readable output. */
  json?: boolean;
}

interface VerbContext {
  projectRoot: string;
  docsRoot: string;
  repo: DocumentRepository;
  auditLog: AuditLog;
  today: string;
  nowIso: string;
  json: boolean;
  yes: boolean;
}

// ──────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────

export async function run(options: DocVerbOptions): Promise<void> {
  const [verb, ...rest] = options.args;
  if (!verb) {
    printHelp();
    process.exit(1);
    return;
  }

  const projectRoot = path.resolve(options.dir || '.');
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');
  if (!fs.existsSync(docsRoot)) {
    console.error(red(`No docs directory at ${docsRoot}`));
    process.exit(2);
    return;
  }

  const repo = new DocumentRepository();
  repo.load(docsRoot);

  const now = new Date();
  const ctx: VerbContext = {
    projectRoot,
    docsRoot,
    repo,
    auditLog: new AuditLog(defaultAuditLogPath(projectRoot)),
    today: now.toISOString().slice(0, 10),
    nowIso: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    json: !!options.json,
    yes: !!options.yes,
  };

  try {
    switch (verb) {
      case 'accept':
        await runAccept(ctx, rest);
        break;
      case 'supersede':
        await runSupersede(ctx, rest);
        break;
      case 'deprecate':
        await runDeprecate(ctx, rest);
        break;
      case 'bump':
        await runBump(ctx, rest);
        break;
      case 'stamp':
        await runStamp(ctx, rest);
        break;
      case 'revive':
        await runRevive(ctx, rest);
        break;
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      default:
        console.error(red(`Unknown doc verb: ${verb}`));
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    if (err instanceof TransitionError) {
      console.error(red(`TransitionError: ${err.message}`));
      if (err.kind === 'Forbidden') {
        const allowed = allowedNextStates(err.from);
        if (allowed.length > 0) {
          console.error(dim(`  allowed from ${err.from}: ${allowed.join(', ')}`));
        }
      }
      process.exit(2);
    }
    console.error(red(`Error: ${err.message || err}`));
    process.exit(2);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Verb: accept
// ──────────────────────────────────────────────────────────────────────

async function runAccept(ctx: VerbContext, args: string[]): Promise<void> {
  const id = requirePositional(args, 'accept <id>');
  const doc = requireDoc(ctx, id);
  const from = doc.frontmatter.status;
  const to: DocumentStatus = 'Accepted';

  if (from === to) {
    // No-op per E15-2: exit 0 with a one-line "nothing to do".
    reportNoop(ctx, 'accept', id, from);
    return;
  }

  if (!isValidTransition(from, to)) {
    throw new TransitionError(from, to, 'Forbidden');
  }

  const updated: DocumentFrontmatter = {
    ...doc.frontmatter,
    status: to,
    version: Math.max(doc.frontmatter.version || 0, 1),
    last_reviewed: ctx.today,
  };

  writeDoc(doc, updated);

  const entry: AuditEntry = {
    timestamp: ctx.nowIso,
    verb: 'accept',
    id,
    from,
    to,
    actor: 'cli',
  };
  ctx.auditLog.append(entry);

  report(ctx, entry, `${id}: ${from} -> ${to}`);
}

// ──────────────────────────────────────────────────────────────────────
// Verb: supersede
// ──────────────────────────────────────────────────────────────────────

async function runSupersede(ctx: VerbContext, args: string[]): Promise<void> {
  const id = requirePositional(args, 'supersede <id> --by <newId>');
  const byId = requireFlag(args, '--by', 'supersede <id> --by <newId>');
  const note = getFlag(args, '--note');

  const doc = requireDoc(ctx, id);
  const successor = ctx.repo.get(byId);
  if (!successor) {
    console.error(red(`Unknown successor id: ${byId}`));
    const suggestion = nearestId(ctx.repo, byId);
    if (suggestion) console.error(dim(`  did you mean ${suggestion}?`));
    process.exit(2);
    return;
  }

  const from = doc.frontmatter.status;
  const to: DocumentStatus = 'Superseded';

  if (!isValidTransition(from, to)) {
    throw new TransitionError(from, to, 'Forbidden');
  }

  // Per ADR-015 E15-3: successor should be Accepted. Refuse otherwise.
  if (successor.frontmatter.status !== 'Accepted') {
    console.error(red(
      `MissingSuccessorError: ${byId} must be Accepted before superseding ${id} ` +
      `(currently ${successor.frontmatter.status})`,
    ));
    process.exit(2);
    return;
  }

  // Primary mutation: old doc.
  const updated: DocumentFrontmatter = {
    ...doc.frontmatter,
    status: to,
    version: (doc.frontmatter.version || 0) + 1,
    last_reviewed: ctx.today,
    superseded_by: byId,
  };
  writeDoc(doc, updated);

  // Reciprocal mirror on successor: add <id> to implemented_by if missing.
  // This is the same atomic-write batch in spirit (two sequential atomic
  // writes); a crash between them leaves a recoverable state because the
  // mirror is idempotent on re-run.
  if (!successor.frontmatter.implemented_by.includes(id)) {
    const mirrorFm: DocumentFrontmatter = {
      ...successor.frontmatter,
      implemented_by: [...successor.frontmatter.implemented_by, id].sort(),
    };
    writeDoc(successor, mirrorFm);
  }

  // Warn on any still-Accepted docs that `implements: [<id>]` — those
  // are now pointing at a freshly-Superseded doc (ADR-012 orphan hint).
  const orphanedDependents = ctx.repo.all().filter(d =>
    d.id !== id &&
    d.frontmatter.status === 'Accepted' &&
    d.frontmatter.implements.includes(id),
  );
  if (orphanedDependents.length > 0 && !ctx.json) {
    console.log(yellow(`  warn: ${orphanedDependents.length} Accepted doc(s) still implement ${id}:`));
    for (const d of orphanedDependents) {
      console.log(dim(`    - ${d.id}`));
    }
  }

  const entry: AuditEntry = {
    timestamp: ctx.nowIso,
    verb: 'supersede',
    id,
    from,
    to,
    by: byId,
    reason: note,
    actor: 'cli',
  };
  ctx.auditLog.append(entry);

  report(ctx, entry, `${id}: ${from} -> ${to} (by ${byId})`);
}

// ──────────────────────────────────────────────────────────────────────
// Verb: deprecate
// ──────────────────────────────────────────────────────────────────────

async function runDeprecate(ctx: VerbContext, args: string[]): Promise<void> {
  const id = requirePositional(args, 'deprecate <id> --note "<reason>"');
  const note = getFlag(args, '--note');
  if (!note) {
    console.error(red('deprecate requires --note "<reason>"'));
    process.exit(2);
    return;
  }

  const doc = requireDoc(ctx, id);
  const from = doc.frontmatter.status;
  const to: DocumentStatus = 'Deprecated';

  if (!isValidTransition(from, to)) {
    throw new TransitionError(from, to, 'Forbidden');
  }

  const updated: DocumentFrontmatter = {
    ...doc.frontmatter,
    status: to,
    version: (doc.frontmatter.version || 0) + 1,
    last_reviewed: ctx.today,
    deprecation_note: note,
  };
  writeDoc(doc, updated);

  const entry: AuditEntry = {
    timestamp: ctx.nowIso,
    verb: 'deprecate',
    id,
    from,
    to,
    reason: note,
    actor: 'cli',
  };
  ctx.auditLog.append(entry);
  report(ctx, entry, `${id}: ${from} -> ${to}`);
}

// ──────────────────────────────────────────────────────────────────────
// Verb: bump
// ──────────────────────────────────────────────────────────────────────

async function runBump(ctx: VerbContext, args: string[]): Promise<void> {
  const id = requirePositional(args, 'bump <id>');
  const doc = requireDoc(ctx, id);

  const previousVersion = doc.frontmatter.version || 0;
  const updated: DocumentFrontmatter = {
    ...doc.frontmatter,
    version: previousVersion + 1,
    last_reviewed: ctx.today,
  };
  writeDoc(doc, updated);

  const entry: AuditEntry = {
    timestamp: ctx.nowIso,
    verb: 'bump',
    id,
    from: null,
    to: null,
    actor: 'cli',
  };
  ctx.auditLog.append(entry);
  report(ctx, entry, `${id}: version ${previousVersion} -> ${updated.version}`);
}

// ──────────────────────────────────────────────────────────────────────
// Verb: stamp
// ──────────────────────────────────────────────────────────────────────

async function runStamp(ctx: VerbContext, args: string[]): Promise<void> {
  const overdue = args.includes('--overdue');
  const idsFlag = getFlag(args, '--id');
  if (!overdue && !idsFlag) {
    console.error(red('stamp requires --overdue or --id <ids>'));
    process.exit(2);
    return;
  }
  if (overdue && idsFlag) {
    console.error(red('stamp accepts --overdue XOR --id, not both'));
    process.exit(2);
    return;
  }

  let targets: Document[] = [];
  if (overdue) {
    targets = ctx.repo.findOverdue(new Date(ctx.nowIso));
  } else if (idsFlag) {
    const ids = idsFlag.split(',').map(s => s.trim()).filter(s => s.length > 0);
    for (const id of ids) {
      const d = ctx.repo.get(id);
      if (!d) {
        console.error(red(`Unknown id: ${id}`));
        process.exit(2);
        return;
      }
      targets.push(d);
    }
  }

  if (targets.length === 0) {
    if (!ctx.json) console.log(dim('  nothing to stamp'));
    return;
  }

  // Show the planned set (unconditionally — even with --yes per E15-8).
  if (!ctx.json) {
    console.log(bold(`Will stamp ${targets.length} doc(s) to last_reviewed=${ctx.today}:`));
    for (const d of targets) {
      console.log(`  ${cyan(d.id)} ${dim(`(${d.frontmatter.last_reviewed})`)}`);
    }
  }

  if (!ctx.yes) {
    // Non-TTY without --yes is refused per E15-5.
    if (!process.stdin.isTTY) {
      console.error(red('stamp in non-interactive mode requires --yes'));
      process.exit(2);
      return;
    }
    const confirmed = await confirm(`Proceed? (y/N) `);
    if (!confirmed) {
      if (!ctx.json) console.log(dim('  aborted — no writes'));
      return;
    }
  }

  const entries: AuditEntry[] = [];
  for (const doc of targets) {
    const updated: DocumentFrontmatter = {
      ...doc.frontmatter,
      last_reviewed: ctx.today,
    };
    writeDoc(doc, updated);

    const entry: AuditEntry = {
      timestamp: ctx.nowIso,
      verb: 'stamp',
      id: doc.id,
      from: null,
      to: null,
      actor: 'cli',
    };
    ctx.auditLog.append(entry);
    entries.push(entry);
  }

  if (ctx.json) {
    console.log(JSON.stringify({ stamped: entries.map(e => e.id), entries }, null, 2));
  } else {
    console.log(green(`  stamped ${entries.length} doc(s)`));
  }
}

// ──────────────────────────────────────────────────────────────────────
// Verb: revive
// ──────────────────────────────────────────────────────────────────────

async function runRevive(ctx: VerbContext, args: string[]): Promise<void> {
  const id = requirePositional(args, 'revive <id>');
  const doc = requireDoc(ctx, id);
  const from = doc.frontmatter.status;
  const to: DocumentStatus = 'Accepted';

  if (!isValidTransition(from, to)) {
    throw new TransitionError(from, to, 'Forbidden');
  }

  const updated: DocumentFrontmatter = {
    ...doc.frontmatter,
    status: to,
    version: (doc.frontmatter.version || 0) + 1,
    last_reviewed: ctx.today,
    deprecation_note: undefined,
  };
  writeDoc(doc, updated);

  const entry: AuditEntry = {
    timestamp: ctx.nowIso,
    verb: 'revive',
    id,
    from,
    to,
    actor: 'cli',
  };
  ctx.auditLog.append(entry);
  report(ctx, entry, `${id}: ${from} -> ${to}`);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function requirePositional(args: string[], usage: string): string {
  const pos = args.find(a => !a.startsWith('-'));
  if (!pos) {
    console.error(red(`Usage: specflow doc ${usage}`));
    process.exit(2);
  }
  return pos as string;
}

function requireFlag(args: string[], flag: string, usage: string): string {
  const v = getFlag(args, flag);
  if (!v) {
    console.error(red(`Usage: specflow doc ${usage} (missing ${flag})`));
    process.exit(2);
  }
  return v as string;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function requireDoc(ctx: VerbContext, id: string): Document {
  const doc = ctx.repo.get(id);
  if (!doc) {
    console.error(red(`Unknown id: ${id}`));
    const suggestion = nearestId(ctx.repo, id);
    if (suggestion) console.error(dim(`  did you mean ${suggestion}?`));
    process.exit(2);
    throw new Error('unreachable'); // for TypeScript narrowing
  }
  return doc;
}

function nearestId(repo: DocumentRepository, target: string): string | null {
  const candidates = repo.all().map(d => d.id);
  let best: { id: string; dist: number } | null = null;
  for (const c of candidates) {
    const dist = levenshtein(target, c);
    if (dist <= 2 && (best === null || dist < best.dist)) {
      best = { id: c, dist };
    }
  }
  return best ? best.id : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

/**
 * Serialise a frontmatter block back over the top of an existing doc.
 * Uses the DocumentWriter atomic port so a crash mid-write never leaves
 * the file in a partial state.
 */
function writeDoc(doc: Document, fm: DocumentFrontmatter): void {
  const content = fs.readFileSync(doc.filePath, 'utf-8');
  const block = extractFrontmatterBlock(content);
  const body = block ? block.body : '\n' + doc.body;
  const trailing = body.startsWith('\n') ? body : '\n' + body;
  const out = serialize(fm) + trailing;
  getDefaultDocumentWriter().writeAtomic(doc.filePath, out);
  // Mutate the in-memory record so repo lookups in the same run see the
  // new state (e.g., when `supersede` writes the successor after reading
  // the predecessor).
  doc.frontmatter = fm;
}

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

function reportNoop(ctx: VerbContext, verb: string, id: string, status: DocumentStatus): void {
  if (ctx.json) {
    console.log(JSON.stringify({ verb, id, noop: true, status }, null, 2));
  } else {
    console.log(dim(`  ${id} already ${status} — nothing to do`));
  }
}

function report(ctx: VerbContext, entry: AuditEntry, humanLine: string): void {
  if (ctx.json) {
    console.log(JSON.stringify(entry, null, 2));
  } else {
    console.log(green(`  ${humanLine}`));
  }
}

function printHelp(): void {
  console.log(`
specflow doc <verb> — lifecycle verbs

Verbs:
  accept <id>                               Draft -> Accepted
  supersede <id> --by <newId> [--note <s>]  Accepted -> Superseded
  deprecate <id> --note <s>                 Accepted -> Deprecated
  bump <id>                                 version++ and last_reviewed=today
  stamp [--overdue | --id <ids>] [--yes]    Re-stamp last_reviewed
  revive <id>                               Deprecated -> Accepted

Common flags:
  --json      machine-readable output
  --yes       bypass interactive confirmation (stamp)
`);
}
