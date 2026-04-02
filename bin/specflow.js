#!/usr/bin/env node

/**
 * Specflow CLI wrapper.
 * Delegates to the TypeScript-compiled dist/cli.js.
 */

const path = require('path');
const distCli = path.join(__dirname, '..', 'dist', 'cli.js');

try {
  require(distCli);
} catch (e) {
  // If dist/ hasn't been built yet, provide a helpful message
  if (e.code === 'MODULE_NOT_FOUND') {
    console.error('Specflow CLI not built. Run: npm run build');
    console.error('Or from source: npx tsc');
    process.exit(1);
  }
  throw e;
}
