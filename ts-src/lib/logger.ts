/**
 * Colored output + --json mode logger.
 */

const isCI = !!process.env.CI;
const isTTY = process.stdout.isTTY && !isCI;

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function wrap(code: string, text: string): string {
  if (!isTTY) return text;
  return `${code}${text}${codes.reset}`;
}

export const bold = (t: string) => wrap(codes.bold, t);
export const dim = (t: string) => wrap(codes.dim, t);
export const red = (t: string) => wrap(codes.red, t);
export const green = (t: string) => wrap(codes.green, t);
export const yellow = (t: string) => wrap(codes.yellow, t);
export const cyan = (t: string) => wrap(codes.cyan, t);

export function printPass(text: string): void {
  console.log(`  ${green('PASS')}  ${text}`);
}

export function printWarn(text: string): void {
  console.log(`  ${yellow('WARN')}  ${text}`);
}

export function printFail(text: string): void {
  console.log(`  ${red('FAIL')}  ${text}`);
}

export function printJson(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}
