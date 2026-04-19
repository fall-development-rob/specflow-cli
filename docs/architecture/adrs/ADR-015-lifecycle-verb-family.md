---
id: ADR-015
title: Lifecycle Verb Family — specflow doc
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-011
  - ADR-014
implemented_by:
  - DDD-008
  - PRD-010
---

# ADR-015: Lifecycle Verb Family — `specflow doc`

---

## Context

The Spec Integrity Toolkit is a linter for a thing nobody has a convenient way to edit. Every operation it reports — "overdue", "should be Superseded", "missing reciprocal link" — resolves to a manual YAML edit. The quarterly review pass (PRD-010) requires hand-stamping `last_reviewed` across 29 frontmatter blocks. Marking an ADR as superseded requires two coordinated edits (`Superseded` + `superseded_by` on the old doc, and `implemented_by`-style acknowledgement on the new one) with no atomic enforcement — a commit landing with only half the pair is valid YAML and passes the schema check.

`specflow review`'s "ORPHANED: suggest Status: Deprecated" output is a direction, not a verb. The reviewer still has to:

1. Open the file.
2. Change `status: Accepted` to `status: Deprecated`.
3. Add `deprecation_note: <reason>`.
4. Bump `version`.
5. Re-stamp `last_reviewed`.
6. Hope they didn't forget one of the above.

The toolkit has the entity (ADR-014) and the lifecycle (ADR-011) and the validation (PRD-010). It is missing the verbs.

---

## Decision

Ship the `specflow doc` verb family. Each verb executes a single, named lifecycle transition through `Document.transitionTo` (ADR-014), writes atomically through the `DocumentWriter` port (ADR-013), mirrors reciprocal links where applicable, and appends an audit entry to `.specflow/audit-log.yml`.

### Verbs

#### `specflow doc accept <id>`

```bash
specflow doc accept ADR-014
```

Transitions `Draft → Accepted`. Validates that required Accepted-status fields are present (title, date, implements or `--allow-orphan`). Stamps `last_reviewed: <today>` and bumps `version` to 1 if it was 0.

#### `specflow doc supersede <id> --by <newId> [--note <s>]`

```bash
specflow doc supersede ADR-007 --by ADR-018
specflow doc supersede PRD-006 --by PRD-009 --note "Replaced after scope change"
```

Transitions `Accepted → Superseded` atomically with a successor cross-check:

- `<newId>` must exist in the repository and must be in status `Accepted` (or `Draft` with `--allow-draft-successor`, discouraged).
- Sets `superseded_by: <newId>` on the old doc.
- Appends the old doc's id to the new doc's `implemented_by` if not already present (reciprocal mirror).
- Bumps `version`, stamps `last_reviewed`, attaches `--note` as a comment in the audit entry.

#### `specflow doc deprecate <id> --note <s>`

```bash
specflow doc deprecate PRD-005 --note "Knowledge embedding superseded by knowledge graph; no direct successor."
```

Transitions `Accepted → Deprecated` or `Deprecated → Deprecated` (note-only update). `--note` is required — deprecation without a reason is forbidden. Sets `deprecation_note`, bumps `version`, stamps `last_reviewed`.

#### `specflow doc bump <id>`

```bash
specflow doc bump ADR-011
```

Increments `version` and stamps `last_reviewed: <today>`. No status change. Intended for material edits where the author wants the version bump but not a full transition (e.g., added an edge case, rewrote a section).

#### `specflow doc stamp [--overdue | --id <id>...]`

```bash
specflow doc stamp --overdue          # Stamp every doc with last_reviewed > 90 days
specflow doc stamp --id ADR-003 --id ADR-004
```

Re-dates `last_reviewed` without bumping `version` — for the quarterly review pass. Interactive by default: prints the impacted set and prompts for confirmation. `--yes` skips the prompt. `--overdue` is the primary calling convention during the quarterly sweep.

#### `specflow doc revive <id>`

```bash
specflow doc revive PRD-005
```

Transitions `Deprecated → Accepted`. Clears `deprecation_note`, bumps `version`, stamps `last_reviewed`. Forbidden for Superseded docs (per ADR-011/ADR-014) — the matrix rejects it at the entity boundary; the command surfaces the TransitionError.

### Behavioural Contract

Every verb performs the same six-step sequence:

1. **Load the entity** through the `DocumentRegistry` (DDD-008). Aborts with `UnknownIdError` if `<id>` is not known.
2. **Call `transitionTo`** (ADR-014) to guard the transition. Aborts with `TransitionError` on a forbidden or no-op transition.
3. **Write atomically** via the `DocumentWriter` port (ADR-013). No partial writes; a crash mid-command leaves the file either fully updated or fully untouched.
4. **Mirror reciprocal links** where applicable — `supersede` updates the successor's `implemented_by`; `accept` populates missing reciprocals on docs listed in `implements`. The mirror is part of the same atomic write batch; if it fails, the primary write is rolled back.
5. **Emit a one-line audit entry** to `.specflow/audit-log.yml`:
   ```yaml
   - ts: 2026-04-17T14:22:03Z
     verb: supersede
     id: ADR-007
     from: Accepted
     to: Superseded
     by: ADR-018
     reason: "Replaced after scope change"
     actor: cli
   ```
