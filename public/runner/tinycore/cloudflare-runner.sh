#!/bin/sh
set -eu

# Tiny Core control-plane runner.
# Polls the existing Worker runtime API and reconciles the local Mysterium process.

API_URL="${CLOUDFLARE_API_URL:?Set CLOUDFLARE_API_URL, e.g. https://your-worker.workers.dev}"
NODE_ID="${NODE_ID:?Set NODE_ID}"
MYST_BIN="${MYST_BIN:-/opt/mysterium/myst}"
DATA_DIR="${MYST_DATA_DIR:-/var/lib/mysterium-node}"
LOG_FILE="${MYST_LOG_FILE:-/var/log/mysterium-node.log}"
POLL_SECONDS="${RUNNER_POLL_SECONDS:-5}"
PID_FILE="${MYST_PID_FILE:-/var/run/mysterium-node.pid}"
DESIRED_FILE="${MYST_DESIRED_FILE:-/var/run/mysterium.desired}"
SUPERVISOR="${MYST_SUPERVISOR:-/opt/cloudflare-node/myst-supervisor.sh}"

api() {
  curl -fsS "${API_URL}/v1/nodes/${NODE_ID}/runtime"
}

heartbeat() {
  curl -fsS -X POST "${API_URL}/v1/nodes/${NODE_ID}/runtime/heartbeat" >/dev/null 2>&1 || true
}

patch_node() {
  status="$1"
  error="${2:-}"
  payload="{\"status\":\"$status\",\"runtime\":\"tinycore-persistent\",\"error\":${error:+\"$error\"}${error:-null}}"
  curl -fsS -X PATCH     -H "content-type: application/json"     --data "$payload"     "${API_URL}/v1/nodes/${NODE_ID}" >/dev/null || true
}

running() {
  [ -f "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

set_desired() {
  printf "%s\n" "$1" >"$DESIRED_FILE"
}

ensure_supervisor() {
  if ! pgrep -f "$SUPERVISOR" >/dev/null 2>&1; then
    nohup "$SUPERVISOR" >>"$(dirname "$LOG_FILE")/myst-supervisor.log" 2>&1 &
  fi
}

while :; do
  heartbeat
  desired="$(api | sed -n 's/.*"status":"\([^"]*\)".*/\1/p' | head -n 1 || true)"

  case "$desired" in
    running|starting)
      set_desired running
      ensure_supervisor
      patch_node online || true
      ;;
    stopped)
      set_desired stopped
      if running; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; fi
      rm -f "$PID_FILE"
      patch_node offline
      ;;
    error)
      patch_node error "cloudflare_requested_error_state"
      ;;
    *)
      # Registry/runtime may not exist yet; retry without killing the local node.
      ;;
  esac

  sleep "$POLL_SECONDS"
done
