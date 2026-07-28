import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';

const { createState, renderScreen, buildLines, describeFilter } =
  await import(join(ROOT, 'dist', 'tui', 'render.js'));
const { appendEntries, handleKey, parseFilterInput, resetEntries, MAX_ENTRIES } =
  await import(join(ROOT, 'dist', 'tui', 'app.js'));
const { splitKeys } = await import(join(ROOT, 'dist', 'commands', 'watch.js'));

const VIEW = { width: 80, bodyHeight: 10 };

function entry(id, over = {}) {
  return {
    id, source: 'nslogger', session_id: 'sess1', seq: id, timestamp: 0,
    level: 2, tag: 'net', thread_id: 't1', message: `msg ${id}`,
    filename: 'Feed.swift', line_number: 88, function_name: 'load()', raw: null,
    ...over,
  };
}

function stateWith(n) {
  const s = createState({});
  appendEntries(s, Array.from({ length: n }, (_, i) => entry(i + 1)));
  return s;
}

test('buildLines yields one line per collapsed entry', () => {
  const lines = buildLines(stateWith(3), 80);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.first));
  assert.match(lines[0].text, /#1 .*msg 1/);
});

test('expanding an entry pauses follow so incoming logs cannot scroll it away', () => {
  const s = stateWith(3);
  assert.equal(s.follow, true);
  handleKey(s, '\r', VIEW);
  assert.equal(s.follow, false);

  const before = s.selected;
  appendEntries(s, [entry(4), entry(5)]);
  assert.equal(s.selected, before);
  assert.ok(s.expanded.has(3));
});

test('collapsing an entry does not resume follow', () => {
  const s = stateWith(3);
  handleKey(s, '\r', VIEW);
  handleKey(s, '\r', VIEW);
  assert.equal(s.follow, false);
  assert.equal(s.expanded.size, 0);
});

test('a paused state created for query --tui starts at the first entry', () => {
  const s = createState({}, false);
  appendEntries(s, [entry(1), entry(2), entry(3)]);
  assert.equal(s.follow, false);
  assert.equal(s.selected, 0);
});

test('expanding an entry adds detail lines', () => {
  const s = stateWith(2);
  s.selected = 0;
  handleKey(s, '\r', VIEW);
  const lines = buildLines(s, 80);
  assert.ok(lines.length > 2);
  assert.match(lines[1].text, /Feed\.swift:88 load\(\)/);
  assert.equal(lines[1].first, false);
});

test('collapsed line marks extra message lines', () => {
  const s = createState({});
  appendEntries(s, [entry(1, { message: 'first\nsecond\nthird' })]);
  const [line] = buildLines(s, 80);
  assert.match(line.text, /first⏎\+2/);
});

test('lines are truncated to the given width', () => {
  const s = createState({});
  appendEntries(s, [entry(1, { message: 'x'.repeat(500) })]);
  const [line] = buildLines(s, 40);
  assert.equal(line.text.length, 40);
  assert.ok(line.text.endsWith('…'));
});

test('renderScreen returns exactly `height` lines', () => {
  const lines = renderScreen(stateWith(3), 80, 12);
  assert.equal(lines.length, 12);
});

test('header shows follow state and filter', () => {
  const s = stateWith(1);
  const [head] = renderScreen(s, 100, 10);
  assert.match(head, /following/);
  assert.match(head, /no filter/);

  s.follow = false;
  s.filter = { tag: 'net', level_min: 3 };
  const [paused] = renderScreen(s, 100, 10);
  assert.match(paused, /paused/);
  assert.match(paused, /tag=net/);
  assert.match(paused, /level>=WARN/);
});

test('the header reports logs held back while paused', () => {
  const s = stateWith(3);
  handleKey(s, 'f', VIEW);
  s.pending = 1234;
  assert.match(renderScreen(s, 100, 10)[0], /\+1234 new \(f to resume\)/);

  s.pending = 0;
  assert.doesNotMatch(renderScreen(s, 100, 10)[0], /new/);
});

