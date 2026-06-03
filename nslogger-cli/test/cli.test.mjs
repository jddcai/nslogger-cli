import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI, seed, makeStore } from './helpers.mjs';

function run(db, ...cmd) {
  return execFileSync('node', [CLI, ...cmd, '--db', db], { encoding: 'utf-8' });
}

test('sessions prints success JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const db = join(dir, 'logs.db');
  try {
    await seed(db);
    const p = JSON.parse(run(db, 'sessions'));
    assert.equal(p.success, true);
    assert.equal(p.data[0].session_id, 'sess1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('query --keyword filters', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const db = join(dir, 'logs.db');
  try {
    await seed(db);
    const p = JSON.parse(run(db, 'query', '--keyword', 'hello'));
    assert.equal(p.data.length, 1);
    assert.equal(p.data[0].message, 'hello world');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('query on empty db returns empty array, exit 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const db = join(dir, 'logs.db');
  try {
    await makeStore(db); // creates empty schema
    const p = JSON.parse(run(db, 'query'));
    assert.equal(p.success, true);
    assert.deepEqual(p.data, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown command exits non-zero with error JSON on stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const db = join(dir, 'logs.db');
  try {
    await makeStore(db);
    let threw = false;
    try { run(db, 'bogus'); }
    catch (e) {
      threw = true;
      assert.notEqual(e.status, 0);
      const p = JSON.parse(String(e.stderr));
      assert.equal(p.success, false);
      assert.match(p.message, /Unknown command/);
    }
    assert.equal(threw, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('help (no command) prints usage to stdout, exit 0', () => {
  const out = execFileSync('node', [CLI, 'help'], { encoding: 'utf-8' });
  assert.match(out, /nslogger-cli <command>/);
});

test('help --json prints machine-readable command list, exit 0', () => {
  const out = execFileSync('node', [CLI, 'help', '--json'], { encoding: 'utf-8' });
  const p = JSON.parse(out);
  assert.equal(p.success, true);
  assert.ok(Array.isArray(p.data));
  assert.ok(p.data.some((c) => c.name === 'query'));
});

test('serve with no enabled sources exits non-zero with a clear message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const cfg = join(dir, 'config.json');
  const db = join(dir, 'logs.db');
  writeFileSync(cfg, JSON.stringify({ db_path: db, watch_dirs: [], sources: { nslogger_file: { enabled: true }, nslogger_tcp: { enabled: false, port: 50000 } } }));
  try {
    let threw = false;
    try { execFileSync('node', [CLI, 'serve', '--config', cfg], { encoding: 'utf-8' }); }
    catch (e) {
      threw = true;
      assert.notEqual(e.status, 0);
      const p = JSON.parse(String(e.stderr));
      assert.equal(p.success, false);
      assert.match(p.message, /nothing to do/);
    }
    assert.equal(threw, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load of a nonexistent file exits non-zero (failure is detectable)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const db = join(dir, 'logs.db');
  try {
    await makeStore(db);
    let threw = false;
    try { run(db, 'load', '/no/such/file.nslogger'); }
    catch (e) {
      threw = true;
      assert.notEqual(e.status, 0);
      const lines = String(e.stderr).trim().split('\n');
      const p = JSON.parse(lines[lines.length - 1]);
      assert.equal(p.success, false);
      assert.match(p.message, /load failed/);
    }
    assert.equal(threw, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('query on a nonexistent db path errors instead of silently creating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const db = join(dir, 'missing.db');
  try {
    let threw = false;
    try { execFileSync('node', [CLI, 'query', '--db', db], { encoding: 'utf-8' }); }
    catch (e) {
      threw = true;
      assert.notEqual(e.status, 0);
      const p = JSON.parse(String(e.stderr));
      assert.match(p.message, /database not found/);
    }
    assert.equal(threw, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
