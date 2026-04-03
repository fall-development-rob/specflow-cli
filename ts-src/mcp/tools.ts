/**
 * MCP tool definitions and dispatch handlers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ToolDefinition, ToolCallResult, toolResultText, toolResultError } from './protocol';
import { loadContracts, scanFiles, checkSnippet, validateContract } from '../lib/native';
import { loadConfig } from '../lib/config';

/** Ensure a resolved path stays within the project root. */
function containPath(userPath: string, base: string = process.cwd()): string | null {
  const resolved = path.resolve(base, userPath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  return resolved;
}

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'specflow_list_contracts',
      description: 'List all contracts in a directory with their rules',
      inputSchema: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Contracts directory (defaults to .specflow/contracts)' } },
      },
    },
    {
      name: 'specflow_check_code',
      description: 'Check a code snippet against all loaded contracts',
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The code to check' },
          file_path: { type: 'string', description: 'Optional virtual file path for scope matching' },
        },
        required: ['code'],
      },
    },
    {
      name: 'specflow_get_violations',
      description: 'Scan a file or directory for contract violations',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File or directory path to scan' } },
        required: ['path'],
      },
    },
    {
      name: 'specflow_validate_contract',
      description: 'Validate a contract YAML file for correctness',
      inputSchema: {
        type: 'object',
        properties: { file: { type: 'string', description: 'Path to the contract YAML file' } },
        required: ['file'],
      },
    },
    {
      name: 'specflow_audit_issue',
      description: 'Audit a GitHub issue for specflow compliance markers',
      inputSchema: {
        type: 'object',
        properties: { issue_number: { type: 'integer', description: 'GitHub issue number to audit' } },
        required: ['issue_number'],
      },
    },
    {
      name: 'specflow_compile_journeys',
      description: 'Compile journey contracts from a CSV file',
      inputSchema: {
        type: 'object',
        properties: { csv_file: { type: 'string', description: 'Path to the journey CSV file' } },
        required: ['csv_file'],
      },
    },
    {
      name: 'specflow_verify_graph',
      description: 'Verify contract graph integrity',
      inputSchema: {
        type: 'object',
        properties: { dir: { type: 'string', description: 'Contracts directory (defaults to .specflow/contracts)' } },
      },
    },
    {
      name: 'specflow_list_agents',
      description: 'List all available agents with their metadata',
      inputSchema: {
        type: 'object',
        properties: { category: { type: 'string', description: 'Filter by category' } },
      },
    },
    {
      name: 'specflow_get_agent',
      description: 'Get full agent prompt and metadata by name',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Agent name' } },
        required: ['name'],
      },
    },
    {
      name: 'specflow_defer_journey',
      description: 'Defer or undefer a journey contract',
      inputSchema: {
        type: 'object',
        properties: {
          journey_id: { type: 'string', description: 'Journey identifier (e.g. J-SIGNUP-FLOW)' },
          reason: { type: 'string', description: 'Reason for deferral' },
          issue: { type: 'string', description: 'Related issue reference' },
          action: { type: 'string', enum: ['defer', 'undefer'], description: 'Whether to defer or undefer' },
        },
        required: ['journey_id', 'reason', 'action'],
      },
    },
  ];
}

export function callTool(name: string, args: any): ToolCallResult {
  switch (name) {
    case 'specflow_list_contracts': return handleListContracts(args);
    case 'specflow_check_code': return handleCheckCode(args);
    case 'specflow_get_violations': return handleGetViolations(args);
    case 'specflow_validate_contract': return handleValidateContract(args);
    case 'specflow_audit_issue': return handleAuditIssue(args);
    case 'specflow_compile_journeys': return handleCompileJourneys(args);
    case 'specflow_verify_graph': return handleVerifyGraph(args);
    case 'specflow_list_agents': return handleListAgents(args);
    case 'specflow_get_agent': return handleGetAgent(args);
    case 'specflow_defer_journey': return handleDeferJourney(args);
    default: return toolResultError(`Unknown tool: ${name}`);
  }
}

function handleListContracts(args: any): ToolCallResult {
  const config = loadConfig();
  const dir = args.dir || config.contractsDir;
  try {
    const contracts = loadContracts(dir);
    let totalRules = 0;
    const contractList = contracts.map(c => {
      const ruleIds = c.rules.map(r => r.id);
      totalRules += ruleIds.length;
      return { id: c.id, file: c.sourceFile, rules: ruleIds.length, rule_ids: ruleIds };
    });
    return toolResultText(JSON.stringify({ contracts: contractList, total_contracts: contracts.length, total_rules: totalRules }, null, 2));
  } catch (e: any) {
    return toolResultError(`Failed to load contracts: ${e.message}`);
  }
}

