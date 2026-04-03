/**
 * specflow graph [dir]
 * Validate contract graph integrity.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { loadConfig } from '../lib/config';

interface GraphOptions {
  dir?: string;
}

export function run(options: GraphOptions): void {
  const config = loadConfig();
  const dir = options.dir || config.contractsDir;
  const script = path.join(process.cwd(), 'scripts', 'verify-graph.cjs');

  // Try specflow root if not in cwd
  const candidates = [
    script,
    path.join(path.resolve(__dirname, '..', '..'), 'scripts', 'verify-graph.cjs'),
  ];

  let scriptPath: string | null = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      scriptPath = candidate;
      break;
    }
  }

  if (!scriptPath) {
    console.error('Graph verification script not found: scripts/verify-graph.cjs');
    process.exit(1);
    return;
  }

  try {
    execFileSync('node', [scriptPath, dir], { stdio: 'inherit' });
  } catch (e: any) {
    process.exit(e.status || 1);
  }
}
