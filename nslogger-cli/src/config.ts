import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';

/** Default DB location. Deliberately under /tmp so the OS reclaims stale log caches
 *  (macOS purges /private/tmp entries untouched for 3 days, WAL/SHM files included). */
export const DEFAULT_DB_PATH = '/tmp/nslogger-cli/logs.db';

export interface Config {
  db_path: string;
  watch_dirs: string[];
  sources: {
    nslogger_file: { enabled: boolean };
    nslogger_tcp: { enabled: boolean; port: number; bonjour?: boolean; service_name?: string; ssl?: boolean };
  };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

/** Resolve which config.json to read: --config > $NSLOGGER_CLI_CONFIG > ~/.nslogger-cli/config.json > ./config.json */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.NSLOGGER_CLI_CONFIG) return resolve(process.env.NSLOGGER_CLI_CONFIG);
  const home = join(homedir(), '.nslogger-cli', 'config.json');
  if (existsSync(home)) return home;
  return resolve(process.cwd(), 'config.json');
}

export function loadConfig(configPath?: string): Config {
  const path = resolveConfigPath(configPath);
  const raw = readFileSync(path, 'utf-8');
  const cfg = JSON.parse(raw) as Config;
  cfg.db_path = expandHome(cfg.db_path);
  cfg.watch_dirs = (cfg.watch_dirs ?? []).map(expandHome);
  cfg.sources.nslogger_tcp.bonjour = cfg.sources.nslogger_tcp.bonjour ?? true;
  cfg.sources.nslogger_tcp.ssl = cfg.sources.nslogger_tcp.ssl ?? true;
  return cfg;
}

/** Resolve the DB path for query commands without requiring a full/valid config.
 *  Order: --db flag > config file's db_path > DEFAULT_DB_PATH. */
export function resolveDbPath(dbFlag?: string, configPath?: string): string {
  if (dbFlag) return expandHome(dbFlag);
  try {
    return loadConfig(configPath).db_path;
  } catch {
    return DEFAULT_DB_PATH;
  }
}
