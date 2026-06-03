/**
 * NSLoggerFileSource
 *
 * Parses .nslogger / .nsloggerdata files saved by the NSLogger desktop Viewer.
 * These are NSKeyedArchive binary plists, not raw TCP binary protocol.
 *
 * Field mapping from NSLogger's LoggerMessage NSCoding:
 *   s   → timestamp (Unix seconds)
 *   us  → timestamp microseconds complement
 *   mt  → message type (0=log, 3=clientinfo, 5=mark, ...)
 *   t   → thread ID
 *   l   → log level
 *   tag → log domain/tag
 *   m   → message text
 *   f   → filename
 *   fn  → function name
 *   n   → sequence number
 *   ln  → line number
 */

import { createHash } from 'crypto';
import { statSync } from 'fs';
import { basename } from 'path';
import bplist from 'bplist-parser';
import chokidar from 'chokidar';
import type { LogEntry, LogSinkFn, LogSource, SessionInfo } from './types.js';

// Message types
const LOGMSG_TYPE_LOG        = 0;
const LOGMSG_TYPE_BLOCKSTART = 1;
const LOGMSG_TYPE_BLOCKEND   = 2;
const LOGMSG_TYPE_CLIENTINFO = 3;
const LOGMSG_TYPE_MARK       = 5;

type UID = { UID: number };

function isUID(v: unknown): v is UID {
  return typeof v === 'object' && v !== null && 'UID' in v;
}

/**
 * Lightweight NSKeyedArchive resolver.
 * Resolves UIDs into plain values by looking them up in the $objects array.
 * Handles strings, numbers, booleans, Dates, Buffers, and NS collections.
 */
class KeyedArchiveDecoder {
  private objects: unknown[];
  private cache = new Map<number, unknown>();

  constructor(objects: unknown[]) {
    this.objects = objects;
  }

  resolve(uid: UID | unknown): unknown {
    if (!isUID(uid)) return uid;
    const idx = uid.UID;
    if (this.cache.has(idx)) return this.cache.get(idx);

    const obj = this.objects[idx];
    const result = this.decodeObject(obj);
    this.cache.set(idx, result);
    return result;
  }

  private decodeObject(obj: unknown): unknown {
    if (obj === null || obj === undefined) return null;
    if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
    if (obj instanceof Date) return obj;
    if (Buffer.isBuffer(obj)) return obj;
    if (isUID(obj)) return this.resolve(obj);

    if (typeof obj === 'object') {
      const dict = obj as Record<string, unknown>;

      // NS array: { 'NS.objects': [...] }
      if ('NS.objects' in dict && Array.isArray(dict['NS.objects'])) {
        return (dict['NS.objects'] as unknown[]).map(v => this.resolve(v));
      }

      // NS dictionary: { 'NS.keys': [...], 'NS.objects': [...] }
      if ('NS.keys' in dict && 'NS.objects' in dict) {
        const keys   = (dict['NS.keys']   as unknown[]).map(v => this.resolve(v));
        const values = (dict['NS.objects'] as unknown[]).map(v => this.resolve(v));
        const result: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i++) result[String(keys[i])] = values[i];
        return result;
      }

      // Encoded object with $class — decode all non-$ keys
      if ('$class' in dict) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(dict)) {
          if (!k.startsWith('$')) result[k] = this.resolve(v);
        }
        return result;
      }

      // Plain dict
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(dict)) result[k] = this.resolve(v);
      return result;
    }

    return obj;
  }
}

interface RawMessage {
  mt?: number;   // message type
  s?: number;    // timestamp seconds
  us?: number;   // timestamp microseconds
  t?: string;    // thread id
  l?: number;    // level
  tag?: string;  // tag
  m?: string;    // message
  f?: string;    // filename
  fn?: string;   // function name
  n?: number;    // sequence
  ln?: number;   // line number
}

interface RawConnection {
  _clientName?: string;
  _clientVersion?: string;
  clientOSName?: string;
  clientOSVersion?: string;
  clientDevice?: string;
  _messages?: RawMessage[];
}

