/**
 * specflow audit <issue-number>
 * Audit a GitHub issue for specflow compliance markers.
 */

import { execSync } from 'child_process';
import { bold, red, green, yellow } from '../lib/logger';

interface AuditOptions {
  issue: string;
}

export function run(options: AuditOptions): void {
  const issue = options.issue;

  if (!/^\d+$/.test(issue)) {
    console.error('Usage: specflow audit <issue-number>');
    process.exit(1);
  }

  // Fetch issue via gh CLI
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
