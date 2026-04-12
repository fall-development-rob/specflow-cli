/**
 * Project detection module.
 * Scans a target directory for language, framework, ORM, and architectural signals
 * to drive contract generation in `specflow init` and `specflow generate`.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface DetectionResult {
  language: string | null;
  framework: string | null;
  orm: string | null;
  dependencies: string[];
  devDependencies: string[];
  hasEnvExample: boolean;
  hasADRs: boolean;
  adrFiles: string[];
  hasExistingContracts: boolean;
  /** Detected source root directories (e.g. ["src"], ["apps/api/src", "apps/web/src"], ["lib"]). */
  sourceRoots: string[];
  sourcePatterns: {
    hasRoutes: boolean;
    hasServices: boolean;
    hasSchemas: boolean;
    hasComponents: boolean;
    hasMigrations: boolean;
  };
  configFiles: {
    tsconfig: boolean;
    eslint: boolean;
    pyproject: boolean;
    gomod: boolean;
    packageJson: boolean;
    claudeMd: boolean;
  };
}

/** Read and parse package.json from the target directory. Returns null if missing. */
function readPackageJson(dir: string): { deps: Record<string, string>; devDeps: Record<string, string> } | null {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return {
      deps: raw.dependencies || {},
      devDeps: raw.devDependencies || {},
    };
  } catch {
    return null;
  }
}

/** Check if a glob-like directory pattern has files. */
function dirHasPattern(dir: string, subdir: string): boolean {
  const target = path.join(dir, subdir);
  if (!fs.existsSync(target)) return false;
  try {
    const stat = fs.statSync(target);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/** Find ADR/invariant YAML/MD files in docs/ or similar directories. */
function findADRFiles(dir: string): string[] {
  const candidates = ['docs', 'docs/adr', 'docs/adrs', 'docs/architecture', 'adr', 'adrs'];
  const adrFiles: string[] = [];

  for (const candidate of candidates) {
    const adrDir = path.join(dir, candidate);
    if (!fs.existsSync(adrDir)) continue;
    try {
      const files = fs.readdirSync(adrDir);
      for (const file of files) {
        const lower = file.toLowerCase();
        if ((lower.startsWith('adr') || lower.includes('invariant') || lower.includes('decision')) &&
            (lower.endsWith('.md') || lower.endsWith('.yml') || lower.endsWith('.yaml'))) {
          adrFiles.push(path.join(candidate, file));
        }
      }
    } catch {
      // skip unreadable directories
    }
  }

  return adrFiles;
}

/**
 * Detect actual source root directories.
 * Handles flat layouts (src/), monorepos (apps/api/src/, packages/domain/src/),
 * and non-standard roots (app/, lib/).
 */
function detectSourceRoots(dir: string): string[] {
  const roots: string[] = [];

  // Check monorepo containers first — apps/*/src, packages/*/src
  for (const container of ['apps', 'packages']) {
    const containerPath = path.join(dir, container);
    if (!fs.existsSync(containerPath)) continue;
    try {
      const entries = fs.readdirSync(containerPath);
      for (const entry of entries) {
        const entryPath = path.join(containerPath, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        // Check for src/ inside each workspace package
        const srcInside = path.join(entryPath, 'src');
        if (fs.existsSync(srcInside) && fs.statSync(srcInside).isDirectory()) {
          roots.push(`${container}/${entry}/src`);
        }
      }
    } catch { /* skip unreadable */ }
  }

  // Check standard flat source directories
  for (const candidate of ['src', 'app', 'lib']) {
    const candidatePath = path.join(dir, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory()) {
      roots.push(candidate);
    }
  }

  // Fallback: if nothing found, default to src so contracts still have a scope
  if (roots.length === 0) {
    roots.push('src');
  }

  return roots;
}

/** Scan src/ for common structural patterns. */
function detectSourcePatterns(dir: string): DetectionResult['sourcePatterns'] {
  const srcDirs = ['src', 'app', 'apps', 'lib', 'packages'];
  let hasRoutes = false;
  let hasServices = false;
  let hasSchemas = false;
  let hasComponents = false;
  let hasMigrations = false;

  for (const srcDir of srcDirs) {
    if (dirHasPattern(dir, srcDir)) {
      // Check for common subdirectory patterns
      hasRoutes = hasRoutes || dirHasPattern(dir, path.join(srcDir, 'routes'))
        || dirHasPattern(dir, path.join(srcDir, 'api'));
      hasServices = hasServices || dirHasPattern(dir, path.join(srcDir, 'services'))
        || dirHasPattern(dir, path.join(srcDir, 'service'));
      hasSchemas = hasSchemas || dirHasPattern(dir, path.join(srcDir, 'schema'))
        || dirHasPattern(dir, path.join(srcDir, 'schemas'))
        || dirHasPattern(dir, path.join(srcDir, 'models'));
      hasComponents = hasComponents || dirHasPattern(dir, path.join(srcDir, 'components'))
        || dirHasPattern(dir, path.join(srcDir, 'features'));
    }
  }

  // Migrations can live in various places
  hasMigrations = dirHasPattern(dir, 'migrations')
    || dirHasPattern(dir, 'db/migrations')
    || dirHasPattern(dir, 'supabase/migrations')
    || dirHasPattern(dir, 'prisma/migrations')
    || dirHasPattern(dir, 'drizzle');

  return { hasRoutes, hasServices, hasSchemas, hasComponents, hasMigrations };
}

/** Detect the primary language from available config files and package.json. */
function detectLanguage(dir: string, pkg: { deps: Record<string, string>; devDeps: Record<string, string> } | null): string | null {
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'setup.py'))
    || fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'rust';
  if (pkg) {
    const allDeps = { ...pkg.deps, ...pkg.devDeps };
    if ('typescript' in allDeps || fs.existsSync(path.join(dir, 'tsconfig.json'))) return 'typescript';
    return 'javascript';
  }
  return null;
}

/** Detect the web framework from dependencies. */
function detectFramework(pkg: { deps: Record<string, string>; devDeps: Record<string, string> } | null, dir: string): string | null {
  if (!pkg) {
    // Python frameworks
    if (fs.existsSync(path.join(dir, 'manage.py'))) return 'django';
    const pyprojectPath = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf-8');
        if (content.includes('django')) return 'django';
        if (content.includes('fastapi')) return 'fastapi';
        if (content.includes('flask')) return 'flask';
      } catch { /* skip */ }
    }
    // Go frameworks
    const goModPath = path.join(dir, 'go.mod');
    if (fs.existsSync(goModPath)) {
      try {
        const content = fs.readFileSync(goModPath, 'utf-8');
        if (content.includes('gin-gonic')) return 'gin';
        if (content.includes('gorilla/mux')) return 'gorilla';
        if (content.includes('labstack/echo')) return 'echo';
        if (content.includes('gofiber')) return 'fiber';
      } catch { /* skip */ }
    }
    return null;
  }

  const deps = pkg.deps;
  if ('next' in deps) return 'next';
  if ('nuxt' in deps || 'nuxt3' in deps) return 'nuxt';
  if ('express' in deps) return 'express';
  if ('fastify' in deps) return 'fastify';
  if ('hono' in deps) return 'hono';
  if ('koa' in deps) return 'koa';
  if ('react' in deps && !('next' in deps)) return 'react';
  if ('vue' in deps && !('nuxt' in deps)) return 'vue';
  if ('svelte' in deps || '@sveltejs/kit' in deps) return 'svelte';
  if ('angular' in deps || '@angular/core' in deps) return 'angular';
  return null;
}

