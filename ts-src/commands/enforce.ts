/**
 * specflow enforce [dir] [--json] [--contract <name>] [--staged] [--diff <branch>] [--suggest]
 * Enforce contracts against project files.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { scanFiles, scanFileList } from '../lib/native';
import { printHuman, printJson } from '../lib/reporter';
import { loadConfig } from '../lib/config';
import {
  loadCouplingContracts,
  evaluate as evaluateCoupling,
  gitDiffScope,
  validateDiffRange,
  GitDiffScopeError,
  CouplingViolation,
} from '../lib/coupling-enforcer';
import { DocumentRepository } from '../lib/document-repository';

interface EnforceOptions {
  dir?: string;
  json?: boolean;
  contract?: string;
  staged?: boolean;
  diff?: string;
  suggest?: boolean;
  /** Opt into a full-tree-scan fallback on shallow clones (ADR-013 E13-1). */
  allowShallow?: boolean;
}

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.webm',
  '.zip', '.tar', '.gz',
  '.pdf', '.lock',
]);

/**
 * Run a git command and return trimmed stdout, or null on failure.
 */
function git(args: string, cwd: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Check if cwd is inside a git repository.
 */
function isGitRepo(cwd: string): boolean {
  return git('rev-parse --is-inside-work-tree', cwd) === 'true';
}

/**
 * Get the repo root directory.
 */
function getRepoRoot(cwd: string): string {
  return git('rev-parse --show-toplevel', cwd) || cwd;
}

/**
 * Filter binary files and resolve paths relative to repo root.
 */
function filterAndResolve(files: string[], repoRoot: string): string[] {
  return files
    .filter(f => f.length > 0)
    .filter(f => !BINARY_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map(f => path.resolve(repoRoot, f));
}

/**
 * Parse git diff --name-only --diff-filter=ACMR output into file paths.
 * For renamed files (R status), only the new path is included.
 */
function parseDiffOutput(output: string): string[] {
  if (!output) return [];
  return output.split('\n').filter(line => line.length > 0);
}

/**
 * Get staged files (Added, Copied, Modified, Renamed only).
 */
function getStagedFiles(cwd: string): string[] {
  const output = git('diff --cached --name-only --diff-filter=ACMR', cwd);
  if (!output) return [];
  return parseDiffOutput(output);
}

/**
 * Get files changed for a validated diff range.
 *
 * Accepts either a bare ref (legacy) — treated as `${ref}..HEAD` with a
 * warning — or a full `<base>..<head>` expression produced by
 * `validateDiffRange`. Uses two-dot semantics per ADR-013 D13-4; triple-dot
 * is rejected upstream by `validateDiffRange`.
 */
function getDiffFiles(range: string, cwd: string): { files: string[]; error?: string } {
  const parts = range.split('..');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { files: [], error: `Invalid diff range: ${range}` };
  }
  const base = parts[0];
  const head = parts[1];

  // Verify both sides resolve.
  if (git(`rev-parse --verify ${base}`, cwd) === null) {
    return { files: [], error: `Diff base not found: ${base}` };
  }
  if (git(`rev-parse --verify ${head}`, cwd) === null) {
    return { files: [], error: `Diff head not found: ${head}` };
  }

  // Check for common ancestor (non-fatal; just informative on divergence).
  const mergeBase = git(`merge-base ${base} ${head}`, cwd);
  if (mergeBase === null) {
    return { files: [], error: `No common ancestor between ${base} and ${head}` };
  }

  const output = git(`diff ${base}..${head} --name-only --diff-filter=ACMR`, cwd);
  if (!output) return { files: [] };
  return { files: parseDiffOutput(output) };
}

export async function run(options: EnforceOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const config = loadConfig(projectRoot);
  const contractsDir = path.join(projectRoot, config.contractsDir);

  if (!fs.existsSync(contractsDir)) {
    console.error(`No contract directory found at ${contractsDir}. Run \`specflow init\` first.`);
    process.exit(1);
  }

  // Normalise --diff input early: correct triple-dot, reject shell metachars,
  // and accept a bare ref (legacy) by upgrading it to `<ref>..HEAD` with a
  // warning (per ADR-013 D13-4).
  if (options.diff) {
    const raw = options.diff;
    if (!raw.includes('..')) {
      console.error(
        `warning: --diff expects a range "<base>..HEAD"; got "${raw}". ` +
          `Interpreting as "${raw}..HEAD".`
      );
      options.diff = `${raw}..HEAD`;
    } else {
      try {
        const validated = validateDiffRange(raw);
        for (const w of validated.warnings) console.error(w);
        options.diff = validated.range;
      } catch (e) {
        const msg = e instanceof GitDiffScopeError || e instanceof Error ? e.message : String(e);
        console.error(`error: ${msg}`);
        process.exit(2);
      }
    }
  }

  let result;

  if (options.staged) {
    // --staged: scan only git-staged files
    if (!isGitRepo(projectRoot)) {
      console.error('Not a git repository — --staged requires git');
      process.exit(2);
    }

    const repoRoot = getRepoRoot(projectRoot);
    const stagedFiles = getStagedFiles(repoRoot);
    if (stagedFiles.length === 0) {
      console.log('No staged files to scan');
      process.exit(0);
    }

    const resolvedFiles = filterAndResolve(stagedFiles, repoRoot);
    if (resolvedFiles.length === 0) {
      console.log('No staged files to scan (all filtered as binary)');
      process.exit(0);
    }

    console.log(`Scanning ${resolvedFiles.length} staged file(s)`);
    result = scanFileList(contractsDir, resolvedFiles, projectRoot);
  } else if (options.diff) {
    // --diff <branch>: scan only files changed vs branch
    if (!isGitRepo(projectRoot)) {
      console.error('Not a git repository — --diff requires git');
      process.exit(2);
    }

    const repoRoot = getRepoRoot(projectRoot);
    const { files, error } = getDiffFiles(options.diff, repoRoot);
    if (error) {
      console.error(error);
      process.exit(2);
    }

    if (files.length === 0) {
      console.log(`No files changed vs ${options.diff}`);
      process.exit(0);
    }

    const resolvedFiles = filterAndResolve(files, repoRoot);
    if (resolvedFiles.length === 0) {
      console.log(`No scannable files changed vs ${options.diff} (all filtered)`);
      process.exit(0);
    }

    console.log(`Scanning ${resolvedFiles.length} files changed vs ${options.diff}`);
    result = scanFileList(contractsDir, resolvedFiles, projectRoot);
  } else {
    // Default: scan full directory
    result = scanFiles(contractsDir, projectRoot);
  }

  // Filter by contract name if specified
  let output = result;
  if (options.contract) {
    output = {
      ...result,
      violations: result.violations.filter(
        v => v.contractId === options.contract
      ),
    };
  }

  // Record violations in knowledge graph (optional — failures don't block enforce)
  let suggestions: Map<string, any> | undefined;
  try {
    const { graphExists, initGraph, closeGraph } = require('../graph/database');
    const { rebuildGraph } = require('../graph/builder');
    const { recordEnforceRun } = require('../graph/recorder');
    const { suggestFix, seedFixSuggestions } = require('../graph/queries');

    // Initialize graph if it doesn't exist yet
    if (!graphExists(projectRoot)) {
      await rebuildGraph(projectRoot);
    }

    const database = await initGraph(projectRoot);
    try {
      recordEnforceRun(database, output);

      // Seed fix suggestions from contract examples on first run
      if (options.suggest) {
        seedFixSuggestions(database, contractsDir);
      }

      // Collect fix suggestions for each violated rule
      if (options.suggest) {
        suggestions = new Map();
        const seen = new Set<string>();
        for (const v of output.violations) {
          const key = `${v.contractId}::${v.ruleId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const suggestion = suggestFix(database, v.ruleId, v.contractId);
          if (suggestion) {
            suggestions.set(key, suggestion);
          }
        }
      }
    } finally {
      closeGraph(database);
    }
  } catch {
    // Graph operations are optional
  }

  if (options.json) {
    // Include suggestions in JSON output if available
    if (suggestions && suggestions.size > 0) {
      const enriched = {
        ...output,
        fix_suggestions: Object.fromEntries(suggestions),
      };
      printJson(enriched);
    } else {
      printJson(output);
    }
  } else {
    printHuman(output, projectRoot);

    // Print fix suggestions after violations (only when --suggest is passed)
    if (options.suggest && suggestions && suggestions.size > 0) {
      console.log('');
      console.log('  Fix suggestions (from knowledge graph):');
      for (const [key, suggestion] of suggestions) {
        const successes = suggestion.successes || 0;
        const desc = suggestion.example_compliant || suggestion.pattern || suggestion.description || suggestion.method || '';
        if (suggestion.confidence > 0.5 && desc) {
          console.log(`  Suggested fix (${successes} successes): ${desc}`);
        }
      }
    }
  }

  // spec_coupling evaluation (additive — runs alongside forbidden/required rules)
  const couplingContracts = loadCouplingContracts(contractsDir);
  if (couplingContracts.length > 0) {
    const docsRoot = path.join(projectRoot, 'docs', 'architecture');
    const repo = new DocumentRepository();
    if (fs.existsSync(docsRoot)) repo.load(docsRoot);

    const diffScope = gitDiffScope({
      diff: options.diff,
      staged: options.staged,
      cwd: projectRoot,
      allowShallow: options.allowShallow,
    });
    const couplingViolations = evaluateCoupling(couplingContracts, diffScope, { docRepo: repo });

    if (options.json) {
      if (couplingViolations.length > 0) {
        console.log(JSON.stringify({ type: 'spec_coupling', violations: couplingViolations }, null, 2));
      }
    } else {
      printCouplingViolations(couplingViolations);
    }

    const hasHardFailures = couplingViolations.some(v => v.severity === 'error');
    if (hasHardFailures) {
      process.exitCode = 1;
    }
  }

  if (output.violations.length > 0) {
    process.exitCode = 1;
  }
}

function printCouplingViolations(violations: CouplingViolation[]): void {
  if (violations.length === 0) return;
  console.log('');
  console.log('  spec_coupling:');
  for (const v of violations) {
    const label = v.severity === 'error' ? '  ERROR' : '  WARN ';
    console.log(`${label} ${v.contractId}::${v.ruleId} — ${v.description}`);
    console.log(`    changed source:  ${v.changedSourceFiles.length} file(s)`);
    console.log(`    expected docs:   ${v.expectedDocGlobs.join(', ')}`);
    if (v.overrideJustification) {
      console.log(`    override:        ${v.overrideJustification}`);
    }
  }
}
