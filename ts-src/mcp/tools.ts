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
    {
      name: 'specflow_get_schema',
      description: 'Returns the complete YAML contract schema specification as structured JSON',
      inputSchema: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            enum: ['full', 'fields', 'patterns', 'examples'],
            description: 'Schema section to return (defaults to full)',
          },
        },
      },
    },
    {
      name: 'specflow_get_example',
      description: 'Returns an annotated example contract YAML for a given type',
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['security', 'accessibility', 'feature', 'journey'],
            description: 'Type of example contract (defaults to security)',
          },
        },
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
    case 'specflow_get_schema': return handleGetSchema(args);
    case 'specflow_get_example': return handleGetExample(args);
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
  const filePath = args.file_path || undefined;

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

function handleGetSchema(args: any): ToolCallResult {
  const section = args.section || 'full';

  const fields = {
    contract_meta: {
      id: { type: 'string', required: true, description: 'Unique contract identifier (e.g. feature_auth, security_defaults)' },
      version: { type: 'integer', required: true, description: 'Schema version, increment on changes' },
      created_from_spec: { type: 'string', required: false, description: 'Source reference (issue number, spec doc)' },
      covers_reqs: { type: 'string[]', required: false, description: 'Requirement IDs this contract covers' },
      owner: { type: 'string', required: false, description: 'Team or person responsible' },
    },
    llm_policy: {
      enforce: { type: 'boolean', required: true, description: 'Whether this contract is actively enforced' },
      llm_may_modify_non_negotiables: { type: 'boolean', required: true, description: 'If false, LLM cannot override non-negotiable rules' },
      override_phrase: { type: 'string', required: true, description: 'Human command to override (e.g. override_contract: <id>)' },
    },
    rules: {
      non_negotiable: {
        type: 'array',
        required: true,
        description: 'Rules that must always pass — violations fail the build',
        item_fields: {
          id: { type: 'string', required: true, description: 'Rule ID (e.g. SEC-001, ARCH-002)' },
          title: { type: 'string', required: true, description: 'Human-readable rule description' },
          scope: { type: 'string[]', required: true, description: 'Glob patterns for files to check (supports ! negation)' },
          behavior: {
            type: 'object',
            required: true,
            fields: {
              forbidden_patterns: { type: 'array', required: false, description: 'Patterns that must NOT match (violations)' },
              required_patterns: { type: 'array', required: false, description: 'Patterns that MUST match (missing = violation)' },
              example_violation: { type: 'string', required: false, description: 'Code example that would fail this rule' },
              example_compliant: { type: 'string', required: false, description: 'Code example that would pass this rule' },
            },
          },
          auto_fix: {
            type: 'object',
            required: false,
            description: 'Optional fix hints for heal-loop agent',
            fields: {
              strategy: { type: 'string', enum: ['add_import', 'remove_pattern', 'wrap_with', 'replace_with'], description: 'Fix strategy to apply' },
            },
          },
        },
      },
      soft: {
        type: 'array',
        required: false,
        description: 'Advisory rules — warnings, not build failures',
        item_fields: {
          id: { type: 'string', required: true, description: 'Rule ID' },
          title: { type: 'string', required: true, description: 'Human-readable description' },
          suggestion: { type: 'string', required: true, description: 'What to do about it' },
          llm_may_bend_if: { type: 'string[]', required: false, description: 'Conditions where bending is acceptable' },
        },
      },
    },
    compliance_checklist: {
      before_editing_files: {
        type: 'array',
        required: false,
        description: 'Pre-edit checklist questions',
        item_fields: {
          question: { type: 'string', required: true },
          if_yes: { type: 'string', required: true },
        },
      },
    },
    test_hooks: {
      tests: {
        type: 'array',
        required: false,
        description: 'Test files that verify this contract',
        item_fields: {
          file: { type: 'string', required: true },
          description: { type: 'string', required: false },
        },
      },
    },
    pattern_format: {
      syntax: '/regex/flags',
      supported_flags: ['i (case-insensitive)', 'g (global)', 'm (multiline)'],
      examples: [
        { pattern: '/localStorage/', matches: 'Any use of localStorage' },
        { pattern: '/supabase\\.(from|rpc)/', matches: 'Direct Supabase calls' },
        { pattern: '/(password|secret)\\s*[:=]\\s*[\'"][^\'"]{8,}[\'"]/i', matches: 'Hardcoded secrets' },
      ],
    },
    scope_format: {
      syntax: 'glob patterns',
      examples: [
        { pattern: 'src/**/*.ts', matches: 'All TypeScript files under src/' },
        { pattern: 'src/**/*.{ts,tsx}', matches: 'TypeScript and TSX files' },
        { pattern: '!src/**/*.test.*', matches: 'Exclude test files (negation)' },
      ],
    },
  };

  if (section === 'fields') {
    const { pattern_format, scope_format, ...fieldDefs } = fields;
    return toolResultText(JSON.stringify(fieldDefs, null, 2));
  }
  if (section === 'patterns') {
    return toolResultText(JSON.stringify({ pattern_format: fields.pattern_format, scope_format: fields.scope_format }, null, 2));
  }
  if (section === 'examples') {
    return handleGetExample({ type: 'security' });
  }
  return toolResultText(JSON.stringify(fields, null, 2));
}