6. **Exit non-zero on any step failing.** Prints a one-line summary on success. `--json` emits the audit entry to stdout for scripting.

Every verb accepts `--yes` to bypass interactive confirmation and `--dry-run` to print the planned mutation without writing.

---

## Edge Cases and Resolutions

### E15-1: `<id>` Not Found

**Problem:** `specflow doc accept ADR-099` where ADR-099 does not exist.

**Resolution:** Registry lookup fails with `UnknownIdError`. Command exits 2 with a one-line error and suggests the nearest id match (Levenshtein distance ≤ 2) if any.

### E15-2: Already in Target Status

**Problem:** `specflow doc accept ADR-014` when ADR-014 is already Accepted.

**Resolution:** `transitionTo` rejects same-status transitions as a no-op (per ADR-014). Verb exits 0 with a one-line "nothing to do". Not an error — quarterly-sweep scripts should be re-runnable.

### E15-3: Successor Not Yet Accepted

**Problem:** `specflow doc supersede ADR-007 --by ADR-018` when ADR-018 is still Draft.

**Resolution:** Verb exits 2 with `MissingSuccessorError: ADR-018 must be Accepted before superseding ADR-007`. The escape hatch is `--allow-draft-successor`, which demotes the check to a warning; CI should forbid this flag in protected branches.

### E15-4: `bump` With No Material Edit

**Problem:** A user runs `specflow doc bump ADR-011` to look busy, but the file has no uncommitted changes.

**Resolution:** `bump` refuses to run on a doc whose git status is unmodified unless `--force` is given. The rationale: a version bump without a content change is noise. The audit entry records the `--force` usage so the review loop can surface gratuitous bumps.

### E15-5: `stamp` Without Confirmation

**Problem:** An agent in a non-interactive context runs `specflow doc stamp --overdue` and waits forever at the confirmation prompt.

**Resolution:** When stdin is not a TTY, the command refuses to prompt and exits 2 with a hint: "rerun with --yes to confirm in non-interactive mode". `--yes` is a conscious opt-in; the default is safe.

### E15-6: Concurrent Verb Invocations

**Problem:** Two `specflow doc` invocations mutate the same file at the same time.

**Resolution:** `DocumentWriter` acquires a per-file advisory lock (`.specflow/.locks/<id>.lock`) for the duration of the write. Second invocation returns `ConcurrentMutationError` and the user reruns. No silent clobbering; no file-level race.

### E15-7: `supersede` Circular Chains

**Problem:** User runs `specflow doc supersede ADR-018 --by ADR-007`, then `specflow doc supersede ADR-007 --by ADR-018`.

**Resolution:** The verb walks `superseded_by` forwards from `<newId>` and refuses if the walk reaches `<id>`. `CircularSupersessionError` is raised before any write. Covers both direct (A → B → A) and transitive (A → B → C → A) cycles.

### E15-8: Interactive Confirmation Via `--yes` Bypass

**Problem:** `--yes` disables confirmation globally; automation scripts can accidentally run destructive stamps against every doc in the repo.

**Resolution:** `--yes` suppresses the prompt but does not suppress the pre-write diff print. The operator always sees the list of affected docs in the command output, even when not prompted. Pair this with a mandatory `--overdue` or `--id` scope on `stamp` — there is no `specflow doc stamp --all`; the closest equivalent is `--overdue`, which is a bounded, meaningful set.

---

## Consequences

### Positive

- The verbs make spec hygiene a one-line command. Quarterly review collapses from 29 hand-edits to `specflow doc stamp --overdue`.
- Every mutation passes through `transitionTo`; the lifecycle becomes impossible to violate by accident.
- The audit log is grep-able history of every status change, eliminating a class of "when did this get deprecated" archaeology.
- Reciprocal-link mirroring in `supersede` removes the "two coordinated edits" failure mode.

### Negative

- Seven new subcommands to document, test, and maintain. Bounded; each verb is a thin wrapper around `transitionTo`.
- `.specflow/audit-log.yml` grows unbounded. Acceptable in practice — one line per mutation, dozens per quarter. A future `specflow doc audit --prune` can trim if needed.
- Interactive prompts add friction to scripting. Mitigated by `--yes`; the design deliberately makes the unsafe path opt-in.

### Neutral

- The verb family is a natural home for future lifecycle extensions (`specflow doc restore`, `specflow doc fork`) without further CLI-shape changes.
- Aligns with the verb-family pattern already present in the CLI (`specflow contract create`, `specflow agent search`, `specflow mcp register`).
