'use strict';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

let jsonMode = false;

const log = {
  setJson(bool) {
    jsonMode = !!bool;
  },

  isJson() {
    return jsonMode;
  },

  pass(msg) {
    if (jsonMode) return;
    process.stdout.write(`${GREEN}\u2714${RESET} ${msg}\n`);
  },

  fail(msg) {
    if (jsonMode) return;
    process.stderr.write(`${RED}\u2718${RESET} ${msg}\n`);
  },

  warn(msg) {
    if (jsonMode) return;
    process.stderr.write(`${YELLOW}\u26A0${RESET} ${msg}\n`);
  },

  info(msg) {
    if (jsonMode) return;
    process.stdout.write(`${BLUE}\u2139${RESET} ${msg}\n`);
  },

  step(n, total, msg) {
    if (jsonMode) return;
    process.stdout.write(`${BLUE}[${n}/${total}]${RESET} ${msg}\n`);
  },

  heading(msg) {
    if (jsonMode) return;
    process.stdout.write(`\n${BOLD}${msg}${RESET}\n${DIM}${'─'.repeat(msg.length)}${RESET}\n`);
  },

  banner(title) {
    if (jsonMode) return;
    const pad = 2;
    const inner = ' '.repeat(pad) + title + ' '.repeat(pad);
    const border = '┌' + '─'.repeat(inner.length) + '┐';
    const bottom = '└' + '─'.repeat(inner.length) + '┘';
    process.stdout.write(
      `\n${BOLD}${border}\n│${inner}│\n${bottom}${RESET}\n\n`
    );
  },

  json(data) {
    process.stdout.write(JSON.stringify(data) + '\n');
  },
};

module.exports = log;
