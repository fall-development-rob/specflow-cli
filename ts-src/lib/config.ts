/**
 * Shared Specflow config loader.
 * Reads .specflow/config.json, returns defaults if missing.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SpecflowConfig {
  contractsDir: string;
  testsDir: string;
  gitHook: boolean;
  claudeHooks: boolean;
}

const DEFAULT_CONFIG: SpecflowConfig = {
  contractsDir: '.specflow/contracts',
  testsDir: '.specflow/tests',
  gitHook: true,
  claudeHooks: true,
};

/**
 * Load Specflow config from .specflow/config.json in the given directory.
 * Returns defaults if the file is missing or unparseable.
 */
export function loadConfig(dir?: string): SpecflowConfig {
  const root = path.resolve(dir || '.');
  const configPath = path.join(root, '.specflow', 'config.json');

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      contractsDir: raw.contractsDir || DEFAULT_CONFIG.contractsDir,
      testsDir: raw.testsDir || DEFAULT_CONFIG.testsDir,
      gitHook: raw.gitHook !== undefined ? !!raw.gitHook : DEFAULT_CONFIG.gitHook,
      claudeHooks: raw.claudeHooks !== undefined ? !!raw.claudeHooks : DEFAULT_CONFIG.claudeHooks,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save Specflow config to .specflow/config.json.
 */
export function saveConfig(dir: string, config: SpecflowConfig): void {
  const specflowDir = path.join(dir, '.specflow');
  if (!fs.existsSync(specflowDir)) {
    fs.mkdirSync(specflowDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(specflowDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n',
  );
}

/**
 * Resolve a config-relative path to an absolute path within the project.
 */
export function resolveConfigPath(projectRoot: string, configPath: string): string {
  return path.join(projectRoot, configPath);
}
