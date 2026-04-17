/**
 * Tests for PRD-011 S7 — upward traceability, typed links, owner filter,
 * and HTML review site (ADR-016).
 *
 * These tests run against the compiled dist/ artefacts, matching the pattern
 * the rest of tests/docs/ uses. Fixtures are built in a per-test tmpdir so
 * we never leak into the repo under test.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseString, validate, serialize } = require('../../dist/lib/frontmatter');
const {
  DocumentRepository,
  Document,
} = require('../../dist/lib/document-repository');
const { loadContractIndex, ContractIndex } = require('../../dist/lib/contract-index');
const { buildContractTree } = require('../../dist/lib/traceability');
const { validate: validateLinks } = require('../../dist/lib/link-validator');
const { generateHtmlSite } = require('../../dist/lib/html-review');

function mktmp(prefix = 'specflow-s7-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeDoc(dir, id, extraYaml = '', body = '\nBody.\n') {
  const type = id.split('-')[0];
  const subdir = {
    ADR: 'adrs',
    PRD: 'prds',
    DDD: 'ddds',
  }[type];
  const target = path.join(dir, subdir);
  fs.mkdirSync(target, { recursive: true });
  const slug = id.toLowerCase();
  const filePath = path.join(target, `${id}-${slug}.md`);
  const content = `---
id: ${id}
title: ${id} Title
type: ${type}
status: Accepted
version: 1
date: '2026-04-16'
last_reviewed: '2026-04-16'
${extraYaml}
---
${body}`;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeContract(dir, id, rulesYaml = '') {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.yml`);
  const yaml = `contract_meta:
  id: ${id}
  type: pattern
  version: "1.0.0"

rules:
${rulesYaml}
`;
  fs.writeFileSync(filePath, yaml, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Frontmatter schema extensions
// ---------------------------------------------------------------------------

describe('frontmatter typed-link validation (S7)', () => {
  test('accepts tests: [ADR-010]', () => {
    const doc = `---
id: ADR-099
title: Valid typed link
type: ADR
status: Accepted
version: 1
date: '2026-04-16'
last_reviewed: '2026-04-16'
implements: []
implemented_by: []
tests:
  - ADR-010
---
Body.
`;
    const r = parseString(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frontmatter.tests).toEqual(['ADR-010']);
    }
  });

  test('rejects tests: [foo] with a shape error', () => {
    const doc = `---
id: ADR-099
title: Bad typed link
type: ADR
status: Accepted
version: 1
date: '2026-04-16'
last_reviewed: '2026-04-16'
implements: []
implemented_by: []
tests:
  - foo
---
Body.
`;
    const r = parseString(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /tests entry "foo"/.test(e))).toBe(true);
    }
  });

  test('owned_by rejects bare text, accepts @handle', () => {
    const bad = `---
id: ADR-099
title: Bad owner
type: ADR
status: Accepted
version: 1
date: '2026-04-16'
last_reviewed: '2026-04-16'
implements: []
implemented_by: []
owned_by:
  - 'platform-team'
---
`;
    const r = parseString(bad);
    expect(r.ok).toBe(false);

    // YAML requires quoting a scalar that begins with `@` — we quote the
    // handle so the parser doesn't treat `@` as a reserved indicator.
    const good = bad.replace("'platform-team'", "'@team-platform'");
    const r2 = parseString(good);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.frontmatter.owned_by).toEqual(['@team-platform']);
  });

  test('implements_contracts accepts arbitrary non-empty contract ids', () => {
    const doc = `---
id: ADR-099
title: Contract link
type: ADR
status: Accepted
version: 1
date: '2026-04-16'
last_reviewed: '2026-04-16'
implements: []
implemented_by: []
implements_contracts:
  - spec_coupling_core
  - yaml_safety
---
`;
    const r = parseString(doc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frontmatter.implements_contracts).toEqual([
        'spec_coupling_core',
        'yaml_safety',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// ContractIndex
// ---------------------------------------------------------------------------

describe('ContractIndex', () => {
  test('indexes contracts by id and exposes rules', () => {
    const dir = mktmp();
    writeContract(
      path.join(dir, '.specflow', 'contracts'),
      'sec_defaults',
      `  - id: SEC-001\n    description: No eval\n  - id: SEC-002\n    description: No secrets\n`
    );
    const index = loadContractIndex(path.join(dir, '.specflow', 'contracts'));
    const entry = index.get('sec_defaults');
    expect(entry).toBeDefined();
    expect(entry.rules.map((r) => r.id).sort()).toEqual(['SEC-001', 'SEC-002']);
  });

  test('returns undefined for unknown contracts', () => {
    const index = loadContractIndex(path.join(mktmp(), 'empty'));
    expect(index.get('whatever')).toBeUndefined();
    expect(index.all()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildContractTree
// ---------------------------------------------------------------------------

describe('buildContractTree (audit --contract)', () => {
  test('walks upward from a contract id to implementing docs and recurses', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    const contractsDir = path.join(dir, '.specflow', 'contracts');
    writeContract(contractsDir, 'sec_defaults', `  - id: SEC-001\n    description: No eval\n`);

    // DDD-099 claims to implement contract SEC-001 (via implements_contracts).
    writeDoc(
      docsDir,
      'DDD-099',
      `implements: []\nimplemented_by:\n  - ADR-099\nimplements_contracts:\n  - sec_defaults`
    );
    // ADR-099 is implemented_by DDD-099 and itself implemented_by PRD-099.
    writeDoc(
      docsDir,
      'ADR-099',
      `implements:\n  - DDD-099\nimplemented_by:\n  - PRD-099`
    );
    // PRD-099 sits at the top.
    writeDoc(
      docsDir,
      'PRD-099',
      `implements:\n  - ADR-099\nimplemented_by: []`
    );

    const repo = new DocumentRepository();
    repo.load(docsDir);
    const index = loadContractIndex(contractsDir);
    const tree = buildContractTree('sec_defaults', index, repo, repo.all());

    expect(tree.found).toBe(true);
    // The contract has one rule (SEC-001) but our implementer points at the
    // contract as a whole, so it shows up under rootDocuments.
    expect(tree.rules.map((r) => r.ruleId)).toEqual(['SEC-001']);
    expect(tree.rules[0].documents).toEqual([]);
    expect(tree.rootDocuments.length).toBe(1);
    const ddd = tree.rootDocuments[0];
    expect(ddd.id).toBe('DDD-099');
    expect(ddd.children.map((c) => c.id)).toEqual(['ADR-099']);
    expect(ddd.children[0].children.map((c) => c.id)).toEqual(['PRD-099']);
  });

  test('rootless contract returns an empty tree without throwing', () => {
    const dir = mktmp();
    const contractsDir = path.join(dir, '.specflow', 'contracts');
    writeContract(contractsDir, 'rootless', `  - id: R-001\n    description: lonely\n`);
    const repo = new DocumentRepository(); // no docs loaded
    const index = loadContractIndex(contractsDir);
    const tree = buildContractTree('rootless', index, repo, repo.all());
    expect(tree.found).toBe(true);
    expect(tree.rootDocuments).toEqual([]);
    expect(tree.rules[0].documents).toEqual([]);
  });

  test('missing contract reports found=false', () => {
    const repo = new DocumentRepository();
    const tree = buildContractTree(
      'nope',
      new ContractIndex([]),
      repo,
      repo.all()
    );
    expect(tree.found).toBe(false);
    expect(tree.rules).toEqual([]);
    expect(tree.rootDocuments).toEqual([]);
  });

  test('cycles are cut at the first repeated id', () => {
    // Author-created cycle: A implemented_by B, B implemented_by A.
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    const contractsDir = path.join(dir, '.specflow', 'contracts');
    writeContract(contractsDir, 'cyc', '  - id: C-001\n    description: cycle root\n');
    writeDoc(
      docsDir,
      'ADR-100',
      `implements: []\nimplemented_by:\n  - ADR-101\nimplements_contracts:\n  - cyc`
    );
    writeDoc(
      docsDir,
      'ADR-101',
      `implements: []\nimplemented_by:\n  - ADR-100`
    );

    const repo = new DocumentRepository();
    repo.load(docsDir);
    const index = loadContractIndex(contractsDir);
    const tree = buildContractTree('cyc', index, repo, repo.all());

    const root = tree.rootDocuments[0];
    expect(root.id).toBe('ADR-100');
    const child = root.children[0];
    expect(child.id).toBe('ADR-101');
    // The cycle back to ADR-100 must be a stub, not a recursion.
    const grand = child.children[0];
    expect(grand.cycleOf).toBe('ADR-100');
    expect(grand.children).toEqual([]);
  });

  test('backward-compat: contract in implemented_by is still picked up', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    const contractsDir = path.join(dir, '.specflow', 'contracts');
    writeContract(contractsDir, 'legacy_contract', '  - id: L-001\n    description: legacy\n');
    // DDD-098 has the contract id dumped into implemented_by (DDD-007 allows it).
    writeDoc(
      docsDir,
      'DDD-098',
      `implements: []\nimplemented_by:\n  - legacy_contract`
    );

    const repo = new DocumentRepository();
    repo.load(docsDir);
    const index = loadContractIndex(contractsDir);
    const tree = buildContractTree('legacy_contract', index, repo, repo.all());
    expect(tree.rootDocuments.map((d) => d.id)).toEqual(['DDD-098']);
  });
});

// ---------------------------------------------------------------------------
// doctor typed-link dangling validation
// ---------------------------------------------------------------------------

describe('doctor typed-link dangling check', () => {
  test('dangling tests: entry is reported, blocks/contradicts do not require reciprocity', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    writeDoc(
      docsDir,
      'ADR-200',
      `implements: []\nimplemented_by: []\ntests:\n  - ADR-999\nblocks:\n  - ADR-201\n`
    );
    writeDoc(docsDir, 'ADR-201', `implements: []\nimplemented_by: []`);

    const repo = new DocumentRepository();
    repo.load(docsDir);
    const report = validateLinks(repo);
    // ADR-999 is missing entirely.
    const dangling = report.danglingReferences.filter((d) => d.field === 'tests');
    expect(dangling.length).toBe(1);
    expect(dangling[0].missingTarget).toBe('ADR-999');
    // blocks target resolves — no dangling
    expect(report.danglingReferences.some((d) => d.field === 'blocks')).toBe(false);
    // No reciprocity is required for blocks / contradicts, so no missingReciprocals
    expect(report.missingReciprocals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// review --owner filter (library-level — CLI wiring covered by a smoke check)
// ---------------------------------------------------------------------------

describe('owner filtering', () => {
  test('only docs whose owned_by contains the handle survive the filter', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    writeDoc(
      docsDir,
      'ADR-300',
      `implements: []\nimplemented_by: []\nowned_by:\n  - '@team-platform'\n`
    );
    writeDoc(docsDir, 'ADR-301', `implements: []\nimplemented_by: []`);
    writeDoc(
      docsDir,
      'ADR-302',
      `implements: []\nimplemented_by: []\nowned_by:\n  - '@team-frontend'\n`
    );

    const repo = new DocumentRepository();
    repo.load(docsDir);

    const platform = repo
      .all()
      .filter((d) => (d.frontmatter.owned_by || []).includes('@team-platform'));
    expect(platform.map((d) => d.id)).toEqual(['ADR-300']);
  });
});

// ---------------------------------------------------------------------------
// HTML site generation
// ---------------------------------------------------------------------------

describe('generateHtmlSite (review --html)', () => {
  test('writes all expected files under .specflow/review/', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    writeDoc(docsDir, 'ADR-400', 'implements: []\nimplemented_by: []');
    writeDoc(docsDir, 'PRD-400', 'implements:\n  - ADR-400\nimplemented_by: []');
    const repo = new DocumentRepository();
    repo.load(docsDir);

    const result = generateHtmlSite(repo, { projectRoot: dir, now: new Date('2026-04-17T00:00:00Z') });
    const rel = path.relative(dir, result.outputDir);
    expect(rel).toBe(path.join('.specflow', 'review'));

    const expected = [
      'index.html',
      'overdue.html',
      'orphaned.html',
      'stale-links.html',
      'graph.html',
      'data.json',
      path.join('assets', 'style.css'),
    ];
    for (const f of expected) {
      expect(fs.existsSync(path.join(result.outputDir, f))).toBe(true);
    }

    const index = fs.readFileSync(path.join(result.outputDir, 'index.html'), 'utf-8');
    expect(index).toMatch(/<title>Summary — Specflow Review<\/title>/);
    expect(index).toMatch(/assets\/style\.css/);
  });

  test('is idempotent — re-running overwrites cleanly', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    writeDoc(docsDir, 'ADR-500', 'implements: []\nimplemented_by: []');
    const repo = new DocumentRepository();
    repo.load(docsDir);

    const now = new Date('2026-04-17T00:00:00Z');
    const r1 = generateHtmlSite(repo, { projectRoot: dir, now });
    const before = fs.readFileSync(path.join(r1.outputDir, 'index.html'), 'utf-8');
    const r2 = generateHtmlSite(repo, { projectRoot: dir, now });
    const after = fs.readFileSync(path.join(r2.outputDir, 'index.html'), 'utf-8');
    expect(after).toBe(before);
    expect(r2.files.length).toBe(r1.files.length);
  });

  test('owner filter affects index body but not file set', () => {
    const dir = mktmp();
    const docsDir = path.join(dir, 'docs', 'architecture');
    writeDoc(
      docsDir,
      'ADR-600',
      `implements: []\nimplemented_by: []\nowned_by:\n  - '@team-platform'\n`
    );
    writeDoc(docsDir, 'ADR-601', 'implements: []\nimplemented_by: []');
    const repo = new DocumentRepository();
    repo.load(docsDir);

    const now = new Date('2026-04-17T00:00:00Z');
    const full = generateHtmlSite(repo, { projectRoot: dir, now });
    const filtered = generateHtmlSite(repo, {
      projectRoot: dir,
      now,
      ownerFilter: '@team-platform',
    });
    expect(full.files.length).toBe(filtered.files.length);
    const filteredIdx = fs.readFileSync(path.join(filtered.outputDir, 'index.html'), 'utf-8');
    expect(filteredIdx).toMatch(/@team-platform/);
  });
});
