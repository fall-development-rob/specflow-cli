/**
 * Contract generation module.
 * Maps project detection results to tailored contract YAML files.
 * Used by `specflow init` and `specflow generate`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DetectionResult } from './detect';
import { green, cyan, dim } from './logger';

export interface ContractDef {
  filename: string;
  id: string;
  title: string;
  source: string;
  rules: RuleDef[];
}

interface RuleDef {
  id: string;
  title: string;
  scope: string[];
  forbidden?: { pattern: string; message: string }[];
  required?: { pattern: string; message: string }[];
  exampleViolation: string;
  exampleCompliant: string;
}

// ── Contract registry keyed by detection signal ────────────────────

function typescriptContracts(): ContractDef[] {
  return [
    {
      filename: 'typescript_no_any.yml',
      id: 'typescript_no_any',
      title: 'No TypeScript Any Types',
      source: 'Detected: typescript',
      rules: [
        {
          id: 'TS-001',
          title: 'Forbid "any" type annotations',
          scope: ['src/**/*.{ts,tsx}', '!src/**/*.test.*', '!src/**/__tests__/**'],
          forbidden: [
            { pattern: '/:\\s*any[\\s;,)]/i', message: 'Avoid "any" type — use a specific type or "unknown"' },
            { pattern: '/as\\s+any/i', message: 'Avoid "as any" cast — use proper type narrowing' },
          ],
          exampleViolation: 'function parse(data: any) {',
          exampleCompliant: 'function parse(data: unknown) {',
        },
      ],
    },
    {
      filename: 'typescript_no_console.yml',
      id: 'typescript_no_console',
      title: 'No Console Logging in Source',
      source: 'Detected: typescript',
      rules: [
        {
          id: 'TS-002',
          title: 'Forbid console.log in production source code',
          scope: ['src/**/*.{ts,tsx}', '!src/**/*.test.*', '!src/**/__tests__/**'],
          forbidden: [
            { pattern: '/console\\.(log|warn|error|debug|info)\\s*\\(/i', message: 'Remove console statement — use a structured logger' },
          ],
          exampleViolation: 'console.log("user data:", user);',
          exampleCompliant: 'logger.info("user data", { userId: user.id });',
        },
      ],
    },
  ];
}

function expressContracts(): ContractDef[] {
  return [
    {
      filename: 'express_auth_routes.yml',
      id: 'express_auth_routes',
      title: 'Auth Middleware on Routes',
      source: 'Detected: express',
      rules: [
        {
          id: 'EXPRESS-001',
          title: 'API routes should reference auth middleware',
          scope: ['src/**/routes/**/*.{ts,js}', 'src/**/api/**/*.{ts,js}'],
          forbidden: [
            { pattern: '/router\\.(get|post|put|patch|delete)\\s*\\(\\s*[\'"][^)]*,\\s*(async\\s+)?\\(req/i', message: 'Route handler appears to lack auth middleware — add authenticate()' },
          ],
          exampleViolation: 'router.get("/users", async (req, res) => {',
          exampleCompliant: 'router.get("/users", authenticate(), async (req, res) => {',
        },
      ],
    },
    {
      filename: 'express_no_body_spread.yml',
      id: 'express_no_body_spread',
      title: 'No Request Body Spread',
      source: 'Detected: express',
      rules: [
        {
          id: 'EXPRESS-002',
          title: 'Forbid spreading req.body into objects',
          scope: ['src/**/*.{ts,js}', '!src/**/*.test.*'],
          forbidden: [
            { pattern: '/\\.\\.\\.req\\.body/i', message: 'Do not spread req.body — destructure specific fields to prevent mass assignment' },
          ],
          exampleViolation: 'const user = { ...req.body, role: "user" };',
          exampleCompliant: 'const { name, email } = req.body;',
        },
      ],
    },
    {
      filename: 'express_error_handling.yml',
      id: 'express_error_handling',
      title: 'Express Error Handling',
      source: 'Detected: express',
      rules: [
        {
          id: 'EXPRESS-003',
          title: 'Async route handlers must have error handling',
          scope: ['src/**/routes/**/*.{ts,js}', 'src/**/api/**/*.{ts,js}'],
          forbidden: [
            { pattern: '/res\\.status\\(500\\)\\.json\\(\\{\\s*error:\\s*err\\.message/i', message: 'Do not leak internal error messages to clients — use generic error responses' },
          ],
          exampleViolation: 'res.status(500).json({ error: err.message });',
          exampleCompliant: 'res.status(500).json({ error: "Internal server error" });',
        },
      ],
    },
  ];
}

