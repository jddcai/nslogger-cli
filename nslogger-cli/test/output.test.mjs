import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { formatResult, formatError, formatLogLine } = await import(join(ROOT, 'dist', 'cli', 'output.js'));

function logEntry(over = {}) {
  return {
    id: 1042, source: 'nslogger', session_id: 'sess1', seq: 1, timestamp: 0,
    level: 4, tag: 'net', thread_id: 't1', message: 'boom',
    filename: null, line_number: null, function_name: null, raw: null,
    ...over,
  };
}

test('formatResult JSON wraps success + passes total', () => {
  const s = formatResult({ data: [{ a: 1 }], total: 1 }, false);
  const p = JSON.parse(s);
  assert.equal(p.success, true);
  assert.equal(p.total, 1);
  assert.deepEqual(p.data, [{ a: 1 }]);
});

test('formatResult pretty renders one compact line per log plus a summary', () => {
  const s = formatResult({ data: [logEntry()], total: 1 }, true);
  const lines = s.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /#1042/);
  assert.match(lines[0], /E {2}\[net\] {2}boom/);
  assert.equal(lines[1], '1 total');
});

test('pretty summary points at --offset when results are truncated', () => {
  const s = formatResult({ data: [logEntry()], total: 214 }, true);
  assert.match(s.split('\n').pop(), /1 shown, 214 total .*--offset/);
});

test('formatLogLine truncates to the given width', () => {
  const line = formatLogLine(logEntry({ message: 'x'.repeat(500) }), 60);
  assert.equal(line.length, 60);
  assert.ok(line.endsWith('…'));
});

test('formatLogLine marks the hidden lines of a multi-line message', () => {
  assert.match(formatLogLine(logEntry({ message: 'a\nb\nc' }), 120), /a⏎\+2/);
});

test('formatLogLine omits the tag column when there is no tag', () => {
  assert.doesNotMatch(formatLogLine(logEntry({ tag: null }), 120), /\[/);
});

test('pretty output points a human at --tui, but stays quiet when piped', () => {
  const was = process.stdout.isTTY;
  try {
    process.stdout.isTTY = true;
    assert.match(formatResult({ data: [logEntry()], total: 1 }, true), /--tui/);
    process.stdout.isTTY = false;
    assert.doesNotMatch(formatResult({ data: [logEntry()], total: 1 }, true), /--tui/);
  } finally {
    process.stdout.isTTY = was;
  }
});

test('formatResult pretty on empty array', () => {
  assert.equal(formatResult({ data: [], total: 0 }, true), '(empty)');
});

test('formatError is JSON with success false', () => {
  assert.deepEqual(JSON.parse(formatError('nope')), { success: false, message: 'nope' });
});

const { stringWidth, truncateToWidth, padToWidth } = await import(join(ROOT, 'dist', 'cli', 'width.js'));

test('stringWidth counts CJK and emoji as two columns', () => {
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('灵感页'), 6);
  assert.equal(stringWidth('a灵b'), 4);
  assert.equal(stringWidth('🔥'), 2);
});

test('truncateToWidth never exceeds the column budget', () => {
  assert.equal(stringWidth(truncateToWidth('灵感页面加载失败', 9)), 9);
  assert.equal(truncateToWidth('abc', 10), 'abc');
  assert.ok(truncateToWidth('灵感页面加载失败', 9).endsWith('…'));
});

test('padToWidth pads by columns, not characters', () => {
  assert.equal(stringWidth(padToWidth('灵感', 10)), 10);
  assert.equal(padToWidth('abc', 2), 'abc');
});

test('formatLogLine keeps CJK messages within the width', () => {
  const line = formatLogLine(logEntry({ message: '灵感页面加载失败'.repeat(20) }), 60);
  assert.ok(stringWidth(line) <= 60);
});
