/**
 * Traceability walker — upward chain from a contract to the docs that claim
 * to implement it, then recursively up through each doc's `implemented_by`
 * chain. Implements ADR-016 the `specflow audit --contract <id>` feature.
 *
 * The walker is intentionally simple and pure: it takes a `DocumentLookup`
 * (repo) and a `ContractIndex`, and returns a tree. All rendering lives in
 * `audit.ts`. Cycles are detected and cut at the first repeat; `cycleOf`
 * records which ancestor triggered the cut so the renderer can annotate it.
 */

import { Document, DocumentLookup } from './document-repository';
import { ContractEntry, ContractIndexLookup, ContractRule } from './contract-index';

export interface DocNode {
  kind: 'document';
  id: string;
  title: string;
  type: string;
  status: string;
  version: number;
  last_reviewed: string;
  /** Recursive upstream children from this doc's `implemented_by`. */
  children: DocNode[];
  /**
   * When a cycle is detected the walker emits the node once and then marks
   * the duplicated edge with `cycleOf: <id>` so renderers can show a short
   * "(cycle)" hint rather than recurse forever.
   */
  cycleOf?: string;
  /** When the doc id was listed but no matching doc exists. */
  missing?: boolean;
}

export interface RuleNode {
  kind: 'rule';
  contractId: string;
  ruleId: string;
  description: string;
  /** Docs that claim to implement this rule (via `implements_contracts`). */
  documents: DocNode[];
}

export interface ContractTree {
  kind: 'contract';
  contractId: string;
  found: boolean;
  filePath?: string;
  type?: string;
  version?: string;
  owner?: string;
  /**
   * One node per rule. When the contract file is not found we synthesise a
   * single node with ruleId `*` so callers still get a consistent shape.
   */
  rules: RuleNode[];
  /**
   * Docs that target the contract id directly (no rule suffix) — either via
   * `implements_contracts: [<id>]` or legacy `implemented_by: [<id>]`. These
   * attach to the contract as a whole, not to any one rule.
   */
  rootDocuments: DocNode[];
}

/**
 * Build a traceability tree anchored at `contractId`. If the contract is not
 * in the index we still return a tree shape with `found: false` so callers
 * can print `(none)` and exit zero (ADR-016 acceptance criterion).
 */
export function buildContractTree(
  contractId: string,
  contractIndex: ContractIndexLookup,
  docs: DocumentLookup,
  allDocs: Iterable<Document>
): ContractTree {
  const entry = contractIndex.get(contractId);
  const documentsByContract = indexDocsByContract(allDocs);

  if (!entry) {
    const rootDocs = (documentsByContract.get(contractId) || []).map(d =>
      walkDocUp(d, docs, new Set<string>())
    );
    return {
      kind: 'contract',
      contractId,
      found: false,
      rules: [],
      rootDocuments: rootDocs,
    };
  }

  const rules: RuleNode[] = entry.rules.map(rule => ({
    kind: 'rule',
    contractId: entry.id,
    ruleId: rule.id,
    description: rule.description,
    documents: (documentsByContract.get(`${entry.id}:${rule.id}`) || [])
      .concat(documentsByContract.get(rule.id) || [])
      .map(d => walkDocUp(d, docs, new Set<string>())),
  }));

  const rootDocs = (documentsByContract.get(entry.id) || []).map(d =>
    walkDocUp(d, docs, new Set<string>())
  );

  return {
    kind: 'contract',
    contractId: entry.id,
    found: true,
    filePath: entry.filePath,
    type: entry.type,
    version: entry.version,
    owner: entry.owner,
    rules,
    rootDocuments: rootDocs,
  };
}

/**
 * Single-doc upward walk. Collects `implemented_by` targets, recurses, and
 * detects cycles via an ancestor set on the stack.
 */
function walkDocUp(
  doc: Document,
  docs: DocumentLookup,
  ancestors: ReadonlySet<string>
): DocNode {
  const node: DocNode = {
    kind: 'document',
    id: doc.id,
    title: doc.frontmatter.title,
    type: doc.frontmatter.type,
    status: doc.frontmatter.status,
    version: doc.frontmatter.version,
    last_reviewed: doc.frontmatter.last_reviewed,
    children: [],
  };

  if (ancestors.has(doc.id)) {
    // Shouldn't happen because the caller filters, but guard anyway.
    node.cycleOf = doc.id;
    return node;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(doc.id);

  for (const childId of doc.frontmatter.implemented_by) {
    if (ancestors.has(childId)) {
      node.children.push({
        kind: 'document',
        id: childId,
        title: '',
        type: '',
        status: '',
        version: 0,
        last_reviewed: '',
        children: [],
        cycleOf: childId,
      });
      continue;
    }
    const childDoc = docs.get(childId);
    if (!childDoc) {
      node.children.push({
        kind: 'document',
        id: childId,
        title: '',
        type: '',
        status: '',
        version: 0,
        last_reviewed: '',
        children: [],
        missing: true,
      });
      continue;
    }
    node.children.push(walkDocUp(childDoc, docs, nextAncestors));
  }

  return node;
}

/**
 * Group every doc by each contract it references. A doc with
 * `implements_contracts: [SEC-001]` is keyed under `SEC-001`; legacy docs
 * that shove a contract id into `implemented_by` (per DDD-007) are indexed
 * the same way for backward compatibility.
 */
function indexDocsByContract(allDocs: Iterable<Document>): Map<string, Document[]> {
  const byKey = new Map<string, Document[]>();
  for (const doc of allDocs) {
    const keys = new Set<string>();
    for (const k of doc.frontmatter.implements_contracts || []) keys.add(k);
    // Backward-compat: DDD-007 says contracts may appear in `implemented_by`.
    // A contract id looks different from an ADR id, so we treat any entry
    // that does NOT match the doc-id pattern as a contract reference.
    for (const k of doc.frontmatter.implemented_by || []) {
      if (!/^(ADR|PRD|DDD)-\d{3}$/.test(k)) keys.add(k);
    }
    for (const k of keys) {
      const list = byKey.get(k) || [];
      list.push(doc);
      byKey.set(k, list);
    }
  }
  return byKey;
}
