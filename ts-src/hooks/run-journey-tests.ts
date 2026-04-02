/**
 * Journey test runner hook.
 * Maps issues to journey IDs to test files, then runs relevant tests.
 * Exit 0 = pass/skip, exit 2 = fail.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function run(): void {
  // Consume stdin (not used directly, but must be read)
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
    const projectRoot = path.resolve(projectDir);

    // Check for defer flag
    const deferFile = path.join(projectRoot, '.claude', '.defer-tests');
    if (fs.existsSync(deferFile)) {
      process.stderr.write(`Tests deferred globally. Run 'rm ${deferFile}' to re-enable.\n`);
      process.exit(0);
      return;
    }

    // Check gh CLI
    try {
      execFileSync('gh', ['--version'], { stdio: 'pipe' });
    } catch {
      process.stderr.write('Warning: gh CLI not installed. Cannot fetch journey contracts from issues.\n');
      process.exit(2);
      return;
    }

    // Check gh auth
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
    } catch {
      process.stderr.write('Warning: gh CLI not authenticated.\n');
      process.exit(2);
      return;
    }

    process.stderr.write('Detecting issues worked on...\n');

    const issues = getRecentIssues(projectRoot, 5);
    if (issues.length === 0) {
      process.stderr.write('No issues found in recent commits. Skipping targeted tests.\n');
      process.exit(0);
      return;
    }

    process.stderr.write(`Issues found: ${issues.join(', ')}\n`);

    const testFiles: string[] = [];

    for (const issue of issues) {
      process.stderr.write(`  Checking #${issue} for journey contracts...\n`);
      const journeys = getJourneyForIssue(issue);

      if (journeys.length === 0) {
        process.stderr.write(`  - #${issue}: No journey contract found\n`);
        continue;
      }

      for (const journey of journeys) {
        const testFile = journeyToTestFile(projectRoot, journey);
        if (fs.existsSync(path.join(projectRoot, testFile))) {
          process.stderr.write(`  + #${issue} -> ${journey} -> ${testFile}\n`);
          testFiles.push(testFile);
        } else {
          process.stderr.write(`  ? #${issue} -> ${journey} but test file not found: ${testFile}\n`);
        }
      }
    }

    // Deduplicate
    const unique = [...new Set(testFiles)].sort();

    if (unique.length === 0) {
      process.stderr.write('No journey tests to run for these issues.\n');
      process.exit(0);
      return;
    }

    process.stderr.write(`\nRunning journey tests: ${unique.join(' ')}\n`);

    const testCmd = detectTestCommand(projectRoot);
    const [testBin, ...testArgs] = testCmd.split(' ');
    try {
      execFileSync(testBin, [...testArgs, ...unique], { stdio: 'inherit', cwd: projectRoot });
      process.stderr.write('\nJourney tests PASSED\n');
      process.exit(0);
    } catch {
      process.stderr.write('\nJourney tests FAILED\n');
      process.exit(2);
    }
  });
}

function getRecentIssues(dir: string, count: number): string[] {
  try {
    const output = execFileSync(
      'git', ['log', `-${count}`, '--pretty=format:%s %b'],
      { cwd: dir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const re = /#(\d+)/g;
    const issues = new Set<string>();
    let match;
    while ((match = re.exec(output)) !== null) {
      issues.add(match[1]);
    }
    return [...issues].sort();
  } catch {
    return [];
  }
}

function getJourneyForIssue(issue: string): string[] {
  try {
    const output = execFileSync(
      'gh', ['issue', 'view', issue, '--json', 'body,comments'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const re = /J-[A-Z0-9]+(-[A-Z0-9]+)*/g;
    const journeys = new Set<string>();
    let match;
    while ((match = re.exec(output)) !== null) {
      journeys.add(match[0]);
    }
    return [...journeys].sort().slice(0, 20);
  } catch {
    return [];
  }
}

function journeyToTestFile(projectRoot: string, journey: string): string {
  // Check contract YAML for explicit test file path
  const contractsDirs = ['docs/contracts', 'contracts', 'docs'];
  for (const dir of contractsDirs) {
    const contractsPath = path.join(projectRoot, dir);
    if (!fs.existsSync(contractsPath)) continue;

    const files = fs.readdirSync(contractsPath).filter(f => f.startsWith('journey_') && f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(contractsPath, file), 'utf-8');
        if (content.includes(`id: ${journey}`) || content.includes(`id: "${journey}"`)) {
          const testMatch = content.match(/e2e_test_file:\s*(.+)/);
          if (testMatch) {
            const testPath = testMatch[1].trim().replace(/^["']|["']$/g, '');
            if (testPath) return testPath;
          }
        }
      } catch {
        // skip
      }
    }
  }

  // Fallback: heuristic naming J-SIGNUP-FLOW -> journey_signup_flow.spec.ts
  const name = journey.replace(/^J-/, '').toLowerCase().replace(/-/g, '_');
  return `tests/e2e/journey_${name}.spec.ts`;
}

function detectTestCommand(root: string): string {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm test:e2e';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn test:e2e';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun test:e2e';
  return 'npm run test:e2e';
}

run();
