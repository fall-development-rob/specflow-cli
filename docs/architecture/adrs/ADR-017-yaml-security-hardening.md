---
id: ADR-017
title: YAML Parsing Security Hardening
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-011
implemented_by:
  - PRD-011
---

# ADR-017: YAML Parsing Security Hardening

---

## Context

The v1 spec-integrity toolkit uses `js-yaml` to parse two kinds of
untrusted-ish YAML: frontmatter blocks in `docs/architecture/**/*.md`
and the snapshot ledger at `docs/architecture/versions.yml`. A review
of the parser surface produced four findings, each a real risk:

1. **Anchors and aliases are active by default.** `js-yaml.load`
   uses the `DEFAULT_SCHEMA` which resolves anchors. A maliciously
   crafted frontmatter can trigger the classic "billion laughs" DoS
   by expanding a chain of aliases. Review tooling runs in CI on
   branch tips; a PR can ship such a payload.

2. **Duplicate keys are silently last-wins.** `js-yaml` does not
   warn when the same key appears twice in a mapping — later
   occurrences overwrite earlier ones. This lets an author hide a
   `status: Draft` behind a visually-first `status: Accepted` and
   satisfy superficial review while defeating enforcement.

3. **Prototype pollution via ledger tag keys.** The snapshot ledger
   indexes entries by release tag (for example `v1.2.0`). If a tag
   matches `__proto__`, `constructor`, or `prototype`, the plain
   object used as the root map pollutes `Object.prototype` the moment
   `ledger[tag] = entry` executes. Any subsequent code in the same
   process reads attacker-controlled data from every plain object.

4. **Frontmatter↔body drift uncaught.** ADR-010's own body carried
   `**Status:** Proposed` while its frontmatter reported
   `status: Accepted`. The toolkit built to catch narrative-code
   drift failed to catch frontmatter-narrative drift on its own
   docs. Reviewers skim the body; enforcement reads the frontmatter;
   the two disagree silently.

Findings 1-3 are security issues; finding 4 is an integrity issue
that the toolkit was specifically commissioned to prevent. All four
are addressed together because they share a single remediation
surface: the YAML parsing wrapper.

---

## Decision

Four rules land in a single hardening slice (PRD-011 S6).

### 1. FAILSAFE Schema for Untrusted YAML

All frontmatter parsing and all ledger parsing switch from the default
`js-yaml` schema to `FAILSAFE_SCHEMA`. FAILSAFE accepts only strings,
sequences, and mappings; it rejects anchors, aliases, implicit type
coercion (including `Date`, `boolean`, `null`, `number`), and custom
tags.

Typed coercion becomes the responsibility of a thin parser wrapper:

```typescript
// ts-src/lib/safe-yaml.ts — conceptual
import yaml from 'js-yaml';

export function parseFrontmatter(raw: string): Frontmatter {
  const tree = yaml.load(raw, {
    schema: yaml.FAILSAFE_SCHEMA,
    onWarning: (e) => { throw e; },
  });
  return coerceFrontmatter(tree);   // explicit Date / number / boolean
}
```

Benefits:

- Billion-laughs is structurally impossible — no alias resolution
  exists in FAILSAFE.
- Attack surface reduces to exactly the types the schema exposes.
- Date/number coercion moves to a reviewable wrapper rather than the
  YAML parser's implicit rules.

### 2. Reject Duplicate Keys

The wrapper passes `onWarning` to `js-yaml.load` and re-throws any
warning. Duplicate-key warnings become parse errors. The wrapper
also performs a second-pass validation: after parsing, it re-scans
the raw text for duplicate top-level keys using a line-oriented
regex and refuses to load if any are found. The belt-and-braces
pairing is intentional because `js-yaml`'s duplicate-key warning
behaviour has historically varied across versions.

Affected files: every doc frontmatter; `docs/architecture/versions.yml`.

### 3. Prototype-Safe Ledger Writes

The snapshot ledger moves from a plain object literal to either a
`Map` or `Object.create(null)`. Both eliminate the `__proto__` escape
hatch because neither inherits from `Object.prototype`.

Additionally, tag-key validation rejects any tag name matching the
regex `/^(__proto__|constructor|prototype)$/`. A tag matching the
deny-list produces a `ProtoKeyRejected` error before any map write
is attempted.

```typescript
// Conceptual
const DENY = /^(__proto__|constructor|prototype)$/;

function setEntry(ledger: Map<string, Entry>, tag: string, entry: Entry) {
  if (DENY.test(tag)) throw new ProtoKeyRejectedError(tag);
  ledger.set(tag, entry);
}
```

Serialisation back to YAML uses `Object.fromEntries(ledger)` right
before the final dump, preserving the disk format.

### 4. Frontmatter↔Body Consistency Check

`specflow doctor --docs` gains a body-consistency check that runs
after frontmatter parsing. For each doc under `docs/architecture/`:

