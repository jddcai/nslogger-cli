import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, makeStore, seed } from './helpers.mjs';

const cmds = await import(join(ROOT, 'dist', 'commands', 'query.js'));

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cmd-'));
  const db = join(dir, 'logs.db');
  return Promise.resolve(fn(db)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('cmdSessions returns seeded session', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdSessions(store);
  assert.equal(r.total, 1);
  assert.equal(r.data[0].session_id, 'sess1');
}));

test('cmdQuery --keyword filters', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdQuery(store, { command: 'query', positionals: [], flags: { keyword: 'hello' } });
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].message, 'hello world');
}));

test('cmdErrors defaults to level >= 3', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdErrors(store, { command: 'errors', positionals: [], flags: {} });
  assert.equal(r.total, 1);
  assert.equal(r.data[0].level, 4);
}));

test('cmdContext requires a positive integer', () => withDb(async (db) => {
  const store = await makeStore(db);
  assert.throws(() => cmds.cmdContext(store, { command: 'context', positionals: [], flags: {} }), /positive integer/);
}));

test('cmdClear validates session id', () => withDb(async (db) => {
  const store = await makeStore(db);
  assert.throws(() => cmds.cmdClear(store, { command: 'clear', positionals: [], flags: {} }), /requires a <session_id>/);
}));

test('cmdTraceThread returns thread entries', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdTraceThread(store, { command: 'trace-thread', positionals: ['sess1', 't1'], flags: {} });
  assert.equal(r.total, 2);
}));

test('cmdContext returns surrounding entries', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdContext(store, { command: 'context', positionals: ['1'], flags: {} });
  assert.ok(r.data.length >= 1);
  assert.equal(r.data[0].session_id, 'sess1');
}));
