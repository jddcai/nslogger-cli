/**
 * NSLoggerTCPSource end-to-end test (no test framework, mirrors test-parse.ts style).
 *
 * Acts as a fake NSLogger client: encodes the binary wire protocol and exercises
 *   1. the pure decoder (whole buffer + split-at-arbitrary-boundary),
 *   2. the live TCP source with an in-memory sink,
 *   3. the full path through SQLite (temp db).
 *
 * Run after `npm run build`:  node test-tcp.mjs
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';

import {
  extractMessages,
  PART_TYPE,
  PART_KEY,
  LOGMSG_TYPE,
} from './dist/sources/nslogger-protocol.js';
import { NSLoggerTCPSource } from './dist/sources/nslogger-tcp.js';
import { LogStore } from './dist/store/sqlite.js';

// ---------- tiny assert harness ----------
let failures = 0;
function check(cond, label) {
  if (cond) {
    console.error(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}
function eq(actual, expected, label) {
  check(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---------- wire encoder (inverse of the decoder) ----------
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n >>> 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

function partString(key, s) {
  const data = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([key, PART_TYPE.STRING]), u32(data.length), data]);
}
function partInt16(key, n) {
  return Buffer.concat([Buffer.from([key, PART_TYPE.INT16]), u16(n)]);
}
function partInt32(key, n) {
  return Buffer.concat([Buffer.from([key, PART_TYPE.INT32]), u32(n)]);
}
function encodeMessage(parts) {
  const body = Buffer.concat([u16(parts.length), ...parts]);
  return Buffer.concat([u32(body.length), body]); // [uint32 len][uint16 partCount][parts]
}

// ---------- build a fixture stream: 1 CLIENTINFO + 3 LOG ----------
const clientInfo = encodeMessage([
  partInt32(PART_KEY.MESSAGE_TYPE, LOGMSG_TYPE.CLIENTINFO),
  partString(PART_KEY.CLIENT_NAME, 'DemoApp'),
  partString(PART_KEY.CLIENT_VERSION, '1.2.3'),
  partString(PART_KEY.OS_NAME, 'iOS'),
  partString(PART_KEY.OS_VERSION, '17.4'),
  partString(PART_KEY.CLIENT_MODEL, 'iPhone'),
  partString(PART_KEY.UNIQUEID, 'uid-abc'),
]);

// thread id as STRING, timestamp via MS
const log1 = encodeMessage([
  partInt32(PART_KEY.MESSAGE_TYPE, LOGMSG_TYPE.LOG),
  partInt32(PART_KEY.MESSAGE_SEQ, 1),
  partInt32(PART_KEY.TIMESTAMP_S, 1700000000),
  partInt16(PART_KEY.TIMESTAMP_MS, 250),
  partString(PART_KEY.THREAD_ID, 'main'),
  partInt16(PART_KEY.LEVEL, 2),
  partString(PART_KEY.TAG, 'network'),
  partString(PART_KEY.MESSAGE, 'hello world'),
  partString(PART_KEY.FILENAME, 'Foo.swift'),
  partInt32(PART_KEY.LINENUMBER, 42),
  partString(PART_KEY.FUNCTIONNAME, 'doThing()'),
]);

// thread id as INT (coercion path), timestamp via US
const log2 = encodeMessage([
  partInt32(PART_KEY.MESSAGE_TYPE, LOGMSG_TYPE.LOG),
  partInt32(PART_KEY.MESSAGE_SEQ, 2),
  partInt32(PART_KEY.TIMESTAMP_S, 1700000001),
  partInt32(PART_KEY.TIMESTAMP_US, 500000),
  partInt32(PART_KEY.THREAD_ID, 7),
  partInt16(PART_KEY.LEVEL, 4),
  partString(PART_KEY.MESSAGE, 'error happened'),
]);

// a MARK message
const log3 = encodeMessage([
  partInt32(PART_KEY.MESSAGE_TYPE, LOGMSG_TYPE.MARK),
  partInt32(PART_KEY.MESSAGE_SEQ, 3),
  partInt32(PART_KEY.TIMESTAMP_S, 1700000002),
  partString(PART_KEY.MESSAGE, 'checkpoint'),
]);

const stream = Buffer.concat([clientInfo, log1, log2, log3]);

// ---------- 1. pure decoder: whole buffer ----------
console.error('\n[1] pure decoder — whole buffer');
{
  const { messages, rest } = extractMessages(stream);
  eq(messages.length, 4, 'decoded 4 messages');
  eq(rest.length, 0, 'no leftover bytes');
  eq(messages[0].type, LOGMSG_TYPE.CLIENTINFO, 'msg0 is CLIENTINFO');
  eq(messages[0].clientName, 'DemoApp', 'clientName');
  eq(messages[0].osVersion, '17.4', 'osVersion');
  eq(messages[1].message, 'hello world', 'log1 message');
  eq(messages[1].threadId, 'main', 'log1 threadId string');
  eq(messages[1].timestampMs, 250, 'log1 ms');
  eq(messages[1].lineNumber, 42, 'log1 line number');
  eq(messages[2].threadId, '7', 'log2 threadId coerced to string');
  eq(messages[2].timestampUs, 500000, 'log2 us');
  eq(messages[3].type, LOGMSG_TYPE.MARK, 'msg3 is MARK');
}

// ---------- 2. pure decoder: split at every boundary (partial reads) ----------
console.error('\n[2] pure decoder — split/partial reassembly');
{
  let allOk = true;
  for (let cut = 1; cut < stream.length; cut++) {
    const a = stream.subarray(0, cut);
    const b = stream.subarray(cut);
    const r1 = extractMessages(a);
    const r2 = extractMessages(Buffer.concat([r1.rest, b]));
    const total = r1.messages.length + r2.messages.length;
    if (total !== 4 || r2.rest.length !== 0) { allOk = false; break; }
  }
  check(allOk, 'every split boundary reassembles to 4 messages with no leftover');
}

// ---------- helpers for live tests ----------
function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
async function sendStream(port, buf) {
  await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(buf, () => sock.end());
    });
    sock.on('error', reject);
    sock.on('close', resolve);
  });
}

// ---------- 3. live TCP source with in-memory sink ----------
console.error('\n[3] live TCP source — in-memory sink');
{
  const captured = [];
  let lastSession = null;
  const sink = (session, entries) => {
    lastSession = session;
    for (const e of entries) captured.push(e);
  };

  const port = await getFreePort();
  const source = new NSLoggerTCPSource({ port, bonjour: false, flushIntervalMs: 50 });
  await source.start(sink);

  await sendStream(port, stream);
  await waitMs(150); // let flush + close settle

  eq(captured.length, 3, 'captured 3 log entries (LOG+LOG+MARK)');
  eq(captured[0].message, 'hello world', 'entry0 message');
  eq(captured[0].level, 2, 'entry0 level');
  eq(captured[0].tag, 'network', 'entry0 tag');
  eq(captured[0].timestamp, 1700000000 * 1000 + 250, 'entry0 timestamp (ms path)');
  eq(captured[1].timestamp, 1700000001 * 1000 + 500, 'entry1 timestamp (us path)');
  eq(captured[1].thread_id, '7', 'entry1 thread coerced');
  eq(captured[2].message, 'checkpoint', 'mark message preserved');
  check(lastSession && lastSession.client_name === 'DemoApp', 'session got CLIENTINFO metadata');
  check(lastSession && lastSession.os_version === '17.4', 'session os_version');
  check(lastSession && lastSession.ended_at !== null, 'session ended_at set after close');

  await source.stop();
}

// ---------- 4. full path through SQLite (temp db) ----------
console.error('\n[4] end-to-end through SQLite');
{
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'nslogger-cli-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const store = new LogStore(dbPath);
  const sink = (session, entries) => {
    store.upsertSession(session);
    if (entries.length) store.insertLogs(entries);
  };

  const port = await getFreePort();
  const source = new NSLoggerTCPSource({ port, bonjour: false, flushIntervalMs: 50 });
  await source.start(sink);

  await sendStream(port, stream);
  await waitMs(150);
  await source.stop();

  const sessions = store.listSessions();
  eq(sessions.length, 1, 'one session persisted');
  eq(sessions[0].client_name, 'DemoApp', 'persisted client_name (COALESCE upsert)');
  eq(sessions[0].device_model, 'iPhone', 'persisted device_model');

  const { rows, total } = store.queryLogs({ session_id: sessions[0].session_id });
  eq(total, 3, '3 rows in db');
  const err = store.getErrors(sessions[0].session_id);
  eq(err.length, 1, 'getErrors returns the level-4 entry');
  eq(err[0].message, 'error happened', 'error entry message');

  rmSync(tmpDir, { recursive: true, force: true });
}

// ---------- summary ----------
console.error(`\n${failures === 0 ? 'ALL PASSED ✅' : `${failures} CHECK(S) FAILED ❌`}`);
process.exit(failures === 0 ? 0 : 1);
