/**
 * specflow enforce [dir] [--json] [--contract <name>]
 * Enforce contracts against project files.
 */

import * as path from 'path';
import * as fs from 'fs';
import { scanFiles } from '../lib/native';
import { printHuman, printJson } from '../lib/reporter';

interface EnforceOptions {
  dir?: string;
  json?: boolean;
  contract?: string;
}

export function run(options: EnforceOptions): void {
  const projectRoot = path.resolve(options.dir || '.');
  const contractsDir = path.join(projectRoot, 'docs', 'contracts');

  if (!fs.existsSync(contractsDir)) {
    console.error(`No contract directory found at ${contractsDir}. Run \`specflow init\` first.`);
    process.exit(1);
  }

  const result = scanFiles(contractsDir, projectRoot);

  // Filter by contract name if specified
  if (options.contract) {
    result.violations = result.violations.filter(
      v => v.contractId === options.contract
    );
  }

  if (options.json) {
    printJson(result);
  } else {
    printHuman(result, projectRoot);
  }

  if (result.violations.length > 0) {
    process.exit(1);
  }
}
