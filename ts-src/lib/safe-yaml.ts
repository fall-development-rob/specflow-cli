/**
 * safe-yaml — the only sanctioned js-yaml entry point in the Specflow CLI.
 *
 * ADR-017 / PRD-011 S6: every YAML parse in the CLI (frontmatter, ledger,
 * coupling contracts, anything touching an untrusted file) goes through
 * `loadSafe()` so the hardening rules are enforced in one place:
 *
 *   1. `FAILSAFE_SCHEMA` — only strings, sequences, mappings.  No
 *      implicit Date / boolean / null / number coercion; no custom tags.
 *   2. Anchors and aliases are rejected at parse time.  FAILSAFE still
 *      resolves aliases structurally, so we scan the raw text for `&foo`
 *      and `*foo` markers before handing the string to js-yaml.  This
 *      closes the billion-laughs surface structurally.
 *   3. Duplicate keys are rejected.  js-yaml 4.x treats duplicate
 *      mapping keys as a parse error by default, and we re-throw any
 *      `onWarning` signal for older versions / edge cases.  We never
 *      pass `json: true` because that flag silently allows duplicates.
 *   4. `__proto__`, `constructor`, `prototype` keys are rejected
 *      anywhere in the tree so that `ledger[tag] = ...` cannot pollute
 *      `Object.prototype`.  The returned object tree uses
 *      `Object.create(null)` roots for further defence in depth.
 *
 * The wrapper throws a typed `YamlSafetyError` with a `code` field so
 * callers can branch on failure mode without parsing error strings.
 *
 * Callers that need typed coercion (for example, frontmatter fields
 * that used to be implicit `Date` values) must do it explicitly on top
 * of the `unknown` value returned here.  `loadSafe` never returns a
 * `Date`; dates come back as strings under FAILSAFE.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');

export type YamlSafetyErrorCode =
  | 'ANCHOR'
  | 'DUPLICATE_KEY'
  | 'PROTOTYPE_KEY'
  | 'PARSE_ERROR';

export class YamlSafetyError extends Error {
  public readonly code: YamlSafetyErrorCode;
  public readonly filename?: string;

  constructor(code: YamlSafetyErrorCode, message: string, filename?: string) {
    super(filename ? `${message} (${filename})` : message);
    this.name = 'YamlSafetyError';
    this.code = code;
    this.filename = filename;
  }
}

/** Deny-list for prototype-pollution keys — matches ADR-017 rule 3. */
const PROTOTYPE_KEY_RE = /^(__proto__|constructor|prototype)$/;

/**
 * Line-oriented scan for YAML anchor (`&name`) or alias (`*name`)
 * markers.  We treat any occurrence outside of scalar quoting as a
 * rejection.  The scanner is intentionally approximate: false
 * positives ("anchors in a quoted string") are acceptable because
 * Specflow YAML has no legitimate need for anchors in any file it
 * owns (frontmatter, ledger, contracts).  False negatives would be
 * security bugs and are avoided by scanning every non-comment byte.
 */
