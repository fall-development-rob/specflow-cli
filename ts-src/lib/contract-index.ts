/**
 * ContractIndex — loads every `.specflow/contracts/*.yml` file and builds a
 * lightweight map of contract id to its file path, metadata, and rule ids.
 *
 * Implements the lookup half of ADR-016 upward traceability (`specflow audit
 * --contract <id>`). The walker in `traceability.ts` consumes this index to
 * anchor each upstream chain at a contract rule or at a bare contract id.
 *
 * Keep this module side-effect-free — it only reads YAML and never mutates it.
 * The existing `CouplingEnforcer` loads a different (typed) slice of the same
 * files; we duplicate neither its invariants nor its evaluation logic. S6
 * owns the YAML loader hardening, so this module intentionally uses the same
 * plain `js-yaml` `.load` path as `loadCouplingContracts` does today.
 */

import * as fs from 'fs';
import * as path from 'path';

const yaml = require('js-yaml');

export interface ContractRule {
  id: string;
  description: string;
}

export interface ContractEntry {
  /** `contract_meta.id` as declared in the YAML. */
  id: string;
  /** Absolute path to the YAML file on disk. */
  filePath: string;
  /** `contract_meta.type` if declared (e.g. `spec_coupling`, `pattern`). */
  type: string;
  /** `contract_meta.version` if declared, otherwise undefined. */
  version?: string;
  /** `contract_meta.owner` if declared, otherwise undefined. */
  owner?: string;
  /** Extracted rules from any known rule-bearing shape. */
  rules: ContractRule[];
}

export interface ContractIndexLookup {
  get(id: string): ContractEntry | undefined;
  all(): ContractEntry[];
  findRule(contractId: string, ruleId: string): ContractRule | undefined;
}

/**
 * In-memory index. Construct via `loadContractIndex(dir)` or directly from a
 * pre-parsed list in tests. `Map`-backed for O(1) lookup.
 */
export class ContractIndex implements ContractIndexLookup {
  private readonly entries = new Map<string, ContractEntry>();

  constructor(entries: ContractEntry[]) {
    for (const e of entries) this.entries.set(e.id, e);
  }

  get(id: string): ContractEntry | undefined {
    return this.entries.get(id);
  }

  all(): ContractEntry[] {
    return Array.from(this.entries.values());
  }

  findRule(contractId: string, ruleId: string): ContractRule | undefined {
    return this.entries.get(contractId)?.rules.find(r => r.id === ruleId);
  }
}

/**
 * Walk a contracts directory and build an index. Skips unparseable files
 * (doctor surfaces YAML parse errors elsewhere) and files without a
 * `contract_meta.id`.
 */
export function loadContractIndex(contractsDir: string): ContractIndex {
  const entries: ContractEntry[] = [];
  if (!fs.existsSync(contractsDir)) return new ContractIndex(entries);

  for (const filePath of collectYamlFiles(contractsDir)) {
    const parsed = safeLoad(filePath);
    if (!parsed || typeof parsed !== 'object') continue;
    const meta = (parsed as any).contract_meta;
    const id = meta?.id;
    if (!id || typeof id !== 'string') continue;
    entries.push({
      id,
      filePath,
      type: meta?.type ? String(meta.type) : '',
      version: meta?.version ? String(meta.version) : undefined,
      owner: meta?.owner ? String(meta.owner) : undefined,
      rules: extractRules(parsed),
    });
  }

  return new ContractIndex(entries);
}

function extractRules(parsed: any): ContractRule[] {
  const rules: ContractRule[] = [];

  // Shape 1 — spec_coupling contracts: `rules.couplings: [{ id, description }]`.
  const couplings = parsed?.rules?.couplings;
  if (Array.isArray(couplings)) {
    for (const r of couplings) {
      if (r?.id) rules.push({ id: String(r.id), description: String(r.description || '') });
    }
  }

  // Shape 2 — pattern / forbidden / required contracts: `rules: [{ id, description }]`.
  if (Array.isArray(parsed?.rules)) {
    for (const r of parsed.rules) {
      if (r?.id) rules.push({ id: String(r.id), description: String(r.description || '') });
    }
  }

  // Shape 3 — spec-integrity contracts (`rules.invariants: [{ id, description }]`).
  const invariants = parsed?.rules?.invariants;
  if (Array.isArray(invariants)) {
    for (const r of invariants) {
      if (r?.id) rules.push({ id: String(r.id), description: String(r.description || '') });
    }
  }

  // Dedupe defensively — the same id might appear in two shapes for a
  // transitional contract. Last write wins (later shapes can override).
  const byId = new Map<string, ContractRule>();
  for (const r of rules) byId.set(r.id, r);
  return Array.from(byId.values());
}

function safeLoad(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return yaml.load(content);
  } catch {
    return undefined;
  }
}

function collectYamlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectYamlFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
      results.push(full);
    }
  }
  return results;
}
