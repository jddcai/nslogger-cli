import type { LogEntry } from '../sources/types.js';
import { truncateToWidth } from './width.js';

export interface CommandResult {
  data: unknown;
  total?: number;
}

const LEVEL_INITIALS = ['N', 'D', 'I', 'W', 'E'];
/** Width assumed when stdout is not a TTY (piped, redirected, or run by an AI tool). */
const FALLBACK_WIDTH = 120;
/** Never truncate below this — a line narrower than this shows nothing useful. */
const MIN_WIDTH = 40;

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

function terminalWidth(): number {
  return Math.max(MIN_WIDTH, process.stdout.columns || FALLBACK_WIDTH);
}

function renderPretty(result: CommandResult): string {
  const { data, total } = result;
  if (Array.isArray(data)) {
    if (data.length === 0) return '(empty)';
    if (looksLikeLogs(data)) {
      const width = terminalWidth();
      const lines = (data as LogEntry[]).map((e) => formatLogLine(e, width));
      lines.push(formatSummary(data.length, total));
      // Only worth suggesting to a human at a terminal; noise for piped/AI callers.
      if (process.stdout.isTTY) lines.push('use --tui to browse and expand entries interactively');
      return lines.join('\n');
    }
    return data.map((d) => JSON.stringify(d)).join('\n');
  }
  return JSON.stringify(data, null, 2);
}

function looksLikeLogs(arr: unknown[]): boolean {
  const f = arr[0] as Record<string, unknown> | undefined;
  return !!f && 'message' in f && 'timestamp' in f && 'level' in f;
}

function formatSummary(shown: number, total?: number): string {
  if (total == null || total <= shown) return `${shown} total`;
  return `... ${shown} shown, ${total} total (use --offset / --limit for the rest)`;
}

/** Local wall-clock time of day; the date is rarely useful when scanning a single session. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** One log entry compressed to a single line that fits `width`.
 *  Multi-line messages keep only their first line, marked with ⏎+N. */
export function formatLogLine(e: LogEntry, width: number): string {
  const id = e.id != null ? `#${e.id}` : '';
  const lvl = LEVEL_INITIALS[e.level] ?? String(e.level);
  const tag = e.tag ? `[${e.tag}]` : '';

  const messageLines = e.message.split('\n');
  const extra = messageLines.length - 1;
  const message = messageLines[0] + (extra > 0 ? `⏎+${extra}` : '');

  const head = `${id.padStart(6)}  ${formatTimestamp(e.timestamp)}  ${lvl}  ${tag ? tag + '  ' : ''}`;
  return truncateToWidth(head + message, width);
}
