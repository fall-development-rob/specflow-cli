/**
 * AuditLog — append-only record of every lifecycle verb invocation.
 *
 * Implements DDD-008 AuditLog aggregate and ADR-015's audit-entry
 * format. Entries are appended as one YAML sequence item per line to
 * `.specflow/audit-log.yml`, so the file stays parseable as a YAML
 * array of mappings and grep-able from the shell.
 *
 * The append goes through the DocumentWriter atomic port (same one
 * used for every doc mutation). Because we append rather than
 * rewrite, the implementation reads the current file, concatenates
 * the new entry, and writes the result atomically. The ADR-015 audit
 * spec permits this simplification — the audit log is small and
 * write volume is low (one entry per verb invocation).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DocumentStatus } from './frontmatter';
import { getDefaultDocumentWriter } from './document-writer';

export interface AuditEntry {
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
  /** One of the verb names: accept, supersede, deprecate, bump, stamp, revive. */
  verb: string;
  /** Document id being mutated. */
  id: string;
  /** Status before the verb, or null for non-status verbs (bump, stamp). */
  from: DocumentStatus | null;
  /** Status after the verb, or null for non-status verbs. */
  to: DocumentStatus | null;
  /** Successor id, for supersede only. */
  by?: string;
  /** Free-text reason / --note payload. */
  reason?: string;
  /** Who invoked the verb. Currently always 'cli'. */
  actor: 'cli' | 'agent' | 'hook';
}

export class AuditLog {
  constructor(private readonly filePath: string) {}

  append(entry: AuditEntry): void {
    const line = formatEntry(entry);
    const existing = fs.existsSync(this.filePath)
      ? fs.readFileSync(this.filePath, 'utf-8')
      : '';
    const content = existing.endsWith('\n') || existing.length === 0
      ? existing + line
      : existing + '\n' + line;
    getDefaultDocumentWriter().writeAtomic(this.filePath, content);
  }

  /** Read the full log back as a list of raw lines (one entry per line). */
  readAll(): string {
    if (!fs.existsSync(this.filePath)) return '';
    return fs.readFileSync(this.filePath, 'utf-8');
  }
}

/**
 * Format a single audit entry as a YAML sequence item on one line.
 * Shape:
 *   - {timestamp: '2026-04-16T12:34:56Z', verb: supersede, id: ADR-007,
 *      from: Accepted, to: Superseded, by: ADR-018, reason: '...', actor: cli}
 */
export function formatEntry(entry: AuditEntry): string {
  const parts: string[] = [];
  parts.push(`timestamp: '${entry.timestamp}'`);
  parts.push(`verb: ${entry.verb}`);
  parts.push(`id: ${entry.id}`);
  parts.push(`from: ${entry.from ?? 'null'}`);
  parts.push(`to: ${entry.to ?? 'null'}`);
  if (entry.by) parts.push(`by: ${entry.by}`);
  if (entry.reason) parts.push(`reason: ${yamlQuote(entry.reason)}`);
  parts.push(`actor: ${entry.actor}`);
  return `- {${parts.join(', ')}}\n`;
}

function yamlQuote(s: string): string {
  // Single-quote and escape any single quotes inside — the simplest YAML
  // quoting rule that preserves newlines as literal backslashes.
  return `'${String(s).replace(/\n/g, ' ').replace(/'/g, "''")}'`;
}

export function defaultAuditLogPath(projectRoot: string): string {
  return path.join(projectRoot, '.specflow', 'audit-log.yml');
}
