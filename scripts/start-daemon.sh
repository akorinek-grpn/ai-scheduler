#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_ROOT/data"
DAEMON_JSON="$DATA_DIR/daemon.json"

# Started from inside Claude Code (the /ai-scheduler skill, an agent's shell), the daemon
# would inherit that session's environment - CLAUDECODE, its session id and messaging
# token, the secrets of ~/.claude/settings.json `env` - and pass it to every job it spawns
# (2026-09-29). Relaunch from a clean login shell, which sets up PATH (node, bun, claude)
# the way a terminal does.
if [ -n "${CLAUDECODE:-}" ] && [ -z "${AI_SCHEDULER_CLEAN_START:-}" ]; then
  exec env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" \
    SHELL="${SHELL:-/bin/zsh}" TERM="${TERM:-xterm-256color}" AI_SCHEDULER_CLEAN_START=1 \
    "${SHELL:-/bin/zsh}" -lic 'exec "$0"' "$SCRIPT_DIR/start-daemon.sh" < /dev/null
fi

mkdir -p "$DATA_DIR"

# Check if daemon is already running
if [ -f "$DAEMON_JSON" ]; then
  PID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).pid)" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Daemon already running (pid: $PID)"
    exit 0
  fi
  rm -f "$DAEMON_JSON"
fi

# Load .env if present
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

echo "Starting AI Scheduler daemon..."
nohup npx tsx "$PROJECT_ROOT/src/daemon/index.ts" >> "$DATA_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
echo "Daemon started (pid: $DAEMON_PID)"

# Wait for daemon.json to appear
for i in $(seq 1 10); do
  if [ -f "$DAEMON_JSON" ]; then
    echo "Daemon ready on port $(node -e "console.log(JSON.parse(require('fs').readFileSync('$DAEMON_JSON','utf8')).port)")"
    exit 0
  fi
  sleep 0.5
done

echo "Warning: Daemon started but daemon.json not yet written"
