# nslogger-cli

A CLI tool that bridges mobile app logs into AI tools. Claude Code, Cursor, and other AI tools can call `nslogger-cli` directly via Bash to query and analyze mobile logs for AI-assisted debugging.

Initial implementation is based on [NSLogger](https://github.com/fpillet/NSLogger); the architecture is designed to support other log sources.

> 中文文档: [README.zh.md](README.zh.md)

## How it works

```
Mobile App (NSLogger)
      │  .nslogger file / TCP live stream
      ▼
┌─────────────────────── nslogger-cli ───────────────────────┐
│  serve (foreground)  Sources ──▶ SQLite ◀── query cmds    │
└───────────────────────────────────────────────────────────┘
      │  stdout: JSON
      ▼
AI tool (via Bash) / human (--pretty)
```

Ingestion and queries share the same SQLite database. `serve` is a foreground process that receives logs and writes them to SQLite; query subcommands open the same database read-only.

## Installation

Requires Node.js >= 18. Run from the repository root:

```bash
bash install.sh
```

The script runs `npm install` → `tsc` build → `npm link` (registers `nslogger-cli` as a global command) and writes default config to `~/.nslogger-cli/config.json`. The script is idempotent and safe to re-run.

> If `nslogger-cli` is not found after install, add the npm global bin directory to your PATH:
> `echo "$(npm prefix -g)/bin"`
>
> If the build fails (e.g. Node < 18, native module `better-sqlite3` compile error), fix the environment first — do not try to bypass it.

## Configuration

Default config at `~/.nslogger-cli/config.json`:

```json
{
  "db_path": "/tmp/nslogger-cli/logs.db",
  "watch_dirs": [],
  "sources": {
    "nslogger_file": { "enabled": true },
    "nslogger_tcp": { "enabled": false, "port": 50000, "bonjour": true, "ssl": true }
  }
}
```

Config lookup order: `--config` > `$NSLOGGER_CLI_CONFIG` > `~/.nslogger-cli/config.json` > `./config.json`.
Query commands also accept `--db <path>` to point directly at a database without a full config file.

| Field | Description |
| --- | --- |
| `db_path` | SQLite database path (auto-created). Defaults under `/tmp` so the OS reclaims stale log caches — logs are a disposable cache, re-import or re-receive to rebuild. Point it elsewhere to keep them |
| `watch_dirs` | Directories `serve` watches; any `.nslogger` file dropped in is auto-imported |
| `nslogger_tcp.enabled` | Enable live TCP ingestion (one connection = one session) |
| `nslogger_tcp.port` | TCP listen port (default 50000) |
| `nslogger_tcp.bonjour` | Advertise via Bonjour for zero-config LAN discovery |
| `nslogger_tcp.ssl` | Enable SSL/TLS (default `true`, matching the NSLogger client default). When `true`, advertises `_nslogger-ssl._tcp` and uses a self-signed cert (client does not verify); `false` uses plain TCP `_nslogger._tcp` |

## Usage

### One-shot file import (recommended)

```bash
nslogger-cli load ~/Downloads/app.nslogger   # import, prints session_id
nslogger-cli query --keyword InspirationFeed --pretty
```

### Reading logs interactively

`query --pretty` prints one compact line per entry (`#id  time  level  [tag]  message`,
truncated to the terminal width, multi-line messages marked `⏎+N`). To browse those results —
move through them and expand any entry — add `--tui`; to follow a device live, use `watch`:

```bash
nslogger-cli query --keyword InspirationFeed --tui   # browse an existing result set
nslogger-cli watch --keyword InspirationFeed --level 3  # live, follows new logs
nslogger-cli watch InspirationFeed                   # a bare word means --keyword
```

Both open the same interactive view on the most recent matching entries. `query --tui` starts
paused (and ignores `--limit` / `--offset`); `watch` starts following.

| Key | Action |
| --- | --- |
| `↑` `↓` (or `k` `j`) / `PgUp` `PgDn` | Move the selection (pauses following) |
| `⏎` | Expand / collapse the entry (file:line, function, thread, full message) |
| `/` | Edit the filter — `tag:net level:3 session:s1 free text`; applies to old and new entries |
| `f` | Pause / resume following |
| `g` / `G` | Jump to the top / bottom (`G` resumes following) |
| `q` | Quit |

Following pauses as soon as you touch the list — moving the selection, expanding an entry, or
opening the filter prompt — so incoming logs can never scroll away what you are reading. Once
paused, only `f` or `G` resumes it.

While paused, incoming logs are counted but **not** added to the view (the header shows
`+N new`); resuming fast-forwards through them. Buffering them would push what you are reading
out of the 5000-entry ring buffer, which on a chatty app makes a "paused" screen keep moving.

Both views open on the **most recent** 500 matching entries and follow from there — they never
scan forward from the beginning of the database. On a multi-GB capture that distinction is the
difference between opening instantly and blocking for half a minute per refresh. To read older
entries, narrow the filter or use `query --offset`.

Both need a terminal; in a pipe or when driven by an AI tool they exit with an error — use
plain `query` there.

### Live TCP ingestion

1. Edit `~/.nslogger-cli/config.json`, set `nslogger_tcp.enabled = true`.
2. Start the foreground receiver in a dedicated terminal (Ctrl-C to stop):

   ```bash
   nslogger-cli serve
   ```

3. Integrate the NSLogger client in your app (SSL works out of the box):

   ```swift
   // NSLogger client defaults to SSL; serve defaults to SSL — they meet on _nslogger-ssl._tcp
   LoggerSetupBonjour(nil, nil, "nslogger-cli" as NSString)  // must match serve's service_name (default: nslogger-cli)
   LoggerStart(nil)
   LogMessage("network", 2, "hello from device")
   ```

   > The Bonjour name must match: the third argument to `LoggerSetupBonjour` must equal the name `serve` advertises (default `nslogger-cli`; override with `"service_name": "<name>"` in config).
   >
   > If serve is configured with `"ssl": false` (plain TCP), disable SSL on the client side:
   > `LoggerSetOptions(nil, UInt32(kLoggerOption_BufferLogsUntilConnection | kLoggerOption_BrowseBonjour))`, then call `LoggerSetupBonjour` / `LoggerStart`.
   >
   > To skip Bonjour and connect directly: `LoggerSetViewerHost(nil, "<Mac LAN IP>" as NSString, 50000)` (works in SSL mode too).

4. Query from another terminal: `nslogger-cli query --keyword ... --pretty`

## Commands

| Command | Description |
| --- | --- |
| `serve` | Start receiver (TCP + file watch), runs in foreground |
| `sessions` | List all sessions |
| `query [--session --tag --level --keyword --limit --offset]` | Filter and search logs |
| `context <log_id> [--before --after]` | Context lines around a log entry |
| `trace-thread <session_id> <thread_id>` | All logs from a specific thread |
| `trace-range <session_id> --from <ms> --to <ms>` | Logs within a time window |
| `errors [--session --level]` | Warnings/errors (default level ≥ 3) |
| `load <file.nslogger>` | Import a file, prints session_id |
| `query ... --tui` | Browse the results interactively (requires a TTY) |
| `watch [--session --tag --level --keyword]` | Interactive live view; follows new logs. Requires a TTY |
| `clear <session_id>` | Delete a session |
| `clear --all` | Delete every session and log |
| `help [--json]` | Help (`--json` outputs a machine-readable command list) |

Global options: `--db <path>`, `--config <path>`, `--pretty` (default output is JSON).

## Enabling the Claude Code skill

This repository ships with a Claude Code skill (`skills/nslogger-cli/`) that lets Claude automatically recognize log-query intent and call `nslogger-cli`. The skill lives under `skills/nslogger-cli/` — **not** `.claude/skills/` — so Claude Code will not discover it automatically. To enable it, symlink or copy the directory into your skills search path:

```bash
# Available globally (all projects)
ln -s "$(pwd)/skills/nslogger-cli" ~/.claude/skills/nslogger-cli

# Or only for a specific project
ln -s "$(pwd)/skills/nslogger-cli" <target-project>/.claude/skills/nslogger-cli
```

> Using a symlink (`ln -s`) keeps the skill in sync as the repo updates; you can also `cp -r` it.

## For AI tools

`nslogger-cli` outputs JSON by default: `{ "success": true, "data": [...], "total": N }` to stdout with exit code 0 on success; `{ "success": false, "message": "..." }` to stderr with a non-zero exit code on error. An empty database returns an empty array (not an error). To enumerate all commands, run `nslogger-cli help --json`.

Common queries:

```bash
nslogger-cli sessions
nslogger-cli query --session <id> --keyword <text>
nslogger-cli errors --session <id>
```
