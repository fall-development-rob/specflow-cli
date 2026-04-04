/**
 * specflow init [dir] [--yes|-y] [--json] [--contracts-dir <path>] [--tests-dir <path>]
 * Initialize Specflow in a project directory.
 *
 * Interactive by default — prompts the user for paths and options.
 * Use --yes/-y to accept all defaults without prompting.
 * Use --contracts-dir / --tests-dir to override paths without prompting.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ensureDir, copyFile, findSpecflowRoot } from '../lib/fs-utils';
import { bold, green, cyan } from '../lib/logger';
import { SpecflowConfig, saveConfig } from '../lib/config';

export interface InitOptions {
  dir?: string;
  yes?: boolean;
  json?: boolean;
  contractsDir?: string;
  testsDir?: string;
}

/** Prompt the user via readline; returns the default if they press enter. */
function prompt(rl: readline.Interface, question: string, defaultValue: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`  ${question} (${defaultValue}) `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

/** Prompt yes/no; returns boolean. Default is yes unless defaultYes is false. */
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

export async function run(options: InitOptions): Promise<void> {
  const target = path.resolve(options.dir || '.');
  const jsonOutput = !!options.json;
  const nonInteractive = !!options.yes;

  if (!jsonOutput) {
    console.log('');
    console.log(bold('Specflow Project Setup'));
    console.log(`Target: ${cyan(target)}`);
    console.log('');
  }

  // Determine config — interactive, flag-overridden, or defaults
  let config: SpecflowConfig;

  if (nonInteractive || options.contractsDir || options.testsDir) {
    // Non-interactive: use flags or defaults
    config = {
      contractsDir: options.contractsDir || '.specflow/contracts',
      testsDir: options.testsDir || '.specflow/tests',
      gitHook: true,
      claudeHooks: true,
    };
  } else if (!jsonOutput && process.stdin.isTTY) {
    // Interactive mode
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (!jsonOutput) {
      console.log('  Configure your project (press Enter for defaults):\n');
    }

    const contractsDir = await prompt(rl, 'Where should contracts live?', '.specflow/contracts');
    const testsDir = await prompt(rl, 'Where should test stubs go?', '.specflow/tests');
    const gitHook = await promptYesNo(rl, 'Install git commit-msg hook?');
    const claudeHooks = await promptYesNo(rl, 'Configure Claude Code hooks?');
    const appendClaudeMd = await promptYesNo(rl, 'Append Specflow rules to CLAUDE.md?');

    rl.close();

    config = { contractsDir, testsDir, gitHook, claudeHooks };

    if (!jsonOutput) console.log('');

    // Run init with the gathered config, handling CLAUDE.md separately
    return doInit(target, config, appendClaudeMd, jsonOutput);
  } else {
    // Non-TTY / JSON mode: use defaults silently
    config = {
      contractsDir: '.specflow/contracts',
      testsDir: '.specflow/tests',
      gitHook: true,
      claudeHooks: true,
    };
  }

  return doInit(target, config, true, jsonOutput);
}

async function doInit(
  target: string,
  config: SpecflowConfig,
  appendClaudeMd: boolean,
  jsonOutput: boolean,
): Promise<void> {
  const specflowRoot = findSpecflowRoot();
  const steps: string[] = [];

  // 1. Create directory structure
  const e2eDirs = (config.testsDir.endsWith('/e2e') || config.testsDir.endsWith('\\e2e'))
    ? [config.contractsDir, config.testsDir, '.specflow', '.claude']
    : [config.contractsDir, config.testsDir, path.join(config.testsDir, 'e2e'), '.specflow', '.claude'];
  const dirs = e2eDirs;
  for (const dir of dirs) {
    const dirPath = path.join(target, dir);
    const created = ensureDir(dirPath);
    if (created && !jsonOutput) {
      console.log(`  ${green('+')} Created ${dir}`);
    }
  }
  steps.push('directories');

  // 2. Save config
  saveConfig(target, config);
  if (!jsonOutput) {
    console.log(`  ${green('+')} Saved .specflow/config.json`);
  }
  steps.push('config');

  // 3. Copy default contract templates
  const templatesDir = path.join(specflowRoot, 'templates', 'contracts');
  if (fs.existsSync(templatesDir)) {
    const contractsDir = path.join(target, config.contractsDir);
    let copied = 0;
    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.yml'));
    for (const file of files) {
      const dest = path.join(contractsDir, file);
      if (!fs.existsSync(dest)) {
        copyFile(path.join(templatesDir, file), dest);
        copied++;
      }
    }
    if (!jsonOutput && copied > 0) {
      console.log(`  ${green('+')} Copied ${copied} default contracts`);
    }
    steps.push('contracts');
  }

  // 4. Generate or append to CLAUDE.md
  if (appendClaudeMd) {
    const claudeMd = path.join(target, 'CLAUDE.md');
    const specflowMarker = '<!-- specflow-init -->';
    const specflowMarkerEnd = '<!-- /specflow-init -->';
    if (fs.existsSync(claudeMd)) {
      const existing = fs.readFileSync(claudeMd, 'utf-8');
      if (!existing.includes(specflowMarker)) {
        const templatePath = path.join(specflowRoot, 'CLAUDE-MD-TEMPLATE.md');
        if (fs.existsSync(templatePath)) {
          const templateContent = fs.readFileSync(templatePath, 'utf-8');
          fs.appendFileSync(claudeMd, `\n\n${specflowMarker}\n## Specflow Rules\n\n${templateContent}\n${specflowMarkerEnd}\n`);
          if (!jsonOutput) {
            console.log(`  ${green('+')} Appended Specflow rules to existing CLAUDE.md`);
          }
        }
      } else if (!jsonOutput) {
        console.log(`  Specflow rules already present in CLAUDE.md — skipped`);
      }
    } else {
      const templatePath = path.join(specflowRoot, 'CLAUDE-MD-TEMPLATE.md');
      if (fs.existsSync(templatePath)) {
        const templateContent = fs.readFileSync(templatePath, 'utf-8');
        fs.writeFileSync(claudeMd, `# CLAUDE.md\n\n${specflowMarker}\n## Specflow Rules\n\n${templateContent}\n${specflowMarkerEnd}\n`);
        if (!jsonOutput) {
          console.log(`  ${green('+')} Generated CLAUDE.md with Specflow rules`);
        }
      }
    }
    steps.push('claude_md');
  }

  // 5. Create .claude/settings.json with hook config
  if (config.claudeHooks) {
    const settingsPath = path.join(target, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      const settings = generateHookSettings();
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      if (!jsonOutput) {
        console.log(`  ${green('+')} Created .claude/settings.json with hooks`);
      }
    }
    steps.push('settings');
  }

  // 6. Create .specflow/baseline.json
  const baseline = path.join(target, '.specflow', 'baseline.json');
  if (!fs.existsSync(baseline)) {
    fs.writeFileSync(baseline, '{}\n');
  }

  // 7. Create .claude/.defer-journal
  const deferJournal = path.join(target, '.claude', '.defer-journal');
  if (!fs.existsSync(deferJournal)) {
    fs.writeFileSync(deferJournal, '');
  }

  // 8. Install git commit-msg hook
  if (config.gitHook) {
    const gitHooksDir = path.join(target, '.git', 'hooks');
    if (fs.existsSync(gitHooksDir)) {
      const commitMsgHook = path.join(gitHooksDir, 'commit-msg');
      if (!fs.existsSync(commitMsgHook)) {
        const hookContent = `#!/bin/sh
# Specflow commit-msg hook: require issue number in commit message
MSG=$(cat "$1")
if ! echo "$MSG" | grep -qE '#[0-9]+'; then
    echo ""
    echo "ERROR: Commit message must reference a GitHub issue (e.g. #42)"
    echo "  Your message: $MSG"
    echo ""
    echo 'Usage: git commit -m "feat: description (#42)"'
    exit 1
fi
`;
        fs.writeFileSync(commitMsgHook, hookContent, { mode: 0o755 });
        if (!jsonOutput) {
          console.log(`  ${green('+')} Installed git commit-msg hook`);
        }
      }
      steps.push('git_hook');
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'success', target, config, steps_completed: steps }, null, 2));
  } else {
    console.log('');
    console.log(bold(green('Setup complete!')));
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Run ${cyan('specflow doctor')} to verify`);
    console.log(`  2. Run ${cyan('specflow enforce')} to check contracts`);
    console.log('  3. Commit with issue numbers: git commit -m "feat: ... (#42)"');
    console.log('');
  }
}

function generateHookSettings(): any {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'specflow hook post-build' }],
        },
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: 'specflow hook compliance' }],
        },
      ],
    },
  };
}
