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
import { detect } from '../lib/detect';
import { generateContracts, generateSummary } from '../lib/generate-contracts';

export interface InitOptions {
  dir?: string;
  yes?: boolean;
  json?: boolean;
  contractsDir?: string;
  testsDir?: string;
  skipContracts?: boolean;
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
    const gitHook = await promptYesNo(rl, 'Require issue numbers in commit messages?');
    const claudeHooks = await promptYesNo(rl, 'Configure Claude Code hooks?');
    const appendClaudeMd = await promptYesNo(rl, 'Append Specflow rules to CLAUDE.md?');

    rl.close();

    config = { contractsDir, testsDir, gitHook, claudeHooks };

    if (!jsonOutput) console.log('');

    // Run init with the gathered config, handling CLAUDE.md separately
    return doInit(target, config, appendClaudeMd, jsonOutput, !!options.skipContracts);
  } else {
    // Non-TTY / JSON mode: use defaults silently
    config = {
      contractsDir: '.specflow/contracts',
      testsDir: '.specflow/tests',
      gitHook: true,
      claudeHooks: true,
    };
  }

  return doInit(target, config, true, jsonOutput, !!options.skipContracts);
}

async function doInit(
  target: string,
  config: SpecflowConfig,
  appendClaudeMd: boolean,
  jsonOutput: boolean,
  skipContracts: boolean = false,
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

  // 3. Detect project stack and generate tailored contracts
  if (!skipContracts) {
    if (!jsonOutput) {
      console.log('');
      console.log(`  Detecting project stack...`);
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

    const contractsDir = path.join(target, config.contractsDir);
    const genResult = generateContracts(detection, contractsDir, { jsonOutput });

    if (!jsonOutput) {
      console.log(`  ${green('+')} ${generateSummary(detection, genResult)}`);
    }
    steps.push('contracts');
  } else {
    if (!jsonOutput) {
      console.log(`  Skipped contract generation (--skip-contracts)`);
    }
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

  // 5. Copy Specflow skill for Claude Code
  const skillsSrcDir = path.join(specflowRoot, 'templates', 'skills');
  const skillsDest = path.join(target, '.claude', 'skills');
  if (fs.existsSync(path.join(skillsSrcDir, 'specflow.md'))) {
    ensureDir(skillsDest);
    const skillSrc = path.join(skillsSrcDir, 'specflow.md');
    const skillDst = path.join(skillsDest, 'specflow.md');
    // Only overwrite if source is newer or dest doesn't exist
    if (!fs.existsSync(skillDst) || fs.statSync(skillSrc).mtimeMs > fs.statSync(skillDst).mtimeMs) {
      copyFile(skillSrc, skillDst);
      if (!jsonOutput) {
        console.log(`  ${green('+')} Installed Specflow skill for Claude Code`);
      }
    } else if (!jsonOutput) {
      console.log(`  Specflow skill already up-to-date — skipped`);
    }
    steps.push('skill');
  }

  // 6. Create .claude/settings.json with hook config
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

  // 7. Update .gitignore with specflow entries
  const gitignorePath = path.join(target, '.gitignore');
  const specflowIgnores = [
    '.specflow/knowledge.db',
    '.specflow/baseline.json',
    '.claude/.defer-journal',
  ];
  const specflowMarker = '# Specflow';
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf-8');
    if (!existing.includes(specflowMarker)) {
      const lines = specflowIgnores.filter(entry => !existing.includes(entry));
      if (lines.length > 0) {
        fs.appendFileSync(gitignorePath, `\n${specflowMarker}\n${lines.join('\n')}\n`);
        if (!jsonOutput) {
          console.log(`  ${green('+')} Added specflow entries to .gitignore`);
        }
      }
    }
  } else {
    fs.writeFileSync(gitignorePath, `${specflowMarker}\n${specflowIgnores.join('\n')}\n`);
    if (!jsonOutput) {
      console.log(`  ${green('+')} Created .gitignore with specflow entries`);
    }
  }

  // 8. Create .specflow/baseline.json (after gitignore so it's already ignored)
  const baseline = path.join(target, '.specflow', 'baseline.json');
  if (!fs.existsSync(baseline)) {
    fs.writeFileSync(baseline, '{}\n');
  }

  // 8. Create .claude/.defer-journal
  const deferJournal = path.join(target, '.claude', '.defer-journal');
  if (!fs.existsSync(deferJournal)) {
    fs.writeFileSync(deferJournal, '');
  }

  // 9. Install git commit-msg hook
  if (config.gitHook) {
    const gitHooksDir = path.join(target, '.git', 'hooks');
    if (fs.existsSync(gitHooksDir)) {
      const commitMsgHook = path.join(gitHooksDir, 'commit-msg');
      if (!fs.existsSync(commitMsgHook)) {
        const hookContent = `#!/bin/sh
# Specflow commit-msg hook: require issue/ticket reference in commit message
MSG=$(cat "$1")
if ! echo "$MSG" | grep -qE '#[0-9]+'; then
    echo ""
    echo "ERROR: Commit message must reference an issue (e.g. #42)"
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

  // 10. Initialize knowledge graph
  try {
    const { rebuildGraph } = require('../graph/builder');
    const result = await rebuildGraph(target);
    if (!jsonOutput) {
      console.log(`  ${green('+')} Built knowledge graph (${result.contracts} contracts, ${result.agents} agents)`);
    }
    steps.push('knowledge_graph');
  } catch {
    // Graph init is optional — don't block setup
    if (!jsonOutput) {
      console.log(`  Knowledge graph initialization skipped`);
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
