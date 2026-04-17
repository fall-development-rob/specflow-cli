/**
 * CouplingEnforcer — evaluates spec_coupling contracts against a git diff.
 * Implements DDD-007 CouplingEnforcer aggregate and GlobMatcher service.
 *
 * ADR-013 S1: path normalisation via DiffScope + minimatch-based glob matching.
 * ADR-013 S2: hardened gitDiffScope (preflight, shallow/merge detection, fail-loud),
 *             rule-scoped override directives, and null-separated file parsing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { minimatch, Minimatch } from 'minimatch';
import { DocumentRepository } from './document-repository';
import { loadSafeOrNull } from './safe-yaml';

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
      const parsed = loadSafeOrNull(content, { filename: filePath }) as any;
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
        const override = findOverride(diff.commitMessages, contract.contractId, rule.id);
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

/**
 * Find an override directive for a given contract (optionally rule-scoped).
 *
 * Per ADR-013 D13-5, accepted forms:
 *   override_contract: <contract_id>            (overrides every rule in that contract)
 *   override_contract: <contract_id>:<rule_id>  (overrides only that rule)
 *
 * Rules enforced here (per D13-5 + E13-8):
 *   - Directive must appear at the start of a line (or after a newline). Substring
 *     matches elsewhere on a line are rejected so that prose mentioning the
 *     directive does not accidentally trigger it.
 *   - Fenced code blocks (``` or ~~~) are stripped before matching so that
 *     quoted commit-message bodies or pasted logs do not trigger overrides.
 *   - The bare `override_contract: spec_coupling` form is no longer accepted —
 *     authors must name a specific contract id.
 *   - The contract id in the directive must match exactly (word boundary) — no
 *     trailing substring matches (`spec_coupling_core_extra` must not be
 *     accepted when the contract id is `spec_coupling_core`).
 */
export function findOverride(
  commitMessages: string[],
  contractId: string,
  ruleId?: string
): string | null {
  const contractPattern = escapeRegExp(contractId);
  // Accept `<contractId>` or `<contractId>:<ruleId>` (if ruleId provided, only
  // the bare contractId and exactly this ruleId count as matches; any other
  // `:otherRule` directive is non-matching for this particular rule).
  const re = new RegExp(
    `^override_contract:\\s+(${contractPattern})(?::([A-Za-z0-9_\\-]+))?\\b(?:[ \\t]+(.*))?$`,
    'gim'
  );

  for (const rawMsg of commitMessages) {
    if (!rawMsg) continue;
    const stripped = stripFencedCodeBlocks(rawMsg);
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      const directiveRuleId = m[2];
      const justification = (m[3] || '').trim();
      // If a specific rule is targeted in the directive, it must match the
      // rule under evaluation. Otherwise the directive covers the entire
      // contract.
      if (directiveRuleId && ruleId && directiveRuleId !== ruleId) continue;
      return justification || 'overridden';
    }
  }
  return null;
}

/**
 * Remove fenced code blocks (``` ... ``` and ~~~ ... ~~~) from a string so that
 * override directives quoted inside them cannot trigger. Unclosed fences at
 * end-of-text consume to end-of-text.
 */
function stripFencedCodeBlocks(text: string): string {
  // Fences at start-of-line only. Matches ``` or ~~~ optionally followed by an
  // info string, content, then the same fence marker.
  return text.replace(/(^|\n)(```+|~~~+)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, '\n');
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

export interface GitDiffScopeOptions {
  diff?: string;
  staged?: boolean;
  cwd: string;
  /**
   * Allow a shallow-clone fallback to a full-tree scan. Equivalent to
   * `SPECFLOW_ALLOW_SHALLOW=1` in the environment (env takes precedence when
   * either signal is set).
   */
  allowShallow?: boolean;
  /** Override fail-loud behaviour in tests; default is `process.exit(2)`. */
  onFatal?: (message: string) => never;
}

export class GitDiffScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitDiffScopeError';
  }
}

/**
 * Validate a user-supplied `--diff` range. Accepts `<base>..<head>`. If the
 * user supplied the triple-dot form (`A...HEAD`) we correct it to two-dot and
 * emit a warning, per ADR-013 D13-4 and PRD-011 S2.
 *
 * Returns the corrected range plus any warning messages.
 */
export function validateDiffRange(raw: string): { range: string; warnings: string[] } {
  const warnings: string[] = [];
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new GitDiffScopeError('--diff requires a non-empty range');
  }
  // Reject shell metacharacters that have no place in a revision range.
  if (/[;&|`$()<>\n\r]/.test(trimmed)) {
    throw new GitDiffScopeError(
      `--diff range contains forbidden characters: ${JSON.stringify(trimmed)}`
    );
  }

  // Triple-dot (symmetric difference) — correct to two-dot with a warning.
  if (trimmed.includes('...')) {
    const corrected = trimmed.replace(/\.\.\.+/g, '..');
    warnings.push(
      `warning: --diff received triple-dot range "${trimmed}"; ` +
        `correcting to two-dot "${corrected}" (per ADR-013 D13-4).`
    );
    const downstream = validateDiffRange(corrected);
    return { range: downstream.range, warnings: [...warnings, ...downstream.warnings] };
  }

  if (!trimmed.includes('..')) {
    throw new GitDiffScopeError(
      `--diff expects a range "<base>..<head>"; got "${trimmed}". ` +
        `Try "${trimmed}..HEAD".`
    );
  }
  const parts = trimmed.split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new GitDiffScopeError(
      `--diff range must have the form "<base>..<head>"; got "${trimmed}".`
    );
  }
  return { range: trimmed, warnings };
}

