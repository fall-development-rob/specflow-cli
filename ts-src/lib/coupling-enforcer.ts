/**
 * CouplingEnforcer — evaluates spec_coupling contracts against a git diff.
 * Implements DDD-007 CouplingEnforcer aggregate and GlobMatcher service.
 *
 * ADR-013 S1: path normalisation via DiffScope + minimatch-based glob matching.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { minimatch, Minimatch } from 'minimatch';
import { DocumentRepository } from './document-repository';

const yaml = require('js-yaml');

export interface CouplingRule {
  id: string;
  description: string;
  source_globs: string[];
  required_doc_globs: string[];
  exclude_globs: string[];
  severity: 'error' | 'warning';
}

export interface CouplingContract {
  contractId: string;
  sourceFile: string;
  rules: CouplingRule[];
}

export interface CouplingViolation {
  contractId: string;
  ruleId: string;
  description: string;
  changedSourceFiles: string[];
  expectedDocGlobs: string[];
  actualDocChanges: string[];
  severity: 'error' | 'warning';
  overrideJustification?: string;
}

/**
 * DiffScope value object (per ADR-013 D13-1 / DDD-007).
 *
 * `changedFiles` entries are always repo-relative, POSIX-style (forward slashes,
 * no leading slash, no drive letter, no `..` segments). `repoRoot` is the
 * absolute path to the repository root; it is used only by adapters at the
 * filesystem boundary and is never concatenated into `changedFiles` for
 * matching purposes.
 */
export interface DiffScope {
  /** Absolute path to repo root — used only at FS boundaries, never for glob matching. */
  repoRoot: string;
  /** Repo-relative, POSIX-style paths. Must not start with `/` or contain `..`. */
  changedFiles: string[];
  /** Raw commit message bodies in the evaluated range. */
  commitMessages: string[];
}

/**
 * Configured minimatch flag set (ADR-013 D13-2 / DDD-007 GlobMatcher).
 * This set is treated as a single named choice: any change is a design decision.
 */
const MINIMATCH_OPTS = Object.freeze({
  dot: false,
  nobrace: false,
  matchBase: false,
  nocase: false,
  noglobstar: false,
}) as import('minimatch').MinimatchOptions;

/**
 * Loads spec_coupling contracts from the contracts directory.
 * These are distinct from forbidden/required rules; they use type: spec_coupling.
 */
export function loadCouplingContracts(contractsDir: string): CouplingContract[] {
  const results: CouplingContract[] = [];
  if (!fs.existsSync(contractsDir)) return results;

  const entries = collectYamlFiles(contractsDir);
  for (const filePath of entries) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = yaml.load(content);
      if (!parsed || typeof parsed !== 'object') continue;
      const type = parsed?.contract_meta?.type;
      if (type !== 'spec_coupling') continue;

      const contractId = parsed?.contract_meta?.id || path.basename(filePath, path.extname(filePath));
      const rulesYaml = parsed?.rules?.couplings || [];
      const defaultSeverity = parsed?.llm_policy?.severity === 'warning' ? 'warning' : 'error';

      const rules: CouplingRule[] = [];
      for (const raw of rulesYaml) {
        if (!raw || typeof raw !== 'object') continue;
        rules.push({
          id: String(raw.id || ''),
          description: String(raw.description || ''),
          source_globs: Array.isArray(raw.source_globs) ? raw.source_globs.map(String) : [],
          required_doc_globs: Array.isArray(raw.required_doc_globs) ? raw.required_doc_globs.map(String) : [],
          exclude_globs: Array.isArray(raw.exclude_globs) ? raw.exclude_globs.map(String) : [],
          severity: raw.severity === 'warning' ? 'warning' : defaultSeverity,
        });
      }

      if (rules.length > 0) {
        results.push({ contractId, sourceFile: filePath, rules });
      }
    } catch {
      // Skip unparseable contracts; doctor will surface them.
    }
  }
  return results;
}

function collectYamlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectYamlFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
      results.push(full);
    }
  }
  return results;
}

