---
id: ADR-009
title: Contract Packages via npm
type: ADR
status: Accepted
version: 1
date: '2026-04-05'
last_reviewed: '2026-04-17'
implements:
  - ADR-003
  - DDD-001
  - DDD-002
---

# ADR-009: Contract Packages via npm

---

## Context

Organizations adopting Specflow across multiple projects need to share contract sets. Today, contracts are copied manually between repos. There is no versioning, no update mechanism, and no way to distribute curated rule sets (e.g., React best practices, security baselines, accessibility standards).

npm already solves package distribution, versioning, and dependency resolution. By packaging contracts as npm packages with a `specflow` field in `package.json`, we leverage existing infrastructure without building a custom registry.

---

## Decision

Contract packages are standard npm packages that contain YAML contract files and declare a `specflow` field in their `package.json`. Specflow provides `add`, `remove`, `update-packages`, `publish`, and `search` commands to manage them.

### Package Format

A contract package's `package.json` includes:

```json
{
  "name": "@specflow/react",
  "version": "1.0.0",
  "specflow": {
    "contracts": "contracts/",
    "dependencies": ["@specflow/typescript"]
  }
}
```

The `specflow.contracts` field points to the directory containing YAML contract files within the package. The `specflow.dependencies` field declares other Specflow packages this one depends on (npm resolves them as regular dependencies).

### Installation Layout

```
.specflow/
  contracts/          # User's own contracts (highest precedence)
  packages/
    @specflow/
      react/          # Contracts copied from node_modules
        REACT-001.yml
        REACT-002.yml
      typescript/
        TS-001.yml
  packages.json       # Lock file tracking installed packages
```

### Lock File Format (`.specflow/packages.json`)

```json
{
  "packages": {
    "@specflow/react": {
      "version": "1.0.0",
      "source": "npm",
      "installedAt": "2026-04-05T10:00:00Z",
      "contractCount": 2
    }
  }
}
```

---

## Edge Cases and Resolutions

### E5-1: Namespaced Installation

**Problem:** Flat installation in `.specflow/packages/` causes name collisions between packages.

**Resolution:** Install to `.specflow/packages/<package-name>/`, preserving npm scope structure. `@specflow/react` installs to `.specflow/packages/@specflow/react/`.

### E5-2: Enforce Must Scan Packages

**Problem:** The enforce command currently only scans `.specflow/contracts/`.

**Resolution:** Modify the contract loader to scan both `.specflow/contracts/` and `.specflow/packages/` recursively. User contracts load first, package contracts second. This is a single-line change to the glob pattern in the loader.

### E5-3: Rule ID Conflicts

**Problem:** Two packages might define the same rule ID (e.g., both define `SEC-001`).

**Resolution:** Do not namespace rule IDs automatically (breaking change to existing references). Instead:
1. On `specflow add`, scan for duplicate rule IDs across all installed packages and user contracts.
2. If a duplicate is found between two packages: error, refuse to install, suggest renaming.
3. If a duplicate is found between a user contract and a package: user wins, emit a warning.
4. `specflow enforce` also checks at load time and warns on duplicates.

### E5-4: Storage Strategy

**Problem:** Contracts in `node_modules` are transient (deleted on `npm ci`, ignored by git).

**Resolution:** `specflow add` copies contract files from `node_modules/<pkg>/<specflow.contracts>/` to `.specflow/packages/<pkg>/`. The copies are committed to git, making enforcement work offline and without `node_modules`.

### E5-5: Update Mechanism

**Problem:** After `npm update`, the copies in `.specflow/packages/` are stale.

**Resolution:** `specflow update-packages` reads `.specflow/packages.json`, re-copies contracts from `node_modules` for each listed package, and updates the version in the lock file. If a package is missing from `node_modules`, warn and skip.

### E5-6: Offline Operation

**Problem:** Enforcement must work without network access.

**Resolution:** Since contracts are copied to `.specflow/packages/` and committed to git, enforcement never reads from `node_modules`. Only `specflow add` and `specflow update-packages` require `node_modules` to be populated.

### E5-7: Transitive Dependencies

**Problem:** `@specflow/nextjs` depends on `@specflow/react`. Both must be installed.

**Resolution:** npm resolves transitive dependencies via the package's `dependencies` field. `specflow add @specflow/nextjs` runs `npm install @specflow/nextjs`, then discovers all Specflow packages in the dependency tree by scanning `node_modules/*/package.json` for the `specflow` field. All discovered packages are copied to `.specflow/packages/`.

### E5-8: Lock File Integrity

**Problem:** Lock file must accurately reflect what's installed.

**Resolution:** Every `specflow add`, `remove`, and `update-packages` command atomically updates `.specflow/packages.json`. The lock file records: package name, version, source (`npm`), installed timestamp, and contract count. `specflow doctor` validates that the lock file matches the actual contents of `.specflow/packages/`.

### E5-9: User Contract Precedence

**Problem:** A user contract and a package contract have the same rule ID.

**Resolution:** User contracts in `.specflow/contracts/` always take precedence. The loader processes user contracts first, builds a set of rule IDs, then loads package contracts — skipping any with duplicate IDs and emitting a warning: `Warning: rule ID 'SEC-001' in package '@specflow/security' shadowed by user contract.`

### E5-10: Package Removal

**Problem:** Need to cleanly remove a package and its contracts.

**Resolution:** `specflow remove <package>` deletes `.specflow/packages/<package>/` and removes the entry from `.specflow/packages.json`. Does not run `npm uninstall` (that's the user's responsibility for their `package.json`).

### E5-11: Publishing Contracts

**Problem:** Users want to share their contracts as packages.

**Resolution:** `specflow publish` creates a minimal `package.json` with the `specflow` field pointing to the contracts directory, validates all contracts compile, and runs `npm publish`. The command scaffolds the package structure if it doesn't exist.

---

## Consequences

### Positive

- Organizations can distribute curated contract sets via existing npm infrastructure
- Versioning and updates are handled by npm's proven mechanisms
- Offline enforcement works because contracts are copied locally
- No custom registry needed

### Negative

- Adds npm as a dependency for package management (not for enforcement itself)
- Duplicate contract copies (node_modules + .specflow/packages/) use disk space
- Rule ID conflicts require manual resolution rather than automatic namespacing

### Neutral

- The contract engine itself is unchanged — it just receives more directories to scan
- Publishing follows standard npm conventions
