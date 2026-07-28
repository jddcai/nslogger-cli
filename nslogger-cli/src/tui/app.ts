import type { LogEntry } from '../sources/types.js';
import type { WatchState, WatchFilter } from './render.js';
import { buildLines, computeTop, anchorLine } from './render.js';

/** Ring-buffer cap. Older entries are dropped so a long watch session cannot grow unbounded. */
export const MAX_ENTRIES = 5000;

/** What the caller must do after a keypress; state changes are already applied. */
export type KeyAction = 'none' | 'quit' | 'refilter' | 'resume';

/** Append newly polled entries, evicting the oldest beyond MAX_ENTRIES. */
export function appendEntries(state: WatchState, incoming: LogEntry[]): void {
  state.connected = true;
  if (incoming.length === 0) return;

  state.entries.push(...incoming);
  const overflow = state.entries.length - MAX_ENTRIES;
  if (overflow > 0) {
    state.entries.splice(0, overflow);
    state.dropped += overflow;
    state.selected = Math.max(-1, state.selected - overflow);
  }
  if (state.follow) state.selected = state.entries.length - 1;
  else if (state.selected === -1) state.selected = 0; // browsing a static result set: start at the top
}

/** Drop everything and re-arm for a fresh query after the filter changed. */
export function resetEntries(state: WatchState): void {
  state.entries = [];
  state.expanded.clear();
  state.selected = -1;
  state.scrollOffset = 0;
  state.dropped = 0;
  state.pending = 0;
  state.connected = false;
}

/** `tag:x level:3 session:y free text` → filter. Bare words become the keyword. */
export function parseFilterInput(input: string): WatchFilter {
  const filter: WatchFilter = {};
  const words: string[] = [];

  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const sep = token.indexOf(':');
    const key = sep === -1 ? '' : token.slice(0, sep);
    const value = token.slice(sep + 1);
    if (key === 'tag' && value) filter.tag = value;
    else if (key === 'session' && value) filter.session_id = value;
    else if (key === 'level' && value && !Number.isNaN(Number(value))) filter.level_min = Number(value);
    else words.push(token);
  }
  if (words.length) filter.keyword = words.join(' ');
  return filter;
}

function formatFilterInput(f: WatchFilter): string {
  const parts: string[] = [];
  if (f.session_id) parts.push(`session:${f.session_id}`);
  if (f.tag) parts.push(`tag:${f.tag}`);
  if (f.level_min != null) parts.push(`level:${f.level_min}`);
  if (f.keyword) parts.push(f.keyword);
  return parts.join(' ');
}

export interface Viewport {
  width: number;
  /** Rows available for log lines (screen height minus header and footer). */
  bodyHeight: number;
}

/** Apply one keypress. The viewport drives page-sized scrolling and scroll clamping. */
export function handleKey(state: WatchState, key: string, view: Viewport): KeyAction {
  if (key === '\x03') return 'quit'; // Ctrl-C

  if (state.editing !== null) return handleEditingKey(state, key);

  switch (key) {
    case 'q':
    case 'Q':
      return 'quit';
    case 'f':
    case 'F':
      if (state.follow) { pause(state, view); return 'none'; }
      state.follow = true;
      return 'resume';
    case '/':
      state.editing = formatFilterInput(state.filter);
      pause(state, view);
      return 'none';
    case 'g':
      state.follow = false;
      state.selected = state.entries.length ? 0 : -1;
      state.scrollOffset = 0;
      return 'none';
    case 'G':
      state.follow = true;
      state.selected = state.entries.length - 1;
      return 'resume';
    case '\r':
    case '\n':
      toggleExpanded(state, view);
      return 'none';
    case '\x1b[A':
    case 'k':
      move(state, -1, view);
      return 'none';
    case '\x1b[B':
    case 'j':
      move(state, 1, view);
      return 'none';
    case '\x1b[5~':
      move(state, -view.bodyHeight, view);
      return 'none';
    case '\x1b[6~':
      move(state, view.bodyHeight, view);
      return 'none';
    default:
      return 'none';
  }
}

function handleEditingKey(state: WatchState, key: string): KeyAction {
  if (key === '\x1b') { state.editing = null; return 'none'; }       // Esc cancels
  if (key === '\r' || key === '\n') {
    state.filter = parseFilterInput(state.editing ?? '');
    state.editing = null;
    state.follow = true;
    return 'refilter';
  }
  if (key === '\x7f' || key === '\b') {
    state.editing = (state.editing ?? '').slice(0, -1);
    return 'none';
  }
  // Ignore control sequences (arrows etc.); accept plain printable input only.
  if (key.length === 1 && key >= ' ') state.editing = (state.editing ?? '') + key;
  return 'none';
}

function toggleExpanded(state: WatchState, view: Viewport): void {
  const entry = state.entries[state.selected];
  if (!entry || entry.id == null) return;
  if (state.expanded.has(entry.id)) {
    state.expanded.delete(entry.id);
  } else {
    // Reading an entry's detail means the user stopped tailing — otherwise incoming
    // logs would immediately scroll what they just opened off the screen.
    pause(state, view);
    state.expanded.add(entry.id);
  }
}

function move(state: WatchState, delta: number, view: Viewport): void {
  if (state.entries.length === 0) return;
  // Where the viewport sits before the selection moves — the screen should stay put unless
  // the new selection would fall outside it.
  const top = computeTop(buildLines(state, view.width), state, view.bodyHeight);

  const next = Math.min(state.entries.length - 1, Math.max(0, state.selected + delta));
  state.selected = next;
  // Moving off the newest entry stops tailing. Moving onto it must NOT resume: pausing is
  // explicit (f / expand), so only an explicit f or G may undo it — otherwise a single ↓
  // at the bottom of the list would silently start the screen scrolling again.
  state.follow = state.follow && next === state.entries.length - 1;
  keepVisible(state, view, top);
}

/** Stop tailing, freezing the viewport exactly where it is on screen. */
function pause(state: WatchState, view: Viewport): void {
  const top = computeTop(buildLines(state, view.width), state, view.bodyHeight);
  state.follow = false;
  keepVisible(state, view, top);
}

/** Re-anchor the scroll offset to `top`, nudging it only as far as needed to keep the
 *  selected entry on screen. */
function keepVisible(state: WatchState, view: Viewport, top: number): void {
  const lines = buildLines(state, view.width);
  const anchor = anchorLine(lines, state);
  if (anchor === -1) return;

  let wanted = top;
  if (anchor < wanted) wanted = anchor;
  if (anchor >= wanted + view.bodyHeight) wanted = anchor - view.bodyHeight + 1;
  state.scrollOffset = Math.max(0, anchor - Math.max(0, wanted));
}
