import type { LogStore } from '../store/sqlite.js';
import { WATCH_BATCH_SIZE } from '../store/sqlite.js';
import type { ParsedArgs } from '../cli/args.js';
import { flagStr, flagNum } from '../cli/args.js';
import { createState, renderScreen } from '../tui/render.js';
import type { WatchState } from '../tui/render.js';
import { appendEntries, resetEntries, handleKey, MAX_ENTRIES } from '../tui/app.js';

/** How often the SQLite cursor is polled for new rows. */
const POLL_INTERVAL_MS = 500;
/** How long to wait for the rest of an escape sequence before treating ESC as a bare keypress. */
const ESC_FLUSH_MS = 30;
const FALLBACK_WIDTH = 120;
const FALLBACK_HEIGHT = 30;

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

/** `follow: false` starts paused at the top — used by `query --tui`, where the user is
 *  browsing an existing result set rather than tailing a device. */
export async function runWatch(
  store: LogStore, args: ParsedArgs, opts: { follow?: boolean; command?: string } = {}
): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(opts.command
      ? `${opts.command} requires an interactive terminal — drop --tui for plain output`
      : "watch requires an interactive terminal — use 'nslogger-cli query' instead");
  }

  const state = createState({
    session_id: flagStr(args.flags, 'session'),
    tag:        flagStr(args.flags, 'tag'),
    level_min:  flagNum(args.flags, 'level'),
    // A bare word is the common case (`watch 场景值监测`), so treat it as --keyword.
    keyword:    flagStr(args.flags, 'keyword') ?? args.positionals[0],
  }, opts.follow ?? true);

  /** Highest id already shown. */
  let cursor = 0;
  /** Highest id already counted into `state.pending` while paused. Kept separate so the
   *  entries themselves stay unconsumed, yet each tick only scans rows it has never seen —
   *  counting from a stale cursor rescans the whole table and freezes the UI. */
  let pendingCursor = 0;

  /** Fill the view with the newest matching entries and jump the cursor to the end of the
   *  table. Scanning backward stops at the limit, so this is cheap even on a huge database,
   *  and it shows current logs instead of the oldest matches ever recorded. */
  const seedLatest = () => {
    const maxId = store.maxLogId();
    resetEntries(state);
    appendEntries(state, store.queryLatestLogs({ ...state.filter, limit: WATCH_BATCH_SIZE }));
    cursor = maxId;
    pendingCursor = maxId;
    state.connected = true;
  };

  /** Pull everything new, one bounded batch at a time. Bounding the scan by `max_id` lets the
   *  cursor jump past non-matching rows: without it a sparse filter leaves the cursor parked on
   *  the last match and every later tick rescans the growing tail. */
  const pullNew = () => {
    let budget = MAX_ENTRIES / WATCH_BATCH_SIZE;
    for (;;) {
      const maxId = store.maxLogId();
      if (maxId <= cursor) break;
      const rows = store.queryLogsAfter(cursor, { ...state.filter, max_id: maxId });
      appendEntries(state, rows);
      // A full batch means the scan stopped at the last row returned, not at maxId.
      cursor = rows.length === WATCH_BATCH_SIZE ? (rows[rows.length - 1].id ?? cursor) : maxId;
      if (rows.length < WATCH_BATCH_SIZE || --budget <= 0) break;
    }
    pendingCursor = cursor;
    state.pending = 0;
    state.connected = true;
  };

  const poll = () => {
    if (state.follow) { pullNew(); draw(state); return; }
    // Paused: count what arrived, consume nothing.
    const maxId = store.maxLogId();
    if (maxId > pendingCursor) {
      state.pending += store.countLogsAfter(pendingCursor, { ...state.filter, max_id: maxId });
      pendingCursor = maxId;
    }
    state.connected = true;
    draw(state);
  };

  /** Resume tailing. More pending entries than the buffer can hold means the frozen window is
   *  hopelessly stale, so jump straight to the newest instead of replaying a backlog. */
  const resume = () => {
    if (state.pending > MAX_ENTRIES) seedLatest();
    else pullNew();
    draw(state);
  };

  await withRawTerminal(async (onKey) => {
    seedLatest();
    draw(state);
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    const resize = () => draw(state);
    process.stdout.on('resize', resize);

    try {
      await onKey((key) => {
        const action = handleKey(state, key, {
          width: process.stdout.columns || FALLBACK_WIDTH,
          bodyHeight: Math.max(1, (process.stdout.rows || FALLBACK_HEIGHT) - 2),
        });
        if (action === 'refilter') {
          seedLatest();
          draw(state);
          return 'continue';
        }
        if (action === 'resume') {
          resume();
          return 'continue';
        }
        draw(state);
        return action === 'quit' ? 'stop' : 'continue';
      });
    } finally {
      clearInterval(timer);
      process.stdout.off('resize', resize);
    }
  });
}

