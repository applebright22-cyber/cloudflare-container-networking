#!/bin/sh
# VampireSquid Oracle Bridge Connector — read-only bridge status.
BASE_URL=https://cloudflare-container-networking.brightlambre22-6dd.workers.dev
echo "=== VAMPIRESQUID ORACLE BRIDGE ==="
wget -T 12 -t 1 -qO- "$BASE_URL/api/vm/oracle-status" || exit 1
echo
