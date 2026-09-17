import initSqlJs from 'sql.js';
import type { SqlJsStatic, Database as SqlJsDb } from 'sql.js';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';

let SQL: SqlJsStatic | null = null;
const innerDb: SqlJsDb | null = null;
let dbPath: string = '';

function getDbPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'lr-agent.db');
}

// ── SqlJsDatabase wrapper ─────────────────────────────────────────

export class SqlJsDatabase {
  private db: SqlJsDb;

  private onDirty: (() => void) | null;

  constructor(db: SqlJsDb, onDirty?: () => void) {
    this.db = db;
    this.onDirty = onDirty ?? null;
  }

  all(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params as import('sql.js').BindParams);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params as import('sql.js').BindParams);
    let result: Record<string, unknown> | undefined;
    if (stmt.step()) {
      result = stmt.getAsObject();
    }
    stmt.free();
    return result;
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.run(sql, params as import('sql.js').BindParams);
    this.markDirty();
  }

  exec(sql: string): void {
    this.db.run(sql);
    this.markDirty();
  }

  transaction(fn: () => void): void {
    this.run('BEGIN');
    try {
      fn();
      this.run('COMMIT');
    } catch (err) {
      this.run('ROLLBACK');
      throw err;
    }
  }

  private markDirty(): void {
    if (this.onDirty) {
      // Use setImmediate to debounce: flush once per event loop tick
      this.onDirty();
    }
  }

  close(): void {
    this.db.close();
  }

  /** Export the entire database as a Uint8Array for saving to disk */
  exportToUint8Array(): Uint8Array {
    return this.db.export();
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────

let _db: SqlJsDatabase | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_DEBOUNCE_MS = 500;
let flushPending = false;

function scheduleFlush(): void {
  if (!_db) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushPending = true;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    doFlush();
  }, FLUSH_DEBOUNCE_MS);
}

function doFlush(): void {
  if (!_db) return;
  try {
    const data = _db.exportToUint8Array();
    fs.writeFile(dbPath, Buffer.from(data), (err) => {
      if (err) {
        console.error('[DB] Failed to flush database:', err);
      }
    });
    flushPending = false;
  } catch (err) {
    console.error('[DB] Failed to flush database:', err);
  }
}

export function getDatabase(): SqlJsDatabase {
  if (!_db) {
    throw new Error(
      'Database not initialized. Call initializeDatabase() first.',
    );
  }
  return _db;
}

export async function initializeDatabase(): Promise<void> {
  dbPath = getDbPath();
  console.log(`[DB] Initializing SQLite database at: ${dbPath}`);

  SQL = await initSqlJs({
    locateFile: (file) =>
      path.join(__dirname, '../../node_modules/sql.js/dist', file),
  });

  let buffer: Uint8Array | null = null;
  try {
    if (await fs.pathExists(dbPath)) {
      buffer = new Uint8Array(await fs.readFile(dbPath));
    }
  } catch {
    console.warn('[DB] Could not read existing database, starting fresh');
  }

  const inner = buffer ? new SQL.Database(buffer) : new SQL.Database();
  _db = new SqlJsDatabase(inner, () => scheduleFlush());
  runMigrations();
  // 初始化迁移后做一次同步写入确保落盘
  if (_db) {
    try {
      fs.writeFileSync(dbPath, Buffer.from(_db.exportToUint8Array()));
    } catch (err) {
      console.error('[DB] Failed to flush after migration:', err);
    }
  }
}

function flushDatabase(): void {
  if (!_db) return;
  // 立即取消待执行的防抖写入并执行同步落盘
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const data = _db.exportToUint8Array();
    fs.writeFileSync(dbPath, Buffer.from(data));
    flushPending = false;
  } catch (err) {
    console.error('[DB] Failed to flush database:', err);
  }
}

export async function closeDatabase(): Promise<void> {
  if (_db) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // 最终同步写入确保不丢数据
    flushDatabase();
    _db.close();
    _db = null;
  }
}

// ── Migrations ─────────────────────────────────────────────────────

function runMigrations(): void {
  const d = _db!;

  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新对话',
      annotation_project_id TEXT,
      interaction_mode TEXT,
      provider_id TEXT,
      model TEXT,
      context_summary TEXT,
      summary_up_to_message_id TEXT,
      last_context_token_estimate INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `);

  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_annotation_project_id ON sessions(annotation_project_id)`,
  );
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at)`,
  );

  d.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      interaction_mode TEXT,
      sort_index INTEGER NOT NULL DEFAULT 0,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'done',
      provider_id TEXT,
      model TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id)`,
  );
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_sort_index ON messages(session_id, sort_index)`,
  );
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_session_role_sort ON messages(session_id, role, sort_index)`,
  );

  d.exec(`
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      encryption_key_id TEXT NOT NULL DEFAULT 'v0',
      model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      vision_probed_at INTEGER,
      vision_probe_detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // user_id multi-user isolation migration
  _addColumnIfMissing(d, 'sessions', 'user_id', "TEXT NOT NULL DEFAULT ''");
  _addColumnIfMissing(d, 'messages', 'user_id', "TEXT NOT NULL DEFAULT ''");
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
  );
  d.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)`,
  );

  // model context window (tokens) + its source: '' | 'manual' | 'probe' | 'heuristic'
  _addColumnIfMissing(d, 'llm_providers', 'context_window_tokens', 'INTEGER');
  _addColumnIfMissing(
    d,
    'llm_providers',
    'context_window_source',
    "TEXT NOT NULL DEFAULT ''",
  );

  console.log('[DB] Migrations completed successfully');
}

function _addColumnIfMissing(
  d: SqlJsDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = d.all(`PRAGMA table_info(${table})`) as { name: string }[];
  if (rows.some((r) => r.name === column)) {
    return;
  }
  try {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    console.error(`[DB] Failed to add column ${column} to ${table}:`, err);
  }
}
