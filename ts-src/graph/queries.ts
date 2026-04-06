/**
 * Reusable graph query functions for scope resolution, fix suggestion,
 * impact analysis, compliance trending, and violation hotspots.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database, query, upsertNode, saveDb } from './database';

/**
 * Get contracts and rules that apply to a given file path.
 * Matches file path against scope globs stored in scopes_to edges.
 */
export function getScopeContracts(database: Database, filePath: string): Record<string, any>[] {
  // Get all scopes_to edges and match file path against globs
  const edges = query(database,
    `SELECT e.source as rule_id, json_extract(e.properties, '$.glob') as glob
     FROM edges e WHERE e.relation = 'scopes_to'`
  );

  const matchingRules = new Set<string>();
  for (const edge of edges) {
    const glob = edge.glob as string;
    if (matchGlob(filePath, glob)) {
      matchingRules.add(edge.rule_id as string);
    }
  }

  if (matchingRules.size === 0) return [];

  const placeholders = Array.from(matchingRules).map(() => '?').join(',');
  return query(database,
    `SELECT n.id, n.type, n.properties FROM nodes n
     WHERE n.id IN (${placeholders})`,
    Array.from(matchingRules)
  ).map(row => ({
    id: row.id,
    type: row.type,
    ...JSON.parse(row.properties as string),
  }));
}

/**
 * Suggest a fix for a rule based on historical success.
 * Returns the most successful fix pattern if one exists with confidence >= 0.7.
 */
export function suggestFix(database: Database, ruleId: string, contractId?: string): Record<string, any> | null {
  const ruleKey = contractId ? `${contractId}::${ruleId}` : ruleId;

  // First check skill library
  const skills = query(database,
    `SELECT id, properties FROM nodes
     WHERE type = 'skill'
     AND json_extract(properties, '$.confidence') >= 0.7
     AND (
       json_extract(properties, '$.rule_ids') LIKE ?
       OR json_extract(properties, '$.rule_ids') LIKE ?
     )
     ORDER BY json_extract(properties, '$.confidence') DESC
     LIMIT 1`,
    [`%${ruleId}%`, `%${ruleKey}%`]
  );

  if (skills.length > 0) {
    const props = JSON.parse(skills[0].properties as string);
    return {
      source: 'skill',
      id: skills[0].id,
      pattern: props.pattern,
      method: props.method,
      confidence: props.confidence,
      fix_template: props.fix_template,
    };
  }

  // Fall back to most recent successful fix
  const fixes = query(database,
    `SELECT id, properties FROM nodes
     WHERE type = 'fix'
     AND json_extract(properties, '$.rule_id') = ?
     AND json_extract(properties, '$.outcome') = 'success'
     ORDER BY json_extract(properties, '$.timestamp') DESC
     LIMIT 1`,
    [ruleId]
  );

  if (fixes.length > 0) {
    const props = JSON.parse(fixes[0].properties as string);
    return {
      source: 'history',
      id: fixes[0].id,
      description: props.description,
      method: props.method,
      code_after: props.code_after,
    };
  }

  // Fall back to seeded fix suggestions from contract examples
  const seeded = query(database,
    `SELECT id, properties FROM nodes
     WHERE type = 'fix_suggestion'
     AND json_extract(properties, '$.rule_id') = ?
     LIMIT 1`,
    [ruleId]
  );

  if (seeded.length > 0) {
    const props = JSON.parse(seeded[0].properties as string);
    return {
      source: 'contract_example',
      id: seeded[0].id,
      example_compliant: props.example_compliant,
      confidence: props.confidence || 0.6,
      successes: props.successes || 1,
    };
  }

  return null;
}

/**
 * Analyze impact of changing a contract.
 * Uses recursive CTE to find affected files, tests, and agents.
 */
export function getImpact(database: Database, contractId: string): ImpactReport {
  // Direct rule children
  const rules = query(database,
    `SELECT e.target as rule_id, n.properties FROM edges e
     JOIN nodes n ON n.id = e.target
     WHERE e.source = ? AND e.relation = 'has_rule'`,
    [contractId]
  ).map(row => ({
    id: row.rule_id as string,
    ...JSON.parse(row.properties as string),
  }));

  // Files in scope (via scopes_to)
  const scopeGlobs = query(database,
    `SELECT DISTINCT json_extract(e.properties, '$.glob') as glob
     FROM edges e
     WHERE e.source IN (SELECT target FROM edges WHERE source = ? AND relation = 'has_rule')
     AND e.relation = 'scopes_to'`,
    [contractId]
  ).map(row => row.glob as string);

  // Agents bound to this contract
  const agents = query(database,
    `SELECT n.id, n.properties FROM nodes n
     JOIN edges e ON n.id = e.source
     WHERE e.target = ? AND e.relation = 'binds_to'`,
    [contractId]
  ).map(row => ({
    id: row.id as string,
    ...JSON.parse(row.properties as string),
  }));

  // Historical violation count for this contract
  const violations = query(database,
    `SELECT count(*) as count FROM nodes
     WHERE type = 'violation'
     AND json_extract(properties, '$.contract_id') = ?`,
    [contractId]
  );

  // Recursive impact via CTE
  const deepImpact = query(database,
    `WITH RECURSIVE impact AS (
       SELECT e.target as node_id, 1 as depth, e.relation
       FROM edges e WHERE e.source = ? AND e.relation IN ('has_rule', 'scopes_to')
       UNION ALL
       SELECT e2.target, i.depth + 1, e2.relation
       FROM edges e2 JOIN impact i ON e2.source = i.node_id
       WHERE i.depth < 5
     )
     SELECT DISTINCT n.id, n.type, n.properties, i.depth
     FROM nodes n JOIN impact i ON n.id = i.node_id`,
    [contractId]
  );

  return {
    contractId,
    rules,
    scopeGlobs,
    agents,
    historicalViolations: (violations[0]?.count as number) || 0,
    deepImpact: deepImpact.map(row => ({
      id: row.id as string,
      type: row.type as string,
      depth: row.depth as number,
      ...JSON.parse(row.properties as string),
    })),
  };
}

