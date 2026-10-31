#!/bin/sh
set -eu

DATA_DIR="/var/lib/mysterium-node"
mkdir -p "$DATA_DIR"

: "${NODE_ID:?NODE_ID is required}"
: "${CLOUDFLARE_API_URL:?CLOUDFLARE_API_URL is required}"

export MYST_DATA_DIR="$DATA_DIR"

term_handler() {
  kill "$MYST_PID" 2>/dev/null || true
  kill "$HEALTH_PID" 2>/dev/null || true
  wait "$MYST_PID" 2>/dev/null || true
  wait "$HEALTH_PID" 2>/dev/null || true
  exit 0
}
trap term_handler TERM INT

/opt/mysterium/myst --data-dir="$DATA_DIR" service --agreed-terms-and-conditions &
MYST_PID=$!

python3 /opt/mysterium/health.py &
HEALTH_PID=$!

# Give TequilaAPI a moment to come up, then claim the node when a Worker secret is supplied.
if [ -n "${MYSTERIUM_API_KEY:-}" ]; then
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 2 http://127.0.0.1:4050/healthcheck >/dev/null 2>&1; then
      /opt/mysterium/myst cli mmn "$MYSTERIUM_API_KEY" >/tmp/myst-mmn.log 2>&1 || true
      break
    fi
    sleep 2
  done
fi

# Keep the control-plane heartbeat independent from Mysterium's process.
(
  while kill -0 "$MYST_PID" 2>/dev/null; do
    curl -fsS --max-time 5 -X POST \
      -H "Content-Type: application/json" \
      "$CLOUDFLARE_API_URL/v1/nodes/$NODE_ID/runtime/heartbeat" >/dev/null 2>&1 || true
    sleep "${RUNNER_HEARTBEAT_SECONDS:-10}"
  done
) &

wait "$MYST_PID"
EXIT_CODE=$?
kill "$HEALTH_PID" 2>/dev/null || true
exit "$EXIT_CODE"