function handleCheckCode(args: any): ToolCallResult {
  const code = args.code;
  if (!code) return toolResultError('Missing required parameter: code');
  const filePath = args.file_path || 'inline.ts';

  try {
    const config = loadConfig();
    const contracts = loadContracts(config.contractsDir);
    const totalRules = contracts.reduce((sum, c) => sum + c.rules.length, 0);
    const violations = checkSnippet(config.contractsDir, code, filePath);
    const result = {
      clean: violations.length === 0,
      violations: violations.map(v => ({
        contract: v.contractId,
        rule: v.ruleId,
        pattern: v.pattern,
        match: v.matchedText,
        line: v.line,
        message: v.message,
      })),
      rules_checked: totalRules,
      rules_passed: totalRules - violations.length,
    };
    return toolResultText(JSON.stringify(result, null, 2));
  } catch (e: any) {
    return toolResultError(`Failed to check code: ${e.message}`);
  }
}

function handleGetViolations(args: any): ToolCallResult {
  const scanPath = args.path;
  if (!scanPath) return toolResultError('Missing required parameter: path');

  const safePath = containPath(scanPath);
  if (!safePath) return toolResultError('Path must be within the project directory');

  try {
    const config = loadConfig();
    const result = scanFiles(config.contractsDir, safePath);
    const violationList = result.violations.map(v => ({
      contract: v.contractId,
      rule: v.ruleId,
      file: v.file,
      line: v.line,
      pattern: v.pattern,
      match: v.matchedText,
      message: v.message,
      kind: v.kind,
    }));

    const filesViolated = new Set(result.violations.map(v => v.file)).size;
    return toolResultText(JSON.stringify({
      scanned_files: result.filesScanned,
      violations: violationList,
      summary: {
        files_clean: result.filesScanned - filesViolated,
        files_violated: filesViolated,
        total_violations: result.violations.length,
      },
    }, null, 2));
  } catch (e: any) {
    return toolResultError(`Scan failed: ${e.message}`);
  }
}

function handleValidateContract(args: any): ToolCallResult {
  const file = args.file;
  if (!file) return toolResultError('Missing required parameter: file');

  const result = validateContract(file);
  return toolResultText(JSON.stringify(result, null, 2));
}

