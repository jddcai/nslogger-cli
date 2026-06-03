import { resolve } from 'path';
import type { LogStore } from '../store/sqlite.js';
import { NSLoggerFileSource } from '../sources/nslogger-file.js';
import type { LogEntry, SessionInfo } from '../sources/types.js';
import type { CommandResult } from '../cli/output.js';
import type { ParsedArgs } from '../cli/args.js';
import { flagStr, flagNum } from '../cli/args.js';

export function cmdSessions(store: LogStore): CommandResult {
  const sessions = store.listSessions();
  return { data: sessions, total: sessions.length };
}

export function cmdQuery(store: LogStore, args: ParsedArgs): CommandResult {
  const { rows, total } = store.queryLogs({
    session_id: flagStr(args.flags, 'session'),
    tag:        flagStr(args.flags, 'tag'),
    level_min:  flagNum(args.flags, 'level'),
    keyword:    flagStr(args.flags, 'keyword'),
    limit:      flagNum(args.flags, 'limit'),
    offset:     flagNum(args.flags, 'offset'),
  });
  return { data: rows, total };
}

export function cmdContext(store: LogStore, args: ParsedArgs): CommandResult {
  const logId = Number(args.positionals[0]);
  if (!Number.isInteger(logId) || logId <= 0) {
    throw new Error('context requires a positive integer <log_id>');
  }
  const rows = store.getLogContext(logId, flagNum(args.flags, 'before') ?? 10, flagNum(args.flags, 'after') ?? 10);
  return { data: rows, total: rows.length };
}

export function cmdTraceThread(store: LogStore, args: ParsedArgs): CommandResult {
  const [sessionId, threadId] = args.positionals;
  if (!sessionId || !threadId) throw new Error('trace-thread requires <session_id> <thread_id>');
  const rows = store.traceThread(sessionId, threadId);
  return { data: rows, total: rows.length };
}

export function cmdTraceRange(store: LogStore, args: ParsedArgs): CommandResult {
  const sessionId = args.positionals[0];
  const from = flagNum(args.flags, 'from');
  const to = flagNum(args.flags, 'to');
  if (!sessionId || from == null || to == null) {
    throw new Error('trace-range requires <session_id> --from <ms> --to <ms>');
  }
  const rows = store.traceTimerange(sessionId, from, to);
  return { data: rows, total: rows.length };
}

export function cmdErrors(store: LogStore, args: ParsedArgs): CommandResult {
  const rows = store.getErrors(flagStr(args.flags, 'session'), flagNum(args.flags, 'level') ?? 3);
  return { data: rows, total: rows.length };
}

export async function cmdLoad(store: LogStore, args: ParsedArgs): Promise<CommandResult> {
  const file = args.positionals[0];
  if (!file) throw new Error('load requires a <file.nslogger> path');
  const absPath = resolve(file);
  const sink = (session: SessionInfo, entries: LogEntry[]) => {
    store.upsertSession(session);
    if (entries.length > 0) store.insertLogs(entries);
  };
  const source = new NSLoggerFileSource([]); // empty watch dirs → start() just wires the sink
  await source.start(sink);
  const session = source.loadFile(absPath);
  if (session.parse_error) {
    throw new Error(`load failed for ${absPath}: ${session.parse_error}`);
  }
  return { data: { session_id: session.session_id, file: absPath } };
}

export function cmdClear(store: LogStore, args: ParsedArgs): CommandResult {
  const sessionId = args.positionals[0];
  if (!sessionId) throw new Error('clear requires a <session_id>');
  store.clearSession(sessionId);
  return { data: { cleared: sessionId } };
}
