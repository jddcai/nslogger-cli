import type { LogEntry } from '../sources/types.js';

export interface CommandResult {
  data: unknown;
  total?: number;
}

const LEVELS = ['NOISE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

export function formatResult(result: CommandResult, pretty: boolean): string {
  if (pretty) return renderPretty(result);
  return JSON.stringify({ success: true, ...result });
}

export function formatError(message: string): string {
  return JSON.stringify({ success: false, message });
}

export function emit(result: CommandResult, pretty: boolean): void {
  process.stdout.write(formatResult(result, pretty) + '\n');
}

export function emitError(message: string): void {
  process.stderr.write(formatError(message) + '\n');
}

function renderPretty(result: CommandResult): string {
  const { data } = result;
  if (Array.isArray(data)) {
    if (data.length === 0) return '(empty)';
    if (looksLikeLogs(data)) return (data as LogEntry[]).map(formatLogLine).join('\n');
    return data.map((d) => JSON.stringify(d)).join('\n');
  }
  return JSON.stringify(data, null, 2);
}

function looksLikeLogs(arr: unknown[]): boolean {
  const f = arr[0] as Record<string, unknown> | undefined;
  return !!f && 'message' in f && 'timestamp' in f && 'level' in f;
}

function formatLogLine(e: LogEntry): string {
  const ts = new Date(e.timestamp).toISOString();
  const lvl = (LEVELS[e.level] ?? String(e.level)).padEnd(5);
  const tag = e.tag ? `[${e.tag}] ` : '';
  return `${ts} ${lvl} ${tag}${e.message}`;
}