function drizzleContracts(): ContractDef[] {
  return [
    {
      filename: 'drizzle_no_type_bypass.yml',
      id: 'drizzle_no_type_bypass',
      title: 'No ORM Type Bypass',
      source: 'Detected: drizzle-orm',
      rules: [
        {
          id: 'ORM-001',
          title: 'Forbid "as any" casts on Drizzle queries',
          scope: ['src/**/*.{ts,tsx}', '!src/**/*.test.*'],
          forbidden: [
            { pattern: '/(?:db|drizzle)\\.[a-zA-Z]+.*as\\s+any/i', message: 'Do not bypass Drizzle type safety with "as any"' },
          ],
          exampleViolation: 'const rows = await db.select().from(users) as any;',
          exampleCompliant: 'const rows = await db.select().from(users);',
        },
      ],
    },
    {
      filename: 'drizzle_parameterised_queries.yml',
      id: 'drizzle_parameterised_queries',
      title: 'Parameterised Queries',
      source: 'Detected: drizzle-orm',
      rules: [
        {
          id: 'ORM-002',
          title: 'Forbid raw SQL string interpolation',
          scope: ['src/**/*.{ts,tsx,js,jsx}', '!src/**/*.test.*'],
          forbidden: [
            { pattern: '/sql`[^`]*\\$\\{(?!sql)/i', message: 'SQL injection risk — use sql placeholder, not string interpolation' },
          ],
          exampleViolation: 'db.execute(sql`SELECT * FROM users WHERE id = ${userId}`)',
          exampleCompliant: 'db.execute(sql`SELECT * FROM users WHERE id = ${sql.placeholder("id")}`, { id: userId })',
        },
      ],
    },
  ];
}

function reactContracts(): ContractDef[] {
  return [
    {
      filename: 'react_no_inline_styles.yml',
      id: 'react_no_inline_styles',
      title: 'No Inline Styles',
      source: 'Detected: react',
      rules: [
        {
          id: 'REACT-001',
          title: 'Forbid inline style objects in JSX',
          scope: ['src/**/*.{tsx,jsx}'],
          forbidden: [
            { pattern: '/style\\s*=\\s*\\{\\{/i', message: 'Inline style detected — use CSS classes, modules, or styled-components' },
          ],
          exampleViolation: '<div style={{ color: "red", fontSize: 14 }}>',
          exampleCompliant: '<div className="error-text">',
        },
      ],
    },
    {
      filename: 'react_no_any_props.yml',
      id: 'react_no_any_props',
      title: 'No Any Props',
      source: 'Detected: react + typescript',
      rules: [
        {
          id: 'REACT-002',
          title: 'Forbid "any" in React component props',
          scope: ['src/**/*.{tsx}'],
          forbidden: [
            { pattern: '/Props\\s*=\\s*\\{[^}]*:\\s*any/i', message: 'Prop type uses "any" — define a specific type' },
          ],
          exampleViolation: 'type Props = { data: any; onSubmit: any };',
          exampleCompliant: 'type Props = { data: UserData; onSubmit: (values: FormValues) => void };',
        },
      ],
    },
  ];
}

