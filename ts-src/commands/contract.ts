/**
 * specflow contract create [description] [--template <name>] [--ai] [--yes]
 * specflow contract list
 *
 * Create contracts from templates or AI-generated descriptions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { loadConfig } from '../lib/config';
import { bold, green, yellow, cyan, red, dim } from '../lib/logger';
import {
  TEMPLATES,
  getTemplate,
  nextContractId,
  generateContractYaml,
  validateContract,
} from '../lib/contract-templates';

interface ContractCreateOptions {
  template?: string;
  ai?: boolean;
  description?: string;
  yes?: boolean;
  dir?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────

function prompt(rl: readline.Interface, question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question} (${defaultValue}) `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

function promptYesNo(rl: readline.Interface, question: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise((resolve) => {
    rl.question(`  ${question} (${hint}) `, (answer) => {
      const a = answer.trim().toLowerCase();
      if (a === '') resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

function promptChoice(rl: readline.Interface, question: string, choices: string[]): Promise<number> {
  return new Promise((resolve) => {
    console.log('');
    choices.forEach((c, i) => {
      console.log(`  ${cyan(String(i + 1))}. ${c}`);
    });
    console.log('');
    rl.question(`  ${question} `, (answer) => {
      const idx = parseInt(answer.trim(), 10) - 1;
      if (idx >= 0 && idx < choices.length) {
        resolve(idx);
      } else {
        resolve(-1);
      }
    });
  });
}

function claudeCliAvailable(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ── List subcommand ──────────────────────────────────────────────────

export function list(): void {
  console.log('');
  console.log(bold('Available contract templates:'));
  console.log('');
  for (const t of TEMPLATES) {
    console.log(`  ${green(t.name.padEnd(20))} ${t.description}`);
  }
  console.log('');
  console.log(dim(`  Usage: specflow contract create --template <name>`));
  console.log('');
}

// ── Create subcommand ────────────────────────────────────────────────

export async function create(options: ContractCreateOptions): Promise<void> {
  const projectRoot = path.resolve(options.dir || '.');
  const config = loadConfig(projectRoot);
  const contractsDir = path.join(projectRoot, config.contractsDir);

  if (options.ai) {
    await createFromAI(options, contractsDir);
  } else {
    await createFromTemplate(options, contractsDir);
  }
}

// ── Mode A: Template-based creation ──────────────────────────────────

async function createFromTemplate(options: ContractCreateOptions, contractsDir: string): Promise<void> {
  let template;

  if (options.template) {
    // Direct template name provided
    template = getTemplate(options.template);
    if (!template) {
      console.error(`Unknown template: ${options.template}`);
      console.error(`Run ${cyan('specflow contract list')} to see available templates.`);
      process.exit(1);
    }
  } else if (process.stdin.isTTY && !options.yes) {
    // Interactive template picker
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('');
    console.log(bold('Create a new contract'));

    const choices = TEMPLATES.map(t => `${bold(t.name)} — ${t.description}`);
    const idx = await promptChoice(rl, 'Select a template (number):', choices);

    if (idx < 0) {
      console.error('Invalid selection.');
      rl.close();
      process.exit(1);
    }

    template = TEMPLATES[idx];

    // Ask for scope
    const scopeDefault = template.defaultScope.join(', ');
    const scopeInput = await prompt(rl, 'File scope (glob pattern):', scopeDefault);
    const scope = scopeInput.split(',').map(s => s.trim()).filter(s => s.length > 0);

    rl.close();

    return generateAndSave(template, scope, contractsDir, options.yes);
  } else {
    // Non-interactive, no template specified — use first template as default
    console.error('No template specified. Use --template <name> or run interactively.');
    console.error(`Run ${cyan('specflow contract list')} to see available templates.`);
    process.exit(1);
  }

  // Direct template path: ask for scope if interactive, else use defaults
  let scope = template.defaultScope;

  if (process.stdin.isTTY && !options.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('');
    console.log(bold(`Creating contract from template: ${cyan(template.name)}`));

    const scopeDefault = template.defaultScope.join(', ');
    const scopeInput = await prompt(rl, 'File scope (glob pattern):', scopeDefault);
    scope = scopeInput.split(',').map(s => s.trim()).filter(s => s.length > 0);
    rl.close();
  }

  return generateAndSave(template, scope, contractsDir, options.yes);
}

async function generateAndSave(
  template: { name: string; title: string; description: string; patterns: any[]; defaultScope: string[]; exampleViolation: string; exampleCompliant: string },
  scope: string[],
  contractsDir: string,
  skipPrompt?: boolean,
): Promise<void> {
  const contractId = nextContractId(contractsDir);
  const yaml = generateContractYaml(template, scope, contractId);

  // Validate
  const errors = validateContract(yaml);
  if (errors.length > 0) {
    console.error('');
    console.error(red('Contract validation failed:'));
    for (const err of errors) {
      console.error(`  ${red('x')} ${err.field}: ${err.message}`);
    }
    process.exit(1);
  }

  // Show preview
  console.log('');
  console.log(bold('Generated contract:'));
  console.log(dim('─'.repeat(50)));
  console.log(yaml);
  console.log(dim('─'.repeat(50)));

  // Save
  const slug = template.name;
  const filename = `custom_${slug}.yml`;
  const filepath = path.join(contractsDir, filename);

  if (skipPrompt) {
    saveContract(filepath, yaml, filename, contractsDir);
    return;
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const save = await promptYesNo(rl, `Save to .specflow/contracts/${filename}?`);
    rl.close();

    if (save) {
      saveContract(filepath, yaml, filename, contractsDir);
    } else {
      console.log('');
      console.log(dim('Contract not saved. YAML printed above for manual use.'));
    }
  } else {
    // Non-TTY: print to stdout
    console.log(yaml);
  }
}

function saveContract(filepath: string, yaml: string, filename: string, contractsDir: string): void {
  // Ensure contracts directory exists
  if (!fs.existsSync(contractsDir)) {
    fs.mkdirSync(contractsDir, { recursive: true });
  }

  fs.writeFileSync(filepath, yaml, 'utf-8');
  console.log('');
  console.log(`  ${green('+')} Saved to ${cyan(filepath)}`);

  // Try to run enforce on the new contract
  const contractId = filename.replace('.yml', '');
  try {
    const projectRoot = path.resolve(contractsDir, '..', '..');
    const result = execSync(
      `node "${path.join(__dirname, '..', 'cli.js')}" enforce . --contract ${contractId}`,
      { cwd: projectRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.trim()) {
      console.log('');
      console.log(bold('Enforcement results:'));
      console.log(result);
    } else {
      console.log(`  ${green('+')} No violations found — contract is currently satisfied.`);
    }
  } catch (e: any) {
    if (e.stdout && e.stdout.trim()) {
      console.log('');
      console.log(bold('Enforcement results:'));
      console.log(e.stdout);
    }
  }
}

// ── Mode B: AI-generated creation ────────────────────────────────────

async function createFromAI(options: ContractCreateOptions, contractsDir: string): Promise<void> {
  // Check Claude CLI exists
  if (!claudeCliAvailable()) {
    console.error(red('Claude CLI not found.'));
    console.error(`Install from ${cyan('https://claude.ai/download')} or use ${cyan('--template')} instead.`);
    process.exit(1);
  }

  let description = options.description || '';

  // If no description, ask interactively
  if (!description && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    description = await prompt(rl, 'Describe the contract you want:', 'no hardcoded secrets');
    rl.close();
  }

  if (!description) {
    console.error('Description required for AI mode. Usage: specflow contract create --ai "description"');
    process.exit(1);
  }

  const contractId = nextContractId(contractsDir);

  const aiPrompt = `Generate a Specflow contract YAML for this requirement: "${description}"

The contract must follow this exact format:

contract_meta:
  id: custom_<slug>
  version: 1
  created_from_spec: "AI-generated: ${description}"
  covers_reqs:
    - ${contractId}
  owner: "user"

llm_policy:
  enforce: true
  llm_may_modify_non_negotiables: false
  override_phrase: "override_contract: custom_<slug>"

rules:
  non_negotiable:
    - id: ${contractId}
      title: "<title>"
      scope:
        - "src/**/*.{ts,tsx,js,jsx}"
      behavior:
        forbidden_patterns:
          - pattern: /<regex>/i
            message: "<message>"
        example_violation: |
          <code that should fail>
        example_compliant: |
          <code that should pass>

