# PRD-009: Contract Packages

**Status:** Proposed
**Date:** 2026-04-05
**Phase:** 11e
**Depends on:** Phase 2 (CLI Rewrite), DDD-001 (Contract Engine)

---

## Overview

Shareable, versioned contract packages distributed via npm. Organizations can publish curated contract sets (e.g., `@specflow/react`, `@specflow/security`) and projects can install them with a single command. Contracts are copied locally for offline enforcement.

See [ADR-009](../adrs/ADR-009-contract-packages.md) for the architectural decision and [DDD-006](../ddds/DDD-006-contract-packages.md) for the domain model.

---

## Goals

1. **Enable sharing** — Organizations publish contract sets as npm packages
2. **Version management** — Semantic versioning via npm, lock file for reproducibility
3. **Offline enforcement** — Contracts copied locally, no network needed at enforce time
4. **Conflict safety** — Duplicate rule IDs detected and resolved deterministically

## Non-Goals

1. **Custom registry** — Use npm, not a Specflow-specific registry
2. **Auto-update** — Packages update explicitly via `specflow update-packages`
3. **Remote enforcement** — All enforcement remains local

---

## Commands

### `specflow add <package>`

Install a contract package.

```bash
specflow add @specflow/react
specflow add @specflow/security@2.0.0
```

**Behavior:**
1. Run `npm install <package>` (adds to project dependencies).
2. Scan `node_modules/<package>/package.json` for `specflow` field.
3. If no `specflow` field: error "Package is not a Specflow contract package."
4. Discover transitive Specflow dependencies (scan `specflow.dependencies`).
5. For each discovered package:
   a. Check for rule ID conflicts with user contracts and other packages.
   b. Copy contracts from `node_modules/<pkg>/<specflow.contracts>/` to `.specflow/packages/<pkg>/`.
   c. Add entry to `.specflow/packages.json`.
6. Report: "Installed 2 packages, 8 contracts. No conflicts."

**Acceptance Criteria:**
- [ ] Installs package and copies contracts to `.specflow/packages/`
- [ ] Creates/updates `.specflow/packages.json`
- [ ] Detects and installs transitive Specflow dependencies
- [ ] Errors on rule ID conflict between packages
- [ ] Warns when user contract shadows package contract (user wins)
- [ ] Non-Specflow package (no `specflow` field) shows clear error

### `specflow remove <package>`

Remove a contract package.

```bash
specflow remove @specflow/react
```

**Behavior:**
1. Delete `.specflow/packages/<package>/` directory.
2. Remove entry from `.specflow/packages.json`.
3. Does NOT run `npm uninstall` — user manages their own `package.json`.
4. Report: "Removed @specflow/react (2 contracts)."

**Acceptance Criteria:**
- [ ] Deletes package directory from `.specflow/packages/`
- [ ] Updates `.specflow/packages.json`
- [ ] Does not modify `package.json` or `node_modules`
- [ ] Removing non-installed package shows "Package not installed"

### `specflow update-packages`

Update all installed packages from `node_modules`.

```bash
specflow update-packages
```

**Behavior:**
1. Read `.specflow/packages.json`.
2. For each package: check version in `node_modules`.
3. If version differs: re-copy contracts, update lock file.
4. If package missing from `node_modules`: warn "Package '@specflow/react' not in node_modules. Run 'npm install' first."
5. Re-check for rule ID conflicts after update.
6. Report: "Updated 1 package. 1 skipped (missing from node_modules)."

**Acceptance Criteria:**
- [ ] Updates changed packages, skips unchanged
- [ ] Warns on missing node_modules packages
- [ ] Re-checks rule ID conflicts after update
- [ ] Updates version in `.specflow/packages.json`

### `specflow publish`

Publish current project's contracts as an npm package.

```bash
specflow publish
specflow publish --dry-run
```

**Behavior:**
1. Check `.specflow/contracts/` has at least one contract.
2. If no `package.json` in `.specflow/`: scaffold one with `specflow` field.
3. Validate all contracts (regex compiles, schema valid).
4. Run `npm publish` (or `--dry-run` for preview).
5. Report: "Published @myorg/specflow-rules@1.0.0 with 5 contracts."

**Acceptance Criteria:**
- [ ] Scaffolds `package.json` with `specflow` field if missing
- [ ] Validates all contracts before publishing
- [ ] `--dry-run` shows what would be published without actually publishing
- [ ] Reports package name, version, and contract count

### `specflow search <query>` (Future)

Search npm for Specflow contract packages.