function prismaContracts(): ContractDef[] {
  return [
    {
      filename: 'prisma_no_raw_sql.yml',
      id: 'prisma_no_raw_sql',
      title: 'No Raw SQL in Prisma',
      source: 'Detected: prisma',
      rules: [
        {
          id: 'PRISMA-001',
          title: 'Forbid raw SQL queries via Prisma',
          scope: ['src/**/*.{ts,tsx,js,jsx}', '!src/**/*.test.*'],
          forbidden: [
            { pattern: '/\\$queryRaw\\s*`/i', message: 'Avoid $queryRaw — use Prisma client methods for type safety' },
            { pattern: '/\\$executeRaw\\s*`/i', message: 'Avoid $executeRaw — use Prisma client methods for type safety' },
          ],
          exampleViolation: 'const users = await prisma.$queryRaw`SELECT * FROM users`;',
          exampleCompliant: 'const users = await prisma.user.findMany();',
        },
      ],
    },
    {
      filename: 'prisma_migration_required.yml',
      id: 'prisma_migration_required',
      title: 'Migration Required for Schema Changes',
      source: 'Detected: prisma',
      rules: [
        {
          id: 'PRISMA-002',
          title: 'Schema changes must have corresponding migrations',
          scope: ['prisma/schema.prisma'],
          required: [
            { pattern: '/model\\s+\\w+/', message: 'Prisma schema must define models — ensure migrations are generated' },
          ],
          exampleViolation: '// Empty schema with no models',
          exampleCompliant: 'model User {\n  id Int @id @default(autoincrement())\n}',
        },
      ],
    },
  ];
}

function djangoContracts(): ContractDef[] {
  return [
    {
      filename: 'django_no_raw_sql.yml',
      id: 'django_no_raw_sql',
      title: 'No Raw SQL in Django',
      source: 'Detected: django',
      rules: [
        {
          id: 'DJANGO-001',
          title: 'Forbid raw SQL in Django views',
          scope: ['**/*.py', '!**/tests/**', '!**/test_*.py'],
          forbidden: [
            { pattern: '/\\.raw\\s*\\(/i', message: 'Avoid raw SQL — use Django ORM querysets' },
            { pattern: '/cursor\\(\\)\\.execute\\s*\\(/i', message: 'Avoid raw cursor.execute — use Django ORM' },
          ],
          exampleViolation: 'User.objects.raw("SELECT * FROM auth_user WHERE id = %s" % user_id)',
          exampleCompliant: 'User.objects.filter(id=user_id)',
        },
      ],
    },
    {
      filename: 'django_csrf_protection.yml',
      id: 'django_csrf_protection',
      title: 'CSRF Protection',
      source: 'Detected: django',
      rules: [
        {
          id: 'DJANGO-002',
          title: 'Forbid CSRF exemptions in views',
          scope: ['**/*.py', '!**/tests/**'],
          forbidden: [
            { pattern: '/@csrf_exempt/i', message: 'Do not disable CSRF protection — use proper CSRF tokens' },
          ],
          exampleViolation: '@csrf_exempt\ndef my_view(request):',
          exampleCompliant: 'def my_view(request):  # CSRF protection active',
        },
      ],
    },
    {
      filename: 'django_no_secret_settings.yml',
      id: 'django_no_secret_settings',
      title: 'No Secrets in Settings',
      source: 'Detected: django',
      rules: [
        {
          id: 'DJANGO-003',
          title: 'Forbid hardcoded SECRET_KEY in settings',
          scope: ['**/settings.py', '**/settings/**/*.py'],
          forbidden: [
            { pattern: '/SECRET_KEY\\s*=\\s*[\'"][^\'"]{8,}[\'"]/i', message: 'SECRET_KEY must come from environment variable, not hardcoded' },
          ],
          exampleViolation: "SECRET_KEY = 'django-insecure-abc123def456'",
          exampleCompliant: "SECRET_KEY = os.environ['DJANGO_SECRET_KEY']",
        },
      ],
    },
  ];
}

function goContracts(): ContractDef[] {
  return [
    {
      filename: 'go_error_handling.yml',
      id: 'go_error_handling',
      title: 'Go Error Handling',
      source: 'Detected: go.mod',
      rules: [
        {
          id: 'GO-001',
          title: 'Forbid ignoring errors with blank identifier',
          scope: ['**/*.go', '!**/*_test.go'],
          forbidden: [
            { pattern: '/,\\s*_\\s*=.*\\(.*\\)/i', message: 'Do not ignore errors with _ — handle or propagate them' },
          ],
          exampleViolation: 'result, _ = doSomething()',
          exampleCompliant: 'result, err := doSomething()\nif err != nil { return err }',
        },
      ],
    },
    {
      filename: 'go_no_panics.yml',
      id: 'go_no_panics',
      title: 'No Panics in Production',
      source: 'Detected: go.mod',
      rules: [
        {
          id: 'GO-002',
          title: 'Forbid panic() in production code',
          scope: ['**/*.go', '!**/*_test.go', '!**/main.go'],
          forbidden: [
            { pattern: '/\\bpanic\\s*\\(/i', message: 'Do not use panic() — return errors instead' },
          ],
          exampleViolation: 'panic("unexpected state")',
          exampleCompliant: 'return fmt.Errorf("unexpected state: %v", state)',
        },
      ],
    },
  ];
}

