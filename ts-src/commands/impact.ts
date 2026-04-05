/**
 * specflow impact <contract-id> [--dir <path>] [--json]
 * Analyze the impact of changing a contract.
 * Shows affected files, rules, agents, and historical violations.
 */

import * as path from 'path';
import { bold, red, green, yellow, cyan, dim } from '../lib/logger';

interface ImpactOptions {
  contractId: string;
  dir?: string;
  json?: boolean;
}

export async function run(options: ImpactOptions): Promise<void> {
  if (!options.contractId) {
    console.error('Usage: specflow impact <contract-id> [--dir <path>] [--json]');
    process.exit(1);
  }

  const projectRoot = path.resolve(options.dir || '.');

  try {
    const { graphExists, initGraph, closeGraph } = require('../graph/database');
    const { rebuildGraph } = require('../graph/builder');
    const { getImpact } = require('../graph/queries');

    if (!graphExists(projectRoot)) {
      await rebuildGraph(projectRoot);
    }

    const database = await initGraph(projectRoot);
    try {
      const report = getImpact(database, options.contractId);

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log('');
        console.log(bold(`Impact Analysis: ${cyan(options.contractId)}`));
        console.log('');

        // Rules
        console.log(`  ${bold('Rules:')} ${report.rules.length}`);
        for (const rule of report.rules) {
          console.log(`    ${yellow(rule.rule_id || rule.id)} — ${rule.title || ''}`);
        }

        // Scope
        console.log('');
        console.log(`  ${bold('Scope globs:')} ${report.scopeGlobs.length}`);
        for (const glob of report.scopeGlobs) {
          console.log(`    ${dim(glob)}`);
        }

        // Agents
        if (report.agents.length > 0) {
          console.log('');
          console.log(`  ${bold('Bound agents:')} ${report.agents.length}`);
          for (const agent of report.agents) {
            console.log(`    ${cyan(agent.name || agent.id)}`);
          }
        }

        // Historical
        console.log('');
        if (report.historicalViolations > 0) {
          console.log(`  ${bold('Historical violations:')} ${red(String(report.historicalViolations))}`);
        } else {
          console.log(`  ${bold('Historical violations:')} ${green('0')}`);
        }

        // Deep impact
        if (report.deepImpact.length > 0) {
          console.log('');
          console.log(`  ${bold('Transitive impact:')} ${report.deepImpact.length} nodes affected`);
          const byType: Record<string, number> = {};
          for (const node of report.deepImpact) {
            byType[node.type] = (byType[node.type] || 0) + 1;
          }
          for (const [type, count] of Object.entries(byType)) {
            console.log(`    ${type}: ${count}`);
          }
        }

        console.log('');
      }
    } finally {
      closeGraph(database);
    }
  } catch (e: any) {
    console.error(`Impact analysis failed: ${e.message}`);
    console.error('Ensure the knowledge graph is initialized (run specflow enforce first).');
    process.exit(1);
  }
}
