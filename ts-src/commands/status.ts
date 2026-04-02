/**
 * specflow status [dir] [--json]
 * Show compliance status dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadContracts, scanFiles } from '../lib/native';
import { bold, red, green, yellow, cyan } from '../lib/logger';

interface StatusOptions {
  dir?: string;
  json?: boolean;
}

export function run(options: StatusOptions): void {
  const projectRoot = path.resolve(options.dir || '.');
  const contractsDir = path.join(projectRoot, 'docs', 'contracts');

  let contractCount = 0;
  let ruleCount = 0;
  let violationCount = 0;
  let filesScanned = 0;

  if (fs.existsSync(contractsDir)) {
    try {
      const contracts = loadContracts(contractsDir);
      contractCount = contracts.length;
      ruleCount = contracts.reduce((sum, c) => sum + c.rules.length, 0);

      const result = scanFiles(contractsDir, projectRoot);
      violationCount = result.violations.length;
      filesScanned = result.filesScanned;
    } catch {
      // counts stay at 0
    }
  }

  let compliancePct: number;
  if (ruleCount > 0 && filesScanned > 0) {
    const totalChecks = ruleCount * filesScanned;
    const passing = Math.max(0, totalChecks - violationCount);
    compliancePct = Math.min(100, (passing / totalChecks) * 100);
  } else if (violationCount === 0) {
    compliancePct = 100;
  } else {
    compliancePct = 0;
  }

  const hasGitHook = isExecutable(path.join(projectRoot, '.git', 'hooks', 'commit-msg'));
  const hasClaudeHooks = fs.existsSync(path.join(projectRoot, '.claude', 'settings.json'));
  const hasClaudeMd = fs.existsSync(path.join(projectRoot, 'CLAUDE.md'));

  if (options.json) {
    console.log(JSON.stringify({
      contracts: contractCount,
      rules: ruleCount,
      violations: violationCount,
      files_scanned: filesScanned,
      compliance_percentage: Math.round(compliancePct * 10) / 10,
      hooks: {
        git_commit_msg: hasGitHook,
        claude_code: hasClaudeHooks,
      },
      claude_md: hasClaudeMd,
    }, null, 2));
  } else {
    console.log('');
    console.log(bold('Specflow Status'));
    console.log(`Project: ${cyan(projectRoot)}`);
    console.log('');

    console.log(`  Contracts:  ${bold(String(contractCount))}`);
    console.log(`  Rules:      ${bold(String(ruleCount))}`);
    console.log(`  Files:      ${bold(String(filesScanned))}`);
    console.log(`  Violations: ${violationCount === 0 ? bold(green('0')) : bold(red(String(violationCount)))}`);

    const pctStr = `${compliancePct.toFixed(1)}%`;
    if (compliancePct >= 100) {
      console.log(`  Compliance: ${bold(green(pctStr))}`);
    } else if (compliancePct >= 80) {
      console.log(`  Compliance: ${bold(yellow(pctStr))}`);
    } else {
      console.log(`  Compliance: ${bold(red(pctStr))}`);
    }

    console.log('');
    console.log('  Hooks:');
    console.log(`    Git commit-msg: ${hasGitHook ? green('installed') : red('missing')}`);
    console.log(`    Claude Code:    ${hasClaudeHooks ? green('installed') : red('missing')}`);
    console.log(`    CLAUDE.md:      ${hasClaudeMd ? green('present') : red('missing')}`);
    console.log('');
  }
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
