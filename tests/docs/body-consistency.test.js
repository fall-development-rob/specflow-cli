/**
 * Tests for ts-src/lib/body-consistency.ts and the doctor --docs body
 * consistency check (ADR-017 rule 4 / S6 deliverable 4).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { checkDocument } = require('../../dist/lib/body-consistency');

function mkdoc({ status, date, implementsList, body }) {
  return {
    id: 'ADR-999',
    filePath: '/tmp/ADR-999.md',
    frontmatter: {
      status,
      date,
      implements: implementsList || [],
    },
    body,
  };
}

describe('checkDocument — body/frontmatter drift (ADR-017 rule 4)', () => {
  test('flags body Status that disagrees with frontmatter', () => {
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      body: '# Title\n\n**Status:** Proposed\nBody text.\n',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('status_drift');
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toMatch(/Proposed/);
    expect(findings[0].message).toMatch(/Accepted/);
  });

  test('does not flag body Status that agrees with frontmatter', () => {
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      body: '# Title\n\n**Status:** Accepted\nBody.\n',
    })).filter((f) => f.type === 'status_drift');
    expect(findings).toHaveLength(0);
  });

  test('flags body Date that disagrees with frontmatter as error', () => {
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      body: '**Date:** 2020-01-01\n',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('date_drift');
    expect(findings[0].severity).toBe('error');
  });

  test('flags body Date that matches frontmatter as warning (redundant)', () => {
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      body: '**Date:** 2026-04-17\n',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('date_redundant');
    expect(findings[0].severity).toBe('warn');
  });

  test('flags body Depends on: when frontmatter.implements is populated', () => {
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      implementsList: ['ADR-001'],
      body: '**Depends on:** ADR-001\n',
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('depends_legacy');
    expect(findings[0].severity).toBe('warn');
  });

  test('does not flag body Depends on: when implements is empty (pre-migration)', () => {
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      implementsList: [],
      body: '**Depends on:** ADR-001\n',
    }));
    expect(findings.filter((f) => f.type === 'depends_legacy')).toHaveLength(0);
  });

  test('skips body drift inside fenced code blocks (``` fence)', () => {
    const body = [
      '# Title',
      '',
      '```',
      '**Status:** Proposed',
      '```',
      '',
      'Real body.',
    ].join('\n');
    const findings = checkDocument(mkdoc({ status: 'Accepted', date: '2026-04-17', body }));
    expect(findings).toHaveLength(0);
  });

  test('skips body drift inside fenced code blocks (~~~ fence)', () => {
    const body = [
      '# Title',
      '',
      '~~~yaml',
      '**Date:** 1999-01-01',
      '~~~',
    ].join('\n');
    const findings = checkDocument(mkdoc({ status: 'Accepted', date: '2026-04-17', body }));
    expect(findings).toHaveLength(0);
  });

  test('reports the correct 1-based line number', () => {
    const body = '\n\n\n**Status:** Draft\n';
    const findings = checkDocument(mkdoc({ status: 'Accepted', date: '2026-04-17', body }));
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(4);
  });

  test('detects multiple drifts in one doc', () => {
    const body = '**Status:** Draft\n**Date:** 2020-01-01\n**Depends on:** ADR-001\n';
    const findings = checkDocument(mkdoc({
      status: 'Accepted',
      date: '2026-04-17',
      implementsList: ['ADR-001'],
      body,
    }));
    expect(findings.some((f) => f.type === 'status_drift')).toBe(true);
    expect(findings.some((f) => f.type === 'date_drift')).toBe(true);
    expect(findings.some((f) => f.type === 'depends_legacy')).toBe(true);
  });
});

describe('doctor --docs end-to-end body-consistency', () => {
  function makeDocsProject(docs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-doctor-body-'));
    const adrs = path.join(dir, 'docs', 'architecture', 'adrs');
    fs.mkdirSync(adrs, { recursive: true });
    for (const [name, content] of Object.entries(docs)) {
      fs.writeFileSync(path.join(adrs, name), content, 'utf-8');
    }
    return dir;
  }

  const cli = path.resolve(__dirname, '..', '..', 'dist', 'cli.js');

  test('exits 1 when a doc has status drift', () => {
    const dir = makeDocsProject({
      'ADR-999-drift.md': `---
id: ADR-999
title: Drifty ADR
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements: []
implemented_by: []
---

# ADR-999

**Status:** Proposed

Context body.
`,
    });

    let exit = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [cli, 'doctor', '--docs', dir], { stdio: 'pipe' }).toString();
    } catch (e) {
      exit = e.status ?? 1;
      stdout = (e.stdout || '').toString();
    }
    expect(exit).toBe(1);
    expect(stdout).toMatch(/Body consistency/);
    expect(stdout).toMatch(/ADR-999-drift\.md/);
    expect(stdout).toMatch(/body '\*\*Status:\*\* Proposed' disagrees/);
  });

  test('does NOT report drift when **Status:** lives inside a fenced code block', () => {
    const dir = makeDocsProject({
      'ADR-888-fenced.md': `---
id: ADR-888
title: Fenced Example
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements: []
implemented_by: []
---

# ADR-888

Example of a legacy header we are documenting:

\`\`\`
**Status:** Proposed
\`\`\`

Real body.
`,
    });

    let exit = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [cli, 'doctor', '--docs', dir], { stdio: 'pipe' }).toString();
    } catch (e) {
      exit = e.status ?? 1;
      stdout = (e.stdout || '').toString();
    }
    expect(exit).toBe(0);
    expect(stdout).not.toMatch(/Body consistency.*error/i);
    expect(stdout).not.toMatch(/ADR-888.*disagrees/);
  });

  test('clean docs pass with no body-consistency section', () => {
    const dir = makeDocsProject({
      'ADR-777-clean.md': `---
id: ADR-777
title: Clean ADR
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements: []
implemented_by: []
---

# ADR-777

Body with no legacy header lines.
`,
    });

    let exit = 0;
    let stdout = '';
    try {
      stdout = execFileSync('node', [cli, 'doctor', '--docs', dir], { stdio: 'pipe' }).toString();
    } catch (e) {
      exit = e.status ?? 1;
      stdout = (e.stdout || '').toString();
    }
    expect(exit).toBe(0);
    expect(stdout).toMatch(/All documentation checks passed/);
  });
});