```bash
specflow search react
```

Searches npm with keyword `specflow-contracts` and filters results with `specflow` field. Deferred to post-v1.0.

---

## Package Format

### `package.json` Structure

```json
{
  "name": "@specflow/react",
  "version": "1.0.0",
  "description": "Specflow contracts for React best practices",
  "keywords": ["specflow", "specflow-contracts", "react"],
  "specflow": {
    "contracts": "contracts/",
    "dependencies": ["@specflow/typescript"]
  },
  "files": ["contracts/"],
  "license": "MIT"
}
```

### Contract File Layout

```
@specflow/react/
  package.json
  contracts/
    feature_react_hooks.yml
    feature_react_performance.yml
    README.md              # Optional: package documentation
```

### `.specflow/packages.json` Format

```json
{
  "version": 1,
  "packages": {
    "@specflow/react": {
      "version": "1.0.0",
      "source": "npm",
      "installedAt": "2026-04-05T10:00:00Z",
      "contractCount": 2,
      "ruleIds": ["REACT-001", "REACT-002"]
    },
    "@specflow/typescript": {
      "version": "1.0.0",
      "source": "npm",
      "installedAt": "2026-04-05T10:00:00Z",
      "contractCount": 3,
      "ruleIds": ["TS-001", "TS-002", "TS-003"]
    }
  }
}
```

---

## Enforce Loader Changes

The contract loader currently scans a single directory. With packages, it scans multiple:

```typescript
// Before
const contracts = loadContracts('.specflow/contracts/');

// After
const dirs = [
  '.specflow/contracts/',                    // User contracts (highest precedence)
  ...getPackageDirs('.specflow/packages/')    // Package contracts
];
const contracts = dirs.flatMap(dir => loadContracts(dir));
```

Duplicate rule ID resolution happens at load time:
1. Build a `Set<string>` of rule IDs as contracts load.
2. User contracts load first — their IDs go in the set.
3. Package contracts load second — if an ID is already in the set, skip with warning.
4. Between packages — if an ID is already in the set, error.

---

## Edge Cases and Resolutions

| ID | Edge Case | Resolution |
|----|-----------|------------|
| E5-1 | Install location | `.specflow/packages/<package-name>/` with npm scope preserved |
| E5-2 | Enforce scanning | Loader scans `contracts/` + `packages/` recursively |
| E5-3 | Rule ID conflicts | Error on package-package duplicates; user-package: user wins with warning |
| E5-4 | Storage strategy | Copy from `node_modules` to `.specflow/packages/` on `add` |
| E5-5 | Update mechanism | `update-packages` re-copies from `node_modules`, updates lock file |
| E5-6 | Offline operation | Enforcement reads from `.specflow/packages/` (committed to git), not `node_modules` |
| E5-7 | Transitive deps | npm resolves deps; `specflow add` discovers via `specflow.dependencies` field |
| E5-8 | Lock file | `.specflow/packages.json` tracks name, version, source, date, rule IDs |
| E5-9 | User precedence | User contracts in `.specflow/contracts/` always win over package contracts |
| E5-10 | Package removal | Delete from `.specflow/packages/` + `packages.json`; no `npm uninstall` |
| E5-11 | Publishing | Scaffold `package.json` with `specflow` field, validate contracts, `npm publish` |

---

## Doctor Integration

`specflow doctor` adds these checks:

| Check | Pass | Warn | Fail |
|-------|------|------|------|
| Lock file exists | `packages.json` found | — | Missing but `.specflow/packages/` has content |
| Lock matches disk | All entries match directories | Version mismatch | Directory missing for lock entry |
| No rule ID conflicts | All IDs unique | User shadows package | Package-package duplicate |
| Contracts valid | All compile | — | Any contract fails validation |

---

## Acceptance Criteria (Overall)

- [ ] `specflow add @specflow/react` installs contracts to `.specflow/packages/`
- [ ] `specflow remove @specflow/react` cleanly removes contracts and lock entry
- [ ] `specflow update-packages` syncs from `node_modules`
- [ ] `specflow publish` creates a valid npm package from user contracts
- [ ] `specflow enforce .` scans both `contracts/` and `packages/` directories
- [ ] Rule ID conflicts between packages are detected and blocked
- [ ] User contracts shadow package contracts with warning
- [ ] `.specflow/packages.json` is always consistent with disk
- [ ] `specflow doctor` validates package installation integrity
- [ ] Transitive Specflow dependencies are discovered and installed
- [ ] Offline enforcement works (no network required after `add`)
