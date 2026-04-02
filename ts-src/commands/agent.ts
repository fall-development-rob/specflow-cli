/**
 * specflow agent list|show|search
 * Agent registry — scan agents/*.md, parse YAML frontmatter.
 */

import * as fs from 'fs';
import * as path from 'path';
import { bold, cyan, dim } from '../lib/logger';

interface AgentMeta {
  name: string;
  description: string;
  category: string;
  trigger: string;
  inputs: string[];
  outputs: string[];
  contracts: string[];
}

interface Agent {
  meta: AgentMeta;
  filePath: string;
  content: string;
}

const EXCLUDED_FILES = ['README.md', 'PROTOCOL.md', 'WORKFLOW.md'];

function parseFrontmatter(content: string): { meta: AgentMeta; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    throw new Error('No frontmatter found (file must start with ---)');
  }

  const afterFirst = trimmed.slice(3);
  const endPos = afterFirst.indexOf('\n---');
  if (endPos === -1) {
    throw new Error('No closing --- found for frontmatter');
  }

  const yamlBlock = afterFirst.slice(0, endPos).trim();
  const bodyStart = endPos + 4;
  const body = bodyStart < afterFirst.length
    ? afterFirst.slice(bodyStart).replace(/^\n+/, '')
    : '';

  // Parse YAML manually (avoid requiring js-yaml just for frontmatter)
  let yaml: any;
  try {
    yaml = require('js-yaml');
  } catch {
    // Fallback: simple key-value parsing
    return { meta: parseSimpleYaml(yamlBlock), body };
  }

  const parsed = yaml.load(yamlBlock);
  const meta: AgentMeta = {
    name: parsed.name || '',
    description: parsed.description || '',
    category: parsed.category || '',
    trigger: parsed.trigger || '',
    inputs: parsed.inputs || [],
    outputs: parsed.outputs || [],
    contracts: parsed.contracts || [],
  };

  if (!meta.name) throw new Error('Agent name is required');
  if (!meta.description) throw new Error('Agent description is required');
  if (!meta.category) throw new Error('Agent category is required');

  return { meta, body };
}

function parseSimpleYaml(block: string): AgentMeta {
  const meta: any = { name: '', description: '', category: '', trigger: '', inputs: [], outputs: [], contracts: [] };
  for (const line of block.split('\n')) {
    const match = line.match(/^(\w+):\s*(.+)/);
    if (match) {
      const key = match[1];
      const val = match[2].replace(/^["']|["']$/g, '');
      if (key in meta) {
        (meta as any)[key] = val;
      }
    }
  }
  return meta;
}

function loadRegistry(agentsDir: string): Map<string, Agent> {
  const agents = new Map<string, Agent>();

  if (!fs.existsSync(agentsDir)) return agents;

  const files = fs.readdirSync(agentsDir)
    .filter(f => f.endsWith('.md') && !EXCLUDED_FILES.includes(f));

  for (const file of files) {
    try {
      const filePath = path.join(agentsDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const { meta, body } = parseFrontmatter(content);
      agents.set(meta.name, { meta, filePath, content: body });
    } catch (e: any) {
      process.stderr.write(`Warning: skipping ${file}: ${e.message}\n`);
    }
  }

  return agents;
}

function searchAgents(agents: Map<string, Agent>, query: string): Agent[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...agents.values()];

  const scored: Array<{ score: number; agent: Agent }> = [];

  for (const agent of agents.values()) {
    let score = 0;
    const nameLower = agent.meta.name.toLowerCase();
    const triggerLower = agent.meta.trigger.toLowerCase();
    const catLower = agent.meta.category.toLowerCase();
    const descLower = agent.meta.description.toLowerCase();

    for (const token of tokens) {
      if (nameLower.includes(token)) score += 3;
      if (triggerLower.includes(token)) score += 2;
      if (catLower === token) score += 2;
      if (descLower.includes(token)) score += 1;
    }

    if (score > 0) scored.push({ score, agent });
  }

  scored.sort((a, b) => b.score - a.score || a.agent.meta.name.localeCompare(b.agent.meta.name));
  return scored.map(s => s.agent);
}

interface AgentListOptions {
  category?: string;
  json?: boolean;
}

interface AgentShowOptions {
  name: string;
}

interface AgentSearchOptions {
  query: string;
  json?: boolean;
}

export function list(agentsDir: string, options: AgentListOptions): void {
  const registry = loadRegistry(agentsDir);
  let agents = [...registry.values()];

  if (options.category) {
    agents = agents.filter(a => a.meta.category.toLowerCase() === options.category!.toLowerCase());
  }

  agents.sort((a, b) => a.meta.category.localeCompare(b.meta.category) || a.meta.name.localeCompare(b.meta.name));

  if (options.json) {
    const summaries = agents.map(a => ({
      name: a.meta.name,
      description: a.meta.description,
      category: a.meta.category,
      trigger: a.meta.trigger,
    }));
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  // Count categories
  const categories = new Set(agents.map(a => a.meta.category));
  console.log(`${agents.length} agents across ${categories.size} categories\n`);

  let currentCat = '';
  for (const agent of agents) {
    if (agent.meta.category !== currentCat) {
      currentCat = agent.meta.category;
      console.log(bold(cyan(currentCat.toUpperCase())));
    }
    console.log(`  ${bold(agent.meta.name.padEnd(28))} ${agent.meta.description}`);
  }
}

export function show(agentsDir: string, options: AgentShowOptions): void {
  const registry = loadRegistry(agentsDir);
  const agent = registry.get(options.name);

  if (!agent) {
    console.error(`Agent not found: ${options.name}`);
    const results = searchAgents(registry, options.name);
    if (results.length > 0) {
      console.error('\nDid you mean:');
      for (const r of results.slice(0, 3)) {
        console.error(`  ${r.meta.name}`);
      }
    }
    process.exit(1);
    return;
  }

  if (process.stdout.isTTY) {
    console.log(`${bold(`# ${agent.meta.name}`)} (${agent.meta.category})\n`);
    console.log(agent.meta.description);
    if (agent.meta.inputs.length > 0) {
      console.log(`\nInputs:  ${agent.meta.inputs.join(', ')}`);
    }
    if (agent.meta.outputs.length > 0) {
      console.log(`Outputs: ${agent.meta.outputs.join(', ')}`);
    }
    if (agent.meta.contracts.length > 0) {
      console.log(`Contracts: ${agent.meta.contracts.join(', ')}`);
    }
    console.log('\n---\n');
  }
  console.log(agent.content);
}

export function search(agentsDir: string, options: AgentSearchOptions): void {
  const registry = loadRegistry(agentsDir);
  const results = searchAgents(registry, options.query);

  if (options.json) {
    const summaries = results.map(a => ({
      name: a.meta.name,
      description: a.meta.description,
      category: a.meta.category,
      trigger: a.meta.trigger,
    }));
    console.log(JSON.stringify(summaries, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`No agents found matching "${options.query}"`);
    return;
  }

  console.log(`${results.length} agents matching "${options.query}"\n`);
  for (const agent of results) {
    console.log(
      `  ${bold(agent.meta.name.padEnd(28))} [${agent.meta.category}] ${agent.meta.description}`
    );
  }
}
