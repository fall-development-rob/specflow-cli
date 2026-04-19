---
id: ADR-013
title: Correctness Hardening for Spec Integrity Toolkit
type: ADR
status: Accepted
version: 1
date: '2026-04-17'
last_reviewed: '2026-04-17'
implements:
  - ADR-010
  - ADR-011
  - ADR-012
implemented_by:
  - DDD-007
---

# ADR-013: Correctness Hardening for Spec Integrity Toolkit

---

## Context

A post-merge review of PR #13 (Spec Integrity Toolkit) found six correctness defects that together render the toolkit untrustworthy in production. Each one silently degrades the guarantee the toolkit is meant to provide — not a crash, not a loud failure, but a quiet pass where a failure was required.

1. **Practice 1 (code/spec coupling) is inert in production.** `gitDiffScope.parseFileList` resolves git's repo-relative output to absolute paths via `path.resolve(cwd, rel)`. Glob patterns in `spec_coupling` contracts are repo-relative (`ts-src/**/*.ts`). Absolute paths never match repo-relative globs, so every `spec_coupling` check passes vacuously regardless of what changed. The flagship enforcement of ADR-010 does nothing.

2. **Silent bypass on shallow clones, initial commits, and merge commits.** The default diff range `HEAD~1..HEAD` fails on the first commit of a repo, on merge commits (two parents), and on shallow clones where `HEAD~1` is not fetched. The surrounding `try/catch` swallows the error and returns an empty diff, which looks like "nothing changed" — so every rule passes. GitHub's `actions/checkout@v4` defaults to `fetch-depth: 1`; CI is the primary victim.

3. **Override directive is a global kill switch, not rule-scoped.** The regex `override_contract:\s*(spec_coupling|<contractId>)` matches any occurrence anywhere in a commit message — including inside quoted code blocks or unrelated discussion. Once matched, every coupling rule in the contract is demoted to a warning. There is no way to override a single rule (COUPLE-002) while keeping the others enforced, and there is no provenance on who authorised the override.

4. **Home-rolled `globToRegex` is wrong on common inputs.** It supports `*`, `**`, `?` and not much else. It does not expand braces (`*.{ts,tsx}` matches nothing), does not anchor path segments (`src/**/foo.ts` matches `srcbar/foo.ts`), has no dotfile handling, no extglob support, and no `!` negation. Every author who writes a "normal" glob gets a rule that silently matches nothing or — worse — matches too much.

5. **No atomic writes on any mutation path.** `snapshot-ledger.write`, `link-validator.writeDoc`, and the migration rewrite in `migrate-docs` all use `fs.writeFileSync` with a truncating open. A crash, signal, or ENOSPC mid-write leaves a truncated file on disk. Concurrent `snapshot` calls race on `versions.yml` with last-writer-wins and no detection.

6. **`--diff` syntax mismatch between docs and code.** The docs and existing CI examples use two-dot range syntax (`origin/main..HEAD`). The code takes a single ref and builds `${ref}...HEAD` (triple-dot symmetric difference), which returns the wrong file set for non-fast-forward branches. The documented CI invocation does not work as written.

In business terms: the toolkit currently gives false confidence. Contracts look enforced; they are not. CI looks green; it is not evaluating. Overrides look local; they are global. Files look written atomically; they are not. This ADR is the correctness floor the PR-13 architecture needs to actually deliver what ADR-010 promised.

---

## Decision

Five architectural decisions. They are cross-referenced — decisions 1, 2, and 3 cooperate at the diff-evaluation boundary; decisions 4 and 5 harden the input and output boundaries respectively.

### D13-1: Repo-relative path normalisation via a `DiffScope` value object

All coupling inputs are repo-relative. Absolute paths are forbidden at the domain boundary. `gitDiffScope` returns a `DiffScope` value object (see DDD-007) constructed via `DiffScope.fromGit(cwd, range)`, which:

- Runs `git rev-parse --show-toplevel` to find the repo root.
- Normalises every path git emits to a repo-relative POSIX-style string (forward slashes, no leading slash).
- Rejects any path that is absolute or escapes the repo root (`..` segments), treating them as a programming error, not a silent skip.

`CouplingEnforcer`, `CouplingMatcher`, and `DocumentRepository.getEnforceableDocs()` all compare repo-relative strings. `filterAccepted()` stops round-tripping through `path.resolve` and compares the repo-relative `doc.filePath` directly against the repo-relative diff entries.

### D13-2: Adopt `minimatch` as the authoritative glob implementation

The home-rolled `globToRegex` is deprecated and removed. `minimatch` (already transitively present in the dependency tree via multiple tools) becomes the canonical matcher with the following configured flags:

- `dot: true` — match dotfiles by default; coupling rules routinely target `.specflow/contracts/`.
- `nobrace: false` — brace expansion enabled so `*.{ts,tsx}` works as written.
- `matchBase: false` — never match a bare basename against a path-qualified glob.
- `nocase: false` — case-sensitive on all platforms; Windows NTFS may be case-insensitive but contracts are portable.
- `noglobstar: false` — `**` spans path segments.

