'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Run a git command and return its stdout as a trimmed string.
 * Returns null if the command fails.
 */
function execGit(args, cwd) {
  try {
    const result = execSync(`git ${args}`, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Walk up from `dir` looking for a `.git` directory.
 * Returns the repo root path, or null if none found.
 */
function findGitRoot(dir) {
  let current = path.resolve(dir);
  const { root } = path.parse(current);

  while (current !== root) {
    try {
      const stat = fs.statSync(path.join(current, '.git'));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // not found, keep walking
    }
    current = path.dirname(current);
  }
  return null;
}

/**
 * Check whether `dir` is inside a git repository.
 */
function isGitRepo(dir) {
  return findGitRoot(dir) !== null;
}

/**
 * Parse the last `count` git log messages for issue references (#NNN).
 * Returns a deduplicated array of issue numbers (integers), most recent first.
 */
function getRecentIssues(dir, count) {
  if (count === undefined) count = 5;
  const log = execGit(`log --oneline -${count}`, dir);
  if (!log) return [];

  const seen = new Set();
  const issues = [];
  const regex = /#(\d+)/g;

  for (const line of log.split('\n')) {
    let match;
    while ((match = regex.exec(line)) !== null) {
      const num = parseInt(match[1], 10);
      if (!seen.has(num)) {
        seen.add(num);
        issues.push(num);
      }
    }
  }

  return issues;
}

module.exports = {
  findGitRoot,
  getRecentIssues,
  isGitRepo,
  execGit,
};