function handleAuditIssue(args: any): ToolCallResult {
  const issueNumber = args.issue_number;
  if (!issueNumber || typeof issueNumber !== 'number' || !Number.isInteger(issueNumber)) {
    return toolResultError('Missing or invalid parameter: issue_number (must be an integer)');
  }

  try {
    const output = execFileSync(
      'gh', ['issue', 'view', String(issueNumber), '--json', 'title,body,comments'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const parsed = JSON.parse(output);
    const title = parsed.title || '';
    const fullText = [parsed.body || '', ...(parsed.comments || []).map((c: any) => c.body || '')].join('\n');

    const checksSpec = [
      ['gherkin', 'Scenario:'],
      ['acceptance_criteria', '- \\[[ x]\\]'],
      ['journey_id', 'J-[A-Z0-9]+(-[A-Z0-9]+)*'],
      ['data_testid', 'data-testid'],
      ['sql_schema', 'CREATE\\s+(TABLE|FUNCTION|OR REPLACE FUNCTION)'],
      ['rls_policy', 'CREATE\\s+POLICY|ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY'],
      ['invariants', 'I-[A-Z]{2,}-\\d+'],
      ['typescript_types', '(?:interface|type)\\s+\\w+'],
      ['scope_section', '(?i)In Scope|Not In Scope'],
      ['definition_of_done', '(?i)Definition of Done|DoD'],
      ['preflight', 'simulation_status:\\s*\\w+'],
    ];

    const checks: any = {};
    const missing: string[] = [];

    for (const [name, pattern] of checksSpec) {
      const re = new RegExp(pattern, 'i');
      const found = re.test(fullText);
      checks[name] = { found };
      if (!found) missing.push(name);
    }

    return toolResultText(JSON.stringify({
      issue: issueNumber,
      title,
      compliant: missing.length === 0,
      checks,
      missing,
    }, null, 2));
  } catch (e: any) {
    return toolResultError(`Could not fetch issue #${issueNumber}: ${e.message}`);
  }
}

function handleCompileJourneys(args: any): ToolCallResult {
  const csvFile = args.csv_file;
  if (!csvFile) return toolResultError('Missing required parameter: csv_file');

  const script = 'scripts/specflow-compile.cjs';
  if (!fs.existsSync(script)) {
    return toolResultError(`Compiler script not found: ${script}`);
  }

  try {
    const output = execFileSync('node', [script, csvFile], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      return toolResultText(JSON.stringify(JSON.parse(output), null, 2));
    } catch {
      return toolResultText(JSON.stringify({ raw_output: output.trim() }, null, 2));
    }
  } catch (e: any) {
    return toolResultError(`Compiler failed: ${e.message}`);
  }
}

function handleVerifyGraph(args: any): ToolCallResult {
  const config = loadConfig();
  const dir = args.dir || config.contractsDir;
  const script = 'scripts/verify-graph.cjs';
  if (!fs.existsSync(script)) {
    return toolResultError(`Graph verification script not found: ${script}`);
  }

  try {
    const output = execFileSync('node', [script, dir], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return toolResultText(JSON.stringify({ passed: true, raw_output: output.trim() }, null, 2));
  } catch (e: any) {
    return toolResultText(JSON.stringify({ passed: false, raw_output: e.stdout || e.message }, null, 2));
  }
}

function handleListAgents(args: any): ToolCallResult {
  const category = args.category;
  const agentsDir = 'agents';

  try {
    const { list } = require('../commands/agent');
    // Capture stdout
    const agents = getAgentList(agentsDir, category);
    return toolResultText(JSON.stringify({ agents, total: agents.length }, null, 2));
  } catch (e: any) {
    return toolResultError(`Failed to load agents: ${e.message}`);
  }
}

function handleGetAgent(args: any): ToolCallResult {
  const name = args.name;
  if (!name) return toolResultError('Missing required parameter: name');
  if (/[\/\\]/.test(name)) return toolResultError('Invalid agent name');

  const agentsDir = path.resolve('agents');
  const filePath = path.join(agentsDir, `${name}.md`);
  if (!filePath.startsWith(agentsDir + path.sep)) return toolResultError('Invalid agent name');

  if (!fs.existsSync(filePath)) {
    return toolResultError(`Agent not found: ${name}`);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const yaml = require('js-yaml');
    const trimmed = content.trimStart();
    if (trimmed.startsWith('---')) {
      const afterFirst = trimmed.slice(3);
      const endPos = afterFirst.indexOf('\n---');
      if (endPos !== -1) {
        const yamlBlock = afterFirst.slice(0, endPos).trim();
        const meta = yaml.load(yamlBlock);
        const body = afterFirst.slice(endPos + 4).replace(/^\n+/, '');
        return toolResultText(JSON.stringify({ ...meta, content: body }, null, 2));
      }
    }
    return toolResultText(JSON.stringify({ name, content }, null, 2));
  } catch (e: any) {
    return toolResultError(`Failed to read agent: ${e.message}`);
  }
}

function handleDeferJourney(args: any): ToolCallResult {
  const journeyId = args.journey_id;
  const reason = args.reason;
  const action = args.action;

  if (!journeyId) return toolResultError('Missing required parameter: journey_id');
  if (!/^J-[A-Z0-9-]+$/.test(journeyId)) return toolResultError('Invalid journey ID format');
  if (!reason) return toolResultError('Missing required parameter: reason');
  if (!action) return toolResultError('Missing required parameter: action');
  if (action !== 'defer' && action !== 'undefer') {
    return toolResultError("action must be 'defer' or 'undefer'");
  }

  const deferDir = path.join('.specflow', 'contracts', '.deferred');
  const deferFile = path.join(deferDir, `${journeyId}.json`);

  if (action === 'defer') {
    fs.mkdirSync(deferDir, { recursive: true });
    const deferral = {
      journey_id: journeyId,
      reason,
      issue: args.issue || '',
      deferred_at: new Date().toISOString(),
    };
    fs.writeFileSync(deferFile, JSON.stringify(deferral, null, 2));
    return toolResultText(JSON.stringify({ deferred: true, journey_id: journeyId }, null, 2));
  } else {
    if (fs.existsSync(deferFile)) {
      fs.unlinkSync(deferFile);
      return toolResultText(JSON.stringify({ deferred: false, journey_id: journeyId }, null, 2));
    }
    return toolResultText(JSON.stringify({ deferred: false, journey_id: journeyId, note: 'was not deferred' }, null, 2));
  }
}

function getAgentList(agentsDir: string, category?: string): any[] {
  if (!fs.existsSync(agentsDir)) return [];

  const yaml = require('js-yaml');
  const excluded = ['README.md', 'PROTOCOL.md', 'WORKFLOW.md'];
  const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md') && !excluded.includes(f));
  const agents: any[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
      const trimmed = content.trimStart();
      if (!trimmed.startsWith('---')) continue;

      const afterFirst = trimmed.slice(3);
      const endPos = afterFirst.indexOf('\n---');
      if (endPos === -1) continue;

      const yamlBlock = afterFirst.slice(0, endPos).trim();
      const meta = yaml.load(yamlBlock);

      if (category && meta.category?.toLowerCase() !== category.toLowerCase()) continue;

      agents.push({
        name: meta.name,
        description: meta.description,
        category: meta.category,
        trigger: meta.trigger || '',
      });
    } catch {
      // skip
    }
  }

  return agents.sort((a, b) => (a.category || '').localeCompare(b.category || '') || (a.name || '').localeCompare(b.name || ''));
}
