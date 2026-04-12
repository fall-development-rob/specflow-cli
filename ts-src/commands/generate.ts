/**
 * specflow generate [dir] [--json] [--contracts-dir <path>]
 * Re-detect the project stack and generate tailored contracts.
 * Does not re-run the full init — only the detection and contract generation steps.
 */

import * as path from 'path';
import * as readline from 'readline';
import { loadConfig } from '../lib/config';
import { detect } from '../lib/detect';
import { generateContracts, generateSummary } from '../lib/generate-contracts';
import { bold, green, cyan, dim } from '../lib/logger';

export interface GenerateOptions {
  dir?: string;
  json?: boolean;
  contractsDir?: string;
}

function prompt(rl: readline.Interface, question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question} (${defaultValue}) `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

export async function run(options: GenerateOptions): Promise<void> {
  const target = path.resolve(options.dir || '.');
  const jsonOutput = !!options.json;

  if (!jsonOutput) {
    console.log('');
    console.log(bold('Specflow Contract Generation'));
    console.log(`Target: ${cyan(target)}`);
    console.log('');
    console.log('  Detecting project stack...');
  }

  const detection = detect(target);

  if (!jsonOutput) {
    const parts: string[] = [];
    if (detection.language) parts.push(detection.language);
    if (detection.framework) parts.push(detection.framework);
    if (detection.orm) parts.push(detection.orm);
    if (parts.length > 0) {
      console.log(`  ${green('+')} Detected: ${parts.join(', ')}`);
    } else {
      console.log(`  ${green('+')} No specific framework detected — generating baseline contracts`);
    }

    if (detection.sourceRoots.length > 0 && detection.sourceRoots[0] !== 'src') {
      console.log(`  ${green('+')} Source roots: ${detection.sourceRoots.join(', ')}`);
    }
    console.log('');
  }

  // Determine contracts directory
  const config = loadConfig(target);
  let contractsDirRel = options.contractsDir || config.contractsDir;

  // Interactive prompt if no flag provided and TTY available
  if (!options.contractsDir && !jsonOutput && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    contractsDirRel = await prompt(rl, 'Where should contracts be written?', contractsDirRel);
    rl.close();
    console.log('');
  }

  const contractsDir = path.join(target, contractsDirRel);
  const result = generateContracts(detection, contractsDir, { jsonOutput });

  if (jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      target,
      contractsDir: contractsDirRel,
      detection: {
        language: detection.language,
        framework: detection.framework,
        orm: detection.orm,
        dependencies: detection.dependencies.length,
        sourceRoots: detection.sourceRoots,
      },
      contracts_generated: result.contracts,
      contracts_skipped: result.skipped,
    }, null, 2));
  } else {
    console.log('');
    console.log(bold(green(generateSummary(detection, result))));
    if (result.skipped.length > 0) {
      console.log(`  (${result.skipped.length} existing contracts preserved)`);
    }
    console.log(`  ${dim(`Written to ${contractsDirRel}`)}`);
    console.log('');
    console.log(`Next: ${cyan('specflow enforce .')} to check contracts against your code`);
    console.log('');
  }
}
