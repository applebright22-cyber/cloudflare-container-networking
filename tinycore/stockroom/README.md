# TinyCore Stockroom host

Stockroom can run as a real service inside a persistent TinyCore Linux host. It uses Python 3 standard-library HTTP server and SQLite; no pip packages are needed.

Requirements:
- TinyCore Linux with Python 3 installed.
- A persistent writable filesystem mounted at /var/lib/stockroom, or STOCKROOM_DATA_DIR set to a persistent mount.
- STOCKROOM_GATEWAY_TOKEN set to a long random secret.
- A TLS reverse proxy or Cloudflare Tunnel in front of the service. Keep the service bound to localhost unless the private tunnel requires another interface.

Start with STOCKROOM_GATEWAY_TOKEN set, then run ./start-stockroom.sh. The service listens on 127.0.0.1:8787 by default. GET /health is a basic health check. All /v1 business routes require X-Stockroom-Gateway-Token and X-Stockroom-Account-ID headers. The Worker verifies user sessions before forwarding.

Each account has a separate SQLite database file. The data directory is mode 0700 and database files are mode 0600. Do not put the data directory on TinyCore's default RAM filesystem: it must be a persistent disk or mounted volume. Back it up regularly before live checkout.

Configure Worker variables/secrets: STOCKROOM_ORIGIN is the HTTPS origin for the TinyCore service (prefer a private Cloudflare Tunnel hostname, no trailing slash); STOCKROOM_GATEWAY_TOKEN must match the TinyCore secret. Do not expose port 8787 directly to the public internet.

Until both Worker settings are configured, the existing Durable Object backend remains active. This allows the code to be deployed before the TinyCore host is connected.

API: POST /v1/initialize; GET/POST /v1/products; PUT/DELETE /v1/products/{uuid}; GET /v1/movements; GET /v1/public-products; POST /v1/consume; POST /v1/purge. All except /health require both headers.