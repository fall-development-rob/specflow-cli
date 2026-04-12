/**
 * specflow generate [dir] [--json]
 * Re-detect the project stack and generate tailored contracts.
 * Does not re-run the full init — only the detection and contract generation steps.
 */

import * as path from 'path';
import { loadConfig } from '../lib/config';
import { detect } from '../lib/detect';
import { generateContracts, generateSummary } from '../lib/generate-contracts';
import { bold, green, cyan } from '../lib/logger';

export interface GenerateOptions {
  dir?: string;
  json?: boolean;
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
    console.log('');
  }

  const config = loadConfig(target);
  const contractsDir = path.join(target, config.contractsDir);
  const result = generateContracts(detection, contractsDir, { jsonOutput });

  if (jsonOutput) {
    console.log(JSON.stringify({
      status: 'success',
      target,
      detection: {
        language: detection.language,
        framework: detection.framework,
        orm: detection.orm,
        dependencies: detection.dependencies.length,
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
    console.log('');
    console.log(`Next: ${cyan('specflow enforce .')} to check contracts against your code`);
    console.log('');
  }
}
