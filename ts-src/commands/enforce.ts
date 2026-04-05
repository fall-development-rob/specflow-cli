/**
 * specflow enforce [dir] [--json] [--contract <name>]
 * Enforce contracts against project files.
 */

import * as path from 'path';
import * as fs from 'fs';
import { scanFiles } from '../lib/native';
import { printHuman, printJson } from '../lib/reporter';
import { loadConfig } from '../lib/config';

interface EnforceOptions {
  dir?: string;
  json?: boolean;
  contract?: string;
}

export async function run(options: EnforceOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const config = loadConfig(projectRoot);
  const contractsDir = path.join(projectRoot, config.contractsDir);

  if (!fs.existsSync(contractsDir)) {
    console.error(`No contract directory found at ${contractsDir}. Run \`specflow init\` first.`);
    process.exit(1);
  }

  const result = scanFiles(contractsDir, projectRoot);

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
    const { suggestFix } = require('../graph/queries');

    // Initialize graph if it doesn't exist yet
    if (!graphExists(projectRoot)) {
      await rebuildGraph(projectRoot);
    }

    const database = await initGraph(projectRoot);
    try {
      recordEnforceRun(database, output);

      // Collect fix suggestions for each violated rule
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

    // Print fix suggestions after violations
    if (suggestions && suggestions.size > 0) {
      console.log('');
      console.log('  Fix suggestions (from knowledge graph):');
      for (const [key, suggestion] of suggestions) {
        const conf = suggestion.confidence ? ` (confidence: ${(suggestion.confidence * 100).toFixed(0)}%)` : '';
        const desc = suggestion.pattern || suggestion.description || suggestion.method || '';
        console.log(`    ${key}: ${desc}${conf}`);
      }
    }
  }

  if (output.violations.length > 0) {
    process.exitCode = 1;
  }
}