The DDD-007 `CouplingMatcher` service is renamed to `GlobMatcher` and specifies `minimatch@^10` as the implementation. Any future swap must preserve the configured flag set.

### D13-3: Fail-loud policy on `gitDiffScope`

Silence is not a safe default for the code that gates CI. `gitDiffScope` runs a pre-flight inspection of the git environment and emits an explicit diagnostic when any of the degenerate conditions are detected. Pseudocode:

```
fn resolveRange(cwd, diffFlag, stagedFlag):
  if stagedFlag:
    return Staged                             # --cached

  if diffFlag:
    return TwoDotRange(diffFlag)              # see D13-4

  # Default path: last-commit range.
  isShallow        = git rev-parse --is-shallow-repository == "true"
  commitCount      = git rev-list --count HEAD
  parentCount      = git rev-list --parents -n 1 HEAD | count_parents
  mergeBase        = try: git merge-base HEAD HEAD~1

  if commitCount == 1:
    warn("initial commit — no previous revision")
    return FullTreeScan                        # evaluate entire repo against rules

  if parentCount >= 2:
    warn("merge commit has multiple parents — diff against first-parent only")
    return FirstParentRange("HEAD^1..HEAD")

  if isShallow AND mergeBase fails:
    if env.SPECFLOW_ALLOW_SHALLOW == "1":
      warn("shallow clone; falling back to full-tree scan")
      return FullTreeScan
    else:
      error("shallow clone prevents reliable diff; run with fetch-depth: 0 or set SPECFLOW_ALLOW_SHALLOW=1")
      exit nonzero

  return TwoDotRange("HEAD~1..HEAD")
```

Three explicit outcomes — first-parent range, full-tree scan, or fail — each with a visible log line. No silent empty diffs. The `try/catch` around `execSync` in `gitDiffScope` is narrowed to individual calls with typed errors, not a blanket suppression.

### D13-4: Two-dot `--diff` semantics, validated at parse time

`--diff <range>` takes a git range expression, not a single ref. Documented form: `<base>..<head>` (two dots, asymmetric, "files changed from base to head"). Single-ref input is rejected with a diagnostic suggesting `<ref>..HEAD`. Triple-dot symmetric difference is accepted only with an explicit `--diff-symmetric` flag added for completeness — the default semantics match what the PRD-010 CI example prescribes and what `git diff` users expect.

Validation rules (applied before invoking git):

- Must contain exactly one `..` and no `...` unless `--diff-symmetric` is set.
- Both sides must be non-empty and resolvable via `git rev-parse --verify`.
- Base must be an ancestor of head (`git merge-base --is-ancestor`) OR `--diff-allow-non-ancestor` is set.

### D13-5: Rule-scoped override directive with signed-override provenance note

The override directive is extended with a rule suffix:

```
override_contract: <contract_id>[:<rule_id>] [— justification text]
```

Matching rules:

- `override_contract: spec_coupling_core` overrides every rule in `spec_coupling_core`.
- `override_contract: spec_coupling_core:COUPLE-002` overrides only COUPLE-002; COUPLE-001, COUPLE-003 remain error-severity.
- Bare `override_contract: spec_coupling` (no contract id) **no longer matches**. The toolkit's flagship contract family name is not a valid override target — authors must name the actual contract id. Migration: doctor emits a one-time deprecation warning on the bare form for two releases.
- The regex is anchored to start-of-line (`^`) after a newline, so directives inside quoted code blocks or backtick spans do not match.

Provenance: when an override fires, the toolkit emits a `SignedOverride` record — `{ contractId, ruleId, author, commit, justification, timestamp }` — to `.specflow/override-log.jsonl`. The log is append-only and auditable. A future ADR may require GPG-signed commit enforcement; this ADR lays the data path.

---

## Edge Cases and Resolutions

### E13-1: Shallow Clones in CI

**Problem:** `actions/checkout@v4` defaults to `fetch-depth: 1`. `HEAD~1` does not exist. Original code silently returned empty.

**Resolution:** D13-3 pre-flight detects `git rev-parse --is-shallow-repository`. Default behaviour: exit non-zero with a message instructing the user to set `fetch-depth: 0` in their workflow. Escape hatch: `SPECFLOW_ALLOW_SHALLOW=1` falls back to a full-tree scan with a visible warning.

### E13-2: Initial Commit (No `HEAD~1`)

**Problem:** Brand-new repo, first commit ever. `HEAD~1..HEAD` fails.

**Resolution:** D13-3 detects `git rev-list --count HEAD == 1` and falls back to a full-tree scan — every tracked file is treated as "changed". This is correct semantically: on the initial commit, every file is new, so any coupling rule that matches the tree must also have a matching doc in the tree.

### E13-3: Merge Commits with Multiple Parents

