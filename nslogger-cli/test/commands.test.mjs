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

test('cmdClear --all wipes every session and log', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdClear(store, { command: 'clear', positionals: [], flags: { all: true } });
  assert.deepEqual(r.data, { cleared_sessions: 1, cleared_logs: 2 });
  assert.equal(cmds.cmdSessions(store).total, 0);
  assert.equal(cmds.cmdQuery(store, { command: 'query', positionals: [], flags: {} }).total, 0);
}));

test('cmdClear rejects --all together with a session id', () => withDb(async (db) => {
  const store = await seed(db);
  assert.throws(
    () => cmds.cmdClear(store, { command: 'clear', positionals: ['sess1'], flags: { all: true } }),
    /not both/,
  );
}));

test('maxLogId reports the newest id, 0 when empty', () => withDb(async (db) => {
  const empty = await makeStore(db);
  assert.equal(empty.maxLogId(), 0);
  const store = await seed(db);
  assert.equal(store.maxLogId(), store.queryLogsAfter(0).pop().id);
}));

test('queryLatestLogs returns the newest matches, oldest-first', () => withDb(async (db) => {
  const store = await seed(db);
  const latest = store.queryLatestLogs({ limit: 1 });
  assert.equal(latest.length, 1);
  assert.equal(latest[0].message, 'boom error');          // the newest of the two seeded rows

  const both = store.queryLatestLogs({});
  assert.deepEqual(both.map((r) => r.message), ['hello world', 'boom error']);
  assert.deepEqual(store.queryLatestLogs({ keyword: 'hello' }).map((r) => r.message), ['hello world']);
}));

test('max_id bounds both the fetch and the count', () => withDb(async (db) => {
  const store = await seed(db);
  const [first, second] = store.queryLogsAfter(0);

  assert.equal(store.queryLogsAfter(0, { max_id: first.id }).length, 1);
  assert.equal(store.countLogsAfter(0, { max_id: first.id }), 1);
  assert.equal(store.countLogsAfter(first.id, { max_id: second.id }), 1);
  // counting the same window twice must not double-count when the cursor advances
  assert.equal(store.countLogsAfter(second.id, { max_id: second.id }), 0);
}));

test('countLogsAfter counts without consuming, honouring filters', () => withDb(async (db) => {
  const store = await seed(db);
  assert.equal(store.countLogsAfter(0), 2);
  assert.equal(store.countLogsAfter(0, { level_min: 4 }), 1);
  assert.equal(store.countLogsAfter(0, { keyword: 'hello' }), 1);

  const all = store.queryLogsAfter(0);
  assert.equal(store.countLogsAfter(all[1].id), 0);
  // counting must not move anything: the same rows are still fetchable
  assert.equal(store.queryLogsAfter(0).length, 2);
}));

test('cmdQuery treats a bare word as --keyword', () => withDb(async (db) => {
  const store = await seed(db);
  const r = cmds.cmdQuery(store, { command: 'query', positionals: ['hello'], flags: {} });
  assert.equal(r.total, 1);
  assert.equal(r.data[0].message, 'hello world');
}));

test('queryLogsAfter advances by cursor and honours filters', () => withDb(async (db) => {
  const store = await seed(db);
  const all = store.queryLogsAfter(0);
  assert.equal(all.length, 2);

  const after = store.queryLogsAfter(all[0].id);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, all[1].id);

  assert.equal(store.queryLogsAfter(0, { level_min: 4 }).length, 1);
  assert.equal(store.queryLogsAfter(0, { keyword: 'hello' })[0].message, 'hello world');
  assert.equal(store.queryLogsAfter(0, { limit: 1 }).length, 1);
  assert.equal(store.queryLogsAfter(all[1].id).length, 0);
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
