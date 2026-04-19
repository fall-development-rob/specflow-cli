---
id: DDD-006
title: Contract Packages Domain Design
type: DDD
status: Accepted
version: 1
date: '2026-04-05'
last_reviewed: '2026-04-17'
implements:
  - DDD-001
  - DDD-002
---

# DDD-006: Contract Packages Domain Design

---

## Domain Overview

Contract packages enable sharing versioned sets of Specflow contracts via npm. This domain models the lifecycle of external contract packages — from discovery and installation to enforcement, updates, and removal. The package system layers on top of the existing contract engine without modifying it; the engine simply receives an expanded list of contract directories to scan.

---

## Ubiquitous Language

| Term | Definition |
|------|-----------|
| **Contract Package** | An npm package containing YAML contract files and a `specflow` field in its `package.json`. |
| **Package Manifest** | The `specflow` field in a contract package's `package.json`, declaring the contracts directory and Specflow dependencies. |
| **Installed Contract** | A YAML contract file copied from `node_modules` to `.specflow/packages/<pkg>/`. |
| **Package Lock** | The `.specflow/packages.json` file tracking all installed packages, their versions, and metadata. |
| **User Contract** | A contract in `.specflow/contracts/` authored by the project's team. Always takes precedence over package contracts. |
| **Rule ID Conflict** | Two contracts (from different packages or user + package) defining the same rule ID. |
| **Specflow Dependency** | A contract package that another contract package depends on, declared in `specflow.dependencies`. |

---

## Value Objects

### PackageManifest

```typescript
interface PackageManifest {
  name: string;              // npm package name, e.g., "@specflow/react"
  version: string;           // semver, e.g., "1.0.0"
  contractsDir: string;      // Relative path within the package, e.g., "contracts/"
  dependencies: string[];    // Other Specflow package names
}
```

### InstalledContract

```typescript
interface InstalledContract {
  ruleId: string;            // e.g., "REACT-001"
  contractId: string;        // e.g., "react_hooks"
  sourcePackage: string;     // e.g., "@specflow/react"
  sourceVersion: string;     // e.g., "1.0.0"
  localPath: string;         // e.g., ".specflow/packages/@specflow/react/react_hooks.yml"
}
```

### PackageLockEntry

```typescript
interface PackageLockEntry {
  version: string;
  source: 'npm';
  installedAt: string;       // ISO 8601 timestamp
  contractCount: number;
}
```

### PackageLock

```typescript
interface PackageLock {
  packages: Record<string, PackageLockEntry>;
}
```

---

## Entities

### Package

The core entity representing a contract package in the system.

```
Package (Entity)
├── name: string                    # "@specflow/react"
├── version: string                 # "1.0.0"
├── manifest: PackageManifest
├── contracts: InstalledContract[]
├── status: 'available' | 'installed' | 'outdated'
└── installedAt?: Date
```

**Invariants:**
- A package must have a valid `specflow` field in its `package.json` to be recognized.
- A package's contracts must all have unique rule IDs within the package.
- The package `name` must be a valid npm package name.

---

## Aggregates

### PackageRegistry

The root aggregate managing all installed contract packages.

```
PackageRegistry (Aggregate Root)
├── lockFile: PackageLock
├── installedPackages: Map<string, Package>
├── userRuleIds: Set<string>        # Rule IDs from .specflow/contracts/
├── packageRuleIds: Map<string, string>  # ruleId → packageName
│
├── add(packageName): void
├── remove(packageName): void
├── updateAll(): void
├── resolveConflicts(): ConflictReport
└── getContractDirs(): string[]     # All directories to scan
```

**Invariants:**
- No two packages may define the same rule ID. Adding a package with a conflicting ID is rejected.
- User rule IDs shadow package rule IDs (user wins, warning emitted).
- The lock file is always consistent with the actual contents of `.specflow/packages/`.

---

## Domain Services

### PackageDiscoveryService

Discovers Specflow packages in the npm dependency tree.

