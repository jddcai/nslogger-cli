import type { LogStore } from '../store/sqlite.js';
import { NSLoggerFileSource } from '../sources/nslogger-file.js';
import { NSLoggerTCPSource } from '../sources/nslogger-tcp.js';
import type { LogEntry, SessionInfo } from '../sources/types.js';
import type { Config } from '../config.js';

/** Start the receiver(s) and block until SIGINT/SIGTERM. */
export async function runServe(cfg: Config, store: LogStore): Promise<void> {
  const fileWatching = cfg.sources.nslogger_file.enabled && cfg.watch_dirs.length > 0;
  const tcpEnabled = cfg.sources.nslogger_tcp.enabled;
  if (!fileWatching && !tcpEnabled) {
    throw new Error(
      'serve has nothing to do: enable nslogger_tcp, or enable nslogger_file with at least one entry in watch_dirs (otherwise nothing keeps the receiver alive).'
    );
  }

  const sink = (session: SessionInfo, entries: LogEntry[]) => {
    store.upsertSession(session);
    if (entries.length > 0) store.insertLogs(entries);
  };

  const fileSource = new NSLoggerFileSource(
    cfg.sources.nslogger_file.enabled ? cfg.watch_dirs : []
  );
  await fileSource.start(sink);

  let tcpSource: NSLoggerTCPSource | undefined;
  if (cfg.sources.nslogger_tcp.enabled) {
    const t = cfg.sources.nslogger_tcp;
    tcpSource = new NSLoggerTCPSource({
      port: t.port,
      bonjour: t.bonjour ?? true,
      serviceName: t.service_name,
      ssl: t.ssl,
    });
    await tcpSource.start(sink);
    console.error(`[nslogger-tcp] Listening on port ${t.port} (ssl=${t.ssl ?? true}, bonjour=${t.bonjour ?? true})`);
  }

  console.error('[nslogger-cli] serve started. Watching:', cfg.watch_dirs);

  await new Promise<void>((done) => {
    const shutdown = async () => {
      await fileSource.stop();
      await tcpSource?.stop();
      done();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
