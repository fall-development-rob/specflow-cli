/**
 * Post-build hook handler.
 * Reads JSON from stdin, detects build/commit commands.
 * Exit 0 = pass, exit 2 = fail.
 */

const BUILD_PATTERN = /(npm run build|pnpm( run)? build|yarn build|vite build|next build|turbo( run)? build|make build|cargo build|go build|gradle build|mvn (package|compile)|\btsc\b|\bwebpack\b)/;

interface HookInput {
  tool_name?: string;
  inputs?: { command?: string };
  response?: { exit_code?: number; exitCode?: number };
}

function run(): void {
  let input = '';
  const chunks: Buffer[] = [];

  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    input = Buffer.concat(chunks).toString('utf-8').trim();

    if (!input) {
      process.exit(0);
      return;
    }

    let hook: HookInput;
    try {
      hook = JSON.parse(input);
    } catch {
      process.exit(0);
      return;
    }

    const command = hook.inputs?.command || '';
    if (!command) {
      process.exit(0);
      return;
    }

    const isBuild = BUILD_PATTERN.test(command);
    const isCommit = command.includes('git commit');

    if (!isBuild && !isCommit) {
      process.exit(0);
      return;
    }

    // Check if the command was successful
    const exitCode = hook.response?.exit_code ?? hook.response?.exitCode;
    if (exitCode === undefined) {
      process.stderr.write('Warning: could not determine build exit code -- skipping tests\n');
      process.exit(0);
      return;
    }

    if (exitCode !== 0) {
      process.exit(0);
      return;
    }

    process.stderr.write('Build/commit detected. Running journey tests...\n');

    const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
    const { existsSync } = require('fs');
    const { execSync } = require('child_process');
    const path = require('path');

    const journeyScript = path.join(projectDir, '.claude', 'hooks', 'run-journey-tests.sh');
    if (existsSync(journeyScript)) {
      try {
        execSync(`bash "${journeyScript}"`, { stdio: 'inherit' });
        process.exit(0);
      } catch {
        process.exit(2);
      }
    } else {
      process.stderr.write('Warning: run-journey-tests.sh not found -- skipping journey tests\n');
      process.exit(0);
    }
  });
}

run();