function envContracts(): ContractDef[] {
  return [
    {
      filename: 'env_vars_documented.yml',
      id: 'env_vars_documented',
      title: 'Environment Variables Documented',
      source: 'Detected: .env.example',
      rules: [
        {
          id: 'ENV-001',
          title: 'Environment variables must be documented',
          scope: ['.env.example'],
          required: [
            { pattern: '/^[A-Z_]+=/', message: '.env.example must list all required environment variables' },
          ],
          exampleViolation: '# Empty .env.example',
          exampleCompliant: 'DATABASE_URL=\nAPI_KEY=\nNODE_ENV=development',
        },
      ],
    },
  ];
}

function securityBaselineContracts(): ContractDef[] {
  return [
    {
      filename: 'security_secrets.yml',
      id: 'security_secrets',
      title: 'No Hardcoded Secrets',
      source: 'Baseline security — always generated',
      rules: [
        {
          id: 'SEC-001',
          title: 'No hardcoded secrets in source code',
          scope: ['src/**/*.{ts,js,tsx,jsx,py,go}', '!src/**/*.test.*', '!src/**/__tests__/**'],
          forbidden: [
            { pattern: '/(password|secret|api_key|apikey|token)\\s*[:=]\\s*[\'"][^\'"]{8,}[\'"]/i', message: 'Hardcoded secret detected — use environment variable' },
            { pattern: '/sk_live_[a-zA-Z0-9]{20,}/', message: 'Stripe live key hardcoded — use env var' },
            { pattern: '/ghp_[a-zA-Z0-9]{36}/', message: 'GitHub PAT hardcoded — use env var' },
            { pattern: '/-----BEGIN (RSA |EC )?PRIVATE KEY-----/', message: 'Private key in source code — use secrets manager' },
          ],
          exampleViolation: 'const API_KEY = "sk_live_abc123def456ghi789";',
          exampleCompliant: 'const API_KEY = process.env.STRIPE_SECRET_KEY;',
        },
      ],
    },
    {
      filename: 'security_no_eval.yml',
      id: 'security_no_eval',
      title: 'No eval or Dynamic Code Execution',
      source: 'Baseline security — always generated',
      rules: [
        {
          id: 'SEC-002',
          title: 'Forbid eval and Function constructor',
          scope: ['src/**/*.{ts,js,tsx,jsx}', '!src/**/*.test.*'],
          forbidden: [
            { pattern: '/\\beval\\s*\\(/i', message: 'eval() is a code injection risk — use JSON.parse or safe alternatives' },
            { pattern: '/new\\s+Function\\s*\\(/i', message: 'Function constructor is equivalent to eval — avoid dynamic code execution' },
          ],
          exampleViolation: 'const result = eval(userExpression);',
          exampleCompliant: 'const result = JSON.parse(userInput);',
        },
      ],
    },
  ];
}

// ── YAML generation ────────────────────────────────────────────────

/** Escape double quotes inside a YAML double-quoted string. */
function yamlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Indent every line of a multi-line string for YAML block scalar. */
function indentBlock(s: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return s.split('\n').map(line => pad + line).join('\n');
}

