/**
 * ReferenceWalker — finds inbound references to docs from source code,
 * contracts, agent files, and other docs. Implements DDD-007 ReferenceWalker.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Reference } from './document-repository';
import { ID_PATTERN_INLINE, DOCUMENT_TYPES } from './document-types';

// Alias to the central inline-id matcher so adding a new DocumentType (e.g.
// RFC) automatically extends the walker without touching this file.
const ID_PATTERN = ID_PATTERN_INLINE;
// Non-global companion used to pull the first id out of a doc's body so we
// can skip self-references. Built from DOCUMENT_TYPES for the same reason.
const ID_PATTERN_FIRST = new RegExp(`\\b(?:${DOCUMENT_TYPES.join('|')})-\\d{3}\\b`);

const SOURCE_EXT = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.rs', '.py']);
const CONTRACT_EXT = new Set(['.yml', '.yaml']);
const AGENT_EXT = new Set(['.md']);

export interface WalkOptions {
  sourceDir?: string;
  contractsDir?: string;
  agentsDir?: string;
  docsDir?: string;
}

export function walkAll(rootDir: string, opts: WalkOptions = {}): Reference[] {
  const refs: Reference[] = [];
  const sourceDir = opts.sourceDir || path.join(rootDir, 'ts-src');
  const contractsDir = opts.contractsDir || path.join(rootDir, '.specflow', 'contracts');
  const agentsDir = opts.agentsDir || path.join(rootDir, 'agents');
  const docsDir = opts.docsDir || path.join(rootDir, 'docs', 'architecture');

  if (fs.existsSync(sourceDir)) {
    refs.push(...walkDirectory(sourceDir, 'source_code', SOURCE_EXT));
  }
  if (fs.existsSync(contractsDir)) {
    refs.push(...walkDirectory(contractsDir, 'contract', CONTRACT_EXT));
  }
  if (fs.existsSync(agentsDir)) {
    refs.push(...walkDirectory(agentsDir, 'agent', AGENT_EXT));
  }
  if (fs.existsSync(docsDir)) {
    refs.push(...walkDocs(docsDir));
  }

  return refs;
}

function walkDirectory(dir: string, sourceType: Reference['sourceType'], extensions: Set<string>): Reference[] {
  const refs: Reference[] = [];
  for (const file of walkFiles(dir, extensions)) {
    const content = safeRead(file);
    if (!content) continue;
    const matches = Array.from(new Set(content.match(ID_PATTERN) || []));
    for (const m of matches) {
      refs.push({ sourceType, sourcePath: file, targetId: m });
    }
  }
  return refs;
}

function walkDocs(docsDir: string): Reference[] {
  const refs: Reference[] = [];
  for (const file of walkFiles(docsDir, new Set(['.md']))) {
    const content = safeRead(file);
    if (!content) continue;
    const ownId = (content.match(ID_PATTERN_FIRST) || [])[0];
    const matches = Array.from(new Set(content.match(ID_PATTERN) || []));
    for (const m of matches) {
      if (m === ownId) continue;
      refs.push({ sourceType: 'document', sourcePath: file, targetId: m });
    }
  }
  return refs;
}

function walkFiles(dir: string, extensions: Set<string>): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extensions));
    } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results;
}

function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
