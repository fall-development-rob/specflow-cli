/**
 * Schema validation test for docs/contracts/feature_preflight.yml
 *
 * This contract is a BOARD-AUDITOR RULE SET — not a source-code pattern scanner.
 * It defines required fields in GitHub ticket bodies, not regex patterns against source files.
 *
 * Tests verify:
 *   1. The YAML file is valid and parseable
 *   2. Standard contract_meta fields are present
 *   3. Required ticket fields (simulation_status, simulated_at, scope) are defined
 *   4. The simulation_status enum values are listed
 *   5. The schema_validation section is machine-readable by board-auditor
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONTRACT_PATH = path.join(
  __dirname,
  '..',
  '..',
  'docs',
  'contracts',
  'feature_preflight.yml'
);

describe('feature_preflight.yml — board-auditor rule set', () => {
  let contract;
  let raw;

  beforeAll(() => {
    raw = fs.readFileSync(CONTRACT_PATH, 'utf-8');
    contract = yaml.load(raw);
  });

  // ─── 1. File validity ────────────────────────────────────────────────────────

  describe('file validity', () => {
    test('file exists at docs/contracts/feature_preflight.yml', () => {
      expect(fs.existsSync(CONTRACT_PATH)).toBe(true);
    });

    test('parses as valid YAML', () => {
      expect(contract).toBeDefined();
      expect(typeof contract).toBe('object');
      expect(contract).not.toBeNull();
    });
  });

  // ─── 2. contract_meta ────────────────────────────────────────────────────────

  describe('contract_meta', () => {
    test('has contract_meta block', () => {
      expect(contract.contract_meta).toBeDefined();
    });

    test('has id: feature_preflight', () => {
      expect(contract.contract_meta.id).toBe('feature_preflight');
    });

    test('has version number', () => {
      expect(contract.contract_meta.version).toBeDefined();
      expect(typeof contract.contract_meta.version).toBe('number');
    });

    test('has created_from_spec referencing the PRD', () => {
      expect(typeof contract.contract_meta.created_from_spec).toBe('string');
      expect(contract.contract_meta.created_from_spec.length).toBeGreaterThan(0);
    });

    test('has covers_reqs as non-empty array', () => {
      expect(Array.isArray(contract.contract_meta.covers_reqs)).toBe(true);
      expect(contract.contract_meta.covers_reqs.length).toBeGreaterThan(0);
    });

    test('covers_reqs includes ARCH-001 through ARCH-008', () => {
      const reqs = contract.contract_meta.covers_reqs;
      ['ARCH-001', 'ARCH-002', 'ARCH-003', 'ARCH-004', 'ARCH-005', 'ARCH-006', 'ARCH-007', 'ARCH-008'].forEach(
        (id) => {
          expect(reqs).toContain(id);
        }
      );
    });

    test('covers_reqs includes SIM-006, SIM-007, SIM-008', () => {
      const reqs = contract.contract_meta.covers_reqs;
      ['SIM-006', 'SIM-007', 'SIM-008'].forEach((id) => {
        expect(reqs).toContain(id);
      });
    });

    test('has owner', () => {
      expect(typeof contract.contract_meta.owner).toBe('string');
      expect(contract.contract_meta.owner.length).toBeGreaterThan(0);
    });
  });

  // ─── 3. llm_policy ───────────────────────────────────────────────────────────

  describe('llm_policy', () => {
    test('has llm_policy block', () => {
      expect(contract.llm_policy).toBeDefined();
    });

    test('enforce is boolean', () => {
      expect(typeof contract.llm_policy.enforce).toBe('boolean');
    });

    test('llm_may_modify_non_negotiables is boolean', () => {
      expect(typeof contract.llm_policy.llm_may_modify_non_negotiables).toBe('boolean');
    });

    test('override_phrase contains "override_contract:"', () => {
      expect(typeof contract.llm_policy.override_phrase).toBe('string');
      expect(contract.llm_policy.override_phrase).toContain('override_contract:');
    });
  });

  // ─── 4. board_auditor_rules — required fields ────────────────────────────────

  describe('board_auditor_rules', () => {
    test('has board_auditor_rules block (not rules.non_negotiable)', () => {
      expect(contract.board_auditor_rules).toBeDefined();
      // This is a board-auditor rule set, not a source-code pattern scanner.
      // It does NOT have rules.non_negotiable with forbidden_patterns.
      expect(contract.rules).toBeUndefined();
    });

    test('has required_section defining ## Pre-flight Findings', () => {
      const section = contract.board_auditor_rules.required_section;
      expect(section).toBeDefined();
      expect(section.heading).toBe('## Pre-flight Findings');
    });

    test('has required_fields array', () => {
      expect(Array.isArray(contract.board_auditor_rules.required_fields)).toBe(true);
      expect(contract.board_auditor_rules.required_fields.length).toBeGreaterThan(0);
    });

    test('simulation_status field is defined in required_fields', () => {
      const fields = contract.board_auditor_rules.required_fields;
      const field = fields.find((f) => f.field === 'simulation_status');
      expect(field).toBeDefined();
    });

    test('simulated_at field is defined in required_fields', () => {
      const fields = contract.board_auditor_rules.required_fields;
      const field = fields.find((f) => f.field === 'simulated_at');
      expect(field).toBeDefined();
    });

    test('scope field is defined in required_fields', () => {
      const fields = contract.board_auditor_rules.required_fields;
      const field = fields.find((f) => f.field === 'scope');
      expect(field).toBeDefined();
    });
  });

  // ─── 5. simulation_status enum values ────────────────────────────────────────

  describe('simulation_status enum', () => {
    let statusField;

    beforeAll(() => {
      const fields = contract.board_auditor_rules.required_fields;
      statusField = fields.find((f) => f.field === 'simulation_status');
    });

    test('simulation_status field has enum_values array', () => {
      expect(Array.isArray(statusField.enum_values)).toBe(true);
      expect(statusField.enum_values.length).toBeGreaterThan(0);
    });

    test('enum includes "passed"', () => {
      expect(statusField.enum_values).toContain('passed');
    });

    test('enum includes "passed_with_warnings"', () => {
      expect(statusField.enum_values).toContain('passed_with_warnings');
    });

    test('enum includes "blocked"', () => {
      expect(statusField.enum_values).toContain('blocked');
    });

    test('enum includes "stale"', () => {
      expect(statusField.enum_values).toContain('stale');
    });

    test('enum includes "override" prefix entry', () => {
      // override:* — any text after colon is valid; enum must list "override" as a prefix
      expect(statusField.enum_values).toContain('override');
    });

    test('non_enum_treatment is "blocked"', () => {
      expect(statusField.non_enum_treatment).toBe('blocked');
    });
  });

  // ─── 6. schema_validation — machine-readable for board-auditor ────────────────

  describe('schema_validation', () => {
    test('has schema_validation block', () => {
      expect(contract.schema_validation).toBeDefined();
    });

    test('has simulation_status_enum array', () => {
      expect(Array.isArray(contract.schema_validation.simulation_status_enum)).toBe(true);
      expect(contract.schema_validation.simulation_status_enum.length).toBeGreaterThan(0);
    });

    test('schema_validation.simulation_status_enum includes all valid values', () => {
      const enumVals = contract.schema_validation.simulation_status_enum;
      expect(enumVals).toContain('passed');
      expect(enumVals).toContain('passed_with_warnings');
      expect(enumVals).toContain('blocked');
      expect(enumVals).toContain('stale');
    });

    test('schema_validation has field_line_formats for all three required fields', () => {
      const formats = contract.schema_validation.field_line_formats;
      expect(formats).toBeDefined();
      expect(formats.simulation_status).toBeDefined();
      expect(formats.simulated_at).toBeDefined();
      expect(formats.scope).toBeDefined();
    });

    test('simulated_at_format is RFC3339-UTC', () => {
      expect(contract.schema_validation.simulated_at_format).toBe('RFC3339-UTC');
    });

    test('scope_enum includes ticket and wave', () => {
      expect(contract.schema_validation.scope_enum).toContain('ticket');
      expect(contract.schema_validation.scope_enum).toContain('wave');
    });
  });

  // ─── 7. staleness rules ───────────────────────────────────────────────────────

  describe('staleness rules', () => {
    test('has staleness_rules block', () => {
      expect(contract.board_auditor_rules.staleness_rules).toBeDefined();
    });

    test('ticket_staleness rule is defined', () => {
      expect(contract.board_auditor_rules.staleness_rules.ticket_staleness).toBeDefined();
    });

    test('contract_staleness rule is defined', () => {
      expect(contract.board_auditor_rules.staleness_rules.contract_staleness).toBeDefined();
    });
  });

  // ─── 8. compliance_checklist ─────────────────────────────────────────────────

  describe('compliance_checklist', () => {
    test('has compliance_checklist block', () => {
      expect(contract.compliance_checklist).toBeDefined();
    });

    test('has before_firing_sprint_executor checklist', () => {
      expect(Array.isArray(contract.compliance_checklist.before_firing_sprint_executor)).toBe(true);
      expect(contract.compliance_checklist.before_firing_sprint_executor.length).toBeGreaterThan(0);
    });
  });

  // ─── 9. test_hooks ───────────────────────────────────────────────────────────

  describe('test_hooks', () => {
    test('has test_hooks.tests array', () => {
      expect(contract.test_hooks).toBeDefined();
      expect(Array.isArray(contract.test_hooks.tests)).toBe(true);
    });

    test('test_hooks references tests/schema/feature_preflight.test.js', () => {
      const files = contract.test_hooks.tests.map((t) => t.file);
      expect(files).toContain('tests/schema/feature_preflight.test.js');
    });
  });
});
