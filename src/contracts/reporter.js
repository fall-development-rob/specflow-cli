/**
 * Contract reporter — format violations and stats for terminal and JSON output.
 *
 * CommonJS module. No external dependencies (ANSI colors are inline).
 */

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

/**
 * Format violations as colored terminal output.
 *
 * Groups by contract, then by rule. Shows file:line and match text.
 *
 * @param {Object[]} violations  Array of Violation objects
 * @param {Object}   [options]
 * @param {boolean}  [options.color=true]   Use ANSI colors
 * @param {boolean}  [options.verbose=false] Show match text
 * @returns {string}
 */
function formatHuman(violations, options) {
  options = options || {};
  const color = options.color !== false;
  const verbose = options.verbose || false;

  if (violations.length === 0) {
    const msg = 'No violations found.';
    return color ? `${GREEN}${BOLD}${msg}${RESET}` : msg;
  }

  // Group by contractId
  const byContract = {};
  for (const v of violations) {
    const key = v.contractId || '<unknown>';
    if (!byContract[key]) byContract[key] = [];
    byContract[key].push(v);
  }

  const lines = [];

  for (const [contractId, contractViolations] of Object.entries(byContract)) {
    const header = `Contract: ${contractId}`;
    lines.push(color ? `\n${BOLD}${CYAN}${header}${RESET}` : `\n${header}`);
    lines.push(color ? `${DIM}${'─'.repeat(header.length + 4)}${RESET}` : '─'.repeat(header.length + 4));

    // Group by ruleId within contract
    const byRule = {};
    for (const v of contractViolations) {
      const key = v.ruleId || '<unknown>';
      if (!byRule[key]) byRule[key] = [];
      byRule[key].push(v);
    }

    for (const [ruleId, ruleViolations] of Object.entries(byRule)) {
      const ruleLabel = `  ${ruleId} (${ruleViolations.length} violation${ruleViolations.length === 1 ? '' : 's'})`;
      lines.push(color ? `${BOLD}${WHITE}${ruleLabel}${RESET}` : ruleLabel);

      for (const v of ruleViolations) {
        const sevColor = v.severity === 'error' ? RED : YELLOW;
        const sevLabel = v.severity === 'error' ? 'ERROR' : 'WARN';
        const location = v.line > 0 ? `${v.file}:${v.line}` : v.file;

        if (color) {
          lines.push(`    ${sevColor}${sevLabel}${RESET} ${location}`);
          lines.push(`      ${DIM}${v.message}${RESET}`);
        } else {
          lines.push(`    ${sevLabel} ${location}`);
          lines.push(`      ${v.message}`);
        }

        if (verbose && v.match) {
          if (color) {
            lines.push(`      ${DIM}> ${v.match}${RESET}`);
          } else {
            lines.push(`      > ${v.match}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Format violations and summary as a JSON-serialisable object.
 *
 * @param {Object[]} violations  Array of Violation objects
 * @param {Object}   [summary]   Optional summary to merge in
 * @returns {Object}  { violations, summary }
 */
function formatJSON(violations, summary) {
  const defaultSummary = {
    total: violations.length,
    errors: violations.filter((v) => v.severity === 'error').length,
    warnings: violations.filter((v) => v.severity === 'warning').length,
    files: [...new Set(violations.map((v) => v.file))].length,
    contracts: [...new Set(violations.map((v) => v.contractId))].length,
  };

  return {
    violations,
    summary: summary ? { ...defaultSummary, ...summary } : defaultSummary,
  };
}

/**
 * Format a one-line summary string.
 *
 * @param {Object[]} violations    Array of Violation objects
 * @param {number}   contractCount Number of contracts scanned
 * @param {number}   ruleCount     Number of rules evaluated
 * @returns {string}
 */
function formatSummary(violations, contractCount, ruleCount) {
  const parts = [];
  parts.push(`${contractCount} contract${contractCount === 1 ? '' : 's'}`);
  parts.push(`${ruleCount} rule${ruleCount === 1 ? '' : 's'}`);

  if (violations.length === 0) {
    parts.push('0 violations');
  } else {
    parts.push(`${violations.length} violation${violations.length === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

/**
 * Format a multi-line dashboard for a status command.
 *
 * @param {Object} stats
 * @param {number} stats.contracts   Number of loaded contracts
 * @param {number} stats.rules       Number of rules
 * @param {number} stats.violations  Number of violations
 * @param {number} [stats.hooks]     Number of hooks configured
 * @param {number} [stats.journeys]  Number of journey contracts
 * @returns {string}
 */
function formatDashboard(stats) {
  const lines = [];

  lines.push('┌─────────────────────────────────────┐');
  lines.push('│        Specflow Status Dashboard     │');
  lines.push('├─────────────────────────────────────┤');

  const pad = (label, value) => {
    const content = `  ${label}: ${value}`;
    return '│' + content.padEnd(37) + '│';
  };

  lines.push(pad('Contracts', stats.contracts));
  lines.push(pad('Rules', stats.rules));

  const vLabel = stats.violations === 0 ? 'PASS (0)' : `FAIL (${stats.violations})`;
  lines.push(pad('Violations', vLabel));

  if (stats.hooks != null) {
    lines.push(pad('Hooks', stats.hooks));
  }

  if (stats.journeys != null) {
    lines.push(pad('Journeys', stats.journeys));
  }

  lines.push('└─────────────────────────────────────┘');

  return lines.join('\n');
}

module.exports = {
  formatHuman,
  formatJSON,
  formatSummary,
  formatDashboard,
};