function handleGetExample(args: any): ToolCallResult {
  const exampleType = args.type || 'security';

  const examples: Record<string, string> = {
    security: `# Security contract — OWASP-aligned baseline patterns
# Every field is annotated with its purpose

contract_meta:
  id: security_defaults                   # Unique identifier for this contract
  version: 1                              # Increment when rules change
  created_from_spec: "OWASP Top 10"       # Where the rules come from
  covers_reqs:                            # Requirement IDs covered
    - SEC-001
    - SEC-002
  owner: "security-team"                  # Who maintains this contract

llm_policy:
  enforce: true                           # Active enforcement (false = disabled)
  llm_may_modify_non_negotiables: false   # LLM cannot override these rules
  override_phrase: "override_contract: security_defaults"  # Human override command

rules:
  non_negotiable:                         # These MUST pass — violations fail the build
    - id: SEC-001                         # Rule identifier
      title: "No hardcoded secrets"       # Human-readable description
      scope:                              # Which files to check (glob patterns)
        - "src/**/*.{ts,js,tsx,jsx}"      # All source files
        - "!src/**/*.test.*"              # Except test files
      behavior:
        forbidden_patterns:               # Patterns that must NOT appear
          - pattern: /(password|secret|api_key)\\s*[:=]\\s*['"][^'"]{8,}['"]/i
            message: "Hardcoded secret detected — use environment variable"
        example_violation: |              # Code that would FAIL this rule
          const API_KEY = "sk_live_abc123def456"
        example_compliant: |              # Code that would PASS this rule
          const API_KEY = process.env.API_KEY

    - id: SEC-002
      title: "No SQL string concatenation"
      scope:
        - "src/**/*.{ts,tsx,js,jsx}"
      behavior:
        forbidden_patterns:
          - pattern: /query\\s*\\(\\s*['\`].*\\$\\{/
            message: "SQL injection risk — use parameterized queries"
        example_violation: |
          db.query(\`SELECT * FROM users WHERE id = '\${userId}'\`)
        example_compliant: |
          db.query('SELECT * FROM users WHERE id = $1', [userId])

compliance_checklist:                     # Pre-edit reminders
  before_editing_files:
    - question: "Are you handling user-provided values in queries?"
      if_yes: "Use parameterized queries, never string concatenation"

test_hooks:                               # Associated test files
  tests:
    - file: "src/__tests__/contracts/security_defaults.test.ts"
      description: "Pattern checks for SEC-001 and SEC-002"`,

    accessibility: `# Accessibility contract — WCAG AA baseline patterns

contract_meta:
  id: accessibility_defaults
  version: 1
  created_from_spec: "WCAG 2.1 AA"
  covers_reqs:
    - A11Y-001
    - A11Y-002
  owner: "specflow-defaults"

llm_policy:
  enforce: true
  llm_may_modify_non_negotiables: false
  override_phrase: "override_contract: accessibility_defaults"

rules:
  non_negotiable:
    - id: A11Y-001
      title: "Images must have alt text"
      scope:
        - "src/**/*.{tsx,jsx}"            # Only JSX/TSX files have images
      behavior:
        forbidden_patterns:
          - pattern: /<img\\s+(?![^>]*\\balt\\s*=)[^>]*\\/?>/
            message: "Image missing alt attribute — add alt text for screen readers"
        example_violation: |
          <img src="/avatar.png" />
        example_compliant: |
          <img src="/avatar.png" alt="User avatar" />

    - id: A11Y-002
      title: "Buttons must have accessible labels"
      scope:
        - "src/**/*.{tsx,jsx}"
      behavior:
        forbidden_patterns:
          - pattern: /<button(?![^>]*aria-label)[^>]*>\\s*<(?:svg|img)[^>]*\\/?>\\s*<\\/button>/
            message: "Icon-only button needs aria-label for screen readers"
        example_violation: |
          <button><TrashIcon /></button>
        example_compliant: |
          <button aria-label="Delete item"><TrashIcon /></button>

  soft:                                   # Advisory rules — warnings only
    - id: A11Y-010
      title: "Interactive elements should have focus-visible styles"
      suggestion: "Add :focus-visible styles for keyboard navigation"
      llm_may_bend_if:
        - "Component library provides focus styles"`,

    feature: `# Feature contract — project-specific architectural rules

contract_meta:
  id: feature_user_auth                   # Name matches the feature area
  version: 1
  created_from_spec: "GitHub issue #42"   # Link to the source spec
  covers_reqs:
    - AUTH-001
    - AUTH-002
  owner: "auth-team"

llm_policy:
  enforce: true
  llm_may_modify_non_negotiables: false
  override_phrase: "override_contract: feature_user_auth"

rules:
  non_negotiable:
    - id: AUTH-001
      title: "All API routes require authentication middleware"
      scope:
        - "src/routes/**/*.ts"            # Only route files
      behavior:
        required_patterns:                # Patterns that MUST be present
          - pattern: /authMiddleware/
            message: "Must import and use authMiddleware"
        example_violation: |
          router.get('/api/users', async (req, res) => { ... })
        example_compliant: |
          router.get('/api/users', authMiddleware, async (req, res) => { ... })
      auto_fix:                           # Enables heal-loop agent
        strategy: "wrap_with"             # Wrap route handler with middleware
        wrapper: "authMiddleware"

    - id: AUTH-002
      title: "Tokens must not be stored in localStorage"
      scope:
        - "src/**/*.{ts,tsx}"
        - "!src/**/*.test.*"
      behavior:
        forbidden_patterns:
          - pattern: /localStorage\\.setItem\\s*\\(\\s*['"].*token/i
            message: "Store tokens in httpOnly cookies, not localStorage"
      auto_fix:
        strategy: "replace_with"
        find: "localStorage.setItem"
        replace: "cookieStore.set"

compliance_checklist:
  before_editing_files:
    - question: "Adding a new API route?"
      if_yes: "Include authMiddleware as the second argument"
    - question: "Storing authentication tokens?"
      if_yes: "Use httpOnly cookies via the auth service"

test_hooks:
  tests:
    - file: "src/__tests__/contracts/auth.test.ts"
      description: "Pattern checks for AUTH-001 and AUTH-002"`,

    journey: `# Journey contract — end-to-end user flow verification

journey_meta:
  id: J-USER-LOGIN                        # Journey ID (J- prefix required)
  from_spec: "GitHub issue #42"
  covers_reqs:
    - AUTH-001
    - AUTH-003
  type: "e2e"                             # Journey type
  dod_criticality: critical               # critical | important | future
  status: not_tested                      # not_tested | passing | failing
  last_verified: null                     # ISO timestamp of last run

preconditions:                            # Setup before the journey
  - description: "Test user exists in database"
    setup_hint: "await seedUser(supabase, { email: 'test@example.com' })"
  - description: "User is on the login page"
    setup_hint: "await page.goto('/login')"

steps:                                    # Sequential journey steps
  - step: 1
    name: "Enter email address"
    required_elements:                    # UI elements that must exist
      - selector: "[data-testid='email-input']"
    actions:
      - type: "fill"
        selector: "[data-testid='email-input']"
        value: "test@example.com"
    expected:
      - type: "element_visible"
        selector: "[data-testid='email-input']"

  - step: 2
    name: "Enter password"
    required_elements:
      - selector: "[data-testid='password-input']"
    actions:
      - type: "fill"
        selector: "[data-testid='password-input']"
        value: "SecurePass123!"

  - step: 3
    name: "Submit login form"
    required_elements:
      - selector: "[data-testid='login-submit']"
    actions:
      - type: "click"
        selector: "[data-testid='login-submit']"
    expected:
      - type: "navigation"
        path_contains: "/dashboard"       # Should redirect after login
      - type: "api_call"
        method: "POST"
        path: "/auth/v1/token"

  - step: 4
    name: "Dashboard loads with user info"
    expected:
      - type: "element_visible"
        selector: "[data-testid='user-greeting']"
      - type: "element_not_visible"
        selector: "[data-testid='login-form']"

test_hooks:
  e2e_test_file: "tests/e2e/journeys/user-login.journey.spec.ts"`,
  };

  const example = examples[exampleType];
  if (!example) {
    return toolResultError(`Unknown example type: ${exampleType}. Valid types: security, accessibility, feature, journey`);
  }

  return toolResultText(example);
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
