/**
 * Pipeline compliance hook — runs after Write/Edit tool use.
 * Checks the changed file against contract patterns.
 * Exit 0 = pass, exit 2 = violations found.
 */

import * as fs from 'fs';
import * as path from 'path';
import { checkSnippet, loadContracts } from '../lib/native';
import { loadConfig } from '../lib/config';

interface HookInput {
  inputs?: {
    file_path?: string;
    command?: string;
  };
}

function run(): void {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const input = Buffer.concat(chunks).toString('utf-8').trim();

    if (!input) {
      process.exit(0);
      return;
    }

    let hook: HookInput;
    try {
      hook = JSON.parse(input);
    } catch {
      process.exit(0);
      return;
    }

    const filePath = hook.inputs?.file_path;
    if (!filePath) {
      process.exit(0);
      return;
    }

    const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
    const projectRoot = path.resolve(projectDir);
    const config = loadConfig(projectRoot);
    const contractsDir = path.join(projectRoot, config.contractsDir);

    if (!fs.existsSync(contractsDir)) {
      process.exit(0);
      return;
    }

    try {
      // Resolve file path relative to project root
      const resolvedFile = path.resolve(projectRoot, filePath);
      if (!fs.existsSync(resolvedFile)) {
        // File doesn't exist (yet) — nothing to scan
        process.exit(0);
        return;
      }

      const fileContent = fs.readFileSync(resolvedFile, 'utf-8');

      // Use relative path from project root for scope matching
      const relativePath = path.relative(projectRoot, resolvedFile);
      const violations = checkSnippet(contractsDir, fileContent, relativePath);

      if (violations.length === 0) {
        process.exit(0);
        return;
      }

      process.stderr.write('\n+---------------------------------------------------------+\n');
      process.stderr.write('|  SPECFLOW CONTRACT VIOLATION                             |\n');
      process.stderr.write('+---------------------------------------------------------+\n\n');

      for (const v of violations) {
        process.stderr.write(`  [${v.ruleId}] ${v.message}\n`);
        process.stderr.write(`    File: ${relativePath}:${v.line}\n`);
        process.stderr.write(`    Match: ${v.matchedText}\n\n`);
      }

      process.stderr.write(`  ${violations.length} violation(s) found in ${relativePath}\n\n`);

      process.exit(2);
    } catch (err) {
      process.stderr.write(`[specflow] Compliance check error: ${err}\n`);
      process.exit(2);
    }
  });
}

run();