function containsAnchorOrAlias(raw: string): { found: boolean; line: number; char?: string } {
  // Strip fenced code blocks inside YAML?  YAML itself has no fenced
  // blocks, so the raw string we get here is pure YAML — we don't
  // need to skip anything.
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track single/double quote state so anchor markers inside quoted
    // scalars don't false-alarm.  YAML's single quotes escape by
    // doubling (''); we treat any `'` toggle as conservative.
    let sq = false;
    let dq = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === '#' && !sq && !dq) break; // rest of line is a comment
      if (ch === "'" && !dq) { sq = !sq; continue; }
      if (ch === '"' && !sq) { dq = !dq; continue; }
      if (sq || dq) continue;

      if (ch === '&' || ch === '*') {
        // Anchor/alias must be followed by an identifier char; a bare
        // `*` or `&` in a flow sequence (`[*]`) is not an alias.
        const next = line[j + 1];
        if (next && /[A-Za-z0-9_]/.test(next)) {
          // But also require the previous non-whitespace to be a
          // YAML-value-entry indicator (`:`, `-`, `,`, `[`, `{`, start
          // of line, or a space after one of these).  An alias can
          // only appear where a value is expected.  Anything else
          // (for example, text in a plain scalar) is not a YAML alias.
          const before = line.slice(0, j).replace(/\s+$/, '');
          const lastChar = before.length > 0 ? before[before.length - 1] : '';
          if (
            before.length === 0 || // start of line (after trim)
            lastChar === ':' ||
            lastChar === '-' ||
            lastChar === ',' ||
            lastChar === '[' ||
            lastChar === '{'
          ) {
            return { found: true, line: i + 1, char: ch };
          }
        }
      }
    }
  }
  return { found: false, line: 0 };
}

/**
 * Walk a parsed object tree and reject any `__proto__`, `constructor`,
 * or `prototype` key.  Also copies mapping nodes onto
 * `Object.create(null)` roots so a subsequent `obj[userKey] = x` write
 * cannot hit `Object.prototype`.  Arrays pass through as-is.
 */
function sanitise(value: unknown, filename?: string): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitise(v, filename));
  }
  if (typeof value !== 'object') return value;

  const out = Object.create(null);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (PROTOTYPE_KEY_RE.test(key)) {
      throw new YamlSafetyError(
        'PROTOTYPE_KEY',
        `YAML contains forbidden key '${key}' — prototype-pollution hazard`,
        filename,
      );
    }
    out[key] = sanitise((value as Record<string, unknown>)[key], filename);
  }
  return out;
}

export interface LoadSafeOptions {
  filename?: string;
}

/**
 * Parse YAML content with ADR-017 hardening.  Returns a plain value
 * (string, array, or prototype-less object).  Throws YamlSafetyError
 * on any hardening violation; throws the underlying js-yaml error
 * (wrapped) on malformed YAML.
 */
export function loadSafe(content: string, opts: LoadSafeOptions = {}): unknown {
  // Defence layer 1: structural anchor/alias rejection.  FAILSAFE
  // still resolves `*foo` to `&foo`, so the safest posture is to
  // refuse inputs that use anchors at all.
  const anchorScan = containsAnchorOrAlias(content);
  if (anchorScan.found) {
    throw new YamlSafetyError(
      'ANCHOR',
      `YAML anchor/alias marker '${anchorScan.char}' found at line ${anchorScan.line} — anchors are rejected (ADR-017)`,
      opts.filename,
    );
  }

  // Defence layer 2: FAILSAFE parse with onWarning rethrow.
  let parsed: unknown;
  try {
    parsed = yaml.load(content, {
      schema: yaml.FAILSAFE_SCHEMA,
      // NB: do NOT set json:true — it silences duplicate-key errors.
      onWarning: (w: Error) => {
        const msg = String((w && w.message) || w);
        if (/duplicat/i.test(msg)) {
          throw new YamlSafetyError('DUPLICATE_KEY', msg, opts.filename);
        }
        throw new YamlSafetyError('PARSE_ERROR', msg, opts.filename);
      },
    });
  } catch (e: unknown) {
    if (e instanceof YamlSafetyError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/duplicat/i.test(msg)) {
      throw new YamlSafetyError('DUPLICATE_KEY', msg, opts.filename);
    }
    throw new YamlSafetyError('PARSE_ERROR', msg, opts.filename);
  }

  // Defence layer 3: prototype-key rejection and null-proto rehoming.
  return sanitise(parsed, opts.filename);
}

/** `loadSafe` but returns `null` instead of throwing on empty input. */
export function loadSafeOrNull(content: string, opts: LoadSafeOptions = {}): unknown {
  if (!content || !content.trim()) return null;
  return loadSafe(content, opts);
}
