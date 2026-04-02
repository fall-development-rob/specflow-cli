/**
 * Contract loader — parse YAML contract files, extract and compile rules.
 *
 * CommonJS module. Depends on js-yaml (already in package.json) and Node.js
 * built-ins (fs, path).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Compile a single "/regex/flags" pattern string.
 * Returns { regex, error } — never throws.
 */
function compilePattern(patternStr) {
  try {
    const trimmed = patternStr.trim();
    const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/s);
    if (!match) {
      return { regex: null, error: `Invalid regex pattern format: ${trimmed}` };
    }
    return { regex: new RegExp(match[1], match[2]), error: null };
  } catch (err) {
    return { regex: null, error: err.message };
  }
}

/**
 * Convert a YAML pattern string like "/regex/flags" into a RegExp.
 * Throws on invalid format or bad regex.
 */
function yamlPatternToRegex(patternStr) {
  const trimmed = patternStr.trim();
  const match = trimmed.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (!match) {
    throw new Error(`Invalid regex pattern format: ${trimmed}`);
  }
  return new RegExp(match[1], match[2]);
}

/**
 * Read and parse a single YAML contract file.
 * Returns the full parsed object.
 */
function loadContract(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(content);
}

/**
 * Load all .yml/.yaml contract files from a directory.
 * Returns array of { filePath, contract, rules }.
 */
function loadAllContracts(dir) {
  const entries = fs.readdirSync(dir).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml')
  );
  return entries.map((filename) => {
    const filePath = path.join(dir, filename);
    const contract = loadContract(filePath);
    const rules = extractRules(contract);
    return { filePath, contract, rules };
  });
}

/**
 * Extract rules from a contract with compiled regex patterns.
 *
 * Returns array of:
 * {
 *   id, title, description, scope,
 *   forbidden: [{ regex, message, raw }],
 *   required:  [{ regex, message, raw }],
 *   example_violation, example_compliant
 * }
 */
function extractRules(contract) {
  const rules = contract.rules?.non_negotiable || [];
  return rules.map((rule) => {
    const forbidden = (rule.behavior?.forbidden_patterns || []).map((fp) => ({
      regex: yamlPatternToRegex(fp.pattern),
      message: fp.message,
      raw: fp.pattern,
    }));

    const required = (rule.behavior?.required_patterns || []).map((rp) => ({
      regex: yamlPatternToRegex(rp.pattern),
      message: rp.message,
      raw: rp.pattern,
    }));

    return {
      id: rule.id,
      title: rule.title || '',
      description: rule.description || '',
      scope: rule.scope || [],
      forbidden,
      required,
      example_violation: rule.behavior?.example_violation || '',
      example_compliant: rule.behavior?.example_compliant || '',
    };
  });
}

/**
 * Validate a parsed contract object.
 * Returns { valid: boolean, errors: string[], warnings: string[] }.
 */
function validateContract(contract) {
  const errors = [];
  const warnings = [];

  // contract_meta checks
  if (!contract.contract_meta) {
    errors.push('Missing contract_meta section');
  } else {
    if (!contract.contract_meta.id) {
      errors.push('Missing contract_meta.id');
    }
    if (!contract.contract_meta.version) {
      warnings.push('Missing contract_meta.version');
    }
    if (!contract.contract_meta.owner) {
      warnings.push('Missing contract_meta.owner');
    }
    if (!contract.contract_meta.covers_reqs || contract.contract_meta.covers_reqs.length === 0) {
      warnings.push('Missing or empty contract_meta.covers_reqs');
    }
  }

  // llm_policy checks
  if (!contract.llm_policy) {
    warnings.push('Missing llm_policy section');
  } else {
    if (contract.llm_policy.severity &&
        !['error', 'warning'].includes(contract.llm_policy.severity)) {
      warnings.push(`Unknown llm_policy.severity: ${contract.llm_policy.severity}`);
    }
  }

  // rules checks
  const nonNeg = contract.rules?.non_negotiable;
  if (!nonNeg || !Array.isArray(nonNeg)) {
    // Only flag if there are no board_auditor_rules either (some contracts
    // are board-auditor-only and have no source-code rules).
    if (!contract.board_auditor_rules) {
      errors.push('Missing rules.non_negotiable array');
    }
  } else {
    nonNeg.forEach((rule, idx) => {
      const label = rule.id || `rule[${idx}]`;
      if (!rule.id) {
        errors.push(`Rule at index ${idx} missing id`);
      }
      if (!rule.title) {
        warnings.push(`${label}: missing title`);
      }

      // Validate all patterns compile
      const allPatterns = [
        ...(rule.behavior?.forbidden_patterns || []),
        ...(rule.behavior?.required_patterns || []),
      ];
      allPatterns.forEach((p) => {
        const { error } = compilePattern(p.pattern);
        if (error) {
          errors.push(`${label}: pattern compile error — ${error}`);
        }
      });
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  yamlPatternToRegex,
  loadContract,
  loadAllContracts,
  extractRules,
  validateContract,
  compilePattern,
};
