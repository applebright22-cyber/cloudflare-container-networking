#!/bin/sh
set -eu

# Mysterium installation is intentionally paused while startup/networking is
# being validated. This script must not download or launch Mysterium.
API_URL="${1:-}"
NODE_ID="${2:-}"

[ -n "$API_URL" ] && [ -n "$NODE_ID" ] || {
  echo "Usage: browser-bootstrap.sh <https-worker-url> <node-id>" >&2
  exit 1
}
case "$API_URL" in
  https://*) ;;
  *) echo "API URL must use https://" >&2; exit 1 ;;
esac
case "$NODE_ID" in
  *[!a-zA-Z0-9._-]*|'') echo "Invalid node id" >&2; exit 1 ;;
esac

echo "Mysterium bootstrap is temporarily disabled."
echo "Networking, TLS setup, and diagnostics are handled by the browser VM startup sequence."
exit 0
