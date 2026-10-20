#!/bin/sh
set -eu

# Configure the 100 private PoC addresses on the selected interface.
# Usage: ./configure-node-ips.sh eth0
# Creates 10.240.0.2 through 10.240.0.101.

IFACE="${1:-eth0}"

command -v ip >/dev/null 2>&1 || {
  echo "ip command is required" >&2
  exit 1
}

ip link show "$IFACE" >/dev/null 2>&1 || {
  echo "Interface not found: $IFACE" >&2
  exit 1
}

host=2
while [ "$host" -le 101 ]; do
  third=$((host / 256))
  fourth=$((host % 256))
  addr="10.240.$third.$fourth"
  ip addr replace "$addr/24" dev "$IFACE"
  host=$((host + 1))
done

echo "Configured 100 PoC addresses on $IFACE: 10.240.0.2-10.240.0.101"
