/**
 * CouplingEnforcer — evaluates spec_coupling contracts against a git diff.
 * Implements DDD-007 CouplingEnforcer aggregate and CouplingMatcher service.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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

export interface DiffScope {
  changedFiles: string[];
  commitMessages: string[];
}

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
  const violations: CouplingViolation[] = [];

  for (const contract of contracts) {
    for (const rule of contract.rules) {
      const changedSourceFiles = matchGlobs(diff.changedFiles, rule.source_globs, rule.exclude_globs);
      if (changedSourceFiles.length === 0) continue; // asymmetric — no source changes, no violation

      const actualDocChanges = matchGlobs(diff.changedFiles, rule.required_doc_globs, []);

      // Only Accepted docs satisfy a coupling (per ADR-011 E11-5).
      const enforceableDocChanges = opts.docRepo
        ? filterAccepted(actualDocChanges, opts.docRepo)
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

function filterAccepted(docPaths: string[], repo: DocumentRepository): string[] {
  const enforceable = new Set<string>();
  for (const d of repo.getEnforceableDocs()) {
    enforceable.add(path.resolve(d.filePath));
  }
  return docPaths.filter(p => enforceable.has(path.resolve(p)));
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
 * Simple glob matcher supporting **, *, and ?.
 */
export function matchGlobs(files: string[], includes: string[], excludes: string[]): string[] {
  const inc = includes.map(globToRegex);
  const exc = excludes.map(globToRegex);
  return files.filter(f => {
    const norm = f.replace(/\\/g, '/');
    if (inc.length > 0 && !inc.some(re => re.test(norm))) return false;
    if (exc.some(re => re.test(norm))) return false;
    return true;
  });
}

export function globToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any path (including zero segments)
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++; // consume trailing slash after **
      } else {
        // * matches any non-slash chars
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

// ─ Git diff helpers ──────────────────────────────────────────────────────────

export function gitDiffScope(opts: { diff?: string; staged?: boolean; cwd: string }): DiffScope {
  const cwd = opts.cwd;
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
      const output = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd, encoding: 'utf-8' });
      changedFiles = parseFileList(output, cwd);
      // For staged changes the intended commit message isn't yet available;
      // check COMMIT_EDITMSG if it exists (during the hook).
      const msgPath = path.join(cwd, '.git', 'COMMIT_EDITMSG');
      if (fs.existsSync(msgPath)) {
        commitMessages.push(fs.readFileSync(msgPath, 'utf-8'));
      }
    } else {
      const output = execSync(`git diff ${range} --name-only --diff-filter=ACMR`, { cwd, encoding: 'utf-8' });
      changedFiles = parseFileList(output, cwd);
      const logOutput = execSync(`git log ${range} --format=%B`, { cwd, encoding: 'utf-8' });
      commitMessages = [logOutput];
    }
  } catch {
    // Leave arrays empty if git invocation fails.
  }

  return { changedFiles, commitMessages };
}

function parseFileList(output: string, cwd: string): string[] {
  return output
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(rel => path.resolve(cwd, rel));
}
