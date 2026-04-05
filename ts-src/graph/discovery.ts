/**
 * SkillDiscovery: Frequency-based pattern extraction from successful fixes.
 * Discovers skills when 3+ fixes of the same pattern succeed.
 * No ML — pure SQL GROUP BY analysis.
 */

import { Database, upsertNode, query, saveDb } from './database';

const DEFAULT_MIN_OCCURRENCES = 3;
const PRUNE_THRESHOLD = 0.3;

/**
 * Discover potential skills from fix history.
 * A skill is a fix pattern that has succeeded N+ times.
 */
export function discoverSkills(database: Database, minOccurrences: number = DEFAULT_MIN_OCCURRENCES): DiscoveredSkill[] {
  const rows = query(database,
    `SELECT json_extract(properties, '$.method') as method,
            json_extract(properties, '$.rule_id') as rule_id,
            json_extract(properties, '$.description') as description,
            count(*) as total,
            sum(CASE WHEN json_extract(properties, '$.outcome') = 'success' THEN 1 ELSE 0 END) as successes
     FROM nodes WHERE type = 'fix'
     GROUP BY method, rule_id, description
     HAVING total >= ?`,
    [minOccurrences]
  );

  return rows.map(row => ({
    method: row.method as string,
    ruleId: row.rule_id as string,
    description: row.description as string,
    total: row.total as number,
    successes: row.successes as number,
    confidence: (row.successes as number) / (row.total as number),
  }));
}

export interface DiscoveredSkill {
  method: string;
  ruleId: string;
  description: string;
  total: number;
  successes: number;
  confidence: number;
}

/**
 * Promote a discovered pattern to a skill node in the graph.
 */
export function promoteToSkill(
  database: Database,
  pattern: DiscoveredSkill,
  fixTemplate?: string
): string {
  const skillId = `skill:${pattern.ruleId}:${pattern.method}`;

  upsertNode(database, skillId, 'skill', {
    pattern: pattern.description,
    rule_ids: [pattern.ruleId],
    method: pattern.method,
    fix_template: fixTemplate || '',
    confidence: pattern.confidence,
    uses: pattern.total,
    successes: pattern.successes,
    failures: pattern.total - pattern.successes,
    discovered: Math.floor(Date.now() / 1000),
    last_used: Math.floor(Date.now() / 1000),
  });

  saveDb(database);
  return skillId;
}

/**
 * Get all discovered skills.
 */
export function getSkills(database: Database): Record<string, any>[] {
  return query(database,
    `SELECT id, properties FROM nodes WHERE type = 'skill'
     ORDER BY json_extract(properties, '$.confidence') DESC`
  ).map(row => ({
    id: row.id,
    ...JSON.parse(row.properties as string),
  }));
}

/**
 * Prune skills with confidence below threshold.
 */
export function pruneSkills(database: Database, threshold: number = PRUNE_THRESHOLD): number {
  const toDelete = query(database,
    `SELECT id FROM nodes WHERE type = 'skill'
     AND json_extract(properties, '$.confidence') < ?`,
    [threshold]
  );

  for (const row of toDelete) {
    database.db.run('DELETE FROM edges WHERE source = ? OR target = ?', [row.id, row.id]);
    database.db.run('DELETE FROM nodes WHERE id = ?', [row.id]);
  }

  if (toDelete.length > 0) saveDb(database);
  return toDelete.length;
}

/**
 * Run full consolidation: discover, promote, prune, vacuum.
 */
export function consolidate(database: Database, minOccurrences: number = DEFAULT_MIN_OCCURRENCES): ConsolidationReport {
  // Discover
  const discovered = discoverSkills(database, minOccurrences);

  // Promote high-confidence patterns
  let promoted = 0;
  for (const skill of discovered) {
    if (skill.confidence >= 0.7) {
      promoteToSkill(database, skill);
      promoted++;
    }
  }

  // Prune low-confidence skills
  const pruned = pruneSkills(database);

  // Prune old violations (> 90 days)
  const cutoff = Math.floor(Date.now() / 1000) - (90 * 24 * 60 * 60);
  const oldViolations = query(database,
    `SELECT id FROM nodes WHERE type = 'violation'
     AND json_extract(properties, '$.timestamp') < ?`,
    [cutoff]
  );
  for (const row of oldViolations) {
    database.db.run('DELETE FROM edges WHERE source = ? OR target = ?', [row.id, row.id]);
    database.db.run('DELETE FROM nodes WHERE id = ?', [row.id]);
  }

  // Vacuum
  database.db.run('VACUUM');
  saveDb(database);

  return {
    discovered: discovered.length,
    promoted,
    pruned,
    oldViolationsRemoved: oldViolations.length,
  };
}

export interface ConsolidationReport {
  discovered: number;
  promoted: number;
  pruned: number;
  oldViolationsRemoved: number;
}
