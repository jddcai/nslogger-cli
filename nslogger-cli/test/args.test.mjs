import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { parseArgs, flagStr, flagNum, flagBool } = await import(join(ROOT, 'dist', 'cli', 'args.js'));

test('first non-flag token is the command, rest are positionals', () => {
  const r = parseArgs(['query', 'pos1', 'pos2']);
  assert.equal(r.command, 'query');
  assert.deepEqual(r.positionals, ['pos1', 'pos2']);
});

test('--key value and --key=value both parse', () => {
  const r = parseArgs(['query', '--tag', 'net', '--limit=50']);
  assert.equal(r.flags.tag, 'net');
  assert.equal(r.flags.limit, '50');
});

test('--flag with no value (followed by flag or end) is boolean true', () => {
  const r = parseArgs(['sessions', '--pretty']);
  assert.equal(r.flags.pretty, true);
});

test('--flag immediately followed by another flag → both true', () => {
  const r = parseArgs(['sessions', '--pretty', '--json']);
  assert.equal(r.flags.pretty, true);
  assert.equal(r.flags.json, true);
});

test('typed accessors', () => {
  const r = parseArgs(['query', '--level', '3', '--pretty']);
  assert.equal(flagStr(r.flags, 'missing'), undefined);
  assert.equal(flagNum(r.flags, 'level'), 3);
  assert.equal(flagNum(r.flags, 'missing'), undefined);
  assert.equal(flagBool(r.flags, 'pretty'), true);
  assert.equal(flagBool(r.flags, 'missing'), false);
});
