#!/bin/sh
set -eu

# Persistent Tiny Core supervisor for the Mysterium service.
# The supervisor itself is started by bootlocal.sh and deliberately stays in
# the foreground so a VM/service manager can monitor it.

MYST_BIN="${MYST_BIN:-/opt/mysterium/myst}"
DATA_DIR="${MYST_DATA_DIR:-/var/lib/mysterium-node}"
LOG_FILE="${MYST_LOG_FILE:-/var/log/mysterium-node.log}"
PID_FILE="${MYST_PID_FILE:-/var/run/mysterium-node.pid}"
RESTART_SECONDS="${MYST_RESTART_SECONDS:-3}"
DESIRED_FILE="${MYST_DESIRED_FILE:-/var/run/mysterium.desired}"

mkdir -p "$DATA_DIR" "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"
printf "%s\n" "${MYST_DEFAULT_DESIRED:-running}" >"$DESIRED_FILE" 2>/dev/null || true

while :; do
  desired="$(cat "$DESIRED_FILE" 2>/dev/null || echo running)"
  if [ "$desired" != "running" ] && [ "$desired" != "starting" ]; then
    rm -f "$PID_FILE"
    sleep 2
    continue
  fi

  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') starting Mysterium" >>"$LOG_FILE"

  "$MYST_BIN" service --agreed-terms-and-conditions     --data-dir="$DATA_DIR" >>"$LOG_FILE" 2>&1 &
  pid=$!
  echo "$pid" >"$PID_FILE"

  wait "$pid" || true
  rm -f "$PID_FILE"

  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Mysterium exited; restarting" >>"$LOG_FILE"
  sleep "$RESTART_SECONDS"
done