function renderContractYaml(def: ContractDef): string {
  const rulesYaml = def.rules.map(rule => {
    const scopeLines = rule.scope.map(s => `        - "${s}"`).join('\n');

    let behaviorYaml = '';
    if (rule.forbidden && rule.forbidden.length > 0) {
      const patterns = rule.forbidden.map(p =>
        `          - pattern: ${p.pattern}\n            message: "${yamlEscape(p.message)}"`
      ).join('\n');
      behaviorYaml += `        forbidden_patterns:\n${patterns}\n`;
    }
    if (rule.required && rule.required.length > 0) {
      const patterns = rule.required.map(p =>
        `          - pattern: ${p.pattern}\n            message: "${yamlEscape(p.message)}"`
      ).join('\n');
      behaviorYaml += `        required_patterns:\n${patterns}\n`;
    }

    const violationBlock = indentBlock(rule.exampleViolation, 10).trimStart();
    const compliantBlock = indentBlock(rule.exampleCompliant, 10).trimStart();

    return `    - id: ${rule.id}
      title: "${yamlEscape(rule.title)}"
      scope:
${scopeLines}
      behavior:
${behaviorYaml}        example_violation: |
          ${violationBlock}
        example_compliant: |
          ${compliantBlock}`;
  }).join('\n\n');

  return `contract_meta:
  id: ${def.id}
  version: 1
  created_from_spec: "${def.source}"
  covers_reqs:
${def.rules.map(r => `    - ${r.id}`).join('\n')}
  owner: "specflow-generated"

llm_policy:
  enforce: true
  llm_may_modify_non_negotiables: false
  override_phrase: "override_contract: ${def.id}"

rules:
  non_negotiable:
${rulesYaml}
`;
}

// ── Public API ─────────────────────────────────────────────────────

export interface GenerateResult {
  contracts: string[];
  skipped: string[];
  detection: DetectionResult;
}

/**
 * Generate contracts based on detection results and write them to disk.
 * Skips contracts whose files already exist (no overwrite).
 */
export function generateContracts(
  detection: DetectionResult,
  contractsDir: string,
  options?: { jsonOutput?: boolean },
): GenerateResult {
  const jsonOutput = options?.jsonOutput ?? false;
  const defs: ContractDef[] = [];

  // Always include security baseline
  defs.push(...securityBaselineContracts());

  // Language-specific
  if (detection.language === 'typescript') {
    defs.push(...typescriptContracts());
  }
  if (detection.language === 'go') {
    defs.push(...goContracts());
  }

  // Framework-specific
  if (detection.framework === 'express' || detection.framework === 'fastify' || detection.framework === 'koa' || detection.framework === 'hono') {
    defs.push(...expressContracts());
  }
  if (detection.framework === 'react' || detection.framework === 'next') {
    defs.push(...reactContracts());
  }
  if (detection.framework === 'django') {
    defs.push(...djangoContracts());
  }

  // ORM-specific
  if (detection.orm === 'drizzle') {
    defs.push(...drizzleContracts());
  }
  if (detection.orm === 'prisma') {
    defs.push(...prismaContracts());
  }

  // Env documentation
  if (detection.hasEnvExample) {
    defs.push(...envContracts());
  }

  // Ensure contracts dir exists
  if (!fs.existsSync(contractsDir)) {
    fs.mkdirSync(contractsDir, { recursive: true });
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const def of defs) {
    const filepath = path.join(contractsDir, def.filename);
    if (fs.existsSync(filepath)) {
      skipped.push(def.filename);
      continue;
    }

    const yaml = renderContractYaml(def);
    fs.writeFileSync(filepath, yaml, 'utf-8');
    written.push(def.filename);

    if (!jsonOutput) {
      console.log(`  ${green('+')} Generated ${cyan(def.filename)} — ${def.title}`);
    }
  }

  if (skipped.length > 0 && !jsonOutput) {
    console.log(`  ${dim(`Skipped ${skipped.length} existing contracts`)}`);
  }

  return { contracts: written, skipped, detection };
}

/**
 * Return a human-readable summary line for the generate result.
 */
export function generateSummary(detection: DetectionResult, result: GenerateResult): string {
  const parts: string[] = [];
  if (detection.language) parts.push(detection.language);
  if (detection.framework) parts.push(detection.framework);
  if (detection.orm) parts.push(detection.orm);
  const stack = parts.length > 0 ? parts.join('/') : 'unknown stack';
  return `Generated ${result.contracts.length} contracts for ${stack}`;
}
