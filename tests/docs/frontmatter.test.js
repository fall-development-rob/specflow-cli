/**
 * Tests for FrontmatterParser (ts-src/lib/frontmatter.ts → dist/lib/frontmatter.js)
 * Covers ADR-011 schema: parsing, validation, lifecycle, serialisation, legacy migration.
 */

const { parseString, validate, serialize, buildFrontmatterFromLegacy, injectFrontmatter, hasFrontmatter } =
  require('../../dist/lib/frontmatter');

const validDoc = `---
id: ADR-099
title: Test ADR
type: ADR
status: Accepted
version: 1
date: 2026-04-16
last_reviewed: 2026-04-16
implements:
  - PRD-099
implemented_by: []
---

# ADR-099

Body content.
`;

describe('FrontmatterParser.parseString', () => {
  test('parses a well-formed doc', () => {
    const r = parseString(validDoc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.frontmatter.id).toBe('ADR-099');
    expect(r.frontmatter.status).toBe('Accepted');
    expect(r.frontmatter.implements).toEqual(['PRD-099']);
    expect(r.body.trim().startsWith('# ADR-099')).toBe(true);
  });

  test('rejects a doc without frontmatter', () => {
    const r = parseString('# hello\nno frontmatter');
    expect(r.ok).toBe(false);
  });

  test('rejects a Superseded doc without superseded_by', () => {
    const bad = validDoc.replace('status: Accepted', 'status: Superseded');
    const r = parseString(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /superseded_by/.test(e))).toBe(true);
  });

  test('rejects a Deprecated doc without deprecation_note', () => {
    const bad = validDoc.replace('status: Accepted', 'status: Deprecated');
    const r = parseString(bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /deprecation_note/.test(e))).toBe(true);
  });

  test('accepts Deprecated when deprecation_note is present', () => {
    const ok = validDoc
      .replace('status: Accepted', 'status: Deprecated')
      .replace('implemented_by: []', 'implemented_by: []\ndeprecation_note: no longer relevant');
    const r = parseString(ok);
    expect(r.ok).toBe(true);
  });

  test('rejects last_reviewed before date', () => {
    const bad = validDoc.replace('last_reviewed: 2026-04-16', 'last_reviewed: 2020-01-01');
    const r = parseString(bad);
    expect(r.ok).toBe(false);
  });

  test('rejects malformed id', () => {
    const bad = validDoc.replace('id: ADR-099', 'id: NOT-A-VALID-ID');
    const r = parseString(bad);
    expect(r.ok).toBe(false);
  });
});

describe('FrontmatterParser.serialize', () => {
  test('round-trips a valid frontmatter', () => {
    const r = parseString(validDoc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = serialize(r.frontmatter);
    const re = parseString(out + '\nbody');
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.frontmatter.id).toBe('ADR-099');
  });
});

describe('buildFrontmatterFromLegacy', () => {
  const legacy = `# ADR-042: Legacy Header

**Status:** Proposed
**Date:** 2026-01-15
**Depends on:** PRD-007, DDD-005

## Context
Legacy body.
`;

  test('parses legacy header block', () => {
    const fm = buildFrontmatterFromLegacy(legacy, '/tmp/ADR-042-legacy.md', '2026-04-16');
    expect(fm).not.toBeNull();
    expect(fm.id).toBe('ADR-042');
    expect(fm.type).toBe('ADR');
    expect(fm.status).toBe('Accepted');
    expect(fm.date).toBe('2026-01-15');
    expect(fm.implements).toEqual(expect.arrayContaining(['PRD-007', 'DDD-005']));
    expect(validate(fm)).toEqual([]);
  });

  test('infers id from filename when title missing', () => {
    const minimal = 'No title\n**Status:** Accepted\n';
    const fm = buildFrontmatterFromLegacy(minimal, '/tmp/PRD-099-thing.md', '2026-04-16');
    expect(fm).not.toBeNull();
    expect(fm.id).toBe('PRD-099');
  });
});

describe('injectFrontmatter', () => {
  test('prepends frontmatter when missing', () => {
    const original = '# Title\nBody';
    const fm = buildFrontmatterFromLegacy('# ADR-001: X\n**Status:** Accepted\n', '/tmp/ADR-001.md', '2026-04-16');
    const out = injectFrontmatter(original, fm);
    expect(hasFrontmatter(out)).toBe(true);
    expect(out).toContain('# Title');
  });

  test('is idempotent when frontmatter already present', () => {
    const out = injectFrontmatter(validDoc, {});
    expect(out).toBe(validDoc);
  });
});
