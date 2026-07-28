---
name: nslogger-cli
description: >-
  Query mobile app logs (NSLogger) for debugging: list sessions, filter/search logs,
  view errors, get context around a log entry, trace by thread or time range, import
  .nslogger files. Trigger when the user says "check app logs", "any errors/crashes",
  "nslogger", "mobile app logs", "load .nslogger file", or Chinese equivalents such as
  "看看 App 日志"、"有什么错误/崩溃日志"、"看一下日志会话"、"查日志"、
  "加载 .nslogger 文件"、"移动端日志" and similar log-debugging expressions.
  Note: this skill only queries/reads; to receive live device logs, prompt the user to
  run `nslogger-cli serve` themselves.
argument-hint: <optional: session id / keyword / .nslogger file>
user-invocable: true
allowed-tools: Bash, Read
---

# nslogger-cli — Query Mobile App Logs

`nslogger-cli` collects logs from mobile apps (NSLogger protocol, via TCP/Bonjour/SSL or
`.nslogger` files) into a shared SQLite database and provides one-shot query commands for
AI-assisted debugging.

**Output convention**: defaults to JSON — `{"success":true,"data":[...],"total":N}` to
stdout, exit code 0; on error `{"success":false,"message":"..."}` to stderr with a non-zero
exit code; empty results return an empty array (not an error). Add `--pretty` for
human-readable output. Parse by reading the `data` array; use `total` to check for results.

## Step 0 — Verify the binary is available

Before starting, confirm `nslogger-cli` is on the PATH:

```bash
command -v nslogger-cli >/dev/null 2>&1 || echo "not installed"
```

If missing, **prompt the user to run `bash install.sh`** as described in the repo README,
then continue. Do not attempt to build or work around this inside the skill.

## Command reference

Run `sessions` first to get a `session_id`, then drill down as needed.
Use only existing CLI flags — **do not invent new ones**.

| Intent | Command |
| --- | --- |
| List all log sessions | `nslogger-cli sessions` |
| Filter / search logs | `nslogger-cli query [--session ID] [--tag T] [--level N] [--keyword K] [--limit N] [--offset N]` |
| Warnings and errors only | `nslogger-cli errors [--session ID] [--level N]` (default level ≥ 3) |
| Context around a log entry | `nslogger-cli context <log_id> [--before N] [--after N]` |
| Trace a thread | `nslogger-cli trace-thread <session_id> <thread_id>` |
| Trace a time window (ms) | `nslogger-cli trace-range <session_id> --from <ms> --to <ms>` |
| Import a .nslogger file | `nslogger-cli load <file.nslogger>` (prints the new `session_id`) |
| Delete a session (destructive) | `nslogger-cli clear <session_id>` |
| Delete everything (destructive) | `nslogger-cli clear --all` |

**Global flags** (any command): `--db <path>` override database path, `--config <path>`
override config file, `--pretty` human-readable output.

## Typical debugging workflow

1. `nslogger-cli sessions` → pick the target `session_id`.
2. `nslogger-cli errors --session <id>` or `nslogger-cli query --session <id> --keyword <K>` to locate suspicious entries.
3. Take a `log_id` and run `nslogger-cli context <log_id>` for surrounding context; or use `trace-thread` / `trace-range` to drill down by thread or time window.
4. Parse the returned `data` array for analysis; if `total` is 0, see the next section.

## No data / live ingestion (handling `serve`)

This skill does **not** start `serve` in the background. When `sessions` is empty or the
user expects live device logs:

- **Prompt the user to start the receiver themselves**: `nslogger-cli serve`
  (enables TCP/Bonjour/SSL per `~/.nslogger-cli/config.json`, Ctrl-C to stop); come back
  to query once logs are flowing.
- If the user has a static capture file, suggest `nslogger-cli load <file.nslogger>` to
  import it first.

## Notes

- `clear` deletes all logs for that session, `clear --all` wipes every session —
  **confirm with the user before running either**.
- The database defaults to `/tmp/nslogger-cli/logs.db`; `serve` (writer) and query commands
  (readers) share the same database. Being under `/tmp` means the OS eventually reclaims it —
  a `database not found` error just means nothing has been imported or received since.
- `watch` and `query --tui` are interactive TUIs and require a terminal —
  **never run either from this skill**; they are for the user to run directly. Use plain
  `query` instead, and suggest `nslogger-cli query ... --tui` when the user wants to read
  a long result themselves.
- Config lookup order: `--config` → `$NSLOGGER_CLI_CONFIG` → `~/.nslogger-cli/config.json`
  → `./config.json`.
- A long-running `serve` can grow the database to many GB. `query` with only `--keyword` then
  scans the whole table; add `--session <id>` (or `--level`) to bound it, and prefer `errors`
  or `--limit` when a sample is enough.
