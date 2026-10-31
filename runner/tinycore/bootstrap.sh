#!/bin/sh
set -eu

# Idempotent Tiny Core first-boot bootstrap for the PoC.

PERSIST="/etc/cloudflare-node"
mkdir -p "$PERSIST"

IFACE="${NODE_INTERFACE:-eth0}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for the Cloudflare runner." >&2
  echo "Install the Tiny Core curl package and persist it in tce/onboot.lst." >&2
  exit 1
fi

"$SCRIPT_DIR/configure-node-ips.sh" "$IFACE"

if [ -z "${CLOUDFLARE_API_URL:-}" ] || [ -z "${NODE_ID:-}" ]; then
  echo "Set CLOUDFLARE_API_URL and NODE_ID before starting the runner." >&2
  exit 1
fi

if [ ! -x /opt/mysterium/myst ]; then
  echo "Mysterium binary missing: install the amd64 standalone release at /opt/mysterium/myst." >&2
  exit 1
fi

echo "Tiny Core PoC bootstrap complete."
echo "Node: $NODE_ID"
echo "Private node range: 10.240.0.2-10.240.0.101"
echo "Starting Cloudflare control runner..."

exec "$SCRIPT_DIR/cloudflare-runner.sh"
