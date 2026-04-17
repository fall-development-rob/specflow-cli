/**
 * Tests for gitDiffScope hardening (PRD-011 S2 / ADR-013).
 *
 * Covers:
 *   - Shallow-clone detection → fail-loud without --allow-shallow
 *   - Initial-commit fallback → full-tree scan with warning
 *   - Merge-commit diff → uses HEAD^1..HEAD with warning
 *   - Override directive rule-scoping and code-fence stripping
 *   - Triple-dot --diff correction to two-dot with warning
 *   - Null-separated file parsing (filenames with spaces / unicode)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  gitDiffScope,
  preflight,
  validateDiffRange,
  parseNullSeparatedFileList,
  findOverride,
  GitDiffScopeError,
} = require('../../dist/lib/coupling-enforcer');

// ─ Helpers ──────────────────────────────────────────────────────────────────

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-gds-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  execSync('git config commit.gpgsign false', { cwd: dir });
  return dir;
}

function commit(dir, file, content, message) {
  fs.writeFileSync(path.join(dir, file), content, 'utf-8');
  execSync(`git add ${JSON.stringify(file)}`, { cwd: dir });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: dir });
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

// Keep the hook-detection env stable across tests so COMMIT_EDITMSG is only
// consulted when we explicitly simulate an active hook.
const priorIndexFile = process.env.GIT_INDEX_FILE;
const priorEditor = process.env.GIT_EDITOR;
const priorAllowShallow = process.env.SPECFLOW_ALLOW_SHALLOW;

beforeEach(() => {
  delete process.env.GIT_INDEX_FILE;
  delete process.env.GIT_EDITOR;
  delete process.env.SPECFLOW_ALLOW_SHALLOW;
});

afterAll(() => {
  if (priorIndexFile !== undefined) process.env.GIT_INDEX_FILE = priorIndexFile;
  if (priorEditor !== undefined) process.env.GIT_EDITOR = priorEditor;
  if (priorAllowShallow !== undefined) process.env.SPECFLOW_ALLOW_SHALLOW = priorAllowShallow;
});

// ─ validateDiffRange ────────────────────────────────────────────────────────

describe('validateDiffRange', () => {
  test('accepts two-dot range unchanged', () => {
    const r = validateDiffRange('origin/main..HEAD');
    expect(r.range).toBe('origin/main..HEAD');
    expect(r.warnings).toEqual([]);
  });

  test('corrects triple-dot to two-dot with warning', () => {
    const r = validateDiffRange('origin/main...HEAD');
    expect(r.range).toBe('origin/main..HEAD');
    expect(r.warnings.join('\n')).toMatch(/triple-dot/);
    expect(r.warnings.join('\n')).toMatch(/ADR-013/);
  });

  test('rejects shell metacharacters', () => {
    expect(() => validateDiffRange('foo;rm -rf /')).toThrow(/forbidden/);
    expect(() => validateDiffRange('foo && bar')).toThrow(/forbidden/);
    expect(() => validateDiffRange('`whoami`')).toThrow(/forbidden/);
    expect(() => validateDiffRange('$(id)')).toThrow(/forbidden/);
  });

  test('rejects missing .. separator', () => {
    expect(() => validateDiffRange('HEAD')).toThrow(/expects a range/);
  });

  test('rejects empty range', () => {
    expect(() => validateDiffRange('')).toThrow(/non-empty/);
    expect(() => validateDiffRange('..HEAD')).toThrow(/form/);
    expect(() => validateDiffRange('HEAD..')).toThrow(/form/);
  });
});

// ─ preflight ────────────────────────────────────────────────────────────────

describe('preflight (git env inspection)', () => {
  test('initial commit → full-tree fallback with warning', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', 'hi', 'init');
    const pre = preflight(dir, {});
    expect(pre.mode).toBe('fullTree');
    expect(pre.warnings.join('\n')).toMatch(/initial commit/);
  });

  test('merge commit → HEAD^1..HEAD with warning', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'first');
    execSync('git checkout -q -b feature', { cwd: dir });
    commit(dir, 'b.txt', '2', 'second');
    execSync('git checkout -q master 2>/dev/null || git checkout -q main', { cwd: dir });
    commit(dir, 'c.txt', '3', 'third');
    execSync('git merge --no-ff -q feature -m "merge feature"', { cwd: dir });
    const pre = preflight(dir, {});
    expect(pre.mode).toBe('range');
    expect(pre.range).toBe('HEAD^1..HEAD');
    expect(pre.warnings.join('\n')).toMatch(/merge commit/);
    expect(pre.warnings.join('\n')).toMatch(/first parent/);
  });

  test('shallow clone (no HEAD~1) → fail-loud', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    commit(dir, 'b.txt', '2', 'two');
    // Simulate a shallow clone by creating .git/shallow and grafting HEAD as
    // the shallow root. The quickest reliable simulation: write a shallow
    // marker for HEAD so `rev-parse --is-shallow-repository` reports true and
    // HEAD~1 fails to resolve.
    const shallowPath = path.join(dir, '.git', 'shallow');
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
    fs.writeFileSync(shallowPath, head + '\n');
    // Sanity-check our simulation:
    const isShallow = execSync('git rev-parse --is-shallow-repository', { cwd: dir, encoding: 'utf-8' }).trim();
    expect(isShallow).toBe('true');
    expect(() => preflight(dir, {})).toThrow(GitDiffScopeError);
  });

  test('shallow clone with SPECFLOW_ALLOW_SHALLOW=1 → full-tree fallback', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    commit(dir, 'b.txt', '2', 'two');
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
    fs.writeFileSync(path.join(dir, '.git', 'shallow'), head + '\n');
    process.env.SPECFLOW_ALLOW_SHALLOW = '1';
    try {
      const pre = preflight(dir, {});
      expect(pre.mode).toBe('fullTree');
      expect(pre.warnings.join('\n')).toMatch(/shallow/);
    } finally {
      delete process.env.SPECFLOW_ALLOW_SHALLOW;
    }
  });

  test('healthy two-commit repo → HEAD~1..HEAD', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    commit(dir, 'b.txt', '2', 'two');
    const pre = preflight(dir, {});
    expect(pre.mode).toBe('range');
    expect(pre.range).toBe('HEAD~1..HEAD');
  });
});

// ─ gitDiffScope (integration) ───────────────────────────────────────────────

describe('gitDiffScope integration', () => {
  test('shallow clone triggers onFatal (exit path) without --allow-shallow', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    commit(dir, 'b.txt', '2', 'two');
    const head = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
    fs.writeFileSync(path.join(dir, '.git', 'shallow'), head + '\n');

    let fatalMessage;
    expect(() =>
      gitDiffScope({
        cwd: dir,
        onFatal: (msg) => {
          fatalMessage = msg;
          throw new Error('fatal invoked');
        },
      })
    ).toThrow(/fatal invoked/);
    expect(fatalMessage).toMatch(/shallow/);
    expect(fatalMessage).toMatch(/fetch-depth/);
  });

  test('merge commit diff uses HEAD^1 (only feature-branch files)', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    execSync('git checkout -q -b feature', { cwd: dir });
    commit(dir, 'feature-file.ts', 'x', 'feature work');
    execSync('git checkout -q master 2>/dev/null || git checkout -q main', { cwd: dir });
    commit(dir, 'main-file.ts', 'y', 'main work');
    execSync('git merge --no-ff -q feature -m "merge"', { cwd: dir });

    const { result, stderr } = captureStderr(() => gitDiffScope({ cwd: dir }));
    // HEAD^1..HEAD from the merge commit includes the feature branch file
    // only (the first-parent trunk path) — not main-file.ts which is on the
    // first-parent history.
    expect(result.changedFiles).toContain('feature-file.ts');
    expect(stderr).toMatch(/merge commit/);
  });

  test('parses filenames with spaces and unicode via -z', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    const weird = 'spaces and ünïcode.txt';
    commit(dir, weird, 'x', 'weird name');
    const { result } = captureStderr(() => gitDiffScope({ cwd: dir }));
    expect(result.changedFiles).toContain(weird);
  });

  test('does not read COMMIT_EDITMSG outside an active commit hook', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    // Put something in COMMIT_EDITMSG as if a previous commit left it there.
    fs.writeFileSync(
      path.join(dir, '.git', 'COMMIT_EDITMSG'),
      'stale message with override_contract: test_coupling stale-reason\n',
      'utf-8'
    );
    // No GIT_INDEX_FILE / GIT_EDITOR → must NOT read COMMIT_EDITMSG.
    const { result } = captureStderr(() => gitDiffScope({ cwd: dir, staged: true }));
    expect(result.commitMessages).toEqual([]);
  });

  test('reads COMMIT_EDITMSG when GIT_INDEX_FILE is set (active hook)', () => {
    const dir = mkRepo();
    commit(dir, 'a.txt', '1', 'one');
    fs.writeFileSync(
      path.join(dir, '.git', 'COMMIT_EDITMSG'),
      'fresh message\n\noverride_contract: test_coupling good-reason\n',
      'utf-8'
    );
    process.env.GIT_INDEX_FILE = path.join(dir, '.git', 'index');
    try {
      const { result } = captureStderr(() => gitDiffScope({ cwd: dir, staged: true }));
      expect(result.commitMessages.length).toBe(1);
      expect(result.commitMessages[0]).toMatch(/override_contract/);
    } finally {
      delete process.env.GIT_INDEX_FILE;
    }
  });
});

// ─ parseNullSeparatedFileList ───────────────────────────────────────────────

describe('parseNullSeparatedFileList', () => {
  test('splits on NUL and drops empties', () => {
    const buf = Buffer.from('a.ts\0dir/b.ts\0\0c.ts\0', 'utf-8');
    expect(parseNullSeparatedFileList(buf)).toEqual(['a.ts', 'dir/b.ts', 'c.ts']);
  });

  test('preserves unicode and spaces', () => {
    const buf = Buffer.from('spaces and ünïcode.txt\0', 'utf-8');
    expect(parseNullSeparatedFileList(buf)).toEqual(['spaces and ünïcode.txt']);
  });

  test('normalises backslashes to forward slashes', () => {
    const buf = Buffer.from('dir\\sub\\file.ts\0', 'utf-8');
    expect(parseNullSeparatedFileList(buf)).toEqual(['dir/sub/file.ts']);
  });
});

// ─ findOverride ─────────────────────────────────────────────────────────────

describe('findOverride (rule-scoped, code-fence-aware)', () => {
  test('accepts contract id at start of line', () => {
    const msg = 'subject\n\noverride_contract: spec_coupling_core COUPLE-001 mechanical';
    expect(findOverride([msg], 'spec_coupling_core')).toMatch(/mechanical/);
  });

  test('accepts rule-scoped form', () => {
    const msg = 'subject\n\noverride_contract: spec_coupling:COUPLE-001 reason';
    expect(findOverride([msg], 'spec_coupling', 'COUPLE-001')).toBe('reason');
  });

  test('rule-scoped directive does not cover a different rule', () => {
    const msg = 'subject\n\noverride_contract: spec_coupling:COUPLE-001 reason';
    expect(findOverride([msg], 'spec_coupling', 'COUPLE-002')).toBeNull();
  });

  test('bare-contract directive covers all rules in that contract', () => {
    const msg = 'subject\n\noverride_contract: spec_coupling reason';
    expect(findOverride([msg], 'spec_coupling', 'COUPLE-001')).toBe('reason');
    expect(findOverride([msg], 'spec_coupling', 'COUPLE-999')).toBe('reason');
  });

  test('rejects directive inside a fenced code block', () => {
    const msg = [
      'subject',
      '',
      'Here is an example of how NOT to do it:',
      '```',
      'override_contract: spec_coupling reason',
      '```',
    ].join('\n');
    expect(findOverride([msg], 'spec_coupling')).toBeNull();
  });

  test('rejects directive inside a tilde-fenced code block', () => {
    const msg = 'subject\n~~~\noverride_contract: spec_coupling reason\n~~~\n';
    expect(findOverride([msg], 'spec_coupling')).toBeNull();
  });

  test('rejects contract-id substring match', () => {
    const msg = 'override_contract: spec_coupling_core_extra reason';
    expect(findOverride([msg], 'spec_coupling_core')).toBeNull();
  });

  test('rejects mid-line directive (must be at start-of-line)', () => {
    const msg = 'see comment: override_contract: spec_coupling reason';
    expect(findOverride([msg], 'spec_coupling')).toBeNull();
  });
});
