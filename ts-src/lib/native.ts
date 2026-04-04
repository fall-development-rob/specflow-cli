/**
 * Native binding wrapper with pure-JS fallback.
 * Tries to load the NAPI-RS Rust module; falls back to JS implementation.
 */

import * as path from 'path';
import * as fs from 'fs';

// Types matching the NAPI-RS exports
export interface NapiContract {
  id: string;
  sourceFile: string;
  coversReqs: string[];
  rules: NapiRule[];
}

export interface NapiRule {
  id: string;
  title: string;
  scope: string[];
  forbiddenCount: number;
  requiredCount: number;
}

export interface NapiViolation {
  contractId: string;
  ruleId: string;
  ruleTitle: string;
  file: string;
  line: number;
  column: number;
  matchedText: string;
  message: string;
  pattern: string;
  kind: string;
}

export interface NapiScanResult {
  violations: NapiViolation[];
  filesScanned: number;
  contractsLoaded: number;
  rulesChecked: number;
}

export interface NapiValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  rulesFound: number;
  patternsCompiled: number;
}

// Try to load the native module
let nativeModule: any = null;

try {
  // Look for the native .node binary in several locations
  const candidates = [
    path.join(__dirname, '..', '..', 'rust', 'specflow-native.node'),
    path.join(__dirname, '..', '..', 'specflow-native.node'),
    path.join(__dirname, '..', 'rust', 'specflow-native.node'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      nativeModule = require(candidate);
      break;
    }
  }
} catch {
  // Native module not available — fall back to JS
}

export const isNativeAvailable = (): boolean => nativeModule !== null;

// ── Pure JS fallback implementation ─────────────────────────────────────────

let yaml: any = null;
function getYaml() {
  if (!yaml) {
    yaml = require('js-yaml');
  }
  return yaml;
}

function yamlPatternToRegex(patternStr: string): RegExp {
  const trimmed = patternStr.trim();
  const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  // Fallback: treat as bare regex string
  return new RegExp(trimmed);
}

interface JsCompiledPattern {
  regex: RegExp;
  message: string;
  raw: string;
}

interface JsCompiledRule {
  id: string;
  title: string;
  scope: string[];
  forbidden: JsCompiledPattern[];
  required: JsCompiledPattern[];
}

interface JsCompiledContract {
  id: string;
  sourceFile: string;
  coversReqs: string[];
  rules: JsCompiledRule[];
}

function loadContractJs(filePath: string): JsCompiledContract {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = getYaml().load(content);

  const rules: JsCompiledRule[] = (parsed.rules?.non_negotiable || []).map((rule: any) => {
    const forbidden = (rule.behavior?.forbidden_patterns || []).map((fp: any) => ({
      regex: yamlPatternToRegex(fp.pattern),
      message: fp.message,
      raw: fp.pattern,
    }));
    const required = (rule.behavior?.required_patterns || []).map((rp: any) => ({
      regex: yamlPatternToRegex(rp.pattern),
      message: rp.message,
      raw: rp.pattern,
    }));
    return {
      id: rule.id,
      title: rule.title || '',
      scope: rule.scope || [],
      forbidden,
      required,
    };
  });

  return {
    id: parsed.contract_meta?.id || '',
    sourceFile: filePath,
    coversReqs: parsed.contract_meta?.covers_reqs || [],
    rules,
  };
}

function loadContractsJs(dir: string): JsCompiledContract[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`Contract directory does not exist: ${dir}`);
  }

  const contracts: JsCompiledContract[] = [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    try {
      contracts.push(loadContractJs(path.join(dir, file)));
    } catch (e: any) {
      process.stderr.write(`Warning: failed to load ${file}: ${e.message}\n`);
    }
  }

  return contracts;
}

function resolveGlob(projectRoot: string, patterns: string[]): string[] {
  // Simple glob resolution using fs
  const included: Set<string> = new Set();
  const excluded: Set<string> = new Set();

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      const negPattern = pattern.slice(1);
      for (const f of simpleGlob(projectRoot, negPattern)) {
        excluded.add(f);
      }
    } else {
      for (const f of simpleGlob(projectRoot, pattern)) {
        if (fs.statSync(f).isFile()) {
          included.add(f);
        }
      }
    }
  }

  return [...included].filter(f => !excluded.has(f)).sort();
}

function simpleGlob(root: string, pattern: string): string[] {
  // Use a simple approach: if pattern has **, walk recursively
  // Otherwise use fs.readdirSync with filtering
  const fullPattern = path.join(root, pattern);
  try {
    // Try using glob module if available
    const globModule = require('glob');
    return globModule.sync(fullPattern, { nodir: true });
  } catch {
    // Minimal fallback: just list the directory
    const dir = path.dirname(fullPattern);
    const base = path.basename(fullPattern);
    if (!fs.existsSync(dir)) return [];

    const ext = path.extname(base);
    if (ext && base.startsWith('*')) {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith(ext))
        .map(f => path.join(dir, f));
    }
    return [];
  }
}

