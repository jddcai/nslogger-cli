/**
 * NSLoggerTCPSource — real-time log reception (Phase 2).
 *
 * Runs a plain TCP server that speaks NSLogger's binary network protocol
 * (decoded by nslogger-protocol.ts) and streams parsed entries into the sink.
 * Optionally advertises itself over Bonjour (`_nslogger._tcp`) so NSLogger
 * clients on the same LAN auto-discover it.
 *
 * Transport: plain TCP or TLS (default TLS, matching NSLogger's default
 * kLoggerOption_UseSSL). In TLS mode a throwaway self-signed certificate is
 * generated at startup; NSLogger clients do not validate it.
 *
 * Each TCP connection = one session (matches NSLogger Viewer behaviour;
 * a reconnect produces a new session).
 */

import net from 'node:net';
import tls from 'node:tls';
import { spawn, type ChildProcess } from 'node:child_process';
import selfsigned from 'selfsigned';
import { createHash } from 'node:crypto';
import Bonjour from 'bonjour-service';
import type { LogEntry, LogSinkFn, LogSource, SessionInfo } from './types.js';
import {
  extractMessages,
  ProtocolError,
  LOGMSG_TYPE,
  MAX_MESSAGE_BYTES,
  type NSLoggerMessage,
} from './nslogger-protocol.js';

export interface NSLoggerTCPOptions {
  port: number;
  bonjour?: boolean;       // advertise via Bonjour (default true)
  serviceName?: string;    // Bonjour instance name (default 'nslogger-cli')
  ssl?: boolean;           // accept TLS connections (default true; NSLogger default)
  flushIntervalMs?: number; // debounce before flushing a partial batch (default 200)
  flushBatchSize?: number;  // flush immediately when pending reaches this (default 200)
}

interface Conn {
  sessionId: string;
  socket: net.Socket;
  buffer: Buffer;
  pending: LogEntry[];
  session: SessionInfo;
  seqFallback: number;
  flushTimer?: NodeJS.Timeout;
  closed: boolean;
}

export class NSLoggerTCPSource implements LogSource {
  readonly name = 'nslogger-tcp';

  private opts: Required<NSLoggerTCPOptions> & { serviceName: string };
  private sink?: LogSinkFn;
  private server?: net.Server;
  private bonjour?: Bonjour;
  private dnssd?: ChildProcess;
  private stopped = false;
  private conns = new Set<Conn>();

  constructor(opts: NSLoggerTCPOptions | number) {
    const o = typeof opts === 'number' ? { port: opts } : opts;
    this.opts = {
      port:            o.port,
      bonjour:         o.bonjour ?? true,
      serviceName:     o.serviceName ?? 'nslogger-cli',
      ssl:             o.ssl ?? true,
      flushIntervalMs: o.flushIntervalMs ?? 200,
      flushBatchSize:  o.flushBatchSize ?? 200,
    };
  }

