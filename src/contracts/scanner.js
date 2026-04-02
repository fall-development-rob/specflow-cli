/**
 * Contract scanner — scan files and code snippets against contract rules.
 *
 * CommonJS module. No external dependencies beyond Node.js built-ins.
 */

const fs = require('fs');
const path = require('path');

/**
 * Convert a glob pattern to a regular expression.
 * Supports:
 *   **  — any number of directory segments (including zero)
 *   *   — any characters except /
 *   ?   — any single character except /
 *   {a,b} — alternation
 *   .   — literal dot
 *
 * @param {string} glob  Glob pattern (without leading ! negation)
 * @returns {RegExp}
 */
function globToRegex(glob) {
  let i = 0;
  let re = '';

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // ** — match any path segments
        if (glob[i + 2] === '/') {
          re += '(?:.+/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        // * — match anything except /
        re += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if (ch === '.') {
      re += '\\.';
      i += 1;
    } else if (ch === '{') {
      // Find matching }
      const end = glob.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
      } else {
        const choices = glob.slice(i + 1, end).split(',');
        re += '(?:' + choices.map(escapeForRegex).join('|') + ')';
        i = end + 1;
      }
    } else if (ch === '(' || ch === ')' || ch === '+' || ch === '^' ||
               ch === '$' || ch === '|' || ch === '[' || ch === ']' ||
               ch === '\\') {
      re += '\\' + ch;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }

  return new RegExp('^' + re + '$');
}

/**
 * Escape a string for use inside a regex character class / alternation.
 */
function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a file path matches an array of scope patterns.
 * Patterns prefixed with ! are exclusions.
 * A file matches if it matches at least one inclusion and no exclusion.
 *
 * @param {string} filePath       Relative file path (forward-slash separated)
 * @param {string[]} scopePatterns  Array of glob patterns, ! prefix = negate
 * @returns {boolean}
 */
function matchesScope(filePath, scopePatterns) {
  if (!scopePatterns || scopePatterns.length === 0) return true;

  // Normalise to forward slashes
  const normalised = filePath.replace(/\\/g, '/');

  const inclusions = [];
  const exclusions = [];

  for (const pattern of scopePatterns) {
    if (pattern.startsWith('!')) {
      exclusions.push(globToRegex(pattern.slice(1)));
    } else {
      inclusions.push(globToRegex(pattern));
    }
  }

  // Must match at least one inclusion (if any exist)
  const included = inclusions.length === 0 ||
    inclusions.some((re) => re.test(normalised));

  if (!included) return false;

  // Must not match any exclusion
  const excluded = exclusions.some((re) => re.test(normalised));

  return !excluded;
}

/**
 * @typedef {Object} Violation
 * @property {string} contractId
 * @property {string} ruleId
 * @property {string} file
 * @property {number} line
 * @property {string} match
 * @property {string} message
 * @property {string} severity
 */

/**
 * Check a code snippet (string) against an array of rules.
 *
 * @param {string}   code      Source code string
 * @param {Object[]} rules     Array of extracted rules (from loader.extractRules)
 * @param {string}   [filePath='<snippet>']  Virtual file path for violation reports
 * @returns {Violation[]}
 */
function checkSnippet(code, rules, filePath) {
  filePath = filePath || '<snippet>';
  const violations = [];
  const lines = code.split('\n');

  for (const rule of rules) {
    // Check scope
    if (!matchesScope(filePath, rule.scope)) continue;

    // Forbidden patterns — each match is a violation
    for (const fp of (rule.forbidden || [])) {
      const regex = new RegExp(fp.regex.source, fp.regex.flags);
      lines.forEach((lineText, idx) => {
        if (regex.test(lineText)) {
          violations.push({
            contractId: rule.contractId || '',
            ruleId: rule.id,
            file: filePath,
            line: idx + 1,
            match: lineText.trim(),
            message: fp.message,
            severity: rule.severity || 'error',
          });
        }
      });
    }

    // Required patterns — violation if NONE of the lines match
    for (const rp of (rule.required || [])) {
      const regex = new RegExp(rp.regex.source, rp.regex.flags);
      const found = lines.some((lineText) => regex.test(lineText));
      if (!found) {
        violations.push({
          contractId: rule.contractId || '',
          ruleId: rule.id,
          file: filePath,
          line: 0,
          match: '',
          message: rp.message,
          severity: rule.severity || 'error',
        });
      }
    }
  }

  return violations;
}

/**
 * Scan a single file against an array of rules.
 *
 * @param {string}   filePath  Absolute or relative file path
 * @param {Object[]} rules     Array of extracted rules (from loader.extractRules)
 * @returns {Violation[]}
 */
function scanFile(filePath, rules) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return checkSnippet(content, rules, filePath);
}

/**
 * Recursively list all files under a directory, respecting ignore list.
 */
function listFiles(dir, ignore) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (ignore.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFiles(full, ignore));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }

  return results;
}

/**
 * Scan all files in a directory against loaded contracts.
 *
 * @param {string}   dir        Directory to scan
 * @param {Object[]} contracts  Array of { filePath, contract, rules } from loadAllContracts
 * @param {Object}   [options]
 * @param {string}   [options.contractFilter]  Only apply contracts whose id matches
 * @param {string[]} [options.ignore]          Directory/file names to skip
 * @returns {Violation[]}
 */
function scanDirectory(dir, contracts, options) {
  options = options || {};
  const ignore = options.ignore || ['node_modules', '.git', 'dist', 'coverage'];
  const allFiles = listFiles(dir, ignore);
  const violations = [];

  for (const loaded of contracts) {
    const contractId = loaded.contract?.contract_meta?.id || '';
    const severity = loaded.contract?.llm_policy?.severity || 'error';

    // Optional contract filter
    if (options.contractFilter && contractId !== options.contractFilter) continue;

    // Annotate rules with contractId and severity
    const annotatedRules = loaded.rules.map((r) => ({
      ...r,
      contractId,
      severity,
    }));

    for (const file of allFiles) {
      // Compute relative path from scan root for scope matching
      const relPath = path.relative(dir, file).replace(/\\/g, '/');

      // Only scan rules whose scope matches this file
      const applicableRules = annotatedRules.filter(
        (r) => matchesScope(relPath, r.scope)
      );

      if (applicableRules.length === 0) continue;

      const fileViolations = checkSnippet(
        fs.readFileSync(file, 'utf-8'),
        applicableRules,
        relPath
      );
      violations.push(...fileViolations);
    }
  }

  return violations;
}

module.exports = {
  scanFile,
  scanDirectory,
  checkSnippet,
  matchesScope,
  globToRegex,
};
