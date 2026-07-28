#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$SCRIPT_DIR/nslogger-cli"

# ── Prerequisites ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Error: Node.js is required (>= 18). Install from https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js >= 18 required (found $(node --version))" >&2
  exit 1
fi

# ── Build & link ─────────────────────────────────────────────────────────────
echo "→ Installing dependencies..."
cd "$CLI_DIR"
npm install --silent

echo "→ Building..."
npm run build --silent

echo "→ Linking global 'nslogger-cli' command..."
npm link

# ── Seed default config ──────────────────────────────────────────────────────
CONFIG_HOME="$HOME/.nslogger-cli"
mkdir -p "$CONFIG_HOME"
if [ ! -f "$CONFIG_HOME/config.json" ]; then
  cp "$CLI_DIR/config.json" "$CONFIG_HOME/config.json"
  echo "→ Wrote default config to $CONFIG_HOME/config.json"
fi

cat <<EOF

═══════════════════════════════════════════════════════════
  nslogger-cli installed.
═══════════════════════════════════════════════════════════

  Try:      nslogger-cli help
  Config:   $CONFIG_HOME/config.json
  DB:       /tmp/nslogger-cli/logs.db (auto-created; the OS reclaims it in time)

  Real-time receive:  edit config (enable nslogger_tcp), then run
                      nslogger-cli serve
  Read a file:        nslogger-cli load <path.nslogger>
                      nslogger-cli query --keyword <text> --pretty
  Live view (TUI):    nslogger-cli watch --keyword <text>

  Upgrading? An existing $CONFIG_HOME/config.json is left untouched, so it
  still points at the old ~/.nslogger-cli/logs.db. Edit "db_path" to switch.

  If 'nslogger-cli' is not found afterward, ensure your npm global
  bin dir is on PATH:  echo "\$(npm prefix -g)/bin"
═══════════════════════════════════════════════════════════
EOF
