/**
 * Tests for CouplingEnforcer — spec_coupling contract evaluation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { evaluate, matchGlobs, globToRegex, loadCouplingContracts } =
  require('../../dist/lib/coupling-enforcer');

describe('globToRegex (deprecated shim)', () => {
  test('matches ** across multiple segments', () => {
    const re = globToRegex('src/**/*.ts');
    expect(re.test('src/a/b/c.ts')).toBe(true);
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('other/a.ts')).toBe(false);
  });

  test('* does not cross segments', () => {
    const re = globToRegex('src/*.ts');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/a/b.ts')).toBe(false);
  });

  test('** matches zero segments (minimatch semantics)', () => {
    // Shim delegates to minimatch; `src/**/foo.ts` matches `src/foo.ts`.
    const re = globToRegex('src/**/foo.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/a/foo.ts')).toBe(true);
  });
});

describe('matchGlobs', () => {
  test('respects excludes', () => {
    const files = ['src/a.ts', 'src/a.test.ts', 'src/b.ts'];
    const out = matchGlobs(files, ['src/**/*.ts'], ['**/*.test.ts']);
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('brace expansion: *.{ts,tsx} matches both extensions', () => {
    const files = ['ts-src/foo.ts', 'ts-src/bar.tsx', 'ts-src/baz.js'];
    const out = matchGlobs(files, ['ts-src/**/*.{ts,tsx}'], []);
    expect(out.sort()).toEqual(['ts-src/bar.tsx', 'ts-src/foo.ts']);
  });

  test('path-segment boundary: src/**/foo.ts does not match srcbar/foo.ts', () => {
    // Regression against the home-rolled globToRegex that translated `src/**`
    // to `src.*` and false-matched neighbouring directories.
    const files = ['src/foo.ts', 'srcbar/foo.ts', 'src/a/foo.ts'];
    const out = matchGlobs(files, ['src/**/foo.ts'], []);
    expect(out.sort()).toEqual(['src/a/foo.ts', 'src/foo.ts']);
  });

  test('negation pattern in include list (!**/*.test.ts)', () => {
    // A lone negative pattern acts as "everything except"; intersected with
    // a positive pattern it removes the matching subset.
    const files = ['src/a.ts', 'src/a.test.ts', 'src/b.ts'];
    const out = matchGlobs(files, ['src/**/*.ts', '!**/*.test.ts'], []);
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  test('dotfiles are not matched by * (dot: false)', () => {
    const files = ['foo.ts', '.hidden'];
    const out = matchGlobs(files, ['*'], []);
    expect(out).toEqual(['foo.ts']);
  });

  test('explicit dot patterns still work (e.g. .specflow/contracts/*.yml)', () => {
    const files = ['.specflow/contracts/foo.yml', 'src/a.ts'];
    const out = matchGlobs(files, ['.specflow/contracts/*.yml'], []);
    expect(out).toEqual(['.specflow/contracts/foo.yml']);
  });
});

describe('CouplingEnforcer.evaluate', () => {
  const contracts = [
    {
      contractId: 'test_coupling',
      sourceFile: '/tmp/test_coupling.yml',
      rules: [
        {
          id: 'COUPLE-T1',
          description: 'source changes require doc changes',
          source_globs: ['ts-src/**/*.ts'],
          required_doc_globs: ['docs/architecture/**/*.md'],
          exclude_globs: ['**/*.test.ts'],
          severity: 'error',
        },
      ],
    },
  ];

  const scope = (files, messages = []) => ({
    repoRoot: '/fake/repo',
    changedFiles: files,
    commitMessages: messages,
  });

  test('doc-only change passes (asymmetric)', () => {
    const violations = evaluate(
      contracts,
      scope(['docs/architecture/adrs/ADR-010.md'])
    );
    expect(violations).toHaveLength(0);
  });

  test('source change without matching doc fails', () => {
    const violations = evaluate(contracts, scope(['ts-src/commands/foo.ts']));
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe('COUPLE-T1');
    expect(violations[0].severity).toBe('error');
  });

  test('matching doc change in same diff satisfies the rule', () => {
    const violations = evaluate(
      contracts,
      scope(['ts-src/commands/foo.ts', 'docs/architecture/adrs/ADR-010.md'])
    );
    expect(violations).toHaveLength(0);
  });

  test('exclude_globs filters test files out of source match', () => {
    const violations = evaluate(contracts, scope(['ts-src/foo.test.ts']));
    expect(violations).toHaveLength(0);
  });

  test('override directive demotes error to warning', () => {
    const violations = evaluate(
      contracts,
      scope(
        ['ts-src/commands/foo.ts'],
        ['fix: typo cleanup\n\noverride_contract: spec_coupling mechanical refactor']
      )
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('warning');
    expect(violations[0].overrideJustification).toMatch(/mechanical/);
  });

  test('unrelated source changes are not flagged', () => {
    const violations = evaluate(
      contracts,
      scope(['README.md', 'package.json'])
    );
    expect(violations).toHaveLength(0);
  });

  test('rejects absolute paths at domain boundary (regression for the ADR-013 silent-pass bug)', () => {
    // The root cause of the original bug: parseFileList produced absolute
    // paths via path.resolve(cwd, rel), and those never matched repo-relative
    // globs, so every coupling passed vacuously. DiffScope now asserts the
    // invariant — absolute input is a loud error, not a silent skip.
    const absolute = path.resolve('/home/robert/specflow/ts-src/commands/foo.ts');
    expect(() => evaluate(contracts, scope([absolute]))).toThrow(/repo-relative/);
  });

  test('rejects changedFiles containing .. segments', () => {
    expect(() =>
      evaluate(contracts, scope(['../outside/repo/leak.ts']))
    ).toThrow(/escape repo root/);
  });

  test('brace-expansion glob drives source matching', () => {
    const contracts = [
      {
        contractId: 'test_cc_brace',
        sourceFile: '/tmp/x.yml',
        rules: [
          {
            id: 'COUPLE-BRACE',
            description: 'brace',
            source_globs: ['ts-src/**/*.{ts,tsx}'],
            required_doc_globs: ['docs/architecture/**/*.md'],
            exclude_globs: [],
            severity: 'error',
          },
        ],
      },
    ];
    const vTsx = evaluate(contracts, scope(['ts-src/ui/Widget.tsx']));
    expect(vTsx).toHaveLength(1);
    expect(vTsx[0].ruleId).toBe('COUPLE-BRACE');

    const vTs = evaluate(contracts, scope(['ts-src/commands/foo.ts']));
    expect(vTs).toHaveLength(1);
  });

  test('path-segment boundary is respected in rule matching', () => {
    const contracts = [
      {
        contractId: 'test_cc_boundary',
        sourceFile: '/tmp/x.yml',
        rules: [
          {
            id: 'COUPLE-BD',
            description: 'bd',
            source_globs: ['src/**/foo.ts'],
            required_doc_globs: ['docs/architecture/**/*.md'],
            exclude_globs: [],
            severity: 'error',
          },
        ],
      },
    ];
    // `srcbar/foo.ts` must NOT match `src/**/foo.ts`.
    const vNeighbour = evaluate(contracts, scope(['srcbar/foo.ts']));
    expect(vNeighbour).toHaveLength(0);

    // `src/a/foo.ts` must match.
    const vReal = evaluate(contracts, scope(['src/a/foo.ts']));
    expect(vReal).toHaveLength(1);
  });
});

describe('loadCouplingContracts', () => {
  test('loads only contracts with type: spec_coupling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-cc-'));
    // spec_coupling contract
    fs.writeFileSync(
      path.join(dir, 'coupling.yml'),
      `contract_meta:
  id: test_cc
  type: spec_coupling
  version: "1.0.0"
llm_policy:
  severity: error
  auto_fixable: false
  instructions: test
rules:
  couplings:
    - id: COUPLE-X
      description: test
      source_globs: ["src/**/*.ts"]
      required_doc_globs: ["docs/**/*.md"]
      exclude_globs: []
`,
      'utf-8'
    );
    // non-coupling contract should be ignored
    fs.writeFileSync(
      path.join(dir, 'other.yml'),
      `contract_meta:
  id: other
  version: "1.0.0"
rules:
  non_negotiable: []
`,
      'utf-8'
    );
    const contracts = loadCouplingContracts(dir);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].contractId).toBe('test_cc');
    expect(contracts[0].rules[0].id).toBe('COUPLE-X');
  });
});
