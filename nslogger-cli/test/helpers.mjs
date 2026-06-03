import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const CLI = join(ROOT, 'dist', 'index.js');

export async function makeStore(dbPath) {
  const { LogStore } = await import(join(ROOT, 'dist', 'store', 'sqlite.js'));
  return new LogStore(dbPath);
}

export async function seed(dbPath) {
  const store = await makeStore(dbPath);
  store.upsertSession({
    session_id: 'sess1', source: 'nslogger',
    client_name: 'App', client_version: '1.0',
    os_name: 'iOS', os_version: '17', device_model: 'iPhone',
    started_at: 1000, ended_at: 2000, parse_error: null,
  });
  store.insertLogs([
    { source: 'nslogger', session_id: 'sess1', seq: 1, timestamp: 1000, level: 2, tag: 'net', thread_id: 't1', message: 'hello world', filename: null, line_number: null, function_name: null, raw: null },
    { source: 'nslogger', session_id: 'sess1', seq: 2, timestamp: 1500, level: 4, tag: 'net', thread_id: 't1', message: 'boom error', filename: null, line_number: null, function_name: null, raw: null },
  ]);
  return store;
}
