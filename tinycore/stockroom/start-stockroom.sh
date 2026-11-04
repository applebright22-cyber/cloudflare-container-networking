#!/bin/sh
set -eu
BASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DATA_DIR="${STOCKROOM_DATA_DIR:-/var/lib/stockroom}"

# Fail closed: never create a database directory on TinyCore's RAM root.
if [ ! -r /proc/mounts ] || ! awk -v p="$DATA_DIR" '$2 == p { found=1 } END { exit !found }' /proc/mounts; then
  echo "Persistent Stockroom volume is not mounted at $DATA_DIR; refusing to start." >&2
  exit 1
fi
if [ -z "${STOCKROOM_GATEWAY_TOKEN:-}" ]; then
  echo "STOCKROOM_GATEWAY_TOKEN must be set; refusing to start an unauthenticated API." >&2
  exit 1
fi
PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || { echo "Python 3 is required (TinyCore package: python3)." >&2; exit 1; }
chmod 700 "$DATA_DIR"
export STOCKROOM_DATA_DIR="$DATA_DIR"
export STOCKROOM_BIND="${STOCKROOM_BIND:-127.0.0.1}"
export STOCKROOM_PORT="${STOCKROOM_PORT:-8787}"
exec "$PYTHON" "$BASE/stockroom.py"