interface PreflightResult {
  mode: 'staged' | 'range' | 'fullTree';
  range?: string;
  warnings: string[];
  /** When true, a full-tree scan is requested (e.g. initial commit / shallow fallback). */
  fullTree?: boolean;
}

/**
 * Inspect the git environment and decide how to compute the diff. Fails loud
 * on shallow clones without an escape hatch; falls back explicitly (with a
 * visible warning) on initial commits and on merge commits.
 *
 * Per ADR-013 D13-3 / E13-1 / E13-2 / E13-3.
 */
export function preflight(
  cwd: string,
  opts: { diff?: string; staged?: boolean; allowShallow?: boolean }
): PreflightResult {
  const warnings: string[] = [];

  if (opts.staged) {
    return { mode: 'staged', warnings };
  }

  if (opts.diff) {
    const validated = validateDiffRange(opts.diff);
    warnings.push(...validated.warnings);
    return { mode: 'range', range: validated.range, warnings };
  }

  // Default path: inspect HEAD~1..HEAD feasibility.
  const allowShallow =
    opts.allowShallow === true || process.env.SPECFLOW_ALLOW_SHALLOW === '1';

  // Shallow clones can masquerade as initial commits (rev-list --count HEAD
  // returns 1 when HEAD is a shallow root), so check shallowness FIRST and
  // use it to distinguish "real first commit" from "fetch-depth=1 CI".
  const isShallowRaw = tryGitCapture('rev-parse --is-shallow-repository', cwd);
  const isShallow = (isShallowRaw || '').trim() === 'true';
  if (isShallow) {
    const headParent = tryGitCapture('rev-parse --verify HEAD~1', cwd);
    if (!headParent) {
      if (allowShallow) {
        warnings.push(
          'warning: shallow clone detected (no HEAD~1); falling back to full-tree scan ' +
            '(SPECFLOW_ALLOW_SHALLOW=1 or --allow-shallow). ' +
            'For precise coupling evaluation set fetch-depth: 0 in CI.'
        );
        return { mode: 'fullTree', warnings, fullTree: true };
      }
      throw new GitDiffScopeError(
        'shallow clone prevents reliable diff (HEAD~1 not fetched). ' +
          'Fix one of:\n' +
          '  - In GitHub Actions: set `fetch-depth: 0` on actions/checkout.\n' +
          '  - Set env SPECFLOW_ALLOW_SHALLOW=1 for a full-tree-scan fallback.\n' +
          '  - Pass `--diff <base>..HEAD` explicitly.'
      );
    }
  }

  const commitCountRaw = tryGitCapture('rev-list --count HEAD', cwd);
  const commitCount = commitCountRaw ? parseInt(commitCountRaw.trim(), 10) : NaN;
  if (Number.isFinite(commitCount) && commitCount <= 1) {
    warnings.push(
      'warning: initial commit — no previous revision; falling back to full-tree scan.'
    );
    return { mode: 'fullTree', warnings, fullTree: true };
  }

  const parentsRaw = tryGitCapture('rev-list --parents -n 1 HEAD', cwd);
  const parentCount = parentsRaw ? Math.max(0, parentsRaw.trim().split(/\s+/).length - 1) : 1;
  if (parentCount >= 2) {
    const firstParent = parentsRaw!.trim().split(/\s+/)[1];
    warnings.push(
      `warning: merge commit has ${parentCount} parents; diffing against first parent only ` +
        `(HEAD^1=${firstParent ? firstParent.substring(0, 7) : '?'}). ` +
        `Use --diff <other-parent-sha>..HEAD for the other side.`
    );
    return { mode: 'range', range: 'HEAD^1..HEAD', warnings };
  }

  return { mode: 'range', range: 'HEAD~1..HEAD', warnings };
}

