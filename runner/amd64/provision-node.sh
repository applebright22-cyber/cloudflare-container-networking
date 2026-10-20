#!/bin/sh
set -eu

: "${CLOUDFLARE_API_URL:?Set CLOUDFLARE_API_URL}"

response="$(curl -fsS -X POST \
  -H "Content-Type: application/json" \
  "$CLOUDFLARE_API_URL/v1/nodes" \
  -d '{"count":1}')"

printf '%s\n' "$response"

node_id="$(printf '%s' "$response" | sed -n 's/.*"node_id":"\([^"]*\)".*/\1/p')"
if [ -z "$node_id" ]; then
  echo "Could not extract node_id from API response" >&2
  exit 1
fi

echo
echo "Created node: $node_id"
echo "Set NODE_ID=$node_id in runner/amd64/runtime.env before starting the runtime."
