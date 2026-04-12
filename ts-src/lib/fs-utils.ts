/**
 * File system helpers.
 */

import * as fs from 'fs';
import * as path from 'path';

export function ensureDir(dirPath: string): boolean {
  if (fs.existsSync(dirPath)) return false;
  fs.mkdirSync(dirPath, { recursive: true });
  return true;
}

export function copyFile(src: string, dst: string): void {
  const parent = path.dirname(dst);
  ensureDir(parent);
  fs.copyFileSync(src, dst);
}

export function countFiles(dir: string, extension: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith(`.${extension}`)).length;
}

export function dirHasFiles(dir: string, extension: string): boolean {
  return countFiles(dir, extension) > 0;
}

/**
 * Find the specflow root directory (where templates/contracts/ lives).
 */
/**
 * Check if a file has executable permission bits set.
 */
export function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function findSpecflowRoot(): string {
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), 'node_modules', '@robotixai', 'specflow-cli'),
    path.join(process.cwd(), 'node_modules', 'specflow-cli'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'templates', 'contracts'))) {
      return candidate;
    }
  }

  // Try the script's own directory
  const scriptDir = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(scriptDir, 'templates', 'contracts'))) {
    return scriptDir;
  }

  return process.cwd();
}
