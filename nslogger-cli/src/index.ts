#!/usr/bin/env node
import { LogStore } from './store/sqlite.js';
import { loadConfig, resolveDbPath } from './config.js';
import { parseArgs, flagStr, flagBool } from './cli/args.js';
import { emit, emitError } from './cli/output.js';
import { runServe } from './commands/serve.js';
import {
  cmdSessions, cmdQuery, cmdContext, cmdTraceThread,
  cmdTraceRange, cmdErrors, cmdLoad, cmdClear,
} from './commands/query.js';

const HELP = `nslogger-cli <command> [options]

Commands:
  serve                                   Start the log receiver (TCP + file watch). Foreground; Ctrl-C to stop.
  sessions                                List all log sessions
  query [--session --tag --level --keyword --limit --offset]
  context <log_id> [--before --after]     Surrounding entries around a log id
  trace-thread <session_id> <thread_id>   All entries for one thread
  trace-range <session_id> --from <ms> --to <ms>
  errors [--session --level]              Warn/error entries (default level>=3)
  load <file.nslogger>                    Import a file; prints its session_id
  clear <session_id>                      Delete a session
  help [--json]                           Show this help (or machine-readable list)

Global options:
  --db <path>       Override database path
  --config <path>   Override config.json path
  --pretty          Human-readable output (default: JSON)
`;

const COMMANDS_JSON = [
  { name: 'serve', args: [], flags: [] },
  { name: 'sessions', args: [], flags: [] },
  { name: 'query', args: [], flags: ['session', 'tag', 'level', 'keyword', 'limit', 'offset'] },
  { name: 'context', args: ['log_id'], flags: ['before', 'after'] },
  { name: 'trace-thread', args: ['session_id', 'thread_id'], flags: [] },
  { name: 'trace-range', args: ['session_id'], flags: ['from', 'to'] },
  { name: 'errors', args: [], flags: ['session', 'level'] },
  { name: 'load', args: ['file'], flags: [] },
  { name: 'clear', args: ['session_id'], flags: [] },
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pretty = flagBool(args.flags, 'pretty');

  if (!args.command || args.command === 'help') {
    if (flagBool(args.flags, 'json')) {
      process.stdout.write(JSON.stringify({ success: true, data: COMMANDS_JSON }) + '\n');
    } else {
      process.stdout.write(HELP);
    }
    return;
  }

  const configPath = flagStr(args.flags, 'config');

  if (args.command === 'serve') {
    // serve needs the full config (watch_dirs, sources), so it uses cfg.db_path,
    // not resolveDbPath/--db. The --db flag is intentionally not honored here.
    const cfg = loadConfig(configPath);
    const store = new LogStore(cfg.db_path);
    await runServe(cfg, store);
    return;
  }

  // load may create a fresh DB; all read/clear commands require it to already exist
  const mustExist = args.command !== 'load';
  const store = new LogStore(resolveDbPath(flagStr(args.flags, 'db'), configPath), { mustExist });

  switch (args.command) {
    case 'sessions':     emit(cmdSessions(store), pretty); return;
    case 'query':        emit(cmdQuery(store, args), pretty); return;
    case 'context':      emit(cmdContext(store, args), pretty); return;
    case 'trace-thread': emit(cmdTraceThread(store, args), pretty); return;
    case 'trace-range':  emit(cmdTraceRange(store, args), pretty); return;
    case 'errors':       emit(cmdErrors(store, args), pretty); return;
    case 'load':         emit(await cmdLoad(store, args), pretty); return;
    case 'clear':        emit(cmdClear(store, args), pretty); return;
    default:
      throw new Error(`Unknown command: ${args.command}. Run 'nslogger-cli help'.`);
  }
}

main().catch((err) => {
  emitError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
