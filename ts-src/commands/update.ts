/**
 * specflow update [dir] [--ci]
 * Update hooks and settings. Uses JSON.parse/JSON.stringify — NO jq, NO bash.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ensureDir } from '../lib/fs-utils';
import { bold, green, cyan } from '../lib/logger';

interface UpdateOptions {
  dir?: string;
  ci?: boolean;
}

export function run(options: UpdateOptions): void {
  const target = path.resolve(options.dir || '.');

  console.log('');
  console.log(bold('Specflow Update'));
  console.log(`Target: ${cyan(target)}`);
  console.log('');

  // 1. Ensure .claude directory exists
  const claudeDir = path.join(target, '.claude');
  ensureDir(claudeDir);

  // 2. Read or create .claude/settings.json
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings: any = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // 3. Merge Specflow hook entries (preserve existing hooks)
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const specflowHooks = [
    {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'specflow hook post-build' }],
    },
    {
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: 'specflow hook compliance' }],
    },
  ];

  // Get existing PostToolUse hooks
  const existing: any[] = settings.hooks.PostToolUse || [];

  // Merge: add specflow hooks that aren't already present
  for (const specHook of specflowHooks) {
    const alreadyPresent = existing.some((e: any) => {
      if (e.matcher !== specHook.matcher) return false;
      return e.hooks?.some((h: any) =>
        specHook.hooks.some(sh => sh.command === h.command)
      );
    });

    if (!alreadyPresent) {
      existing.push(specHook);
    }
  }

  settings.hooks.PostToolUse = existing;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  ${green('+')} Updated .claude/settings.json with hooks`);

  // 4. Install git commit-msg hook
  const gitHooksDir = path.join(target, '.git', 'hooks');
  if (fs.existsSync(path.join(target, '.git'))) {
    ensureDir(gitHooksDir);
    const commitMsgHook = path.join(gitHooksDir, 'commit-msg');
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
    console.log(`  ${green('+')} Installed git commit-msg hook`);
  }

  // 5. CI pipeline guidance (static templates replaced by ci-builder agent)
  if (options.ci) {
    console.log('');
    console.log('  To generate a CI pipeline, run: specflow agent show ci-builder');
    console.log('  Or ask Claude Code: Generate CI pipeline for this project');
  }

  console.log('');
  console.log(bold(green('Update complete!')));
  console.log('');
}
