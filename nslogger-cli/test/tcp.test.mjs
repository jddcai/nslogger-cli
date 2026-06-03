import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import process from 'node:process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const { NSLoggerTCPSource } = await import(join(ROOT, 'dist', 'sources', 'nslogger-tcp.js'));
const { PART_KEY, PART_TYPE } = await import(join(ROOT, 'dist', 'sources', 'nslogger-protocol.js'));

// Build one NSLogger wire frame: [uint32 BE len][uint16 BE partCount][parts...]
function strPart(key, s) {
  const data = Buffer.from(s, 'utf8');
  const b = Buffer.alloc(2 + 4 + data.length);
  b[0] = key; b[1] = PART_TYPE.STRING; b.writeUInt32BE(data.length, 2); data.copy(b, 6);
  return b;
}
function frame(parts) {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(parts.length, 0);
  const body = Buffer.concat([head, ...parts]);
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}
const logFrame = frame([strPart(PART_KEY.MESSAGE, 'hello over wire')]);

function collectSink() {
  const entries = [];
  const sessions = [];
  return { sink: (session, batch) => { sessions.push(session); entries.push(...batch); }, entries, sessions };
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((res, rej) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return res();
      if (Date.now() - started > timeoutMs) return rej(new Error('timeout waiting for entries'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('receives a log frame over TLS (ssl:true)', async () => {
  const port = 50071;
  const { sink, entries } = collectSink();
  const src = new NSLoggerTCPSource({ port, bonjour: false, ssl: true, flushIntervalMs: 30 });
  await src.start(sink);
  try {
    const sock = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false });
    await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    sock.write(logFrame);
    await waitFor(() => entries.length >= 1);
    assert.equal(entries[0].message, 'hello over wire');
    sock.destroy();
  } finally { await src.stop(); }
});

test('receives a log frame over plain TCP (ssl:false)', async () => {
  const port = 50072;
  const { sink, entries } = collectSink();
  const src = new NSLoggerTCPSource({ port, bonjour: false, ssl: false, flushIntervalMs: 30 });
  await src.start(sink);
  try {
    const sock = net.connect({ port, host: '127.0.0.1' });
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    sock.write(logFrame);
    await waitFor(() => entries.length >= 1);
    assert.equal(entries[0].message, 'hello over wire');
    sock.destroy();
  } finally { await src.stop(); }
});

test('advertise spawns dns-sd on macOS and stop cleans it up (both transports)', async () => {
  for (const [i, ssl] of [[0, true], [1, false]]) {
    const src = new NSLoggerTCPSource({ port: 50073 + i, bonjour: true, ssl, flushIntervalMs: 30 });
    await src.start(() => {});
    if (process.platform === 'darwin') {
      assert.ok(src.dnssd, 'expected a dns-sd child process on macOS');
    }
    await src.stop(); // must not hang or throw
    assert.equal(src.dnssd, undefined, 'dns-sd handle cleared after stop');
  }
});