export function evaluate(
  contracts: CouplingContract[],
  diff: DiffScope,
  opts: { docRepo?: DocumentRepository } = {}
): CouplingViolation[] {
  assertDiffScopeInvariants(diff);
  const violations: CouplingViolation[] = [];

  for (const contract of contracts) {
    for (const rule of contract.rules) {
      const changedSourceFiles = matchGlobs(diff.changedFiles, rule.source_globs, rule.exclude_globs);
      if (changedSourceFiles.length === 0) continue; // asymmetric — no source changes, no violation

      const actualDocChanges = matchGlobs(diff.changedFiles, rule.required_doc_globs, []);

      // Only Accepted docs satisfy a coupling (per ADR-011 E11-5).
      const enforceableDocChanges = opts.docRepo
        ? filterAccepted(actualDocChanges, opts.docRepo, diff.repoRoot)
        : actualDocChanges;

      if (enforceableDocChanges.length === 0) {
        const override = findOverride(diff.commitMessages, contract.contractId);
        violations.push({
          contractId: contract.contractId,
          ruleId: rule.id,
          description: rule.description,
          changedSourceFiles,
          expectedDocGlobs: rule.required_doc_globs,
          actualDocChanges,
          severity: override ? 'warning' : rule.severity,
          overrideJustification: override || undefined,
        });
      }
    }
  }

  return violations;
}

/**
 * Enforces I13-1 at the domain boundary: every `changedFiles` entry must be
 * repo-relative POSIX form. An absolute path here is a programming error —
 * the whole point of the `DiffScope` value object is that this invariant
 * holds by construction, so a breach becomes a loud failure rather than a
 * silent vacuous pass (the ADR-013 bug class).
 */
function assertDiffScopeInvariants(diff: DiffScope): void {
  for (const f of diff.changedFiles) {
    if (path.isAbsolute(f) || /^[A-Za-z]:[\\/]/.test(f)) {
      throw new Error(
        `DiffScope invariant violated: changedFiles must be repo-relative, got absolute path: ${f}`
      );
    }
    if (f.split('/').some(seg => seg === '..')) {
      throw new Error(
        `DiffScope invariant violated: changedFiles must not escape repo root: ${f}`
      );
    }
    if (f.startsWith('/')) {
      throw new Error(
        `DiffScope invariant violated: changedFiles must not start with '/': ${f}`
      );
    }
  }
}

/**
 * Convert a possibly-absolute filesystem path to a repo-relative POSIX path.
 * Used when comparing Document.filePath (which may be absolute, depending on
 * how DocumentRepository was loaded) against DiffScope.changedFiles.
 */
function toRepoRelativePosix(filePath: string, repoRoot: string): string {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  const rel = path.relative(repoRoot, abs);
  return rel.split(path.sep).join('/');
}

function filterAccepted(docPaths: string[], repo: DocumentRepository, repoRoot: string): string[] {
  const enforceable = new Set<string>();
  for (const d of repo.getEnforceableDocs()) {
    enforceable.add(toRepoRelativePosix(d.filePath, repoRoot));
  }
  return docPaths.filter(p => enforceable.has(toRepoRelativePosix(p, repoRoot)));
}