- Grep the body (post-frontmatter) for `**Status:** <value>`,
  `**Date:** <value>`, and `**Depends on:** <list>` lines — the
  legacy header conventions.
- Compare each found value to the frontmatter:
  - `**Status:**` value must equal `frontmatter.status`.
  - `**Date:**` value must equal `frontmatter.date`.
  - `**Depends on:**` IDs (regex `(ADR|PRD|DDD)-\d{3}`) must be a
    subset of `frontmatter.implements`.
- Any mismatch is an error (not a warning). The check fails
  `doctor --docs` with a `BodyFrontmatterDriftError`.

This is the rule that would have caught the ADR-010 drift. It is the
most mechanically simple of the four and the most operationally
important.

---

## Edge Cases and Resolutions

### E17-1: FAILSAFE Breaks Existing String Coercion

**Problem:** Existing frontmatter uses `date: 2026-04-16` without
quotes. `DEFAULT_SCHEMA` parses this as a JS `Date`; `FAILSAFE_SCHEMA`
parses it as a string. Code that did `fm.date.toISOString()` now
crashes.

**Resolution:** The explicit coercion wrapper converts ISO-date
strings using `new Date(fm.date)` with strict format validation
(`^\d{4}-\d{2}-\d{2}$`). Any frontmatter that authored dates as
unquoted YAML timestamps is re-serialised as quoted strings during
migration. The coercion wrapper is the only code path allowed to
instantiate `Date` from YAML input.

### E17-2: Ledger Migration from Plain-Object Format

**Problem:** `versions.yml` authored under the old code is a plain
YAML mapping. Moving to `Map` changes internal representation; disk
format should stay the same.

**Resolution:** On disk, the ledger remains a plain YAML mapping. The
migration is in-memory only: `yaml.load` → `Object.entries` →
`new Map(entries)` → typed operations → `Object.fromEntries(map)` →
`yaml.dump`. Disk compatibility is preserved; runtime prototype
pollution is eliminated.

### E17-3: Body Lines Intended as Historical Record

**Problem:** A doc intentionally quotes `"**Status:** Deprecated"`
as part of a narrative ("we previously marked this Deprecated in
2025"). The body-consistency check flags it.

**Resolution:** The grep is anchored to the beginning of a line and
rejects matches inside fenced code blocks. Any `**Status:**` inside
a backtick-code-fence is skipped. For inline body quotation outside
code blocks, authors escape with a leading backslash
(`\**Status:** Deprecated`) which the grep treats as literal. A
dedicated `<!-- specflow-ignore:body-drift -->` comment above the
line also suppresses the check on the following line only.

### E17-4: Legacy `**Depends on:**` Still Present After Migration

**Problem:** `specflow migrate-docs` populated `implements:` but left
the `**Depends on:**` line in the body. The body check then flags the
body line as redundant even though values agree.

**Resolution:** The body-consistency check treats exact-match
redundancy (frontmatter and body agree) differently from mismatch:
- Exact match + frontmatter covers the same IDs: warning, suggests
  deletion during review.
- Mismatch: error, fails `doctor --docs`.

The DOC-003 invariant in `doc_body_consistency.yml` upgrades the
warning to an error once migration is complete.

### E17-5: Markdown Code Blocks Containing `**Status:**`-like Text

**Problem:** A doc has a fenced code block demonstrating YAML
frontmatter; the block contains `**Status:** Accepted` as sample
output.

**Resolution:** The grep ignores fenced code blocks (both ```` ``` ````
and ```` ~~~ ```` fences) by maintaining a state machine that toggles
on fence open/close. HTML comments
(`<!-- -->`) and indented code blocks (4+ leading spaces) are also
skipped. The implementation is a line-oriented scanner, not a regex
over the whole body.

---

## Consequences

### Positive

- The three security findings (billion-laughs, duplicate-key
  last-wins, prototype pollution) have closed-form fixes landing
  together.
- The body-consistency check directly prevents the class of drift
  that motivated the entire toolkit — and caught by the toolkit on
  its own docs.
- FAILSAFE schema means future YAML consumers in Specflow inherit a
  hardened default; unsafe parsing requires explicit opt-in.

### Negative

- FAILSAFE breaks every code path that relied on implicit YAML type
  coercion. Migration is mechanical but not zero-cost (E17-1).
- The body-consistency check creates a new class of CI failures on
  legacy docs until they are cleaned up. Mitigated by the warning
  -> error transition path (E17-4).
- Duplicate-key rejection changes parser behaviour from "last-wins"
  to "fail". Any doc that relied on last-wins (if any exist) must be
  cleaned up.

### Neutral

- `Map` vs plain-object is an internal representation change;
  serialised disk format is unchanged.
- The hardened wrapper becomes the single point of entry for all
  untrusted YAML; future threats against YAML parsers are handled in
  one file.
- The body-consistency rule is expressed as an invariant contract
  (`doc_body_consistency.yml`) — the enforcement surface that
  Specflow was built for.