```typescript
interface PackageDiscoveryService {
  /** Scan node_modules for packages with a specflow field */
  discoverPackages(nodeModulesPath: string): PackageManifest[];

  /** Resolve transitive Specflow dependencies */
  resolveTransitiveDeps(rootPackage: string): PackageManifest[];

  /** Read the specflow field from a package's package.json */
  readManifest(packagePath: string): PackageManifest | null;
}
```

### PackageInstallerService

Handles copying contracts from `node_modules` to `.specflow/packages/`.

```typescript
interface PackageInstallerService {
  /** Install a package: npm install, discover, copy contracts, update lock */
  install(packageName: string): InstallResult;

  /** Remove a package: delete directory, update lock */
  uninstall(packageName: string): void;

  /** Update all packages: re-copy from node_modules, update lock */
  updateAll(): UpdateResult;

  /** Copy contracts from node_modules path to .specflow/packages/ */
  copyContracts(manifest: PackageManifest, nodeModulesPath: string): InstalledContract[];
}
```

### ConflictResolutionService

Detects and resolves rule ID conflicts.

```typescript
interface ConflictResolutionService {
  /** Check for rule ID conflicts across all sources */
  detectConflicts(
    userContracts: Contract[],
    packageContracts: Map<string, Contract[]>
  ): ConflictReport;

  /** Apply resolution: user wins over package, package-package is error */
  resolve(conflicts: Conflict[]): Resolution[];
}

interface Conflict {
  ruleId: string;
  sources: { type: 'user' | 'package'; name: string; path: string }[];
}

type Resolution =
  | { action: 'shadow'; ruleId: string; winner: string; loser: string }  // user wins
  | { action: 'error'; ruleId: string; packages: string[] };             // package conflict
```

### ContractLoaderExtension

Extends the existing contract loader to include package directories.

```typescript
interface ContractLoaderExtension {
  /** Returns all directories to scan for contracts */
  getContractDirectories(): string[];
  // Returns: ['.specflow/contracts/', '.specflow/packages/@specflow/react/', ...]
}
```

---

## Package Lifecycle

```
┌─────────────┐    npm install    ┌──────────────┐
│  Available   │ ───────────────→ │  In          │
│  (npm)       │                  │  node_modules │
└─────────────┘                   └──────┬───────┘
                                         │
                                   specflow add
                                   (copy + lock)
                                         │
                                         ▼
                                  ┌──────────────┐
                                  │  Installed    │
                                  │  (.specflow/  │
                                  │   packages/)  │
                                  └──────┬───────┘
                                         │
                          ┌──────────────┼──────────────┐
                          │              │              │
                   specflow enforce   update-packages   specflow remove
                   (scan contracts)  (re-copy from     (delete + unlock)
                                      node_modules)
```

---

## Integration Points

| Component | How It Integrates |
|-----------|-------------------|
| Contract engine | Receives expanded directory list from `ContractLoaderExtension` |
| `enforce` command | Calls `getContractDirectories()` instead of hardcoded `.specflow/contracts/` |
| `init` command | Creates `.specflow/packages/` directory and empty `packages.json` |
| `doctor` command | Validates lock file matches `.specflow/packages/` contents |
| Knowledge graph | Package contracts are indexed as nodes with `source: package` attribute |
| `publish` command | Scaffolds npm package structure from `.specflow/contracts/` |

---

## Error Types

| Error | Trigger | Resolution |
|-------|---------|------------|
| `PackageNotFoundError` | `specflow add <pkg>` where pkg doesn't exist in npm | Clear error: "Package '<pkg>' not found in npm registry" |
| `NoManifestError` | Package exists but has no `specflow` field | Clear error: "Package '<pkg>' is not a Specflow contract package" |
| `RuleIdConflictError` | Two packages define the same rule ID | Block install, list conflicts, suggest renaming |
| `StalePackageError` | Lock file version doesn't match node_modules version | Warn on `doctor`, fix with `update-packages` |
| `MissingNodeModulesError` | `specflow add` without prior `npm install` | Clear error: "Run 'npm install' first" |
