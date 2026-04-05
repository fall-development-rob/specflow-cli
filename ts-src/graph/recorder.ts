/**
 * ViolationRecorder: Records enforce results as graph nodes and edges.
 * Each enforce run creates an Episode, violations link to rules and files.
 */

import { Database, upsertNode, insertEdge, query, saveDb } from './database';

export interface ViolationInput {
  contractId: string;
  ruleId: string;
  file: string;
  line: number;
  matchedText: string;
  message: string;
  kind: string;
}

export interface EnforceRunResult {
  violations: ViolationInput[];
  filesScanned: number;
  contractsLoaded: number;
  rulesChecked: number;
}

/**
 * Record an entire enforce run: creates an Episode node plus Violation nodes and edges.
 * Deduplicates violations (same rule + file + line) by incrementing count.
 */
export function recordEnforceRun(database: Database, results: EnforceRunResult): string {
  const episodeId = `episode:${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);

  // Episode node
  upsertNode(database, episodeId, 'episode', {
    timestamp,
    file_count: results.filesScanned,
    violation_count: results.violations.length,
    contracts_loaded: results.contractsLoaded,
    rules_checked: results.rulesChecked,
  });

  for (const v of results.violations) {
    recordViolation(database, v, episodeId, timestamp);
  }

  saveDb(database);
  return episodeId;
}

function recordViolation(
  database: Database,
  violation: ViolationInput,
  episodeId: string,
  timestamp: number
): void {
  const ruleKey = `${violation.contractId}::${violation.ruleId}`;
  const violationId = `violation:${ruleKey}:${violation.file}:${violation.line}`;

  // Check for existing violation (deduplication)
  const existing = query(database,
    'SELECT properties FROM nodes WHERE id = ? AND type = ?',
    [violationId, 'violation']
  );

  if (existing.length > 0) {
    // Update existing: increment count, update last_seen
    const props = JSON.parse(existing[0].properties as string);
    props.count = (props.count || 1) + 1;
    props.last_seen = timestamp;
    props.last_episode = episodeId;
    upsertNode(database, violationId, 'violation', props);
  } else {
    // New violation
    upsertNode(database, violationId, 'violation', {
      rule_id: violation.ruleId,
      contract_id: violation.contractId,
      file: violation.file,
      line: violation.line,
      match: violation.matchedText,
      message: violation.message,
      kind: violation.kind,
      timestamp,
      status: 'active',
      count: 1,
      first_seen: timestamp,
      last_seen: timestamp,
      episode_id: episodeId,
      last_episode: episodeId,
    });

    // Ensure file node exists
    upsertNode(database, `file:${violation.file}`, 'file', {
      path: violation.file,
      last_scanned: timestamp,
    });

    // Violation → File edge
    insertEdge(database, violationId, `file:${violation.file}`, 'violated_in', {
      first_seen: timestamp,
      last_seen: timestamp,
    });

    // Violation → Rule edge
    insertEdge(database, violationId, ruleKey, 'triggered_by', {
      timestamp,
    });
  }
}
