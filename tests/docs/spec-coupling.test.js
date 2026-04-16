/**
 * Tests for CouplingEnforcer — spec_coupling contract evaluation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { evaluate, matchGlobs, globToRegex, loadCouplingContracts } =
  require('../../dist/lib/coupling-enforcer');

describe('globToRegex', () => {
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
});

describe('matchGlobs', () => {
  test('respects excludes', () => {
    const files = ['src/a.ts', 'src/a.test.ts', 'src/b.ts'];
    const out = matchGlobs(files, ['src/**/*.ts'], ['**/*.test.ts']);
    expect(out.sort()).toEqual(['src/a.ts', 'src/b.ts']);
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

  test('doc-only change passes (asymmetric)', () => {
    const violations = evaluate(contracts, {
      changedFiles: ['docs/architecture/adrs/ADR-010.md'],
      commitMessages: [],
    });
    expect(violations).toHaveLength(0);
  });

  test('source change without matching doc fails', () => {
    const violations = evaluate(contracts, {
      changedFiles: ['ts-src/commands/foo.ts'],
      commitMessages: [],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].ruleId).toBe('COUPLE-T1');
    expect(violations[0].severity).toBe('error');
  });

  test('matching doc change in same diff satisfies the rule', () => {
    const violations = evaluate(contracts, {
      changedFiles: ['ts-src/commands/foo.ts', 'docs/architecture/adrs/ADR-010.md'],
      commitMessages: [],
    });
    expect(violations).toHaveLength(0);
  });

  test('exclude_globs filters test files out of source match', () => {
    const violations = evaluate(contracts, {
      changedFiles: ['ts-src/foo.test.ts'],
      commitMessages: [],
    });
    expect(violations).toHaveLength(0);
  });

  test('override directive demotes error to warning', () => {
    const violations = evaluate(contracts, {
      changedFiles: ['ts-src/commands/foo.ts'],
      commitMessages: ['fix: typo cleanup\n\noverride_contract: spec_coupling mechanical refactor'],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe('warning');
    expect(violations[0].overrideJustification).toMatch(/mechanical/);
  });

  test('unrelated source changes are not flagged', () => {
    const violations = evaluate(contracts, {
      changedFiles: ['README.md', 'package.json'],
      commitMessages: [],
    });
    expect(violations).toHaveLength(0);
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