export function gitDiffScope(opts: GitDiffScopeOptions): DiffScope {
  const cwd = opts.cwd;
  const repoRoot = resolveRepoRoot(cwd);
  const onFatal =
    opts.onFatal ||
    ((msg: string): never => {
      process.stderr.write(msg + '\n');
      process.exit(2);
    });

  let pre: PreflightResult;
  try {
    pre = preflight(repoRoot, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return onFatal(`specflow enforce: ${msg}`) as never;
  }
  for (const w of pre.warnings) {
    process.stderr.write(w + '\n');
  }

  let changedFiles: string[] = [];
  let commitMessages: string[] = [];

  try {
    if (pre.mode === 'staged') {
      const output = tryGitCaptureBuffer(
        ['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'],
        repoRoot
      );
      changedFiles = parseNullSeparatedFileList(output);
      commitMessages = readActiveCommitMessage(repoRoot);
    } else if (pre.mode === 'fullTree') {
      // Full-tree scan: treat every tracked file as changed (initial commit /
      // shallow fallback). Uses `git ls-files -z` for null-separated output.
      const output = tryGitCaptureBuffer(
        ['-c', 'core.quotepath=false', 'ls-files', '-z'],
        repoRoot
      );
      changedFiles = parseNullSeparatedFileList(output);
      // Commit messages are not applicable in this fallback — override
      // directives from HEAD are still useful, so we include them.
      const logOutput = tryGitCapture('log -n 50 --format=%B', repoRoot);
      if (logOutput) commitMessages = [logOutput];
    } else {
      const range = pre.range!;
      const output = tryGitCaptureBuffer(
        ['-c', 'core.quotepath=false', 'diff', range, '--name-only', '-z', '-M', '--diff-filter=ACMR'],
        repoRoot
      );
      changedFiles = parseNullSeparatedFileList(output);
      const logOutput = tryGitCapture(`log ${range} --format=%B`, repoRoot);
      if (logOutput) commitMessages = [logOutput];
    }
  } catch (e) {
    // Narrow catch — any error here is unexpected; surface it rather than
    // silently returning empty (per D13-3).
    const msg = e instanceof Error ? e.message : String(e);
    return onFatal(`specflow enforce: git invocation failed: ${msg}`) as never;
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
 * Read the commit message only when we are actively inside a commit hook.
 * Detecting this precisely is best-effort: git sets GIT_INDEX_FILE for
 * `pre-commit`/`commit-msg`/`prepare-commit-msg`, and GIT_EDITOR for the
 * editor-launching variants. We require one of those signals before trusting
 * `.git/COMMIT_EDITMSG` — otherwise the file is stale from the previous commit.
 */
function readActiveCommitMessage(cwd: string): string[] {
  const inHook = Boolean(process.env.GIT_INDEX_FILE || process.env.GIT_EDITOR);
  if (!inHook) return [];
  const gitDir = tryGitCapture('rev-parse --git-dir', cwd);
  const base = gitDir ? path.resolve(cwd, gitDir.trim()) : path.join(cwd, '.git');
  const msgPath = path.join(base, 'COMMIT_EDITMSG');
  if (!fs.existsSync(msgPath)) return [];
  try {
    const msg = fs.readFileSync(msgPath, 'utf-8');
    return msg ? [msg] : [];
  } catch {
    return [];
  }
}

function tryGitCapture(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function tryGitCaptureBuffer(args: string[], cwd: string): Buffer {
  // Use spawnSync-style argv (via execFileSync) so we never pass user input
  // through a shell. Returns empty buffer on failure to let higher-level code
  // decide how to react.
  const { execFileSync } = require('child_process') as typeof import('child_process');
  try {
    return execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as Buffer;
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Parse `git ... -z` null-separated output into a list of repo-relative paths.
 * Preserves filenames containing spaces, quotes, and non-ASCII bytes verbatim.
 * Normalises Windows backslashes defensively; never calls `path.resolve`.
 */
export function parseNullSeparatedFileList(buf: Buffer | string): string[] {
  const text = typeof buf === 'string' ? buf : buf.toString('utf-8');
  if (!text) return [];
  return text
    .split('\0')
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/\\/g, '/'))
    .map((p) => p.replace(/^\/+/, ''));
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
export function parseFileList(output: string): string[] {
  if (!output) return [];
  return output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => l.replace(/\\/g, '/'))
    .map(l => l.replace(/^\/+/, ''));
}
