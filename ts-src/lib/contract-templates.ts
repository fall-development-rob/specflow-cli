/**
 * Pre-built contract templates and contract validation utilities.
 * Used by `specflow contract create` to generate contracts from templates.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface TemplatePattern {
  pattern: string;
  message: string;
}

export interface ContractTemplate {
  name: string;
  title: string;
  description: string;
  patterns: TemplatePattern[];
  defaultScope: string[];
  exampleViolation: string;
  exampleCompliant: string;
}

export interface ContractRule {
  id: string;
  title: string;
  scope: string[];
  behavior: {
    forbidden_patterns: { pattern: string; message: string }[];
    example_violation: string;
    example_compliant: string;
  };
}

export interface GeneratedContract {
  contract_meta: {
    id: string;
    version: number;
    created_from_spec: string;
    covers_reqs: string[];
    owner: string;
  };
  llm_policy: {
    enforce: boolean;
    llm_may_modify_non_negotiables: boolean;
    override_phrase: string;
  };
  rules: {
    non_negotiable: ContractRule[];
  };
}

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * All pre-built contract templates.
 */
export const TEMPLATES: ContractTemplate[] = [
  {
    name: 'no-console-log',
    title: 'No Console Logging',
    description: 'Forbids console.log/warn/error/debug/info in production source code',
    patterns: [
      { pattern: '/console\\.(log|warn|error|debug|info)\\s*\\(/i', message: 'Remove console statement — use a logging library' },
    ],
    defaultScope: ['src/**/*.{ts,tsx,js,jsx}'],
    exampleViolation: 'console.log("debug info");',
    exampleCompliant: 'logger.info("debug info");',
  },
  {
    name: 'no-any-type',
    title: 'No TypeScript Any Type',
    description: 'Forbids TypeScript "any" type annotations',
    patterns: [
      { pattern: '/:\\s*any[\\s;,)]/i', message: 'Avoid "any" type — use a specific type or "unknown"' },
    ],
    defaultScope: ['src/**/*.{ts,tsx}'],
    exampleViolation: 'function parse(data: any) {',
    exampleCompliant: 'function parse(data: unknown) {',
  },
  {
    name: 'api-auth-required',
    title: 'API Auth Required',
    description: 'Requires auth middleware on API route handlers',
    patterns: [
      { pattern: '/router\\.(get|post|put|patch|delete)\\s*\\([^)]*(?!authenticate)/i', message: 'API route missing auth middleware — add authenticate() middleware' },
    ],
    defaultScope: ['src/**/routes/**/*.{ts,js}', 'src/**/api/**/*.{ts,js}'],
    exampleViolation: 'router.get("/users", listUsers);',
    exampleCompliant: 'router.get("/users", authenticate(), listUsers);',
  },
  {
    name: 'no-todo-comments',
    title: 'No TODO Comments',
    description: 'Forbids TODO/FIXME/HACK comments in production code',
    patterns: [
      { pattern: '/\\/\\/\\s*(TODO|FIXME|HACK)/i', message: 'Remove TODO/FIXME/HACK comment — resolve or file an issue' },
    ],
    defaultScope: ['src/**/*.{ts,tsx,js,jsx}'],
    exampleViolation: '// TODO: fix this later',
    exampleCompliant: '// See issue #123 for planned improvements',
  },
  {
    name: 'env-vars-only',
    title: 'Environment Variables Only',
    description: 'Forbids hardcoded configuration values (URLs, ports, keys)',
    patterns: [
      { pattern: '/(API_KEY|SECRET|PASSWORD|API_URL|DATABASE_URL)\\s*=\\s*[\'"][^\'"]{4,}[\'"]/i', message: 'Hardcoded config value — use environment variable via process.env' },
      { pattern: '/https?:\\/\\/localhost:\\d+/i', message: 'Hardcoded localhost URL — use environment variable' },
    ],
    defaultScope: ['src/**/*.{ts,tsx,js,jsx}'],
    exampleViolation: 'const API_URL = "https://api.example.com";',
    exampleCompliant: 'const API_URL = process.env.API_URL;',
  },
  {
    name: 'no-inline-styles',
    title: 'No Inline Styles',
    description: 'Forbids inline style attributes in JSX/HTML',
    patterns: [
      { pattern: '/style\\s*=\\s*\\{\\{/i', message: 'Inline style detected — use CSS classes or styled-components' },
    ],
    defaultScope: ['src/**/*.{tsx,jsx}'],
    exampleViolation: '<div style={{ color: "red" }}>',
    exampleCompliant: '<div className="error-text">',
  },
];

