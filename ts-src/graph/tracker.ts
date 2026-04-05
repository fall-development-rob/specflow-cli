/**
 * FixTracker: Records fix attempts and outcomes.
 * Called by heal-loop hook or agent after attempting a fix.
 */

import { Database, upsertNode, insertEdge, query, saveDb } from './database';

export interface FixInput {
  ruleId: string;
  contractId: string;
  file: string;
  fixDescription: string;
  method: 'skill' | 'heuristic' | 'manual' | 'auto_fix';
  agent?: string;
  codeBefore?: string;
  codeAfter?: string;
  success: boolean;
}

/**
 * Record a fix attempt for a rule violation.
 */
export function recordFix(database: Database, fix: FixInput): string {
  const fixId = `fix:${fix.contractId}::${fix.ruleId}:${Date.now()}`;
  const timestamp = Math.floor(Date.now() / 1000);

  upsertNode(database, fixId, 'fix', {
    rule_id: fix.ruleId,
    contract_id: fix.contractId,
    file: fix.file,
    description: fix.fixDescription,
    method: fix.method,
    agent: fix.agent || '',
    code_before: fix.codeBefore || '',
    code_after: fix.codeAfter || '',
    outcome: fix.success ? 'success' : 'failure',
    timestamp,
    re_enforce_passed: fix.success,
  });

  // Find the violation this fix addresses
  const ruleKey = `${fix.contractId}::${fix.ruleId}`;
  const violations = query(database,
    `SELECT id FROM nodes WHERE type = 'violation'
     AND json_extract(properties, '$.contract_id') = ?
     AND json_extract(properties, '$.rule_id') = ?
     AND json_extract(properties, '$.file') = ?
     AND json_extract(properties, '$.status') = 'active'
     ORDER BY json_extract(properties, '$.timestamp') DESC LIMIT 1`,
    [fix.contractId, fix.ruleId, fix.file]
  );

  if (violations.length > 0) {
    insertEdge(database, violations[0].id as string, fixId, 'fixed_by', { timestamp });

    // If fix succeeded, mark violation as fixed
    if (fix.success) {
      const vProps = JSON.parse(
        (query(database, 'SELECT properties FROM nodes WHERE id = ?', [violations[0].id])[0]?.properties as string) || '{}'
      );
      vProps.status = 'fixed';
      vProps.fixed_at = timestamp;
      upsertNode(database, violations[0].id as string, 'violation', vProps);
    }
  }

  // Link fix to rule
  insertEdge(database, fixId, ruleKey, 'fixes_rule', { timestamp });

  saveDb(database);
  return fixId;
}

/**
 * Get fix history for a rule, ordered by most recent.
 */
export function getFixHistory(database: Database, ruleId: string, contractId?: string): Record<string, any>[] {
  let sql = `SELECT n.id, n.properties FROM nodes n
    WHERE n.type = 'fix'
    AND json_extract(n.properties, '$.rule_id') = ?`;
  const params: any[] = [ruleId];

  if (contractId) {
    sql += ` AND json_extract(n.properties, '$.contract_id') = ?`;
    params.push(contractId);
  }

  sql += ` ORDER BY json_extract(n.properties, '$.timestamp') DESC`;

  return query(database, sql, params).map(row => ({
    id: row.id,
    ...JSON.parse(row.properties as string),
  }));
}

/**
 * Get success rate for fixes of a given rule.
 */
export function getFixSuccessRate(database: Database, ruleId: string): { total: number; successes: number; rate: number } {
  const fixes = query(database,
    `SELECT json_extract(properties, '$.outcome') as outcome FROM nodes
     WHERE type = 'fix' AND json_extract(properties, '$.rule_id') = ?`,
    [ruleId]
  );

  const total = fixes.length;
  const successes = fixes.filter(f => f.outcome === 'success').length;

  return {
    total,
    successes,
    rate: total > 0 ? successes / total : 0,
  };
}
