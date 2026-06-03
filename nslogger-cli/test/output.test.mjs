import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { formatResult, formatError } = await import(join(ROOT, 'dist', 'cli', 'output.js'));

test('formatResult JSON wraps success + passes total', () => {
  const s = formatResult({ data: [{ a: 1 }], total: 1 }, false);
  const p = JSON.parse(s);
  assert.equal(p.success, true);
  assert.equal(p.total, 1);
  assert.deepEqual(p.data, [{ a: 1 }]);
});

test('formatResult pretty renders log lines', () => {
  const s = formatResult({ data: [{
    timestamp: 0, level: 4, tag: 'net', message: 'boom',
  }], total: 1 }, true);
  assert.match(s, /ERROR/);
  assert.match(s, /\[net\] boom/);
});

test('formatResult pretty on empty array', () => {
  assert.equal(formatResult({ data: [], total: 0 }, true), '(empty)');
});

test('formatError is JSON with success false', () => {
  assert.deepEqual(JSON.parse(formatError('nope')), { success: false, message: 'nope' });
});