Return ONLY the YAML, no explanation.`;

  console.log(dim('Generating contract via Claude CLI...'));

  try {
    const result = execSync(`claude -p "${aiPrompt.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Extract YAML from response (strip markdown fences if present)
    let yaml = result.trim();
    yaml = yaml.replace(/^```ya?ml\n?/m, '').replace(/\n?```$/m, '').trim();

    // Validate
    const errors = validateContract(yaml);
    if (errors.length > 0) {
      console.error('');
      console.error(red('Generated contract has validation errors:'));
      for (const err of errors) {
        console.error(`  ${red('x')} ${err.field}: ${err.message}`);
      }
      console.error('');
      console.error('Try refining your description with more specific terms.');
      process.exit(1);
    }

    // Show preview
    console.log('');
    console.log(bold('Generated contract:'));
    console.log(dim('─'.repeat(50)));
    console.log(yaml);
    console.log(dim('─'.repeat(50)));

    // Save
    const slugWords = description.split(/\s+/).slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const filename = `custom_${slugWords}.yml`;
    const filepath = path.join(contractsDir, filename);

    if (options.yes) {
      saveContract(filepath, yaml, filename, contractsDir);
      return;
    }

    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const save = await promptYesNo(rl, `Save to .specflow/contracts/${filename}?`);
      rl.close();

      if (save) {
        saveContract(filepath, yaml, filename, contractsDir);
      } else {
        console.log('');
        console.log(dim('Contract not saved. YAML printed above for manual use.'));
      }
    }
  } catch (e: any) {
    console.error(red('Failed to generate contract via Claude CLI.'));
    if (e.message) console.error(dim(e.message));
    process.exit(1);
  }
}