**Problem:** `HEAD~1..HEAD` on a merge commit is ambiguous — which parent? git defaults to first-parent, but the user's mental model of "what changed in this commit" varies.

**Resolution:** D13-3 detects `parentCount >= 2` and uses the explicit first-parent form `HEAD^1..HEAD`. A warning is logged so the author knows which parent was chosen. Authors who want the other diff use `--diff <sha-of-other-parent>..HEAD`.

### E13-4: Git Rename Detection

**Problem:** A file renamed from `ts-src/old.ts` to `ts-src/new.ts` appears under `--diff-filter=ACMR` but the matcher sees only the new name; a coupling rule targeting the old path can fire on a rename that should be a no-op.

**Resolution:** `gitDiffScope` passes `-M` to `git diff` and requests `--name-status`, parsing rename records (`R100\told\tnew`). Both old and new paths are added to the diff file set; coupling rules that match either end of the rename are evaluated with the rename flagged. Authors can use `exclude_globs` or the rule-scoped override to suppress rename-driven false positives.

### E13-5: Windows Backslash Paths

**Problem:** On Windows, git may emit backslash-separated paths (depending on `core.quotepath` and terminal). Glob patterns use forward slashes. The existing `f.replace(/\\/g, '/')` is applied only inside `matchGlobs` after absolute-path resolution has already mangled things.

**Resolution:** `DiffScope.fromGit` normalises to POSIX-style separators at the value-object boundary. All downstream code sees forward slashes only. `path.sep`-aware joins are confined to the `DocumentWriter` adapter (see DDD-007) which converts at the filesystem boundary.

### E13-6: Filenames with Spaces, Quotes, or Non-ASCII

**Problem:** Git's default output may quote paths containing spaces, non-ASCII, or control characters (`"sp\\303\\266cial.ts"`) unless `core.quotepath=false` is set. The current line-split-and-trim pipeline mis-parses these.

**Resolution:** `DiffScope.fromGit` invokes git with `-c core.quotepath=false` and uses `-z` (NUL-separated output) where supported, splitting on `\0` rather than `\n`. Spaces, quotes, and unicode flow through verbatim.

### E13-7: Stale `COMMIT_EDITMSG`

**Problem:** In staged mode, the code reads `.git/COMMIT_EDITMSG` to discover the override directive. That file is whatever git last wrote there — a previous `git commit --amend` dialog, a cancelled commit, or a merge message from three commits ago. The override directive is evaluated against stale text.

**Resolution:** `DiffScope.fromGit` treats `COMMIT_EDITMSG` as authoritative only when invoked from inside an active `prepare-commit-msg` or `commit-msg` hook (detected via `GIT_EDITOR`/env). Otherwise the commit-message source is the `--message` flag passed explicitly by the caller. When neither signal is present, `commitMessages` is empty and overrides cannot fire.

### E13-8: Multi-Line Override Directives in Commit Bodies

**Problem:** Authors write override directives on the second line of a commit body; or they paste a quoted commit message that contains the directive; or they open a markdown code fence and the directive appears inside it.

**Resolution:** D13-5's anchored regex (`^override_contract:` at start of a line, after newline) accepts multi-line bodies but rejects matches inside fenced code blocks. The parser pre-processes the commit message: it strips ``` ``` ``` and `~~~` fences before applying the directive regex. Multiple directives in one message are all honoured (rule-by-rule scoping), recorded in the provenance log in order of appearance.

---

## Consequences

### Positive

- `spec_coupling` actually runs in CI — the flagship enforcement promise of ADR-010 is delivered rather than merely declared.
- Silent-pass failure modes are converted to loud-fail or explicit-fallback, restoring operator trust in green builds.
- Rule-scoped overrides let authors disable a single noisy rule without disabling the contract family, preserving enforcement on the rules that still apply.
- `minimatch` eliminates a class of glob bugs that would otherwise recur every time an author writes a "normal" pattern.
- Atomic writes (delegated to DDD-007's `DocumentWriter` port) remove a torn-file failure mode from every mutation path in the toolkit.

### Negative

- Breaking change to the `--diff` flag semantics: existing hooks and CI pipelines that pass a single ref will fail until updated. Mitigated by the parse-time diagnostic that suggests the correct form.
- Breaking change to the bare `override_contract: spec_coupling` form. Two-release deprecation window, but any commit relying on the bare form will eventually stop being honoured.
- `minimatch` adds a direct dependency where there was none; package size grows by ~30KB.
- Rule-scoped overrides increase the cardinality of override identifiers authors must know.

### Neutral

- `DiffScope` becomes the canonical boundary type; future features that reason about diffs have a single input shape to target.
- The `DocumentWriter` port (DDD-007) is reusable beyond this ADR — any future command that mutates docs goes through the same atomic path.
- Pre-flight git inspection adds two or three `git rev-parse` calls per invocation; negligible on local, negligible in CI.
- The signed-override log is a stepping stone to a future ADR requiring commit-signing for overrides.
