import { createHash } from 'crypto';
import { statSync } from 'fs';
import { basename } from 'path';
import bplist from 'bplist-parser';
import type { LogEntry, SessionInfo } from './src/sources/types.js';

// Message types
const LOGMSG_TYPE_LOG = 0;
const LOGMSG_TYPE_BLOCKSTART = 1;
const LOGMSG_TYPE_BLOCKEND = 2;
const LOGMSG_TYPE_CLIENTINFO = 3;
const LOGMSG_TYPE_MARK = 5;

type UID = { UID: number };

function isUID(v: unknown): v is UID {
  return typeof v === 'object' && v !== null && 'UID' in v;
}

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

      if ('NS.objects' in dict && Array.isArray(dict['NS.objects'])) {
        return (dict['NS.objects'] as unknown[]).map(v => this.resolve(v));
      }

      if ('NS.keys' in dict && 'NS.objects' in dict) {
        const keys = (dict['NS.keys'] as unknown[]).map(v => this.resolve(v));
        const values = (dict['NS.objects'] as unknown[]).map(v => this.resolve(v));
        const result: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i++) result[String(keys[i])] = values[i];
        return result;
      }

      if ('$class' in dict) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(dict)) {
          if (!k.startsWith('$')) result[k] = this.resolve(v);
        }
        return result;
      }

      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(dict)) result[k] = this.resolve(v);
      return result;
    }

    return obj;
  }
}

interface RawMessage {
  mt?: number;
  s?: number;
  us?: number;
  t?: string;
  l?: number;
  tag?: string;
  m?: string;
  f?: string;
  fn?: string;
  n?: number;
  ln?: number;
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
  (bplist as unknown as { maxObjectCount: number }).maxObjectCount = 2_000_000;
  const [raw] = bplist.parseFileSync(filePath) as [Record<string, unknown>];

  const objects = raw['$objects'] as unknown[];
  const topRoot = raw['$top'] as Record<string, UID>;
  const decoder = new KeyedArchiveDecoder(objects);

  const rootArray = decoder.resolve(topRoot['root']) as RawConnection[];
  const connections = Array.isArray(rootArray) ? rootArray : [rootArray];
  const conn = connections[0] as RawConnection;

  const rawMessages = (conn._messages ?? []) as RawMessage[];
  const entries: LogEntry[] = [];

  for (const msg of rawMessages) {
    const mt = msg.mt ?? LOGMSG_TYPE_LOG;
    if (mt === LOGMSG_TYPE_CLIENTINFO || mt === LOGMSG_TYPE_BLOCKSTART || mt === LOGMSG_TYPE_BLOCKEND) {
      continue;
    }

    const tsS = msg.s ?? 0;
    const tsUs = msg.us ?? 0;
    const timestamp = tsS * 1000 + Math.floor(tsUs / 1000);

    let message = msg.m ?? '';
    if (mt === LOGMSG_TYPE_MARK) message = message || '[mark]';

    entries.push({
      source: 'nslogger',
      session_id: '',
      seq: msg.n ?? entries.length,
      timestamp,
      level: msg.l ?? 0,
      tag: msg.tag ?? null,
      thread_id: msg.t ?? 'unknown',
      message,
      filename: msg.f || null,
      line_number: msg.ln ?? null,
      function_name: msg.fn || null,
      raw: null,
    });
  }

  return { session: {}, entries };
}

async function main() {
  const filePath = '/Users/bytedance/Downloads/encourage1.nsloggerdata';
  console.error(`[test] Starting to parse ${filePath}`);

  const startTime = Date.now();

  const parseStartTime = Date.now();
  const { session, entries } = parseNSLoggerArchive(filePath);
  const parseTime = Date.now() - parseStartTime;

  const totalTime = Date.now() - startTime;

  console.error(`\n=== Parse Results ===`);
  console.error(`File: ${basename(filePath)}`);
  console.error(`Total entries parsed: ${entries.length}`);
  console.error(`Parse time: ${parseTime}ms (${(parseTime / 1000).toFixed(2)}s)`);
  console.error(`Total time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)`);
  console.error(`Avg per entry: ${(parseTime / entries.length).toFixed(3)}ms`);

  // Sample first few entries
  console.error(`\n=== First 3 entries ===`);
  entries.slice(0, 3).forEach((e, i) => {
    console.error(`[${i}] tag="${e.tag}" message="${e.message.substring(0, 80)}..."`);
  });

  // Check for XTTrackerService
  const trackerLogs = entries.filter(e => e.tag?.includes('XTTrackerService') || e.message.includes('XTTrackerService'));
  console.error(`\n=== XTTrackerService logs ===`);
  console.error(`Found ${trackerLogs.length} entries with XTTrackerService`);
  if (trackerLogs.length > 0) {
    console.error(`First entry tag="${trackerLogs[0].tag}"`);
    console.error(`First message: ${trackerLogs[0].message.substring(0, 100)}...`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