function findOverride(commitMessages: string[], contractId: string): string | null {
  const re = new RegExp(`override_contract:\\s*(spec_coupling|${escapeRegExp(contractId)})(?:\\s+(.+))?`, 'i');
  for (const msg of commitMessages) {
    const m = msg.match(re);
    if (m) return (m[2] || 'overridden').trim();
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match `files` against `includes` (any-of) minus `excludes` (none-of).
 *
 * All inputs are expected to be repo-relative POSIX strings. Delegates to
 * `minimatch` with the flag set specified by ADR-013 D13-2 / DDD-007.
 *
 * Bare negation patterns (starting with `!`) in either list are supported:
 * they invert the match result, so a pattern like `!<glob>.test.ts` excludes
 * test files from the include set when placed in `includes`.
 */
export function matchGlobs(files: string[], includes: string[], excludes: string[]): string[] {
  return files.filter(f => {
    const norm = f.replace(/\\/g, '/');
    if (includes.length > 0 && !matchesAny(norm, includes)) return false;
    if (excludes.length > 0 && matchesAny(norm, excludes)) return false;
    return true;
  });
}

function matchesAny(file: string, patterns: string[]): boolean {
  // Split into positive and negation patterns. A file matches the set iff at
  // least one positive pattern matches AND no negation pattern rejects it.
  // If the list contains only negations, treat it as "everything except ...".
  let positives: string[] = [];
  let negatives: string[] = [];
  for (const p of patterns) {
    if (p.startsWith('!')) negatives.push(p.slice(1));
    else positives.push(p);
  }

  const positiveHit = positives.length === 0
    ? true
    : positives.some(p => minimatch(file, p, MINIMATCH_OPTS));
  if (!positiveHit) return false;
  if (negatives.some(p => minimatch(file, p, MINIMATCH_OPTS))) return false;
  return true;
}

/**
 * @deprecated ADR-013 D13-2: use `minimatch` or `matchGlobs` directly. This
 * shim preserves the historical export name and returns a RegExp that
 * mirrors the minimatch behaviour of the given pattern (approximate — the
 * exported RegExp no longer drives production matching; it exists only for
 * backward compatibility with callers that imported `globToRegex`).
 */
export function globToRegex(pattern: string): RegExp {
  const mm = new Minimatch(pattern, MINIMATCH_OPTS);
  // If minimatch could not produce a regex (e.g. brace-expansion set),
  // fall back to a tester wrapper that executes minimatch per call.
  const re: RegExp | false = mm.makeRe();
  if (re) return re;
  // Brace expansions and some other patterns have no single RegExp; return a
  // wrapper that always defers to minimatch. This preserves the `.test(path)`
  // contract used by older callers.
  const wrapper: RegExp = Object.create(RegExp.prototype);
  (wrapper as unknown as { test: (s: string) => boolean }).test = (s: string) =>
    minimatch(s, pattern, MINIMATCH_OPTS);
  return wrapper;
}

// ─ Git diff helpers ──────────────────────────────────────────────────────────

export function gitDiffScope(opts: { diff?: string; staged?: boolean; cwd: string }): DiffScope {
  const cwd = opts.cwd;
  const repoRoot = resolveRepoRoot(cwd);
  let range: string;
  if (opts.staged) {
    range = '--cached';
  } else if (opts.diff) {
    range = `${opts.diff}...HEAD`;
  } else {
    // Default: last commit (HEAD~1..HEAD) — useful for post-commit hook
    range = 'HEAD~1..HEAD';
  }

  let changedFiles: string[] = [];
  let commitMessages: string[] = [];

  try {
    if (opts.staged) {
      const output = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: repoRoot, encoding: 'utf-8' });
      changedFiles = parseFileList(output);
      // For staged changes the intended commit message isn't yet available;
      // check COMMIT_EDITMSG if it exists (during the hook).
      const msgPath = path.join(repoRoot, '.git', 'COMMIT_EDITMSG');
      if (fs.existsSync(msgPath)) {
        commitMessages.push(fs.readFileSync(msgPath, 'utf-8'));
      }
    } else {
      const output = execSync(`git diff ${range} --name-only --diff-filter=ACMR`, { cwd: repoRoot, encoding: 'utf-8' });
      changedFiles = parseFileList(output);
      const logOutput = execSync(`git log ${range} --format=%B`, { cwd: repoRoot, encoding: 'utf-8' });
      commitMessages = [logOutput];
    }
  } catch {
    // Leave arrays empty if git invocation fails.
  }

  return { repoRoot, changedFiles, commitMessages };
}

/**
 * Find the repo root via `git rev-parse --show-toplevel`. Falls back to `cwd`
 * when git is unavailable or the directory is not a repository; in that case
 * parseFileList still produces repo-relative strings because git is not
 * producing any output to parse.
 */
function resolveRepoRoot(cwd: string): string {
  try {
    const top = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf-8' }).trim();
    if (top.length > 0) return top;
  } catch {
    // fall through
  }
  return cwd;
}

/**
 * Parse `git diff --name-only` output into repo-relative POSIX paths.
 *
 * Git emits paths relative to the repository root (when invoked from the
 * root) using forward slashes. We normalise defensively — stripping any
 * accidental leading slash and converting backslashes on Windows — but we
 * never call `path.resolve`, which was the root cause of the silent-pass
 * bug fixed by ADR-013 D13-1.
 */
function parseFileList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l.replace(/\\/g, '/'))
    .map(l => l.replace(/^\/+/, ''));
}
