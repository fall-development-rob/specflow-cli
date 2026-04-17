/**
 * specflow audit <issue-number> | --contract <id>
 *
 * Issue-number form: audits a GitHub issue body for specflow compliance
 * markers (Gherkin, data-testid, etc.) — this is the v1 behaviour.
 *
 * `--contract <id>` form (S7, ADR-016): walks the upward traceability chain
 * starting at a `.specflow/contracts/*.yml` contract id. For each rule we
 * list every doc whose frontmatter declares `implements_contracts: [<id>]`
 * (or legacy `implemented_by: [<id>]`) and recurse through that doc's
 * `implemented_by` chain to show the full reach.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { bold, red, green, yellow, cyan, dim } from '../lib/logger';
import { DocumentRepository } from '../lib/document-repository';
import { loadContractIndex } from '../lib/contract-index';
import {
  buildContractTree,
  ContractTree,
  DocNode,
  RuleNode,
} from '../lib/traceability';

interface AuditOptions {
  issue?: string;
  contract?: string;
  dir?: string;
  json?: boolean;
}

export function run(options: AuditOptions): void {
  if (options.contract) {
    return runContractAudit(options);
  }

  const issue = options.issue || '';
  if (!/^\d+$/.test(issue)) {
    console.error('Usage: specflow audit <issue-number>');
    console.error('       specflow audit --contract <contract-id> [--json]');
    process.exit(1);
  }
  runIssueAudit(issue);
}

// ---------------------------------------------------------------------------
// --contract <id> handler
// ---------------------------------------------------------------------------

function runContractAudit(options: AuditOptions): void {
  const projectRoot = path.resolve(options.dir || '.');
  const contractsDir = path.join(projectRoot, '.specflow', 'contracts');
  const docsRoot = path.join(projectRoot, 'docs', 'architecture');

  const contractIndex = loadContractIndex(contractsDir);
  const repo = new DocumentRepository();
  if (fs.existsSync(docsRoot)) repo.load(docsRoot);

  const tree = buildContractTree(options.contract!, contractIndex, repo, repo.all());

  if (options.json) {
    console.log(JSON.stringify(tree, null, 2));
    // Exit zero even on rootless contracts — per ADR-016, (none) is a valid
    // outcome the reviewer wants to see, not an error.
    return;
  }

  printContractTree(tree, projectRoot);
}

function printContractTree(tree: ContractTree, projectRoot: string): void {
  console.log('');
  console.log(`${bold('AUDIT')}: contract ${cyan(tree.contractId)}`);
  if (tree.found && tree.filePath) {
    const rel = path.relative(projectRoot, tree.filePath);
    console.log(`  ${dim(`source: ${rel}`)}`);
    const meta: string[] = [];
    if (tree.type) meta.push(`type=${tree.type}`);
    if (tree.version) meta.push(`version=${tree.version}`);
    if (tree.owner) meta.push(`owner=${tree.owner}`);
    if (meta.length > 0) console.log(`  ${dim(meta.join('  '))}`);
  } else {
    console.log(`  ${yellow('contract not found in .specflow/contracts/')}`);
  }
  console.log('');

  const totalDocs =
    tree.rootDocuments.length +
    tree.rules.reduce((n, r) => n + r.documents.length, 0);

  if (totalDocs === 0) {
    console.log(`  ${dim('(none)')}`);
    console.log('');
    return;
  }

  if (tree.rootDocuments.length > 0) {
    console.log(cyan(bold('  Contract-level implementers')));
    for (const doc of tree.rootDocuments) printDocNode(doc, '    ', true);
    console.log('');
  }

  for (const rule of tree.rules) {
    printRuleNode(rule);
  }
}

function printRuleNode(rule: RuleNode): void {
  console.log(`${cyan('  ' + rule.ruleId)}  ${rule.description || dim('(no description)')}`);
  if (rule.documents.length === 0) {
    console.log(`    ${dim('(no implementers)')}`);
  } else {
    for (const doc of rule.documents) printDocNode(doc, '    ', true);
  }
  console.log('');
}

function printDocNode(node: DocNode, indent: string, isRoot: boolean): void {
  const prefix = isRoot ? indent : indent;
  if (node.missing) {
    console.log(`${prefix}${red(node.id)} ${dim('(missing — not in docs/architecture)')}`);
    return;
  }
  if (node.cycleOf) {
    console.log(`${prefix}${yellow(node.id)} ${dim('(cycle)')}`);
    return;
  }
  const meta: string[] = [];
  if (node.status) meta.push(`status=${node.status}`);
  if (node.version) meta.push(`v${node.version}`);
  if (node.last_reviewed) meta.push(`reviewed=${node.last_reviewed}`);
  const metaStr = meta.length ? dim(`(${meta.join(', ')})`) : '';
  const title = node.title ? ` ${dim('— ' + node.title)}` : '';
  console.log(`${prefix}${bold(node.id)}${title}  ${metaStr}`);
  for (const child of node.children) {
    printDocNode(child, indent + '  ', false);
  }
}

// ---------------------------------------------------------------------------
// <issue-number> handler — unchanged from v1 apart from function extraction.
// ---------------------------------------------------------------------------

function runIssueAudit(issue: string): void {
  let body: string;
  try {
    body = execSync(`gh issue view ${issue} --json title,body,comments`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    console.error(`Could not fetch issue #${issue}. Is gh authenticated?`);
    process.exit(1);
    return; // unreachable but satisfies TS
  }

  const parsed = JSON.parse(body);
  const title = parsed.title || '';
  const fullText = [
    parsed.body || '',
    ...(parsed.comments || []).map((c: any) => c.body || ''),
  ].join('\n');

  console.log(`\n${bold('AUDIT')}: #${issue} -- ${title}\n`);

  const checks: Array<{ name: string; pattern: RegExp }> = [
    { name: 'Gherkin', pattern: /Scenario:/i },
    { name: 'Acceptance', pattern: /- \[[ x]\]/ },
    { name: 'Journey ID', pattern: /J-[A-Z0-9]+(-[A-Z0-9]+)*/ },
    { name: 'data-testid', pattern: /data-testid/i },
    { name: 'SQL', pattern: /CREATE\s+(TABLE|FUNCTION|OR REPLACE FUNCTION)/i },
    { name: 'RLS', pattern: /CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY|ROW\s+LEVEL\s+SECURITY/i },
    { name: 'Invariants', pattern: /I-[A-Z]{2,}-\d+/ },
    { name: 'TypeScript', pattern: /(?:interface|type)\s+\w+/ },
    { name: 'Scope', pattern: /In Scope|Not In Scope/i },
    { name: 'DoD', pattern: /Definition of Done|DoD/i },
    { name: 'Pre-flight', pattern: /simulation_status:\s*\w+/ },
  ];

  let passCount = 0;
  const maxName = Math.max(...checks.map(c => c.name.length));

  for (const check of checks) {
    const match = fullText.match(check.pattern);
    const icon = match ? green('PASS') : red('FAIL');
    const evidence = match ? match[0].substring(0, 60) : 'MISSING';
    console.log(`  ${icon} ${check.name.padEnd(maxName + 2)} ${evidence}`);
    if (match) passCount++;
  }

  console.log(`\n  ${passCount}/${checks.length} checks passed\n`);

  if (passCount === checks.length) {
    console.log(`  ${bold(green('VERDICT: Compliant'))}\n`);
  } else if (passCount >= 4) {
    console.log(`  ${bold(yellow('VERDICT: Needs uplift'))}\n`);
  } else {
    console.log(`  ${bold(red('VERDICT: Non-compliant -- needs full specflow-writer pass'))}\n`);
  }
}
