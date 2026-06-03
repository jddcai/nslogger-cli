import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { resolveConfigPath, resolveDbPath, loadConfig } = await import(join(ROOT, 'dist', 'config.js'));

test('resolveConfigPath honors explicit path first', () => {
  assert.equal(resolveConfigPath('/tmp/foo.json'), resolve('/tmp/foo.json'));
});

test('resolveConfigPath falls back to $NSLOGGER_CLI_CONFIG', () => {
  const prev = process.env.NSLOGGER_CLI_CONFIG;
  process.env.NSLOGGER_CLI_CONFIG = '/tmp/env-config.json';
  try {
    assert.equal(resolveConfigPath(), resolve('/tmp/env-config.json'));
  } finally {
    if (prev === undefined) delete process.env.NSLOGGER_CLI_CONFIG;
    else process.env.NSLOGGER_CLI_CONFIG = prev;
  }
});

test('resolveDbPath uses --db flag and expands ~', () => {
  assert.equal(resolveDbPath('~/x.db'), join(homedir(), 'x.db'));
});

test('resolveDbPath reads db_path from a config file when no flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const cfgPath = join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({
    db_path: '~/.nslogger-cli/logs.db', watch_dirs: [],
    sources: { nslogger_file: { enabled: true }, nslogger_tcp: { enabled: false, port: 50000 } },
  }));
  try {
    assert.equal(resolveDbPath(undefined, cfgPath), join(homedir(), '.nslogger-cli', 'logs.db'));
    const cfg = loadConfig(cfgPath);
    assert.equal(cfg.sources.nslogger_tcp.bonjour, true); // defaulted
    assert.equal(cfg.sources.nslogger_tcp.ssl, true); // ssl defaults to true
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
