/**
 * Tests for the `specflow status` truth-hierarchy banner (PRD-010, Practice 3).
 *
 * The banner must:
 *   - Appear in the default human-rendered output.
 *   - Be absent from --json output so machine consumers stay clean.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { run } = require('../../dist/commands/status');

function makeEmptyProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specflow-status-banner-'));
  // Minimal config so status.run() doesn't bail.
  fs.mkdirSync(path.join(dir, '.specflow', 'contracts'), { recursive: true });
  return dir;
}

function captureStdout(fn) {
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  return Promise.resolve(fn()).then(
    () => {
      spy.mockRestore();
      return lines.join('\n');
    },
    (err) => {
      spy.mockRestore();
      throw err;
    }
  );
}

// Match the banner independent of ANSI colour codes.
const BANNER_RE = /Truth:.*contracts.*>.*ADRs.*>.*PRDs\/DDDs/;

describe('specflow status — truth-hierarchy banner', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = makeEmptyProject();
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('renders the truth banner in human output', async () => {
    const output = await captureStdout(() => run({ dir: projectDir, json: false }));
    expect(output).toMatch(BANNER_RE);
    // The explanatory clause should appear too.
    expect(output).toMatch(/ADRs document decisions/);
    expect(output).toMatch(/PRDs\/DDDs describe a moment in time/);
  });

  test('renders the banner above the rest of the dashboard', async () => {
    const output = await captureStdout(() => run({ dir: projectDir, json: false }));
    const bannerIdx = output.search(BANNER_RE);
    const headerIdx = output.indexOf('Specflow Status');
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(bannerIdx).toBeLessThan(headerIdx);
  });

  test('suppresses the banner in --json output', async () => {
    const output = await captureStdout(() => run({ dir: projectDir, json: true }));
    expect(output).not.toMatch(BANNER_RE);
    expect(output).not.toMatch(/Truth:/);
    // And the JSON payload should still parse cleanly.
    expect(() => JSON.parse(output)).not.toThrow();
  });
});
