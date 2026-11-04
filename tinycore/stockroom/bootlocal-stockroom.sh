#!/bin/sh
# Source this from /opt/bootlocal.sh only after the persistent data volume is mounted.
# Keep the secret in a root-readable environment file, never in Git.
set -eu
STOCKROOM_ENV="${STOCKROOM_ENV:-/etc/stockroom.env}"
LOG="/var/log/stockroom.log"

if [ ! -r "$STOCKROOM_ENV" ]; then
  echo "Stockroom not started: $STOCKROOM_ENV is missing." >> "$LOG"
  exit 0
fi
. "$STOCKROOM_ENV"
export STOCKROOM_GATEWAY_TOKEN STOCKROOM_DATA_DIR STOCKROOM_BIND STOCKROOM_PORT
STOCKROOM_DATA_DIR="${STOCKROOM_DATA_DIR:-/var/lib/stockroom}"
STOCKROOM_BIND="${STOCKROOM_BIND:-127.0.0.1}"
STOCKROOM_PORT="${STOCKROOM_PORT:-8787}"
export STOCKROOM_DATA_DIR STOCKROOM_BIND STOCKROOM_PORT

# Do not create the directory until its persistent filesystem is confirmed mounted.
if [ ! -r /proc/mounts ] || ! awk -v p="$STOCKROOM_DATA_DIR" '$2 == p { found=1 } END { exit !found }' /proc/mounts; then
  echo "Stockroom not started: persistent volume is not mounted at $STOCKROOM_DATA_DIR." >> "$LOG"
  exit 0
fi
if [ -z "${STOCKROOM_GATEWAY_TOKEN:-}" ]; then
  echo "Stockroom not started: STOCKROOM_GATEWAY_TOKEN is missing." >> "$LOG"
  exit 0
fi

chmod 700 "$STOCKROOM_DATA_DIR"
"/opt/stockroom/start-stockroom.sh" >> "$LOG" 2>&1 &
