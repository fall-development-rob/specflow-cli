/**
 * specflow compile <csv-file>
 * Compile journey contracts from CSV.
 */

import * as fs from 'fs';
import * as path from 'path';

interface CompileOptions {
  args: string[];
}

// CSV parsing
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

const REQUIRED_HEADERS = ['journey_id', 'journey_name', 'step', 'user_does', 'system_shows', 'critical', 'owner', 'notes'];

function parseCsv(content: string): { headers: string[]; rows: any[] } {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV must have at least a header and one data row');

  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  for (const required of REQUIRED_HEADERS) {
    if (!headers.includes(required)) {
      throw new Error(`Missing required CSV header: ${required}`);
    }
  }

  const rows = lines.slice(1).map((line, idx) => {
    const fields = parseCsvLine(line);
    const row: any = {};
    headers.forEach((h, i) => { row[h] = fields[i] || ''; });
    row._line = idx + 2;
    return row;
  });

  return { headers, rows };
}

function validateRows(rows: any[]): string[] {
  const errors: string[] = [];
  const journeyIdPattern = /^J-[A-Z][A-Z0-9-]+$/;
  const seenIds = new Set<string>();

  for (const row of rows) {
    if (!journeyIdPattern.test(row.journey_id)) {
      errors.push(`Line ${row._line}: Invalid journey_id "${row.journey_id}" (expected J-[A-Z][A-Z0-9-]+)`);
    }
    const key = `${row.journey_id}:${row.step}`;
    if (seenIds.has(key)) {
      errors.push(`Line ${row._line}: Duplicate step ${row.step} for ${row.journey_id}`);
    }
    seenIds.add(key);
  }

  return errors;
}

interface Journey {
  id: string;
  name: string;
  owner: string;
  critical: string;
  steps: any[];
  acceptance_criteria: string[];
}

function groupByJourney(rows: any[]): Map<string, Journey> {
  const map = new Map<string, Journey>();
  for (const row of rows) {
    let j = map.get(row.journey_id);
    if (!j) {
      j = {
        id: row.journey_id,
        name: row.journey_name,
        owner: row.owner,
        critical: row.critical,
        steps: [],
        acceptance_criteria: [],
      };
      map.set(row.journey_id, j);
    }
    j.steps.push(row);
    if (row.notes) {
      j.acceptance_criteria.push(row.notes);
    }
  }
  return map;
}

function journeyIdToSlug(id: string): string {
  return id.replace(/^J-/, '').toLowerCase().replace(/-/g, '_');
}

function generateYaml(journey: Journey): string {
  const slug = journeyIdToSlug(journey.id);
  const lines = [
    `journey_meta:`,
    `  id: "${journey.id}"`,
    `  name: "${journey.name}"`,
    `  from_spec: "compiled"`,
    `  covers_reqs: []`,
    `  type: feature`,
    `  dod_criticality: "${journey.critical}"`,
    `  status: draft`,
    `  last_verified: null`,
    `  owner: "${journey.owner}"`,
    ``,
    `preconditions:`,
    `  - User is authenticated`,
    ``,
    `steps:`,
  ];

  for (const step of journey.steps) {
    lines.push(`  - step: ${step.step}`);
    lines.push(`    user_does: "${step.user_does}"`);
    lines.push(`    system_shows: "${step.system_shows}"`);
    if (step.notes) {
      lines.push(`    notes: "${step.notes}"`);
    }
  }

  lines.push('');
  lines.push('acceptance_criteria:');
  for (const ac of journey.acceptance_criteria) {
    lines.push(`  - "${ac}"`);
  }

  lines.push('');
  lines.push('test_hooks:');
  lines.push(`  e2e_test_file: .specflow/tests/e2e/journey_${slug}.spec.ts`);
  lines.push(`  checker_script: scripts/check-contracts.js`);

  return lines.join('\n') + '\n';
}

function generatePlaywright(journey: Journey): string {
  const slug = journeyIdToSlug(journey.id);
  const lines = [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.describe('${journey.id}: ${journey.name}', () => {`,
  ];

  for (const step of journey.steps) {
    lines.push(`  test('Step ${step.step}: ${step.user_does}', async ({ page }) => {`);
    lines.push(`    // TODO: Implement step ${step.step}`);
    lines.push(`    // User does: ${step.user_does}`);
    lines.push(`    // System shows: ${step.system_shows}`);
    lines.push(`  });`);
    lines.push('');
  }

  lines.push('});');
  return lines.join('\n') + '\n';
}

export function run(options: CompileOptions): void {
  const csvFile = options.args[0];
  if (!csvFile) {
    console.error('Usage: specflow compile <csv-file>');
    process.exit(1);
  }

  if (!fs.existsSync(csvFile)) {
    console.error(`File not found: ${csvFile}`);
    process.exit(1);
  }

  const content = fs.readFileSync(csvFile, 'utf-8');
  const { rows } = parseCsv(content);

  const errors = validateRows(rows);
  if (errors.length > 0) {
    console.error('Validation errors:');
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const journeys = groupByJourney(rows);

  const targetDir = path.dirname(path.resolve(csvFile));
  const contractsDir = path.resolve(targetDir, '.specflow/contracts');
  const testsDir = path.resolve(targetDir, '.specflow/tests/e2e');
  fs.mkdirSync(contractsDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });

  let contractsGenerated = 0;
  let testStubsGenerated = 0;
  const files: string[] = [];

  for (const [, journey] of journeys) {
    const slug = journeyIdToSlug(journey.id);

    // Write contract YAML
    const yamlPath = path.join(contractsDir, `journey_${slug}.yml`);
    fs.writeFileSync(yamlPath, generateYaml(journey));
    files.push(yamlPath);
    contractsGenerated++;

    // Write Playwright test stub
    const testPath = path.join(testsDir, `journey_${slug}.spec.ts`);
    if (!fs.existsSync(testPath)) {
      fs.writeFileSync(testPath, generatePlaywright(journey));
      testStubsGenerated++;
    }
    files.push(testPath);
  }

  console.log(`Compiled ${journeys.size} journey(s) from ${csvFile}`);
  console.log(`  Contracts: ${contractsGenerated} written to ${contractsDir}/`);
  console.log(`  Test stubs: ${testStubsGenerated} written to ${testsDir}/`);
}
