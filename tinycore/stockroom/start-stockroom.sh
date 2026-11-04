#!/bin/sh
set -eu
BASE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DATA_DIR="${STOCKROOM_DATA_DIR:-/var/lib/stockroom}"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
if [ -z "${STOCKROOM_GATEWAY_TOKEN:-}" ]; then
  echo "STOCKROOM_GATEWAY_TOKEN must be set; refusing to start an unauthenticated API." >&2
  exit 1
fi
PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || { echo "Python 3 is required (TinyCore package: python3)." >&2; exit 1; }
export STOCKROOM_DATA_DIR="$DATA_DIR"
export STOCKROOM_BIND="${STOCKROOM_BIND:-127.0.0.1}"
export STOCKROOM_PORT="${STOCKROOM_PORT:-8787}"
exec "$PYTHON" "$BASE/stockroom.py"
