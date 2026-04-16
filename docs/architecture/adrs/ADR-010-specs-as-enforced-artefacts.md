# ADR-010: Specs as First-Class Enforceable Artefacts

**Status:** Proposed
**Date:** 2026-04-16
**Depends on:** ADR-008 (Incremental Enforcement), DDD-001 (Contract Engine), DDD-002 (Enforcement Pipeline)

---

## Context

Specflow already enforces YAML contracts against source code. Narrative documentation — ADRs, PRDs, DDDs in `docs/architecture/` — is not enforced and decays independently of the code it describes. Today there is nothing preventing:

- A PR that changes domain code without updating the matching DDD.
- An ADR that documents a now-removed decision.
- A PRD whose acceptance criteria no longer match the implementation.

The repo's existing artefact set already implies a truth ranking: **executable contracts → ADRs → PRDs/DDDs**. Contracts are continuously validated; everything else relies on human discipline. A stale narrative doc is worse than a missing one — it looks authoritative while being wrong.

This ADR establishes the architectural shift: documentation is enforceable, not advisory. It is the foundation for ADR-011 (lifecycle states) and ADR-012 (link reciprocity).

---

## Decision

Documentation becomes a first-class enforceable artefact category in Specflow, alongside source code. Three concrete mechanisms:

1. **New contract type `spec_coupling`** — maps source-path globs to required doc-path globs. When source files matching a coupled glob change in a commit/PR, at least one doc matching the corresponding glob must also change. Enforced by `specflow enforce` and the existing post-commit / pre-push hooks. Implements practice 1.

2. **Truth hierarchy codified in `CLAUDE-MD-TEMPLATE.md`** — adds an explicit section: "When narrative docs and contracts disagree, contracts win. ADRs document decisions; PRDs/DDDs describe a moment in time. The contract YAML is the only artefact continuously verified against running code." Implements practice 3.

3. **Frontmatter substrate** — every doc under `docs/architecture/` gains a YAML frontmatter block (defined in ADR-011). The substrate is what makes 4–7 (links, snapshots, reviews, soft-deletes) implementable.

The contract engine itself does not change. `spec_coupling` is a new contract category consumed by the existing loader, evaluated against git diff state rather than file contents.

---

## Edge Cases and Resolutions

### E10-1: Doc-Only Commits

**Problem:** A commit that only edits docs would always pass `spec_coupling` (no source changes); a commit that only edits source needs the matching doc.

**Resolution:** `spec_coupling` is asymmetric — it fails only when source paths in a coupled glob are touched without the corresponding doc paths. Doc-only commits are unaffected.

### E10-2: Bulk Refactors and Mechanical Changes

**Problem:** A typo fix across 50 files in a coupled directory would require touching 50 docs.

**Resolution:** The contract supports a `severity` field (`error` / `warning`) and the existing override protocol (`override_contract: spec_coupling`). Mechanical refactors get a one-line override. Future: AST-diff coupling that distinguishes behaviour changes from cosmetic ones (deferred).

### E10-3: New Source Files With No Matching Doc

**Problem:** A new file in a coupled directory has no existing doc to update.

**Resolution:** The matching doc-glob can be a wildcard pattern; creating a new doc satisfies the rule. If no doc exists for a new feature area, the contract fails — author must either create the doc or override.

### E10-4: Generated, Vendored, or Migration Code

**Problem:** Generated code, vendored dependencies, and DB migrations don't have docs and shouldn't trigger coupling.

**Resolution:** `spec_coupling` rules use the existing `exclude_globs` syntax already supported by the contract engine.

### E10-5: Path Coupling vs Behaviour Coupling

**Problem:** Not every source change is a behaviour change worth documenting (formatting, comments, dependency bumps).

**Resolution:** Path-based coupling is a deliberate over-approximation. False positives are cheap to override; false negatives (silent decay) are expensive. Refinements like AST-diff coupling are deferred to a future ADR.

### E10-6: Coupling Against PRs vs Local Commits

**Problem:** A multi-commit PR might split a code change and a doc change across commits.

**Resolution:** `spec_coupling` evaluates against the diff scope `enforce` is given. Local pre-commit checks single commits; CI uses `--diff origin/main..HEAD` (existing flag from ADR-008) to evaluate the whole PR.

---

## Consequences

### Positive

- Source-doc divergence becomes a CI failure rather than honour-system discipline.
- The shift is implemented as a single new contract category — no engine rewrite.
- The codified truth hierarchy ends meta-debate about which artefact to trust.
- Frontmatter substrate unlocks ADRs 011-012 cheaply.

### Negative

- Adds friction to PRs that legitimately don't need doc updates → relies on the override protocol being lightweight in practice.
- Authors must learn what gets coupled to what (mitigated by `specflow doctor --docs` reporting).

### Neutral

- The contract engine is unchanged structurally — a new category, not a new mechanism.
- Migration is one-shot and scriptable (see ADR-011).
