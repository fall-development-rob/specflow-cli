/**
 * GraphBuilder: Materializes YAML contracts and agents into graph nodes and edges.
 * Called by specflow init and specflow enforce (on first run).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database, upsertNode, insertEdge, clearGraph, saveDb, initGraph, closeGraph } from './database';

interface ParsedContract {
  id: string;
  version?: number;
  sourceFile: string;
  rules: ParsedRule[];
  covers_reqs?: string[];
  owner?: string;
}

interface ParsedRule {
  id: string;
  title: string;
  scope: string[];
  forbidden_patterns?: Array<{ pattern: string; message: string }>;
  required_patterns?: Array<{ pattern: string; message: string }>;
  auto_fix?: { strategy: string };
}

interface ParsedAgent {
  name: string;
  description?: string;
  category?: string;
  trigger?: string;
  contracts?: string[];
}

/**
 * Parse all YAML contract files from a directory and insert them as graph nodes/edges.
 */
export function buildFromContracts(database: Database, contractsDir: string): number {
  if (!fs.existsSync(contractsDir)) return 0;

  const yaml = require('js-yaml');
  const files = fs.readdirSync(contractsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  let nodeCount = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(contractsDir, file), 'utf-8');
      const parsed = yaml.load(content);
      if (!parsed?.contract_meta?.id) continue;

      const contract = parseContract(parsed, file);
      indexContract(database, contract);
      nodeCount++;
    } catch {
      // Skip unparseable files — doctor check will flag them
    }
  }

  return nodeCount;
}

function parseContract(parsed: any, sourceFile: string): ParsedContract {
  const meta = parsed.contract_meta || {};
  const rules: ParsedRule[] = [];

  const ruleGroups = [
    ...(parsed.rules?.non_negotiable || []),
    ...(parsed.rules?.soft || []),
  ];

  for (const rule of ruleGroups) {
    const forbidden = (rule.behavior?.forbidden_patterns || []).map((p: any) => ({
      pattern: typeof p === 'string' ? p : p.pattern,
      message: typeof p === 'string' ? '' : (p.message || ''),
    }));
    const required = (rule.behavior?.required_patterns || []).map((p: any) => ({
      pattern: typeof p === 'string' ? p : p.pattern,
      message: typeof p === 'string' ? '' : (p.message || ''),
    }));

    rules.push({
      id: rule.id,
      title: rule.title || '',
      scope: rule.scope || [],
      forbidden_patterns: forbidden,
      required_patterns: required,
      auto_fix: rule.auto_fix,
    });
  }

  return {
    id: meta.id,
    version: meta.version,
    sourceFile,
    rules,
    covers_reqs: meta.covers_reqs,
    owner: meta.owner,
  };
}

function indexContract(database: Database, contract: ParsedContract): void {
  // Contract node
  upsertNode(database, contract.id, 'contract', {
    version: contract.version || 1,
    status: 'active',
    path: contract.sourceFile,
    rule_count: contract.rules.length,
    covers_reqs: contract.covers_reqs || [],
    owner: contract.owner || '',
    last_indexed: Math.floor(Date.now() / 1000),
  });

  for (let i = 0; i < contract.rules.length; i++) {
    const rule = contract.rules[i];
    const ruleId = `${contract.id}::${rule.id}`;

    // Rule node
    upsertNode(database, ruleId, 'rule', {
      contract_id: contract.id,
      rule_id: rule.id,
      title: rule.title,
      severity: 'non_negotiable',
      scope: rule.scope,
      pattern_count: (rule.forbidden_patterns?.length || 0) + (rule.required_patterns?.length || 0),
      auto_fix: rule.auto_fix || null,
    });

    // Contract → Rule edge
    insertEdge(database, contract.id, ruleId, 'has_rule', { position: i });

    // Pattern nodes and edges
    const allPatterns = [
      ...(rule.forbidden_patterns || []).map(p => ({ ...p, type: 'forbidden' })),
      ...(rule.required_patterns || []).map(p => ({ ...p, type: 'required' })),
    ];

    for (let j = 0; j < allPatterns.length; j++) {
      const pat = allPatterns[j];
      const patternId = `${ruleId}::pattern_${j}`;
      upsertNode(database, patternId, 'pattern', {
        regex: pat.pattern,
        type: pat.type,
        message: pat.message,
        rule_id: rule.id,
      });
      insertEdge(database, ruleId, patternId, 'has_pattern', { position: j });
    }

    // Scope → File edges (store scope globs as metadata)
    for (const glob of rule.scope) {
      insertEdge(database, ruleId, `scope:${glob}`, 'scopes_to', {
        glob,
        resolved: Math.floor(Date.now() / 1000),
      });
    }
  }
}

/**
 * Parse agent markdown files and insert as graph nodes with binds_to edges.
 */
export function buildFromAgents(database: Database, agentsDir: string): number {
  if (!fs.existsSync(agentsDir)) return 0;

  const yaml = require('js-yaml');
  const excluded = ['README.md', 'PROTOCOL.md', 'WORKFLOW.md'];
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md') && !excluded.includes(f));
  let agentCount = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
      const agent = parseAgentFrontmatter(content, file);
      if (!agent) continue;

      upsertNode(database, `agent:${agent.name}`, 'agent', {
        name: agent.name,
        description: agent.description || '',
        category: agent.category || '',
        trigger: agent.trigger || '',
      });

      // Bind agent to contracts if specified
      if (agent.contracts) {
        for (const contractId of agent.contracts) {
          insertEdge(database, `agent:${agent.name}`, contractId, 'binds_to', {});
        }
      }

      agentCount++;
    } catch {
      // Skip
    }
  }

  return agentCount;
}

function parseAgentFrontmatter(content: string, file: string): ParsedAgent | null {
  const yaml = require('js-yaml');
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const afterFirst = trimmed.slice(3);
  const endPos = afterFirst.indexOf('\n---');
  if (endPos === -1) return null;

  const yamlBlock = afterFirst.slice(0, endPos).trim();
  const meta = yaml.load(yamlBlock);
  if (!meta?.name) return null;

  return {
    name: meta.name,
    description: meta.description,
    category: meta.category,
    trigger: meta.trigger,
    contracts: meta.contracts,
  };
}

/**
 * Clear and rebuild the entire graph from contracts and agents.
 */
export async function rebuildGraph(projectDir: string): Promise<{ contracts: number; agents: number }> {
  const database = await initGraph(projectDir);

  clearGraph(database);

  const contractsDir = path.join(projectDir, '.specflow', 'contracts');
  const agentsDir = path.join(projectDir, 'agents');

  const contracts = buildFromContracts(database, contractsDir);
  const agents = buildFromAgents(database, agentsDir);

  saveDb(database);
  closeGraph(database);

  return { contracts, agents };
}
