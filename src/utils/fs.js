'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Create directory recursively, return the dir path.
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copy a file, creating parent directories as needed.
 */
function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/**
 * Write content to a file, creating parent directories as needed.
 */
function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Read a file as a UTF-8 string. Returns null if the file does not exist.
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Check whether a file exists.
 */
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * List files in a directory matching a simple glob pattern.
 * Supports leading '*' (e.g. '*.yml'), trailing '*', and '*' in the middle.
 * Does not recurse into subdirectories — use '**' patterns with care.
 */
function listFiles(dir, pattern) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  if (!pattern) return entries;

  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '__GLOBSTAR__')
        .replace(/\*/g, '[^/]*')
        .replace(/__GLOBSTAR__/g, '.*') +
      '$'
  );

  return entries.filter((name) => regex.test(name));
}

/**
 * Read and parse a JSON file. Returns null if not found or invalid JSON.
 */
function readJson(filePath) {
  const raw = readFile(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write data as JSON with 2-space indentation.
 */
function writeJson(filePath, data) {
  writeFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Deep-merge `data` into the existing JSON at `filePath`, then write back.
 * If the file does not exist, writes `data` as a new file.
 */
function mergeJson(filePath, data) {
  const existing = readJson(filePath) || {};
  const merged = deepMerge(existing, data);
  writeJson(filePath, merged);
}

/**
 * Recursively merge source into target (both plain objects).
 * Arrays are replaced, not concatenated.
 */
function deepMerge(target, source) {
  const result = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    if (
      isPlainObject(source[key]) &&
      isPlainObject(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

module.exports = {
  ensureDir,
  copyFile,
  writeFile,
  readFile,
  fileExists,
  listFiles,
  readJson,
  writeJson,
  mergeJson,
};