test('resuming asks the caller to fast-forward', () => {
  const s = stateWith(3);
  handleKey(s, 'f', VIEW);
  assert.equal(handleKey(s, 'f', VIEW), 'resume');
  assert.equal(s.follow, true);

  handleKey(s, 'f', VIEW);            // pause again
  assert.equal(handleKey(s, 'G', VIEW), 'resume');
});

test('footer shows the filter prompt while editing', () => {
  const s = stateWith(1);
  handleKey(s, '/', VIEW);
  handleKey(s, 'a', VIEW);
  handleKey(s, 'b', VIEW);
  const lines = renderScreen(s, 80, 10);
  assert.match(lines[lines.length - 1], /filter> ab/);
});

test('follow pins selection to the newest entry', () => {
  const s = stateWith(3);
  assert.equal(s.selected, 2);
  appendEntries(s, [entry(4)]);
  assert.equal(s.selected, 3);
});

test('arrow up leaves follow mode, G re-enters it', () => {
  const s = stateWith(5);
  handleKey(s, '\x1b[A', VIEW);
  assert.equal(s.follow, false);
  assert.equal(s.selected, 3);
  handleKey(s, 'G', VIEW);
  assert.equal(s.follow, true);
  assert.equal(s.selected, 4);
});

test('new entries do not move the selection while paused', () => {
  const s = stateWith(5);
  handleKey(s, '\x1b[A', VIEW);
  appendEntries(s, [entry(6)]);
  assert.equal(s.selected, 3);
});

test('ring buffer evicts oldest entries and keeps selection aligned', () => {
  const s = createState({});
  appendEntries(s, Array.from({ length: MAX_ENTRIES }, (_, i) => entry(i + 1)));
  handleKey(s, 'g', VIEW);            // select oldest
  assert.equal(s.entries[s.selected].id, 1);
  appendEntries(s, [entry(MAX_ENTRIES + 1)]);
  assert.equal(s.entries.length, MAX_ENTRIES);
  assert.equal(s.dropped, 1);
  assert.equal(s.entries[0].id, 2);
});

test('q and Ctrl-C quit', () => {
  assert.equal(handleKey(stateWith(1), 'q', VIEW), 'quit');
  assert.equal(handleKey(stateWith(1), '\x03', VIEW), 'quit');
});

test('f toggles follow', () => {
  const s = stateWith(2);
  handleKey(s, 'f', VIEW);
  assert.equal(s.follow, false);
  handleKey(s, 'f', VIEW);
  assert.equal(s.follow, true);
});

test('pausing with f freezes the visible lines while logs keep arriving', () => {
  const s = stateWith(40);
  handleKey(s, 'f', VIEW);
  const frozen = renderScreen(s, 80, 12).slice(1, -1);

  for (let i = 0; i < 20; i++) appendEntries(s, [entry(100 + i)]);
  assert.deepEqual(renderScreen(s, 80, 12).slice(1, -1), frozen);

  handleKey(s, 'f', VIEW);   // resume
  assert.equal(s.follow, true);
  assert.notDeepEqual(renderScreen(s, 80, 12).slice(1, -1), frozen);
});

test('moving onto the newest entry never silently resumes follow', () => {
  const s = stateWith(5);
  handleKey(s, 'f', VIEW);              // explicit pause at the bottom
  handleKey(s, '\x1b[B', VIEW);         // ↓ with nowhere to go
  assert.equal(s.follow, false);

  handleKey(s, '\x1b[A', VIEW);         // step off and back on
  handleKey(s, '\x1b[B', VIEW);
  assert.equal(s.selected, 4);
  assert.equal(s.follow, false);

  handleKey(s, 'G', VIEW);              // only an explicit key resumes
  assert.equal(s.follow, true);
});

test('opening the filter prompt also pauses', () => {
  const s = stateWith(5);
  handleKey(s, '/', VIEW);
  assert.equal(s.follow, false);
});

test('committing the filter prompt returns refilter', () => {
  const s = stateWith(2);
  handleKey(s, '/', VIEW);
  for (const ch of 'tag:net boom') handleKey(s, ch, VIEW);
  assert.equal(handleKey(s, '\r', VIEW), 'refilter');
  assert.deepEqual(s.filter, { tag: 'net', keyword: 'boom' });
  assert.equal(s.editing, null);
});

