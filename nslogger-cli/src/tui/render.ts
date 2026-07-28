import type { LogEntry } from '../sources/types.js';
import { formatTimestamp } from '../cli/output.js';
import { truncateToWidth, padToWidth, stringWidth } from '../cli/width.js';

export interface WatchFilter {
  session_id?: string;
  tag?: string;
  level_min?: number;
  keyword?: string;
}

export interface WatchState {
  /** Oldest first. Bounded by MAX_ENTRIES; evictions counted in `dropped`. */
  entries: LogEntry[];
  /** Index into `entries`, or -1 when empty. */
  selected: number;
  /** Ids of entries rendered in expanded (multi-line) form. */
  expanded: Set<number>;
  /** Auto-scroll to the newest entry as logs arrive. */
  follow: boolean;
  filter: WatchFilter;
  /** Non-null while the `/` filter prompt is open; holds the raw input buffer. */
  editing: string | null;
  /** Display lines kept visible above the selected entry. Anchoring the viewport to the
   *  selection (rather than to an absolute line number) keeps the screen still when entries
   *  are evicted from the head of the buffer. */
  scrollOffset: number;
  /** Entries evicted from the head of the buffer. */
  dropped: number;
  /** Matching logs that arrived while paused and are deliberately not buffered yet. */
  pending: number;
  /** Set once polling has run at least one query. */
  connected: boolean;
}

export interface DisplayLine {
  text: string;
  entryIndex: number;
  /** First line of an entry — the row selection anchors to. */
  first: boolean;
}

const LEVEL_INITIALS = ['N', 'D', 'I', 'W', 'E'];
const LEVEL_NAMES = ['NOISE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];
/** SGR color per level; index matches LEVEL_INITIALS. */
const LEVEL_COLORS = ['90', '90', '', '33', '31'];

const RESET = '\x1b[0m';
const INVERSE = '\x1b[7m';
const DIM = '\x1b[2m';

export function createState(filter: WatchFilter, follow = true): WatchState {
  return {
    entries: [], selected: -1, expanded: new Set(), follow,
    filter, editing: null, scrollOffset: 0, dropped: 0, pending: 0, connected: false,
  };
}

export function describeFilter(f: WatchFilter): string {
  const parts: string[] = [];
  if (f.session_id) parts.push(`session=${f.session_id}`);
  if (f.tag) parts.push(`tag=${f.tag}`);
  if (f.level_min != null) parts.push(`level>=${LEVEL_NAMES[f.level_min] ?? f.level_min}`);
  if (f.keyword) parts.push(`keyword=${f.keyword}`);
  return parts.length ? parts.join(' ') : 'no filter';
}

/** Flatten the buffer into printable lines, expanding entries the user opened. */
export function buildLines(state: WatchState, width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  state.entries.forEach((e, i) => {
    lines.push({ text: collapsedLine(e, width), entryIndex: i, first: true });
    if (e.id != null && state.expanded.has(e.id)) {
      for (const detail of expandedLines(e, width)) {
        lines.push({ text: detail, entryIndex: i, first: false });
      }
    }
  });
  return lines;
}

function collapsedLine(e: LogEntry, width: number): string {
  const id = (e.id != null ? `#${e.id}` : '').padStart(6);
  const lvl = LEVEL_INITIALS[e.level] ?? String(e.level);
  const tag = e.tag ? `[${e.tag}]  ` : '';
  const messageLines = e.message.split('\n');
  const extra = messageLines.length - 1;
  const message = messageLines[0] + (extra > 0 ? `⏎+${extra}` : '');
  return truncateToWidth(`${id}  ${formatTimestamp(e.timestamp)}  ${lvl}  ${tag}${message}`, width);
}

function expandedLines(e: LogEntry, width: number): string[] {
  const out: string[] = [];
  const where = [e.filename && `${e.filename}:${e.line_number ?? '?'}`, e.function_name]
    .filter(Boolean).join(' ');
  const meta = [where, `thread ${e.thread_id}`, e.session_id].filter(Boolean).join('  ');
  out.push(truncateToWidth(`        ${meta}`, width));
  for (const line of e.message.split('\n')) {
    out.push(truncateToWidth(`        ${line}`, width));
  }
  return out;
}

/** Index of the selected entry's first display line, or -1 when there is no selection. */
export function anchorLine(lines: DisplayLine[], state: WatchState): number {
  return lines.findIndex((l) => l.first && l.entryIndex === state.selected);
}

/** First visible display line: pinned to the tail while following, otherwise derived from the
 *  selection so the selected entry holds its row even as the buffer shifts underneath it. */
export function computeTop(lines: DisplayLine[], state: WatchState, bodyHeight: number): number {
  const maxTop = Math.max(0, lines.length - bodyHeight);
  if (state.follow) return maxTop;

  const anchor = anchorLine(lines, state);
  if (anchor === -1) return maxTop;

  let top = Math.min(Math.max(0, anchor - state.scrollOffset), maxTop);
  if (anchor < top) top = anchor;
  if (anchor >= top + bodyHeight) top = anchor - bodyHeight + 1;
  return Math.max(0, top);
}

/** Render the whole screen as exactly `height` lines (header + body + footer). */
export function renderScreen(state: WatchState, width: number, height: number): string[] {
  const bodyHeight = Math.max(1, height - 2);
  const lines = buildLines(state, width);
  const top = computeTop(lines, state, bodyHeight);
  const visible = lines.slice(top, top + bodyHeight);

  const body = visible.map((l) => {
    const selected = l.entryIndex === state.selected;
    const styled = l.first ? colorize(l.text, state.entries[l.entryIndex]) : DIM + l.text + RESET;
    return selected ? INVERSE + padToWidth(stripStyles(l.text), width) + RESET : styled;
  });
  while (body.length < bodyHeight) body.push('');

  return [header(state, width), ...body, footer(state, width)];
}

function header(state: WatchState, width: number): string {
  const status = state.follow ? '● following' : '❚❚ paused';
  const pending = state.pending ? `  +${state.pending} new (f to resume)` : '';
  const count = `${state.entries.length}${state.dropped ? `+${state.dropped} dropped` : ''} logs${pending}`;
  const left = ` nslogger-cli  ${status}  ${count}`;
  const right = `${describeFilter(state.filter)} `;
  const gap = Math.max(1, width - stringWidth(left) - stringWidth(right));
  return INVERSE + padToWidth(truncateToWidth(left + ' '.repeat(gap) + right, width), width) + RESET;
}

function footer(state: WatchState, width: number): string {
  if (state.editing !== null) {
    return padToWidth(truncateToWidth(`filter> ${state.editing}`, width), width);
  }
  const help = state.connected && state.entries.length === 0
    ? 'waiting for logs…   / filter   q quit'
    : '↑↓ move   ⏎ expand   / filter   f follow   g/G top/bottom   q quit';
  return DIM + truncateToWidth(' ' + help, width) + RESET;
}

function colorize(text: string, e: LogEntry | undefined): string {
  const color = e ? LEVEL_COLORS[e.level] : '';
  return color ? `\x1b[${color}m${text}${RESET}` : text;
}

function stripStyles(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