  async start(sink: LogSinkFn): Promise<void> {
    this.stopped = false;
    this.sink = sink;

    if (this.opts.ssl) {
      const pems = selfsigned.generate(undefined, { days: 3650, keySize: 2048 });
      this.server = tls.createServer(
        { key: pems.private, cert: pems.cert },
        socket => this.handleConnection(socket),
      );
    } else {
      this.server = net.createServer(socket => this.handleConnection(socket));
    }
    this.server.on('error', err => console.error('[nslogger-tcp] server error:', err));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server!.once('error', onError);
      this.server!.listen(this.opts.port, () => {
        this.server!.off('error', onError);
        resolve();
      });
    });

    if (this.opts.bonjour) this.advertise();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Stop advertising first so no new clients discover a dying server.
    if (this.dnssd) {
      this.dnssd.kill('SIGTERM');
      this.dnssd = undefined;
    }
    await new Promise<void>(resolve => {
      if (!this.bonjour) return resolve();
      this.bonjour.destroy(() => resolve());
    });
    this.bonjour = undefined;

    // Flush + close all live connections.
    for (const conn of this.conns) {
      this.finalize(conn);
      conn.socket.destroy();
    }
    this.conns.clear();

    await new Promise<void>(resolve => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = undefined;
  }

  private advertise(): void {
    const typeBase = this.opts.ssl ? 'nslogger-ssl' : 'nslogger';

    // Prefer the OS-native responder on macOS. The pure-JS responder in
    // bonjour-service answers hostname queries with every interface address
    // (IPv6 link-local, 0.0.0.0, 169.254), which breaks NSLogger client
    // resolution. macOS mDNSResponder (via dns-sd -R, same as NSLogger.app)
    // answers per-interface with reachable addresses.
    if (process.platform === 'darwin') {
      try {
        this.dnssd = spawn(
          'dns-sd',
          ['-R', this.opts.serviceName, `_${typeBase}._tcp`, 'local', String(this.opts.port)],
          { stdio: 'ignore' },
        );
        this.dnssd.on('error', err => {
          this.dnssd = undefined;
          if (this.stopped) return; // shutting down; don't re-advertise
          console.error(`[nslogger-tcp] dns-sd registration failed (${err.message}); falling back to bonjour-service`);
          this.advertiseViaBonjourService(typeBase);
        });
        this.dnssd.on('exit', (code, signal) => {
          if (this.stopped) return;
          console.error(`[nslogger-tcp] dns-sd exited unexpectedly (code=${code} signal=${signal}); Bonjour advertising stopped`);
        });
        console.error(`[nslogger-tcp] advertising via dns-sd: ${this.opts.serviceName} _${typeBase}._tcp :${this.opts.port}`);
        return;
      } catch (err) {
        // Note: a missing dns-sd binary surfaces via the async 'error' event above,
        // not here; this catch only handles a synchronous spawn failure (bad args, etc.).
        console.error('[nslogger-tcp] dns-sd spawn failed synchronously; falling back to bonjour-service:', err);
      }
    }

    this.advertiseViaBonjourService(typeBase);
  }

  private advertiseViaBonjourService(typeBase: string): void {
    try {
      this.bonjour = new Bonjour();
      // bonjour-service prepends '_' and appends '._tcp' → '_<typeBase>._tcp'
      this.bonjour.publish({
        name: this.opts.serviceName,
        type: typeBase,
        protocol: 'tcp',
        port: this.opts.port,
      });
    } catch (err) {
      console.error('[nslogger-tcp] Bonjour advertisement failed (continuing without it):', err);
      this.bonjour = undefined;
    }
  }

  private handleConnection(socket: net.Socket): void {
    const connectMs = Date.now();
    const sessionId = createHash('sha1')
      .update(`${socket.remoteAddress}:${socket.remotePort}:${connectMs}`)
      .digest('hex')
      .slice(0, 16);

    const conn: Conn = {
      sessionId,
      socket,
      buffer: Buffer.alloc(0),
      pending: [],
      seqFallback: 0,
      closed: false,
      session: {
        session_id:     sessionId,
        source:         'nslogger',
        client_name:    null,
        client_version: null,
        os_name:        null,
        os_version:     null,
        device_model:   null,
        started_at:     connectMs,
        ended_at:       null,
        parse_error:    null,
      },
    };
    this.conns.add(conn);
    console.error(`[nslogger-tcp] client connected: ${socket.remoteAddress} (session ${sessionId})`);

    socket.on('data', chunk => this.onData(conn, chunk));
    socket.on('error', () => this.onClose(conn));
    socket.on('close', () => this.onClose(conn));
  }

  private onData(conn: Conn, chunk: Buffer): void {
    conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk;

    let messages: NSLoggerMessage[];
    try {
      const out = extractMessages(conn.buffer);
      messages = out.messages;
      conn.buffer = out.rest;
    } catch (err) {
      if (err instanceof ProtocolError) {
        console.error(`[nslogger-tcp] protocol error (session ${conn.sessionId}): ${err.message}`);
        conn.socket.destroy();
        return;
      }
      throw err;
    }

    // Guard against a never-completing oversized frame.
    if (conn.buffer.length > MAX_MESSAGE_BYTES) {
      console.error(`[nslogger-tcp] oversized partial frame (session ${conn.sessionId}); dropping connection`);
      conn.socket.destroy();
      return;
    }

    for (const msg of messages) this.dispatch(conn, msg);
  }

  private dispatch(conn: Conn, msg: NSLoggerMessage): void {
    switch (msg.type) {
      case LOGMSG_TYPE.CLIENTINFO:
        this.applyClientInfo(conn, msg);
        return;
      case LOGMSG_TYPE.BLOCKSTART:
      case LOGMSG_TYPE.BLOCKEND:
        return; // structural, no entry
      case LOGMSG_TYPE.DISCONNECT:
        conn.socket.destroy();
        return;
      case LOGMSG_TYPE.LOG:
      case LOGMSG_TYPE.MARK:
      default:
        conn.pending.push(this.toEntry(conn, msg));
        this.scheduleFlush(conn);
        return;
    }
  }

  private applyClientInfo(conn: Conn, msg: NSLoggerMessage): void {
    const s = conn.session;
    s.client_name    = msg.clientName    ?? s.client_name;
    s.client_version = msg.clientVersion ?? s.client_version;
    s.os_name        = msg.osName        ?? s.os_name;
    s.os_version     = msg.osVersion     ?? s.os_version;
    s.device_model   = msg.model         ?? s.device_model;
    // Persist metadata promptly even if no logs have arrived yet.
    this.flush(conn);
  }

  /** Map a LOG/MARK wire message to a LogEntry (mirrors nslogger-file.ts). */
  private toEntry(conn: Conn, msg: NSLoggerMessage): LogEntry {
    const tsS  = msg.timestampS ?? 0;
    const subMs = msg.timestampMs ?? (msg.timestampUs != null ? Math.floor(msg.timestampUs / 1000) : 0);
    const timestamp = tsS ? tsS * 1000 + subMs : Date.now();

    let message = msg.message ?? '';
    if (msg.isImage) message = '[image]';
    else if (msg.isBinary) message = '[binary]';
    if (msg.type === LOGMSG_TYPE.MARK) message = message || '[mark]';

    return {
      source:        'nslogger',
      session_id:    conn.sessionId,
      seq:           msg.seq ?? conn.seqFallback++,
      timestamp,
      level:         msg.level ?? 0,
      tag:           msg.tag ?? null,
      thread_id:     msg.threadId ?? 'unknown',
      message,
      filename:      msg.filename || null,
      line_number:   msg.lineNumber ?? null,
      function_name: msg.functionName || null,
      raw:           null,
    };
  }

  private scheduleFlush(conn: Conn): void {
    if (conn.pending.length >= this.opts.flushBatchSize) {
      this.flush(conn);
      return;
    }
    if (!conn.flushTimer) {
      conn.flushTimer = setTimeout(() => this.flush(conn), this.opts.flushIntervalMs);
    }
  }

  private flush(conn: Conn): void {
    if (conn.flushTimer) {
      clearTimeout(conn.flushTimer);
      conn.flushTimer = undefined;
    }
    if (conn.closed) return;

    const batch = conn.pending;
    conn.pending = [];
    // Bump ended_at so an active session shows recent activity (live "last seen").
    conn.session.ended_at = Date.now();
    this.sink?.(conn.session, batch);
  }

  private onClose(conn: Conn): void {
    if (conn.closed) return;
    this.finalize(conn);
    this.conns.delete(conn);
    console.error(`[nslogger-tcp] client disconnected (session ${conn.sessionId})`);
  }

  /** Final flush + mark session ended. Safe to call once per connection. */
  private finalize(conn: Conn): void {
    if (conn.closed) return;
    if (conn.flushTimer) {
      clearTimeout(conn.flushTimer);
      conn.flushTimer = undefined;
    }
    const batch = conn.pending;
    conn.pending = [];
    conn.session.ended_at = Date.now();
    this.sink?.(conn.session, batch);
    conn.closed = true;
  }
}