test('Esc cancels the filter prompt without changing the filter', () => {
  const s = stateWith(2);
  s.filter = { keyword: 'old' };
  handleKey(s, '/', VIEW);
  handleKey(s, 'x', VIEW);
  handleKey(s, '\x1b', VIEW);
  assert.equal(s.editing, null);
  assert.deepEqual(s.filter, { keyword: 'old' });
});

test('backspace edits the filter buffer', () => {
  const s = stateWith(1);
  handleKey(s, '/', VIEW);
  for (const ch of 'abc') handleKey(s, ch, VIEW);
  handleKey(s, '\x7f', VIEW);
  assert.equal(s.editing, 'ab');
});

test('parseFilterInput splits typed tokens from free text', () => {
  assert.deepEqual(parseFilterInput('tag:net level:3 session:s1 hello world'),
    { tag: 'net', level_min: 3, session_id: 's1', keyword: 'hello world' });
  assert.deepEqual(parseFilterInput('   '), {});
  assert.deepEqual(parseFilterInput('level:abc'), { keyword: 'level:abc' });
});

test('resetEntries clears the buffer for a fresh query', () => {
  const s = stateWith(3);
  s.expanded.add(1);
  resetEntries(s);
  assert.deepEqual(s.entries, []);
  assert.equal(s.selected, -1);
  assert.equal(s.expanded.size, 0);
  assert.equal(s.connected, false);
});

test('describeFilter summarises the active filter', () => {
  assert.equal(describeFilter({}), 'no filter');
  assert.equal(describeFilter({ keyword: 'boom' }), 'keyword=boom');
});

test('splitKeys keeps escape sequences intact', () => {
  assert.deepEqual(splitKeys('\x1b[Aq'), { keys: ['\x1b[A', 'q'], rest: '' });
  assert.deepEqual(splitKeys('ab'), { keys: ['a', 'b'], rest: '' });
  assert.deepEqual(splitKeys('\x1b[5~'), { keys: ['\x1b[5~'], rest: '' });
});

test('splitKeys normalises application-cursor (SS3) arrows to their CSI form', () => {
  assert.deepEqual(splitKeys('\x1bOA'), { keys: ['\x1b[A'], rest: '' });
  assert.deepEqual(splitKeys('\x1bOB\x1bOA'), { keys: ['\x1b[B', '\x1b[A'], rest: '' });
});

test('splitKeys holds a sequence cut in half by a chunk boundary', () => {
  const first = splitKeys('x\x1b');
  assert.deepEqual(first, { keys: ['x'], rest: '\x1b' });
  assert.deepEqual(splitKeys(first.rest + '[B'), { keys: ['\x1b[B'], rest: '' });
  assert.deepEqual(splitKeys('\x1b['), { keys: [], rest: '\x1b[' });
  assert.deepEqual(splitKeys('\x1bO'), { keys: [], rest: '\x1bO' });
});

test('SS3 arrows drive the selection', () => {
  const s = stateWith(5);
  handleKey(s, splitKeys('\x1bOA').keys[0], VIEW);
  assert.equal(s.follow, false);
  assert.equal(s.selected, 3);
});

test('uppercase F and Q are bound like their lowercase keys', () => {
  const s = stateWith(3);
  handleKey(s, 'F', VIEW);
  assert.equal(s.follow, false);
  assert.equal(handleKey(stateWith(1), 'Q', VIEW), 'quit');
});

test('the viewport holds still while entries are evicted from the buffer', () => {
  const s = createState({});
  appendEntries(s, Array.from({ length: MAX_ENTRIES }, (_, i) => entry(i + 1)));
  handleKey(s, 'f', VIEW);
  const frozen = renderScreen(s, 80, 12).slice(1, -1);

  for (let i = 0; i < 50; i++) appendEntries(s, [entry(MAX_ENTRIES + 1 + i)]);
  assert.equal(s.dropped, 50);
  assert.deepEqual(renderScreen(s, 80, 12).slice(1, -1), frozen);
});
