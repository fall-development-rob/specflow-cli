/**
 * specflow init [dir] [--wizard] [--json]
 * Initialize Specflow in a project directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { ensureDir, copyFile, findSpecflowRoot } from '../lib/fs-utils';
import { bold, green, cyan } from '../lib/logger';

interface InitOptions {
  dir?: string;
  wizard?: boolean;
  json?: boolean;
}

export async function run(options: InitOptions): Promise<void> {
  const target = path.resolve(options.dir || '.');
  const jsonOutput = !!options.json;

  if (!jsonOutput) {
    console.log('');
    console.log(bold('Specflow Project Setup'));
    console.log(`Target: ${cyan(target)}`);
    console.log('');
  }

  const specflowRoot = findSpecflowRoot();
  const steps: string[] = [];

  // 1. Create directory structure
  const dirs = ['.specflow/contracts', '.specflow/tests', '.specflow/tests/e2e', '.specflow', '.claude'];
  for (const dir of dirs) {
    const dirPath = path.join(target, dir);
    const created = ensureDir(dirPath);
    if (created && !jsonOutput) {
      console.log(`  ${green('+')} Created ${dir}`);
    }
  }
  steps.push('directories');

  // 2. Copy default contract templates
  const templatesDir = path.join(specflowRoot, 'templates', 'contracts');
  if (fs.existsSync(templatesDir)) {
    const contractsDir = path.join(target, '.specflow', 'contracts');
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

  // 3. Generate or append to CLAUDE.md
  const claudeMd = path.join(target, 'CLAUDE.md');
  const specflowMarker = '## Specflow Rules';
  if (fs.existsSync(claudeMd)) {
    const existing = fs.readFileSync(claudeMd, 'utf-8');
    if (!existing.includes(specflowMarker)) {
      const templatePath = path.join(specflowRoot, 'CLAUDE-MD-TEMPLATE.md');
      if (fs.existsSync(templatePath)) {
        const templateContent = fs.readFileSync(templatePath, 'utf-8');
        fs.appendFileSync(claudeMd, `\n\n${specflowMarker}\n\n${templateContent}\n`);
        if (!jsonOutput) {
          console.log(`  ${green('+')} Appended Specflow rules to existing CLAUDE.md`);
        }
      }
    }
  } else {
    const templatePath = path.join(specflowRoot, 'CLAUDE-MD-TEMPLATE.md');
    if (fs.existsSync(templatePath)) {
      const templateContent = fs.readFileSync(templatePath, 'utf-8');
      fs.writeFileSync(claudeMd, `# CLAUDE.md\n\n${specflowMarker}\n\n${templateContent}\n`);
      if (!jsonOutput) {
        console.log(`  ${green('+')} Generated CLAUDE.md with Specflow rules`);
      }
    }
  }
  steps.push('claude_md');

  // 4. Create .claude/settings.json with hook config
  const settingsPath = path.join(target, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    const settings = generateHookSettings();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    if (!jsonOutput) {
      console.log(`  ${green('+')} Created .claude/settings.json with hooks`);
    }
  }
  steps.push('settings');

  // 5. Create .specflow/baseline.json
  const baseline = path.join(target, '.specflow', 'baseline.json');
  if (!fs.existsSync(baseline)) {
    fs.writeFileSync(baseline, '{}\n');
  }

  // 6. Create .claude/.defer-journal
  const deferJournal = path.join(target, '.claude', '.defer-journal');
  if (!fs.existsSync(deferJournal)) {
    fs.writeFileSync(deferJournal, '');
  }

  // 7. Install git commit-msg hook
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

  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'success', target, steps_completed: steps }, null, 2));
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
