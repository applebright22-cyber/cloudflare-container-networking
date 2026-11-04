#!/bin/sh
# Source this from /opt/bootlocal.sh after the persistent data volume is mounted.
# Keep the secret in a root-readable persistent environment file, not in Git.
STOCKROOM_ENV="${STOCKROOM_ENV:-/etc/stockroom.env}"
if [ ! -r "$STOCKROOM_ENV" ]; then
  echo "Stockroom not started: $STOCKROOM_ENV is missing."
  exit 0
fi
. "$STOCKROOM_ENV"
export STOCKROOM_GATEWAY_TOKEN STOCKROOM_DATA_DIR STOCKROOM_BIND STOCKROOM_PORT
STOCKROOM_DATA_DIR="${STOCKROOM_DATA_DIR:-/var/lib/stockroom}"
STOCKROOM_BIND="${STOCKROOM_BIND:-127.0.0.1}"
STOCKROOM_PORT="${STOCKROOM_PORT:-8787}"
export STOCKROOM_DATA_DIR STOCKROOM_BIND STOCKROOM_PORT
mkdir -p "$STOCKROOM_DATA_DIR"
chmod 700 "$STOCKROOM_DATA_DIR"
# The start script remains in /opt/stockroom; the database directory must be
# a mounted persistent disk, not TinyCore's volatile RAM filesystem.
"/opt/stockroom/start-stockroom.sh" >> /var/log/stockroom.log 2>&1 &