export interface ImpactReport {
  contractId: string;
  rules: Record<string, any>[];
  scopeGlobs: string[];
  agents: Record<string, any>[];
  historicalViolations: number;
  deepImpact: Record<string, any>[];
}

/**
 * Get compliance trend: violations per day over N days.
 */
export function getComplianceTrend(database: Database, days: number = 30): TrendEntry[] {
  const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

  return query(database,
    `SELECT date(json_extract(properties, '$.timestamp'), 'unixepoch') as day,
            count(*) as violations
     FROM nodes
     WHERE type = 'violation'
     AND json_extract(properties, '$.first_seen') > ?
     GROUP BY day
     ORDER BY day`,
    [since]
  ).map(row => ({
    day: row.day as string,
    violations: row.violations as number,
  }));
}

export interface TrendEntry {
  day: string;
  violations: number;
}

/**
 * Get violation hotspots: most violated rules and files.
 */
export function getViolationHotspots(database: Database, limit: number = 10): HotspotReport {
  const byRule = query(database,
    `SELECT json_extract(properties, '$.rule_id') as rule_id,
            json_extract(properties, '$.contract_id') as contract_id,
            count(*) as count
     FROM nodes WHERE type = 'violation' AND json_extract(properties, '$.status') = 'active'
     GROUP BY rule_id, contract_id
     ORDER BY count DESC LIMIT ?`,
    [limit]
  ).map(row => ({
    ruleId: row.rule_id as string,
    contractId: row.contract_id as string,
    count: row.count as number,
  }));

  const byFile = query(database,
    `SELECT json_extract(properties, '$.file') as file, count(*) as count
     FROM nodes WHERE type = 'violation' AND json_extract(properties, '$.status') = 'active'
     GROUP BY file
     ORDER BY count DESC LIMIT ?`,
    [limit]
  ).map(row => ({
    file: row.file as string,
    count: row.count as number,
  }));

  return { byRule, byFile };
}

export interface HotspotReport {
  byRule: Array<{ ruleId: string; contractId: string; count: number }>;
  byFile: Array<{ file: string; count: number }>;
}

/**
 * Get most violated rules.
 */
export function getMostViolatedRules(database: Database, limit: number = 10): Array<{ ruleId: string; contractId: string; count: number }> {
  return getViolationHotspots(database, limit).byRule;
}

/**
 * Seed fix suggestions from contract example_compliant fields.
 * Called on first enforce --suggest if graph has zero fix nodes.
 * Idempotent: skips if fix nodes already exist.
 */
export function seedFixSuggestions(database: Database, contractsDir: string): void {
  // Check if fix nodes already exist
  const existing = query(database,
    `SELECT count(*) as count FROM nodes WHERE type = 'fix_suggestion'`
  );
  if (existing.length > 0 && (existing[0].count as number) > 0) {
    return; // Already seeded
  }

  // Load contract YAML files and extract example_compliant
  let yaml: any;
  try {
    yaml = require('js-yaml');
  } catch {
    return; // js-yaml not available
  }

  const files = fs.readdirSync(contractsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(contractsDir, file), 'utf-8');
      const parsed = yaml.load(content);
      const contractId = parsed?.contract_meta?.id || '';
      const rules = parsed?.rules?.non_negotiable || [];

      for (const rule of rules) {
        const ruleId = rule.id;
        const exampleCompliant = rule.behavior?.example_compliant;
        if (!ruleId || !exampleCompliant) continue;

        const text = typeof exampleCompliant === 'string' ? exampleCompliant.trim() : '';
        if (!text) continue;

        const nodeId = `fix_suggestion:${contractId}::${ruleId}`;
        upsertNode(database, nodeId, 'fix_suggestion', {
          rule_id: ruleId,
          contract_id: contractId,
          example_compliant: text,
          confidence: 0.6,
          successes: 1,
          total: 1,
          source: 'contract_example',
          seeded_at: Math.floor(Date.now() / 1000),
        });
      }
    } catch {
      // Skip malformed contracts
    }
  }

  saveDb(database);
}

/**
 * Simple glob matching (supports *, **, ?, and ! negation).
 * Not a full glob implementation — covers common contract scope patterns.
 */
function matchGlob(filePath: string, glob: string): boolean {
  // Handle negation
  if (glob.startsWith('!')) {
    return !matchGlob(filePath, glob.slice(1));
  }

  // Convert glob to regex
  let regex = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
    .replace(/\?/g, '.')
    .replace(/\{([^}]+)\}/g, '($1)')
    .replace(/,/g, '|');

  regex = `^${regex}$`;

  try {
    return new RegExp(regex).test(filePath);
  } catch {
    return false;
  }
}