/**
 * Find a template by name.
 */
export function getTemplate(name: string): ContractTemplate | undefined {
  return TEMPLATES.find(t => t.name === name);
}

/**
 * Generate the next CUSTOM-NNN ID by scanning existing contracts.
 */
export function nextContractId(contractsDir: string): string {
  let maxNum = 0;

  if (fs.existsSync(contractsDir)) {
    const files = fs.readdirSync(contractsDir);
    for (const file of files) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      try {
        const content = fs.readFileSync(path.join(contractsDir, file), 'utf-8');
        const match = content.match(/id:\s*CUSTOM-(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  const next = maxNum + 1;
  return `CUSTOM-${String(next).padStart(3, '0')}`;
}

/**
 * Generate a contract YAML string from a template and scope.
 */
export function generateContractYaml(
  template: ContractTemplate,
  scope: string[],
  contractId: string,
): string {
  const slug = template.name;
  const ruleId = contractId;

  const scopeYaml = scope.map(s => `        - "${s}"`).join('\n');
  const patternsYaml = template.patterns
    .map(p => `          - pattern: ${p.pattern}\n            message: "${p.message}"`)
    .join('\n');

  return `contract_meta:
  id: custom_${slug}
  version: 1
  created_from_spec: "specflow contract create --template ${slug}"
  covers_reqs:
    - ${ruleId}
  owner: "user"

llm_policy:
  enforce: true
  llm_may_modify_non_negotiables: false
  override_phrase: "override_contract: custom_${slug}"

rules:
  non_negotiable:
    - id: ${ruleId}
      title: "${template.title}"
      scope:
${scopeYaml}
      behavior:
        forbidden_patterns:
${patternsYaml}
        example_violation: |
          ${template.exampleViolation}
        example_compliant: |
          ${template.exampleCompliant}
`;
}

/**
 * Validate a contract YAML string.
 * Returns an array of errors (empty = valid).
 */
export function validateContract(yamlContent: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check required fields
  if (!yamlContent.includes('contract_meta:')) {
    errors.push({ field: 'contract_meta', message: 'Missing contract_meta section' });
  }
  if (!/id:\s*\S+/.test(yamlContent)) {
    errors.push({ field: 'contract_meta.id', message: 'Missing contract ID' });
  }
  if (!yamlContent.includes('rules:')) {
    errors.push({ field: 'rules', message: 'Missing rules section' });
  }
  if (!yamlContent.includes('scope:')) {
    errors.push({ field: 'scope', message: 'Missing scope definition' });
  }

  // Validate regex patterns compile
  const patternMatches = yamlContent.matchAll(/pattern:\s*\/(.+?)\/([gimsuy]*)/g);
  for (const match of patternMatches) {
    try {
      new RegExp(match[1], match[2]);
    } catch (e: any) {
      errors.push({
        field: 'pattern',
        message: `Invalid regex /${match[1]}/${match[2]}: ${e.message}`,
      });
    }
  }

  // Validate scope globs are syntactically reasonable
  const scopeMatches = yamlContent.matchAll(/- "([^"]+)"/g);
  for (const match of scopeMatches) {
    const glob = match[1];
    // Basic check: glob shouldn't be empty or contain obvious errors
    if (glob.length === 0) {
      errors.push({ field: 'scope', message: 'Empty scope glob' });
    }
  }

  return errors;
}
