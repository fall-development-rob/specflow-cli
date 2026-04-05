/**
 * specflow status [dir] [--json]
 * Show compliance status dashboard.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadContracts, scanFiles } from '../lib/native';
import { isExecutable } from '../lib/fs-utils';
import { bold, red, green, yellow, cyan, dim } from '../lib/logger';
import { loadConfig } from '../lib/config';

interface StatusOptions {
  dir?: string;
  json?: boolean;
  history?: boolean;
  since?: string;
}

export async function run(options: StatusOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const config = loadConfig(projectRoot);
  const contractsDir = path.join(projectRoot, config.contractsDir);

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

  // Show history from knowledge graph if --history flag
  if (options.history) {
    try {
      const { graphExists, initGraph, closeGraph } = require('../graph/database');
      if (graphExists(projectRoot)) {
        const database = await initGraph(projectRoot);
        try {
          const { getComplianceTrend, getViolationHotspots } = require('../graph/queries');
          const days = options.since ? Math.ceil((Date.now() - new Date(options.since).getTime()) / (1000 * 60 * 60 * 24)) : 30;
          const trend = getComplianceTrend(database, days);
          const hotspots = getViolationHotspots(database, 5);

          if (options.json) {
            console.log(JSON.stringify({ compliance_trend: trend, hotspots }, null, 2));
          } else {
            if (trend.length > 0) {
              console.log(bold('  Compliance Trend'));
              for (const entry of trend) {
                const bar = '#'.repeat(Math.min(entry.violations, 40));
                console.log(`    ${entry.day}: ${red(String(entry.violations).padStart(3))} ${dim(bar)}`);
              }
              console.log('');
            } else {
              console.log('  No violation history recorded yet.');
              console.log('');
            }

            if (hotspots.byRule.length > 0) {
              console.log(bold('  Violation Hotspots'));
              console.log('    By rule:');
              for (const h of hotspots.byRule) {
                console.log(`      ${yellow(h.ruleId)} (${h.contractId}): ${red(String(h.count))} violations`);
              }
              if (hotspots.byFile.length > 0) {
                console.log('    By file:');
                for (const h of hotspots.byFile) {
                  console.log(`      ${cyan(h.file)}: ${red(String(h.count))} violations`);
                }
              }
              console.log('');
            }
          }
        } finally {
          closeGraph(database);
        }
      } else {
        if (!options.json) {
          console.log('  No knowledge graph found. Run specflow enforce to build one.');
          console.log('');
        }
      }
    } catch {
      // Graph operations are optional
    }
  }
}

