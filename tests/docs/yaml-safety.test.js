/**
 * Tests for ts-src/lib/safe-yaml.ts — ADR-017 rules 1, 2, 3.
 */

const { loadSafe, loadSafeOrNull, YamlSafetyError } = require('../../dist/lib/safe-yaml');

describe('loadSafe — anchor/alias rejection (ADR-017 rule 1)', () => {
  test('rejects a simple anchor/alias pair with code ANCHOR', () => {
    const src = 'foo: &a bar\nbaz: *a\n';
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('ANCHOR');
  });

  test('rejects a deeply nested alias without OOM (billion-laughs safety)', () => {
    // Build a chain of aliases referring back to a single anchor. Even
    // if js-yaml resolved it, FAILSAFE + our structural anchor scanner
    // rejects at the first `&`.
    let src = 'a: &a x\n';
    for (let i = 0; i < 10000; i++) src += `b${i}: *a\n`;
    const start = Date.now();
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('ANCHOR');
    // Must fail fast — structural scan is O(n) in bytes.
    expect(elapsed).toBeLessThan(2000);
  });

  test('accepts a plain document without anchors', () => {
    const src = 'id: ADR-001\ntitle: Safe\n';
    const r = loadSafe(src);
    expect(r).toMatchObject({ id: 'ADR-001', title: 'Safe' });
  });

  test('does not false-alarm on `&` or `*` inside a quoted string', () => {
    const src = "title: 'A & B *test*'\n";
    const r = loadSafe(src);
    expect(r.title).toBe('A & B *test*');
  });
});

describe('loadSafe — duplicate key rejection (ADR-017 rule 2)', () => {
  test('rejects duplicate top-level keys with code DUPLICATE_KEY', () => {
    const src = 'status: Accepted\nstatus: Draft\n';
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('DUPLICATE_KEY');
  });

  test('rejects duplicate keys in nested mapping', () => {
    const src = 'outer:\n  a: 1\n  a: 2\n';
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('DUPLICATE_KEY');
  });
});

describe('loadSafe — prototype-key rejection (ADR-017 rule 3)', () => {
  test('rejects __proto__ top-level key with code PROTOTYPE_KEY', () => {
    const src = '__proto__:\n  polluted: true\n';
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('PROTOTYPE_KEY');
  });

  test('rejects constructor as a mapping key', () => {
    const src = 'outer:\n  constructor: x\n';
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('PROTOTYPE_KEY');
  });

  test('rejects prototype as a mapping key', () => {
    const src = 'prototype:\n  mutated: true\n';
    let caught;
    try { loadSafe(src); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(YamlSafetyError);
    expect(caught.code).toBe('PROTOTYPE_KEY');
  });

  test('returned object uses a null prototype', () => {
    const r = loadSafe('foo: bar\n');
    expect(Object.getPrototypeOf(r)).toBeNull();
  });

  test('does not pollute Object.prototype on clean input', () => {
    loadSafe('a: 1\nb: 2\n');
    expect(({}).polluted).toBeUndefined();
  });
});

describe('loadSafe — FAILSAFE schema (ADR-017 rule 1)', () => {
  test('returns dates as strings, never Date objects', () => {
    const r = loadSafe('date: 2026-04-17\n');
    expect(typeof r.date).toBe('string');
    expect(r.date).toBe('2026-04-17');
  });

  test('returns booleans as strings (FAILSAFE has no implicit bool)', () => {
    const r = loadSafe('flag: true\n');
    // FAILSAFE keeps strings, does not coerce `true` to boolean.
    expect(r.flag).toBe('true');
  });

  test('returns numbers as strings (FAILSAFE has no implicit int)', () => {
    const r = loadSafe('n: 42\n');
    expect(r.n).toBe('42');
  });
});

describe('loadSafeOrNull', () => {
  test('returns null on empty input', () => {
    expect(loadSafeOrNull('')).toBeNull();
    expect(loadSafeOrNull('   \n\n')).toBeNull();
  });

  test('parses non-empty input like loadSafe', () => {
    const r = loadSafeOrNull('x: 1\n');
    expect(r.x).toBe('1');
  });

  test('still throws on anchors in non-empty input', () => {
    let caught;
    try { loadSafeOrNull('a: &a x\nb: *a\n'); } catch (e) { caught = e; }
    expect(caught.code).toBe('ANCHOR');
  });
});

describe('YamlSafetyError', () => {
  test('carries a filename when provided', () => {
    let caught;
    try { loadSafe('__proto__: x\n', { filename: 'foo.yml' }); } catch (e) { caught = e; }
    expect(caught.filename).toBe('foo.yml');
    expect(caught.message).toMatch(/foo\.yml/);
  });

  test('is still an Error instance for compatibility', () => {
    let caught;
    try { loadSafe('a: &a x\nb: *a\n'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.name).toBe('YamlSafetyError');
  });
});
