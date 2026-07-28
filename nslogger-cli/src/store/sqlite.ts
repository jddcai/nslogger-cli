import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type { LogEntry, SessionInfo } from '../sources/types.js';

/** Rows fetched per incremental poll in `watch`. Bounds memory and keeps each tick cheap. */
export const WATCH_BATCH_SIZE = 500;

export interface LogFilter {
  session_id?: string;
  tag?: string;
  level_min?: number;
  keyword?: string;
}

export class LogStore {
  private db: Database.Database;

  constructor(dbPath: string, opts: { mustExist?: boolean } = {}) {
    if (opts.mustExist && !existsSync(dbPath)) {
      // Under the default /tmp location the OS may have reclaimed it — say what to do next.
      throw new Error(
        `database not found at ${dbPath} — run 'nslogger-cli load <file.nslogger>' or start 'nslogger-cli serve' first`
      );
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id   TEXT PRIMARY KEY,
        source       TEXT NOT NULL,
        client_name  TEXT,
        client_version TEXT,
        os_name      TEXT,
        os_version   TEXT,
        device_model TEXT,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        parse_error  TEXT
      );

      CREATE TABLE IF NOT EXISTS logs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        source        TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        timestamp     INTEGER NOT NULL,
        level         INTEGER NOT NULL DEFAULT 0,
        tag           TEXT,
        thread_id     TEXT NOT NULL,
        message       TEXT NOT NULL,
        filename      TEXT,
        line_number   INTEGER,
        function_name TEXT,
        raw           TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_logs_session   ON logs(session_id);
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_logs_level     ON logs(level);
      CREATE INDEX IF NOT EXISTS idx_logs_tag       ON logs(tag);
      CREATE INDEX IF NOT EXISTS idx_logs_thread    ON logs(session_id, thread_id);
    `);
  }

  upsertSession(session: SessionInfo) {
    this.db.prepare(`
      INSERT INTO sessions (session_id, source, client_name, client_version, os_name, os_version, device_model, started_at, ended_at, parse_error)
      VALUES (@session_id, @source, @client_name, @client_version, @os_name, @os_version, @device_model, @started_at, @ended_at, @parse_error)
      ON CONFLICT(session_id) DO UPDATE SET
        client_name    = COALESCE(excluded.client_name,    sessions.client_name),
        client_version = COALESCE(excluded.client_version, sessions.client_version),
        os_name        = COALESCE(excluded.os_name,        sessions.os_name),
        os_version     = COALESCE(excluded.os_version,     sessions.os_version),
        device_model   = COALESCE(excluded.device_model,   sessions.device_model),
        ended_at       = excluded.ended_at,
        parse_error    = excluded.parse_error
    `).run(session);
  }

  insertLogs(entries: LogEntry[]) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO logs (source, session_id, seq, timestamp, level, tag, thread_id, message, filename, line_number, function_name, raw)
      VALUES (@source, @session_id, @seq, @timestamp, @level, @tag, @thread_id, @message, @filename, @line_number, @function_name, @raw)
    `);
    const insertMany = this.db.transaction((rows: LogEntry[]) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(entries);
  }

  listSessions(): SessionInfo[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as SessionInfo[];
  }

  queryLogs(opts: {
    session_id?: string;
    tag?: string;
    level_min?: number;
    keyword?: string;
    limit?: number;
    offset?: number;
  }): { rows: LogEntry[]; total: number } {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.session_id) { conditions.push('session_id = @session_id'); params.session_id = opts.session_id; }
    if (opts.tag)        { conditions.push('tag = @tag'); params.tag = opts.tag; }
    if (opts.level_min != null) { conditions.push('level >= @level_min'); params.level_min = opts.level_min; }
    if (opts.keyword)    { conditions.push('message LIKE @keyword'); params.keyword = `%${opts.keyword}%`; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM logs ${where}`).get(params) as { c: number }).c;

    params.limit  = opts.limit  ?? 100;
    params.offset = opts.offset ?? 0;
    const rows = this.db.prepare(`SELECT * FROM logs ${where} ORDER BY timestamp ASC, seq ASC LIMIT @limit OFFSET @offset`).all(params) as LogEntry[];

    return { rows, total };
  }

  getLogContext(logId: number, before = 10, after = 10): LogEntry[] {
    const row = this.db.prepare('SELECT * FROM logs WHERE id = ?').get(logId) as LogEntry | undefined;
    if (!row) return [];

    const prevRows = this.db.prepare(
      'SELECT * FROM logs WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
    ).all(row.session_id, logId, before) as LogEntry[];

    const nextRows = this.db.prepare(
      'SELECT * FROM logs WHERE session_id = ? AND id >= ? ORDER BY id ASC LIMIT ?'
    ).all(row.session_id, logId, after + 1) as LogEntry[];

    return [...prevRows.reverse(), ...nextRows];
  }

  traceThread(sessionId: string, threadId: string): LogEntry[] {
    return this.db.prepare(
      'SELECT * FROM logs WHERE session_id = ? AND thread_id = ? ORDER BY timestamp ASC, seq ASC'
    ).all(sessionId, threadId) as LogEntry[];
  }

  traceTimerange(sessionId: string, fromMs: number, toMs: number): LogEntry[] {
    return this.db.prepare(
      'SELECT * FROM logs WHERE session_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC, seq ASC'
    ).all(sessionId, fromMs, toMs) as LogEntry[];
  }

  getErrors(sessionId?: string, levelMin = 3): LogEntry[] {
    if (sessionId) {
      return this.db.prepare(
        'SELECT * FROM logs WHERE session_id = ? AND level >= ? ORDER BY timestamp ASC, seq ASC'
      ).all(sessionId, levelMin) as LogEntry[];
    }
    return this.db.prepare(
      'SELECT * FROM logs WHERE level >= ? ORDER BY timestamp ASC, seq ASC'
    ).all(levelMin) as LogEntry[];
  }

  clearSession(sessionId: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM logs WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
    })();
  }

  /** Delete every session and log. Returns how many rows each delete removed. */
  clearAll(): { sessions: number; logs: number } {
    return this.db.transaction(() => {
      const logs = this.db.prepare('DELETE FROM logs').run().changes;
      const sessions = this.db.prepare('DELETE FROM sessions').run().changes;
      return { sessions, logs };
    })();
  }

  sessionExists(sessionId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM sessions WHERE session_id = ?').get(sessionId);
  }

}