function scanFilesJs(contractsDir: string, targetDir: string): NapiScanResult {
  const contracts = loadContractsJs(contractsDir);
  const filesScanned = new Set<string>();
  const violations: NapiViolation[] = [];
  let rulesChecked = 0;

  for (const contract of contracts) {
    for (const rule of contract.rules) {
      rulesChecked++;
      const files = resolveGlob(targetDir, rule.scope);

      for (const file of files) {
        filesScanned.add(file);
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf-8');
        } catch {
          continue;
        }

        for (const pattern of rule.forbidden) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const match = pattern.regex.exec(lines[i]);
            if (match) {
              violations.push({
                contractId: contract.id,
                ruleId: rule.id,
                ruleTitle: rule.title,
                file,
                line: i + 1,
                column: (match.index || 0) + 1,
                matchedText: match[0],
                message: pattern.message,
                pattern: pattern.raw,
                kind: 'Forbidden',
              });
            }
            // Reset regex lastIndex for global patterns
            pattern.regex.lastIndex = 0;
          }
        }

        for (const pattern of rule.required) {
          pattern.regex.lastIndex = 0;
          if (!pattern.regex.test(content)) {
            violations.push({
              contractId: contract.id,
              ruleId: rule.id,
              ruleTitle: rule.title,
              file,
              line: 0,
              column: 0,
              matchedText: '',
              message: pattern.message,
              pattern: pattern.raw,
              kind: 'MissingRequired',
            });
          }
          pattern.regex.lastIndex = 0;
        }
      }
    }
  }

  return {
    violations,
    filesScanned: filesScanned.size,
    contractsLoaded: contracts.length,
    rulesChecked,
  };
}

function checkSnippetJs(
  contractsDir: string,
  code: string,
  filePath?: string,
): NapiViolation[] {
  const contracts = loadContractsJs(contractsDir);
  const virtualPath = filePath || 'inline.ts';
  const violations: NapiViolation[] = [];

  for (const contract of contracts) {
    for (const rule of contract.rules) {
      // Skip scope check when no file path is provided (inline snippet checking)
      const skipScope = !filePath;
      const inScope = skipScope || rule.scope.length === 0 || rule.scope.some(s => {
        if (s.startsWith('!')) return false;
        // Convert glob to regex: handle {a,b}, escape dots, glob ? before **/
        const regexStr = s
          .replace(/\{([^}]+)\}/g, (_, alts: string) => `(${alts.split(',').join('|')})`)
          .replace(/\./g, '\\.')
          .replace(/\?/g, '.')
          .replace(/\*\*\//g, '(.+/)?')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*');
        return new RegExp('^' + regexStr + '$').test(virtualPath);
      });

      if (!inScope) continue;

      for (const pattern of rule.forbidden) {
        const lines = code.split('\n');
        for (let i = 0; i < lines.length; i++) {
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(lines[i]);
          if (match) {
            violations.push({
              contractId: contract.id,
              ruleId: rule.id,
              ruleTitle: rule.title,
              file: virtualPath,
              line: i + 1,
              column: (match.index || 0) + 1,
              matchedText: match[0],
              message: pattern.message,
              pattern: pattern.raw,
              kind: 'Forbidden',
            });
          }
        }
      }

      for (const pattern of rule.required) {
        pattern.regex.lastIndex = 0;
        if (!pattern.regex.test(code)) {
          violations.push({
            contractId: contract.id,
            ruleId: rule.id,
            ruleTitle: rule.title,
            file: virtualPath,
            line: 0,
            column: 0,
            matchedText: '',
            message: pattern.message,
            pattern: pattern.raw,
            kind: 'MissingRequired',
          });
        }
        pattern.regex.lastIndex = 0;
      }
    }
  }

  return violations;
}

function validateContractJs(filePath: string): NapiValidationResult {
  if (!fs.existsSync(filePath)) {
    return { valid: false, errors: [`File not found: ${filePath}`], warnings: [], rulesFound: 0, patternsCompiled: 0 };
  }

  try {
    const contract = loadContractJs(filePath);
    const errors: string[] = [];
    const warnings: string[] = [];
    let patternsCompiled = 0;

    for (const rule of contract.rules) {
      patternsCompiled += rule.forbidden.length + rule.required.length;
      if (rule.scope.length === 0) warnings.push(`Rule ${rule.id} has no scope patterns`);
      if (!rule.title) warnings.push(`Rule ${rule.id} has no title`);
    }

    if (!contract.id) errors.push('contract_meta.id is empty');

    return { valid: errors.length === 0, errors, warnings, rulesFound: contract.rules.length, patternsCompiled };
  } catch (e: any) {
    return { valid: false, errors: [e.message], warnings: [], rulesFound: 0, patternsCompiled: 0 };
  }
}

function parsePatternJs(patternStr: string): boolean {
  try {
    yamlPatternToRegex(patternStr);
    return true;
  } catch {
    return false;
  }
}

// ── Exported API (auto-selects native or JS) ────────────────────────────────

export function loadContracts(dir: string): NapiContract[] {
  if (nativeModule) {
    return nativeModule.loadContracts(dir);
  }
  const contracts = loadContractsJs(dir);
  return contracts.map(c => ({
    id: c.id,
    sourceFile: c.sourceFile,
    coversReqs: c.coversReqs,
    rules: c.rules.map(r => ({
      id: r.id,
      title: r.title,
      scope: r.scope,
      forbiddenCount: r.forbidden.length,
      requiredCount: r.required.length,
    })),
  }));
}

export function scanFiles(contractsDir: string, targetDir: string): NapiScanResult {
  if (nativeModule) {
    return nativeModule.scanFiles(contractsDir, targetDir);
  }
  return scanFilesJs(contractsDir, targetDir);
}

export function checkSnippet(
  contractsDir: string,
  code: string,
  filePath?: string,
): NapiViolation[] {
  if (nativeModule) {
    return nativeModule.checkSnippet(contractsDir, code, filePath || null);
  }
  return checkSnippetJs(contractsDir, code, filePath);
}

export function validateContract(filePath: string): NapiValidationResult {
  if (nativeModule) {
    return nativeModule.validateContract(filePath);
  }
  return validateContractJs(filePath);
}

export function parsePattern(patternStr: string): boolean {
  if (nativeModule) {
    return nativeModule.parsePattern(patternStr);
  }
  return parsePatternJs(patternStr);
}
