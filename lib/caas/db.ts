/**
 * The embedded database: SQLite running inside the Node.js process of the pod.
 *
 * It uses Node's built-in `node:sqlite` (Node >= 22.5), so there is no native
 * addon to compile and nothing outside the pod. The module is loaded through
 * process.getBuiltinModule so the Next.js bundler never tries to resolve it.
 *
 * To switch to better-sqlite3, this file is the only one to change.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type SqlValue = string | number | bigint | null;
export type Row = Record<string, SqlValue>;

export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  service    TEXT NOT NULL,
  path       TEXT NOT NULL,
  body       TEXT NOT NULL,
  etag       TEXT NOT NULL,
  hlc        TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service, path)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS history (
  service    TEXT NOT NULL,
  path       TEXT NOT NULL,
  hlc        TEXT NOT NULL,
  body       TEXT NOT NULL,
  etag       TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (service, path, hlc)
) WITHOUT ROWID;
`;

export function openDatabase(dataDir: string): Database {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const sqlite = getBuiltin?.('node:sqlite') as { DatabaseSync: new (file: string) => Database } | undefined;
  if (!sqlite) {
    throw new Error(`node:sqlite is not available in Node ${process.version}; Node 22.5 or newer is required`);
  }

  let file = ':memory:';
  if (dataDir !== ':memory:') {
    mkdirSync(dataDir, { recursive: true });
    file = join(dataDir, 'caas.db');
  }

  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}
