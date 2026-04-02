/**
 * Human + JSON output formatting for violations.
 */

import * as path from 'path';
import { NapiScanResult, NapiViolation } from './native';
import { bold, red, green, cyan, yellow, dim } from './logger';

export function printHuman(result: NapiScanResult, projectRoot: string): void {
  if (result.violations.length === 0) {
    console.log(
      `\n${bold(green('PASS'))}  No violations found (${result.filesScanned} files scanned, ${result.rulesChecked} rules checked)\n`
    );
    return;
  }

  console.log(
    `\n${bold(red('FAIL'))}  ${result.violations.length} violation(s) found\n`
  );

  // Group by contract
  const byContract = new Map<string, NapiViolation[]>();
  for (const v of result.violations) {
    const list = byContract.get(v.contractId) || [];
    list.push(v);
    byContract.set(v.contractId, list);
  }

  for (const [contractId, violations] of byContract) {
    console.log(`  ${bold(contractId)} (${red(`${violations.length} violations`)})`);
    for (const v of violations) {
      const relPath = v.file.startsWith(projectRoot)
        ? v.file.slice(projectRoot.length + 1)
        : v.file;

      if (v.kind === 'Forbidden') {
        console.log(
          `    ${red('x')} ${cyan(relPath)}:${v.line}:${v.column} ${yellow(v.ruleId)}`
        );
        console.log(`      ${v.message}`);
        if (v.matchedText) {
          const display = v.matchedText.length > 80
            ? v.matchedText.slice(0, 77) + '...'
            : v.matchedText;
          console.log(`      matched: ${dim(display)}`);
        }
      } else {
        console.log(
          `    ${red('x')} ${cyan(relPath)} ${yellow(v.ruleId)}`
        );
        console.log(`      ${v.message}`);
      }
    }
    console.log('');
  }

  console.log(
    `  ${result.contractsLoaded} contracts, ${result.rulesChecked} rules, ${result.filesScanned} files scanned`
  );
  console.log('');
}

export function printJson(result: NapiScanResult): void {
  const output = {
    status: result.violations.length === 0 ? 'pass' : 'fail',
    violations: result.violations,
    summary: {
      violation_count: result.violations.length,
      files_scanned: result.filesScanned,
      contracts_loaded: result.contractsLoaded,
      rules_checked: result.rulesChecked,
    },
  };
  console.log(JSON.stringify(output, null, 2));
}