function parseNSLoggerArchive(filePath: string): {
  session: Partial<SessionInfo>;
  entries: LogEntry[];
} {
  // bplist-parser defaults to 32768 objects; large log files can exceed this
  (bplist as unknown as { maxObjectCount: number }).maxObjectCount = 2_000_000;
  const [raw] = bplist.parseFileSync(filePath) as [Record<string, unknown>];

  const objects = raw['$objects'] as unknown[];
  const topRoot = raw['$top'] as Record<string, UID>;
  const decoder = new KeyedArchiveDecoder(objects);

  // Root is an array of LoggerConnection objects
  const rootArray = decoder.resolve(topRoot['root']) as RawConnection[];
  const connections = Array.isArray(rootArray) ? rootArray : [rootArray];
  const conn = connections[0] as RawConnection;

  const session: Partial<SessionInfo> = {
    client_name:    conn._clientName    ?? null,
    client_version: conn._clientVersion ?? null,
    os_name:        conn.clientOSName   ?? null,
    os_version:     conn.clientOSVersion ?? null,
    device_model:   conn.clientDevice   ?? null,
  };

  const rawMessages = (conn._messages ?? []) as RawMessage[];
  const entries: LogEntry[] = [];

  for (const msg of rawMessages) {
    const mt = msg.mt ?? LOGMSG_TYPE_LOG;
    if (mt === LOGMSG_TYPE_CLIENTINFO || mt === LOGMSG_TYPE_BLOCKSTART || mt === LOGMSG_TYPE_BLOCKEND) {
      continue; // skip structural messages
    }

    const tsS  = msg.s  ?? 0;
    const tsUs = msg.us ?? 0;
    const timestamp = tsS * 1000 + Math.floor(tsUs / 1000);

    let message = msg.m ?? '';
    if (mt === LOGMSG_TYPE_MARK) message = message || '[mark]';

    entries.push({
      source:        'nslogger',
      session_id:    '', // filled by caller
      seq:           msg.n           ?? entries.length,
      timestamp,
      level:         msg.l           ?? 0,
      tag:           msg.tag         ?? null,
      thread_id:     msg.t           ?? 'unknown',
      message,
      filename:      msg.f           || null,
      line_number:   msg.ln          ?? null,
      function_name: msg.fn          || null,
      raw:           null,
    });
  }

  return { session, entries };
}

export class NSLoggerFileSource implements LogSource {
  readonly name = 'nslogger-file';

  private watchDirs: string[];
  private watcher?: chokidar.FSWatcher;
  private sink?: LogSinkFn;

  constructor(watchDirs: string[]) {
    this.watchDirs = watchDirs;
  }

  async start(sink: LogSinkFn): Promise<void> {
    this.sink = sink;
    if (this.watchDirs.length === 0) return;

    this.watcher = chokidar.watch(
      this.watchDirs.flatMap(d => [
        `${d}/**/*.nslogger`,
        `${d}/**/*.nsloggerdata`,
      ]),
      { persistent: true, ignoreInitial: false }
    );

    this.watcher.on('add',    path => this.loadFile(path));
    this.watcher.on('change', path => this.loadFile(path));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  /** Public: load a specific file on demand (used by the `load` command and the file watcher) */
  loadFile(filePath: string): SessionInfo {
    try {
      const stat = statSync(filePath);
      const sessionId = createHash('sha1').update(filePath).digest('hex').slice(0, 16);

      const { session, entries } = parseNSLoggerArchive(filePath);

      const sessionInfo: SessionInfo = {
        session_id:     sessionId,
        source:         'nslogger',
        client_name:    session.client_name    ?? null,
        client_version: session.client_version ?? null,
        os_name:        session.os_name        ?? null,
        os_version:     session.os_version     ?? null,
        device_model:   session.device_model   ?? null,
        started_at:     entries[0]?.timestamp  ?? stat.mtimeMs,
        ended_at:       entries[entries.length - 1]?.timestamp ?? null,
        parse_error:    null,
      };

      for (const e of entries) e.session_id = sessionId;

      this.sink?.(sessionInfo, entries);
      console.error(`[nslogger-file] Loaded ${entries.length} entries from ${basename(filePath)}`);
      return sessionInfo;
    } catch (err) {
      const sessionId = createHash('sha1').update(filePath).digest('hex').slice(0, 16);
      const errorMsg  = err instanceof Error ? err.message : String(err);
      console.error(`[nslogger-file] Failed to parse ${filePath}: ${errorMsg}`);
      const errorSession: SessionInfo = {
        session_id: sessionId, source: 'nslogger',
        client_name: null, client_version: null,
        os_name: null, os_version: null, device_model: null,
        started_at: Date.now(), ended_at: null,
        parse_error: errorMsg,
      };
      this.sink?.(errorSession, []);
      return errorSession;
    }
  }
}