function draw(state: WatchState): void {
  const width = process.stdout.columns || FALLBACK_WIDTH;
  const height = process.stdout.rows || FALLBACK_HEIGHT;
  const lines = renderScreen(state, width, height);
  process.stdout.write(CLEAR + lines.join('\n'));
}

type KeyVerdict = 'continue' | 'stop';

/** Put the terminal in raw/alt-screen mode, feed keys to the caller, and always restore it. */
async function withRawTerminal(
  run: (onKey: (handler: (key: string) => KeyVerdict) => Promise<void>) => Promise<void>
): Promise<void> {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);

  const restore = () => {
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
  // Terminal state must survive crashes, not just clean exits.
  process.on('exit', restore);

  try {
    await run((handler) => new Promise<void>((resolve) => {
      let pending = '';
      let flushTimer: NodeJS.Timeout | undefined;

      const feed = (keys: string[]): boolean => {
        // A paste or fast keypress can deliver several sequences in one chunk.
        for (const key of keys) {
          if (handler(key) === 'stop') {
            stdin.off('data', onData);
            clearTimeout(flushTimer);
            resolve();
            return true;
          }
        }
        return false;
      };

      function onData(chunk: string): void {
        clearTimeout(flushTimer);
        const { keys, rest } = splitKeys(pending + chunk);
        pending = rest;
        if (feed(keys)) return;
        // An unterminated sequence is either a real key still arriving or a bare Esc press;
        // if nothing follows shortly, treat it as the latter.
        if (pending) {
          flushTimer = setTimeout(() => {
            const held = pending;
            pending = '';
            feed(held.split(''));
          }, ESC_FLUSH_MS);
        }
      }

      stdin.on('data', onData);
    }));
  } finally {
    process.off('exit', restore);
    restore();
  }
}

/** Split raw stdin into keys. Escape sequences are kept intact, SS3 (`ESC O A`, sent by
 *  terminals in application-cursor mode) is normalised to its CSI form (`ESC [ A`), and a
 *  sequence cut in half by a chunk boundary is returned in `rest` to prepend to the next chunk. */
export function splitKeys(chunk: string): { keys: string[]; rest: string } {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    if (ch !== '\x1b') { keys.push(ch); i++; continue; }

    const kind = chunk[i + 1];
    if (kind === undefined) return { keys, rest: chunk.slice(i) };  // bare ESC, maybe more coming

    if (kind === 'O') {                                            // SS3: ESC O <final>
      const final = chunk[i + 2];
      if (final === undefined) return { keys, rest: chunk.slice(i) };
      keys.push(`\x1b[${final}`);
      i += 3;
      continue;
    }
    if (kind === '[') {                                            // CSI: ESC [ <params> <final>
      let j = i + 2;
      while (j < chunk.length && !/[A-Za-z~]/.test(chunk[j])) j++;
      if (j >= chunk.length) return { keys, rest: chunk.slice(i) };
      keys.push(chunk.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    keys.push(ch);                                                 // lone ESC (e.g. cancel)
    i++;
  }
  return { keys, rest: '' };
}
