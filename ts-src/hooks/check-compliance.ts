/**
 * Pipeline compliance hook — runs after Write/Edit tool use.
 * Checks changed files against contracts.
 * Exit 0 = pass, exit 2 = violations found.
 */

import * as fs from 'fs';
import * as path from 'path';
import { scanFiles } from '../lib/native';
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

    const filePath = hook.inputs?.file_path || hook.inputs?.command;
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
      const result = scanFiles(contractsDir, projectRoot);

      if (result.violations.length === 0) {
        process.exit(0);
        return;
      }

      // Check pipeline compliance
      const violations: string[] = [];
      checkJourneyTestContracts(projectRoot, config.contractsDir, config.testsDir, violations);
      checkOrphanContracts(projectRoot, config.contractsDir, config.testsDir, violations);
      checkCsvCompiled(projectRoot, config.contractsDir, violations);

      if (violations.length === 0) {
        process.exit(0);
        return;
      }

      process.stderr.write('\n+---------------------------------------------------------+\n');
      process.stderr.write('|  SPECFLOW PIPELINE VIOLATION                             |\n');
      process.stderr.write('+---------------------------------------------------------+\n\n');

      for (const v of violations) {
        process.stderr.write(`  x ${v}\n`);
      }

      process.stderr.write('\n  The correct pipeline is:\n');
      process.stderr.write('    CSV -> compile:journeys -> YAML contracts + stubs -> fill in stubs\n\n');

      process.exit(2);
    } catch (err) {
      process.stderr.write(`[specflow] Compliance check error: ${err}\n`);
      process.exit(2);
    }
  });
}

function checkJourneyTestContracts(root: string, contractsDirRel: string, testsDirRel: string, violations: string[]): void {
  const testDir = path.join(root, testsDirRel, 'e2e');
  if (!fs.existsSync(testDir)) return;

  const testFiles = fs.readdirSync(testDir).filter(f => f.startsWith('journey_') && f.endsWith('.spec.ts'));
  for (const file of testFiles) {
    const base = file.replace('.spec.ts', '');
    const contractPath = path.join(root, contractsDirRel, `${base}.yml`);
    if (!fs.existsSync(contractPath)) {
      violations.push(`PIPELINE SKIP: ${testsDirRel}/e2e/${file} exists but ${contractsDirRel}/${base}.yml is missing`);
    }
  }
}

function checkOrphanContracts(root: string, contractsDirRel: string, testsDirRel: string, violations: string[]): void {
  const contractsDir = path.join(root, contractsDirRel);
  if (!fs.existsSync(contractsDir)) return;

  const contractFiles = fs.readdirSync(contractsDir).filter(f => f.startsWith('journey_') && f.endsWith('.yml'));
  for (const file of contractFiles) {
    const base = file.replace('.yml', '');
    const testPath = path.join(root, testsDirRel, 'e2e', `${base}.spec.ts`);
    if (!fs.existsSync(testPath)) {
      violations.push(`ORPHAN CONTRACT: ${contractsDirRel}/${file} exists but ${testsDirRel}/e2e/${base}.spec.ts is missing`);
    }
  }
}

function checkCsvCompiled(root: string, contractsDirRel: string, violations: string[]): void {
  const csvDir = path.join(root, 'docs', 'journeys');
  const contractsDir = path.join(root, contractsDirRel);

  if (!fs.existsSync(csvDir)) return;

  const csvCount = fs.readdirSync(csvDir).filter(f => f.endsWith('.csv')).length;
  const contractCount = fs.existsSync(contractsDir)
    ? fs.readdirSync(contractsDir).filter(f => f.startsWith('journey_') && f.endsWith('.yml')).length
    : 0;

  if (csvCount > 0 && contractCount === 0) {
    violations.push(`CSV NOT COMPILED: Found ${csvCount} journey CSV(s) but no journey contracts`);
  }
}

run();
