/**
 * Knowledge graph database manager.
 * Uses sql.js (WASM SQLite) for zero-dependency local storage.
 * Database file: .specflow/knowledge.db
 */

import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_SQL } from './schema';

// sql.js types (minimal subset we use)
interface SqlJsDatabase {
  run(sql: string, params?: any): void;
  exec(sql: string): Array<{ columns: string[]; values: any[][] }>;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatement {
  bind(params?: any): boolean;
  step(): boolean;
  getAsObject(params?: any): Record<string, any>;
  free(): void;
  run(params?: any): void;
}

export interface Database {
  db: SqlJsDatabase;
  dbPath: string;
}

const DB_FILENAME = 'knowledge.db';

/**
 * Open or create the knowledge graph database.
 * Runs schema DDL on first init (IF NOT EXISTS makes it idempotent).
 */
export async function initGraph(projectDir: string): Promise<Database> {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  const specflowDir = path.join(projectDir, '.specflow');
  const dbPath = path.join(specflowDir, DB_FILENAME);

  let db: SqlJsDatabase;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    fs.mkdirSync(specflowDir, { recursive: true });
    db = new SQL.Database();
  }

  // Run schema (IF NOT EXISTS makes this safe to repeat)
  db.run(SCHEMA_SQL);
  saveDb({ db, dbPath });

  return { db, dbPath };
}

/** Save database to disk. */
export function saveDb(database: Database): void {
  const data = database.db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(database.dbPath, buffer);
}

/** Close the database (saves first). */
export function closeGraph(database: Database): void {
  saveDb(database);
  database.db.close();
}

/** Check whether a knowledge graph database exists for a project. */
export function graphExists(projectDir: string): boolean {
  return fs.existsSync(path.join(projectDir, '.specflow', DB_FILENAME));
}

/** Insert or replace a node. */
export function upsertNode(database: Database, id: string, type: string, properties: Record<string, any>): void {
  database.db.run(
    'INSERT OR REPLACE INTO nodes (id, type, properties) VALUES (?, ?, ?)',
    [id, type, JSON.stringify(properties)]
  );
}

/** Insert an edge. */
export function insertEdge(
  database: Database,
  source: string,
  target: string,
  relation: string,
  properties: Record<string, any> = {}
): void {
  database.db.run(
    'INSERT INTO edges (source, target, relation, properties) VALUES (?, ?, ?, ?)',
    [source, target, relation, JSON.stringify(properties)]
  );
}

/** Run a query and return rows as objects. */
export function query(database: Database, sql: string, params: any[] = []): Record<string, any>[] {
  const stmt = database.db.prepare(sql);
  const results: Record<string, any>[] = [];
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

/** Delete all nodes and edges (for rebuild). */
export function clearGraph(database: Database): void {
  database.db.run('DELETE FROM edges');
  database.db.run('DELETE FROM nodes');
}
