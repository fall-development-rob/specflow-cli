/**
 * specflow doctor [dir] [--json] [--fix]
 * Run health checks on Specflow setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { loadContracts } from '../lib/native';
import { countFiles, isExecutable } from '../lib/fs-utils';
import { bold, red, green, yellow, cyan, dim } from '../lib/logger';
import { loadConfig } from '../lib/config';
import { DocumentRepository } from '../lib/document-repository';
import { validate as validateLinks, fix as fixLinks } from '../lib/link-validator';
import { walkAll as walkReferences } from '../lib/reference-walker';
import { loadContractIndex } from '../lib/contract-index';

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type Status = 'pass' | 'warn' | 'fail';

interface Check {
  name: string;
  severity: Severity;
  status: Status;
  detail: string;
}

interface DoctorOptions {
  dir?: string;
  json?: boolean;
  fix?: boolean;
  docs?: boolean;
}

export function run(options: DoctorOptions): void {
  const projectRoot = path.resolve(options.dir || '.');

  if (options.docs) {
    return runDocsMode(projectRoot, options);
  }

  const config = loadConfig(projectRoot);
  const checks: Check[] = [];

  // 1. Node.js >= 20
  const nodeVersion = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'Node.js version',
    severity: 'CRITICAL',
    status: nodeVersion >= 20 ? 'pass' : 'fail',
    detail: nodeVersion >= 20 ? `v${process.versions.node}` : `v${process.versions.node} (requires >= 20)`,
  });

  // 2. Contract directory with YAML files
  const contractsDir = path.join(projectRoot, config.contractsDir);
  const ymlCount = countFiles(contractsDir, 'yml') + countFiles(contractsDir, 'yaml');
  if (!fs.existsSync(contractsDir)) {
    checks.push({ name: 'Contract directory', severity: 'CRITICAL', status: 'fail', detail: `${contractsDir} does not exist` });
  } else if (ymlCount === 0) {
    checks.push({ name: 'Contract directory', severity: 'CRITICAL', status: 'fail', detail: 'No YAML contract files found' });
  } else {
    checks.push({ name: 'Contract directory', severity: 'CRITICAL', status: 'pass', detail: `${ymlCount} contract file(s)` });
  }

  // 3. All YAML files parse cleanly
  checks.push(checkYamlParse(contractsDir));

  // 4. All regex patterns compile
  checks.push(checkPatternsCompile(contractsDir));

  // 5. Test directory exists
  const testDir = path.join(projectRoot, config.testsDir);
  checks.push({
    name: 'Test directory',
    severity: 'HIGH',
    status: fs.existsSync(testDir) ? 'pass' : 'warn',
    detail: fs.existsSync(testDir) ? `${config.testsDir}/ exists` : `${config.testsDir}/ not found`,
  });

  // 6. package.json has test scripts
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const hasTest = !!pkg.scripts?.test;
      checks.push({
        name: 'Test scripts',
        severity: 'HIGH',
        status: hasTest ? 'pass' : 'warn',
        detail: hasTest ? 'package.json has test script' : 'No test script in package.json',
      });
    } catch {
      checks.push({ name: 'Test scripts', severity: 'HIGH', status: 'warn', detail: 'Could not parse package.json' });
    }
  } else {
    checks.push({ name: 'Test scripts', severity: 'HIGH', status: 'warn', detail: 'package.json not found' });
  }

  // 7. CLAUDE.md exists
  const claudeMd = path.join(projectRoot, 'CLAUDE.md');
  checks.push({
    name: 'CLAUDE.md',
    severity: 'HIGH',
    status: fs.existsSync(claudeMd) ? 'pass' : 'fail',
    detail: fs.existsSync(claudeMd) ? 'CLAUDE.md exists' : 'CLAUDE.md not found',
  });

  // 8. Git commit-msg hook
  const commitHook = path.join(projectRoot, '.git', 'hooks', 'commit-msg');
  const hookInstalled = fs.existsSync(commitHook) && isExecutable(commitHook);
  checks.push({
    name: 'Git commit-msg hook',
    severity: 'MEDIUM',
    status: hookInstalled ? 'pass' : 'warn',
    detail: hookInstalled ? 'Installed and executable' : 'Not installed -- run specflow update',
  });

  // 9. Claude Code hooks
  const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const hasHooks = content.includes('PostToolUse');
    checks.push({
      name: 'Claude Code hooks',
      severity: 'MEDIUM',
      status: hasHooks ? 'pass' : 'warn',
      detail: hasHooks ? '.claude/settings.json has hook config' : 'settings.json exists but no PostToolUse hooks',
    });
  } else {
    checks.push({ name: 'Claude Code hooks', severity: 'MEDIUM', status: 'warn', detail: 'Not installed -- run specflow update' });
  }

  // 10. Contract test file references
  checks.push(checkTestFileReferences(projectRoot, contractsDir));

  // 11. gh CLI
  checks.push(checkCommand('gh', ['--version'], 'gh CLI', 'LOW'));

  // 12. Playwright
  checks.push(checkCommand('npx', ['playwright', '--version'], 'Playwright', 'LOW'));

  // 13. Contract graph integrity
  checks.push(checkGraphIntegrity(projectRoot));

  // 14. Knowledge graph database
  checks.push(checkKnowledgeGraph(projectRoot));

  // 15. Documentation health summary
  checks.push(checkDocsHealth(projectRoot));

  // Output
  if (options.json) {
    printJsonOutput(checks);
  } else {
    printHumanOutput(checks, projectRoot);
  }

  const hasCriticalFail = checks.some(
    c => c.status === 'fail' && (c.severity === 'CRITICAL' || c.severity === 'HIGH')
  );
  if (hasCriticalFail) {
    process.exit(1);
  }
}

function checkYamlParse(dir: string): Check {
  if (!fs.existsSync(dir)) {
    return { name: 'YAML parsing', severity: 'CRITICAL', status: 'fail', detail: 'Contract directory missing' };
  }

  let yaml: any;
  try { yaml = require('js-yaml'); } catch {
    return { name: 'YAML parsing', severity: 'CRITICAL', status: 'warn', detail: 'js-yaml not available' };
  }

  const errors: string[] = [];
  let count = 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    count++;
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      yaml.load(content);
    } catch (e: any) {
      errors.push(`${file}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    return { name: 'YAML parsing', severity: 'CRITICAL', status: 'fail', detail: `${errors.length} error(s): ${errors[0]}` };
  }
  return { name: 'YAML parsing', severity: 'CRITICAL', status: 'pass', detail: `All ${count} files parse cleanly` };
}

function checkPatternsCompile(dir: string): Check {
  if (!fs.existsSync(dir)) {
    return { name: 'Pattern compilation', severity: 'CRITICAL', status: 'fail', detail: 'Contract directory missing' };
  }

  try {
    const contracts = loadContracts(dir);
    const ruleCount = contracts.reduce((sum, c) => sum + c.rules.length, 0);
    return { name: 'Pattern compilation', severity: 'CRITICAL', status: 'pass', detail: `${ruleCount} rules across ${contracts.length} contracts` };
  } catch (e: any) {
    return { name: 'Pattern compilation', severity: 'CRITICAL', status: 'fail', detail: `Failed: ${e.message}` };
  }
}

function checkTestFileReferences(projectRoot: string, contractsDir: string): Check {
  if (!fs.existsSync(contractsDir)) {
    return { name: 'Test file references', severity: 'MEDIUM', status: 'warn', detail: 'No contracts directory' };
  }

  let yaml: any;
  try { yaml = require('js-yaml'); } catch {
    return { name: 'Test file references', severity: 'MEDIUM', status: 'warn', detail: 'js-yaml not available' };
  }

  const missing: string[] = [];
  const files = fs.readdirSync(contractsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(contractsDir, file), 'utf-8');
      const parsed = yaml.load(content);
      const testFile = parsed?.test_hooks?.e2e_test_file;
      if (testFile && !fs.existsSync(path.join(projectRoot, testFile))) {
        missing.push(`${file} -> ${testFile}`);
      }
    } catch {
      // skip parse errors — covered by YAML parsing check
    }
  }

  if (missing.length > 0) {
    return { name: 'Test file references', severity: 'MEDIUM', status: 'warn', detail: `${missing.length} referenced test file(s) missing` };
  }
  return { name: 'Test file references', severity: 'MEDIUM', status: 'pass', detail: 'All referenced test files exist' };
}

function checkCommand(cmd: string, args: string[], name: string, severity: Severity): Check {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return { name, severity, status: 'pass', detail: 'Installed' };
  } catch {
    return { name, severity, status: 'warn', detail: 'Not installed' };
  }
}

function checkGraphIntegrity(projectRoot: string): Check {
  const script = path.join(projectRoot, 'scripts', 'verify-graph.cjs');
  if (!fs.existsSync(script)) {
    return { name: 'Contract graph', severity: 'LOW', status: 'warn', detail: 'verify-graph.cjs not found' };
  }
  try {
    execFileSync('node', [script, path.join(projectRoot, '.specflow', 'contracts')], { stdio: 'pipe' });
    return { name: 'Contract graph', severity: 'LOW', status: 'pass', detail: 'Integrity checks passed' };
  } catch {
    return { name: 'Contract graph', severity: 'LOW', status: 'fail', detail: 'Graph integrity errors' };
  }
}

function checkKnowledgeGraph(projectRoot: string): Check {
  try {
    const { graphExists } = require('../graph/database');
    if (!graphExists(projectRoot)) {
      return { name: 'Knowledge graph', severity: 'LOW', status: 'warn', detail: 'Not initialized — run specflow init or specflow enforce' };
    }
    // Verify database can be opened and has tables
    const { initGraph, query, closeGraph } = require('../graph/database');
    const database = (globalThis as any).__syncInitGraph?.(projectRoot);
    if (!database) {
      // Can't do async check in sync function — just verify file exists
      return { name: 'Knowledge graph', severity: 'LOW', status: 'pass', detail: '.specflow/knowledge.db exists' };
    }
    return { name: 'Knowledge graph', severity: 'LOW', status: 'pass', detail: '.specflow/knowledge.db exists and valid' };
  } catch (e: any) {
    return { name: 'Knowledge graph', severity: 'LOW', status: 'warn', detail: `Check failed: ${e.message}` };
  }
}

function checkDocsHealth(projectRoot: string): Check {
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');
  if (!fs.existsSync(docsRoot)) {
    return { name: 'Documentation', severity: 'LOW', status: 'warn', detail: 'No docs/architecture directory' };
  }
  try {
    const repo = new DocumentRepository();
    repo.load(docsRoot);
    const counts = repo.statusCounts();
    const now = new Date();
    const overdue = repo.findOverdue(now).length;
    const refs = walkReferences(projectRoot);
    repo.setInboundReferences(refs);
    const orphaned = repo.all().filter(d => d.classify(now, repo) === 'orphaned').length;
    const detail = `${counts.Accepted} Accepted, ${counts.Superseded} Superseded, ${counts.Deprecated} Deprecated. ${overdue} overdue, ${orphaned} orphaned.`;
    const status = overdue > 0 || orphaned > 0 ? 'warn' : 'pass';
    return { name: 'Documentation', severity: 'LOW', status, detail };
  } catch (e: any) {
    return { name: 'Documentation', severity: 'LOW', status: 'warn', detail: `Check failed: ${e.message}` };
  }
}

function runDocsMode(projectRoot: string, options: DoctorOptions): void {
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');
  if (!fs.existsSync(docsRoot)) {
    console.error(`No docs directory at ${docsRoot}`);
    process.exit(2);
  }

  const repo = new DocumentRepository();
  repo.load(docsRoot);
  const parseErrors = repo.getErrors();
  const linkReport = validateLinks(repo);

  if (options.fix) {
    const fixResult = fixLinks(repo);
    if (!options.json) {
      if (fixResult.fixed.length > 0) {
        console.log(green(`  Fixed ${fixResult.fixed.length} reciprocal link(s).`));
      }
      for (const r of fixResult.refused) {
        console.log(yellow(`  Refused: ${r.reciprocal.from} ↔ ${r.reciprocal.to} (${r.reason})`));
      }
    }
    repo.load(docsRoot); // reload after writes
  }

  const postFixReport = options.fix ? validateLinks(repo) : linkReport;
  const counts = repo.statusCounts();

  // S7 — validate `implements_contracts` against the on-disk contract index.
  // Contract ids are author-defined strings, not ID_PATTERN shaped, so the
  // frontmatter validator can only check shape. Existence lives here.
  const contractIndex = loadContractIndex(path.join(projectRoot, '.specflow', 'contracts'));
  const missingContracts: Array<{ from: string; missingContract: string }> = [];
  for (const doc of repo.all()) {
    for (const cid of doc.frontmatter.implements_contracts || []) {
      if (!contractIndex.get(cid)) {
        missingContracts.push({ from: doc.id, missingContract: cid });
      }
    }
  }

  if (options.json) {
    console.log(JSON.stringify({
      counts,
      parseErrors: parseErrors.map(e => ({ filePath: path.relative(projectRoot, e.filePath), error: e.error })),
      missingReciprocals: postFixReport.missingReciprocals,
      danglingReferences: postFixReport.danglingReferences,
      missingContracts,
    }, null, 2));
  } else {
    printDocsHuman(repo, parseErrors, postFixReport, counts, projectRoot, missingContracts);
  }

  const hasFailures =
    parseErrors.length > 0 ||
    postFixReport.missingReciprocals.length > 0 ||
    postFixReport.danglingReferences.length > 0 ||
    missingContracts.length > 0;
  if (hasFailures) {
    process.exit(1);
  }
}

function printDocsHuman(
  repo: DocumentRepository,
  parseErrors: Array<{ filePath: string; error: string }>,
  report: { missingReciprocals: Array<{ from: string; to: string; direction: string }>; danglingReferences: Array<{ from: string; missingTarget: string; field: string }> },
  counts: Record<string, number>,
  projectRoot: string,
  missingContracts: Array<{ from: string; missingContract: string }> = []
): void {
  console.log('');
  console.log(bold('Specflow Doctor — Documentation'));
  console.log('');

  console.log(`  Docs loaded: ${repo.all().length}`);
  console.log(`    Draft: ${counts.Draft}  Accepted: ${counts.Accepted}  Superseded: ${counts.Superseded}  Deprecated: ${counts.Deprecated}`);
  console.log('');

  if (parseErrors.length > 0) {
    console.log(red(bold(`  Parse errors (${parseErrors.length}):`)));
    for (const e of parseErrors) {
      console.log(`    ${path.relative(projectRoot, e.filePath)}: ${e.error}`);
    }
    console.log('');
  }

  if (report.danglingReferences.length > 0) {
    console.log(red(bold(`  Dangling references (${report.danglingReferences.length}):`)));
    for (const d of report.danglingReferences) {
      console.log(`    ${d.from}.${d.field} → ${d.missingTarget} (not found)`);
    }
    console.log('');
  }

  if (report.missingReciprocals.length > 0) {
    console.log(yellow(bold(`  Missing reciprocal links (${report.missingReciprocals.length}):`)));
    for (const m of report.missingReciprocals) {
      console.log(`    ${m.from} ↔ ${m.to} (missing ${m.direction === 'implements' ? 'implemented_by' : 'implements'})`);
    }
    console.log(dim('  Run with --fix to auto-mirror.'));
    console.log('');
  }

  if (missingContracts.length > 0) {
    console.log(red(bold(`  Unknown implements_contracts (${missingContracts.length}):`)));
    for (const m of missingContracts) {
      console.log(`    ${m.from} → ${m.missingContract} (not in .specflow/contracts/)`);
    }
    console.log('');
  }

  if (
    parseErrors.length === 0 &&
    report.danglingReferences.length === 0 &&
    report.missingReciprocals.length === 0 &&
    missingContracts.length === 0
  ) {
    console.log(green('  All documentation checks passed.'));
    console.log('');
  }
}

function printHumanOutput(checks: Check[], projectRoot: string): void {
  console.log('');
  console.log(bold('Specflow Doctor'));
  console.log(`Project: ${cyan(projectRoot)}`);
  console.log('');

  const maxName = Math.max(...checks.map(c => c.name.length));

  for (let i = 0; i < checks.length; i++) {
    const c = checks[i];
    const icon = c.status === 'pass' ? green('PASS') : c.status === 'warn' ? yellow('WARN') : red('FAIL');
    const sev = c.severity === 'CRITICAL' ? red(c.severity)
      : c.severity === 'HIGH' ? yellow(c.severity)
      : c.severity === 'LOW' ? dim(c.severity)
      : c.severity;

    console.log(
      `  ${String(i + 1).padStart(2)}. [${icon}] ${c.name.padEnd(maxName)}  ${String(sev).padStart(8)}  ${dim(c.detail)}`
    );
  }

  const passCount = checks.filter(c => c.status === 'pass').length;
  console.log('');
  console.log(`  ${passCount}/${checks.length} checks passed`);
  console.log('');
}

function printJsonOutput(checks: Check[]): void {
  const passCount = checks.filter(c => c.status === 'pass').length;
  const hasFailures = checks.some(c => c.status === 'fail');

  const output = {
    status: hasFailures ? 'fail' : 'pass',
    checks: checks.map(c => ({
      name: c.name,
      severity: c.severity,
      status: c.status,
      detail: c.detail,
    })),
    summary: {
      total: checks.length,
      pass: passCount,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
    },
  };
  console.log(JSON.stringify(output, null, 2));
}