/** Detect ORM from dependencies. */
function detectORM(pkg: { deps: Record<string, string>; devDeps: Record<string, string> } | null, dir: string): string | null {
  if (!pkg) {
    // Python ORMs
    const pyprojectPath = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf-8');
        if (content.includes('sqlalchemy')) return 'sqlalchemy';
        if (content.includes('django')) return 'django-orm';
      } catch { /* skip */ }
    }
    return null;
  }

  const allDeps = { ...pkg.deps, ...pkg.devDeps };
  if ('drizzle-orm' in allDeps) return 'drizzle';
  if ('prisma' in allDeps || '@prisma/client' in allDeps) return 'prisma';
  if ('typeorm' in allDeps) return 'typeorm';
  if ('sequelize' in allDeps) return 'sequelize';
  if ('knex' in allDeps) return 'knex';
  if ('mongoose' in allDeps) return 'mongoose';
  return null;
}

/**
 * Detect the project stack by scanning the target directory.
 * Returns a structured result describing the language, framework, ORM,
 * dependencies, and source patterns found.
 */
export function detect(dir: string): DetectionResult {
  const target = path.resolve(dir);
  const pkg = readPackageJson(target);

  const language = detectLanguage(target, pkg);
  const framework = detectFramework(pkg, target);
  const orm = detectORM(pkg, target);

  const dependencies = pkg ? Object.keys(pkg.deps) : [];
  const devDependencies = pkg ? Object.keys(pkg.devDeps) : [];

  const hasEnvExample = fs.existsSync(path.join(target, '.env.example'))
    || fs.existsSync(path.join(target, '.env.sample'));

  const adrFiles = findADRFiles(target);

  const contractsDir = path.join(target, '.specflow', 'contracts');
  const hasExistingContracts = fs.existsSync(contractsDir) &&
    fs.readdirSync(contractsDir).some(f => f.endsWith('.yml') || f.endsWith('.yaml'));

  return {
    language,
    framework,
    orm,
    dependencies,
    devDependencies,
    hasEnvExample,
    hasADRs: adrFiles.length > 0,
    adrFiles,
    hasExistingContracts,
    sourceRoots: detectSourceRoots(target),
    sourcePatterns: detectSourcePatterns(target),
    configFiles: {
      tsconfig: fs.existsSync(path.join(target, 'tsconfig.json')),
      eslint: fs.existsSync(path.join(target, '.eslintrc'))
        || fs.existsSync(path.join(target, '.eslintrc.js'))
        || fs.existsSync(path.join(target, '.eslintrc.json'))
        || fs.existsSync(path.join(target, 'eslint.config.js'))
        || fs.existsSync(path.join(target, 'eslint.config.mjs')),
      pyproject: fs.existsSync(path.join(target, 'pyproject.toml')),
      gomod: fs.existsSync(path.join(target, 'go.mod')),
      packageJson: pkg !== null,
      claudeMd: fs.existsSync(path.join(target, 'CLAUDE.md')),
    },
  };
}
