// DuckDB adapter: a minimal pg-shaped wrapper over @duckdb/node-api.
// Single embedded instance + one pooled connection; migrations are applied
// idempotently on startup (see migrate()).

import { DuckDBConnection, DuckDBInstance, DuckDBMaterializedResult } from '@duckdb/node-api';

export type DuckQueryRow = Record<string, unknown>;

export interface DuckQueryResult {
  rows: DuckQueryRow[];
  rowCount: number;
}

export function getDuckDbPath(): string {
  return process.env.DUCKDB_PATH || './data/antispam.duckdb';
}

let instancePromise: Promise<DuckDBInstance> | null = null;
// Per-path connections: parallel test files in one worker may point
// DUCKDB_PATH at different files; a single shared cache would open the wrong file.
const connections = new Map<string, Promise<DuckDBConnection>>();

export async function getDuckConnection(): Promise<DuckDBConnection> {
  const path = getDuckDbPath();
  let connectionPromise = connections.get(path);
  if (!connectionPromise) {
    connectionPromise = (async () => {
      const dir = path.replace(/\/[^/]+$/, '');
      if (dir && dir !== path) await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
      const instance = await DuckDBInstance.create(path);
      return instance.connect();
    })();
    // A failed open (bad path, full disk) must not poison the module forever:
    // the next caller retries with the then-current DUCKDB_PATH.
    connectionPromise.catch(() => { connections.delete(path); });
    connections.set(path, connectionPromise);
  }
  return connectionPromise;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= max && value >= -max ? Number(value) : value.toString();
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = canonicalize(v);
    return out;
  }
  return value;
}

async function toPgShaped(result: DuckDBMaterializedResult): Promise<DuckQueryResult> {
  // Mutations without RETURNING yield a single phantom row `{ Count: n }`
  // where n = affected rows (0 when ON CONFLICT DO NOTHING skipped).
  // Row-returning statements (SELECT / RETURNING) list real rows only.
  const raw = await result.getRowObjectsJS();
  if (raw.length === 1) {
    const only = raw[0];
    if (only && Object.keys(only).length === 1 && 'Count' in only) {
      return { rows: [], rowCount: Number(only.Count) };
    }
  }
  const rows = raw.map((row) => {
    const out: DuckQueryRow = {};
    for (const [k, v] of Object.entries(row ?? {})) out[k] = canonicalize(v);
    return out;
  });
  return { rows, rowCount: rows.length };
}

/** Parameterized query. Values are positional ($1, $2, ...). */
export async function duckQuery(sql: string, values: unknown[] = []): Promise<DuckQueryResult> {
  const connection = await getDuckConnection();
  const result = await connection.run(sql, values as never);
  return await toPgShaped(result);
}

/** Run one or more statements (split on statement boundaries outside quotes). */
export async function duckExec(sql: string): Promise<void> {
  const connection = await getDuckConnection();
  for (const statement of splitStatements(sql)) {
    if (statement.trim().length === 0) continue;
    await connection.run(statement);
  }
}

export async function closeDuck(): Promise<void> {
  const open = [...connections.values()];
  connections.clear();
  instancePromise = null;
  for (const connection of open) {
    (await connection).closeSync();
  }
}

/** Split a .sql file into individual statements; semicolons inside quotes are preserved. */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote && quote === "'") {
          current += sql[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      current += '\n';
      continue;
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements;
}

/**
 * Idempotent migration runner. Tracks applied files in schema_migrations
 * keyed by filename; files must sort in execution order.
 */
export async function duckMigrate(migrationsDir: string): Promise<void> {
  const { readdir, readFile } = await import('node:fs/promises');
  await duckQuery('CREATE TABLE IF NOT EXISTS schema_migrations (filename VARCHAR PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = new Set((await duckQuery('SELECT filename FROM schema_migrations')).rows.map((r) => String(r.filename)));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(`${migrationsDir}/${file}`, 'utf8');
    await duckExec(sql);
    // Concurrent migrators race here; DO NOTHING keeps the ledger authoritative.
    await duckQuery('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [file]);
  }
}
