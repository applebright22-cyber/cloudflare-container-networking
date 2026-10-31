# amd64 Mysterium runtime

This is the real Mysterium runtime for a Linux amd64 host. The browser/v86 Tiny Core VM remains a console/UI proof of concept; this runtime is where the Mysterium provider process runs.

## Requirements

- Linux amd64 host (Oracle VM, VPS, or another Linux server)
- Docker + Docker Compose
- outbound Internet access
- host networking
- /dev/net/tun
- NET_ADMIN capability
- a deployed Cloudflare Worker URL
- a Mysterium onboarding key supplied only through the local .env file

Mysterium's provider service uses WireGuard, so this runtime intentionally uses host networking and the host TUN device rather than trying to run the provider inside the browser/v86 VM.

## Start

1. Copy .env.example to .env.
2. Set NODE_ID to the existing node ID assigned by the Cloudflare API.
3. Set CLOUDFLARE_API_URL to the deployed Worker URL.
4. Set MYSTERIUM_API_KEY locally if automatic MMN onboarding is desired.
5. Run:

    docker compose up -d --build

## Verify

The container exposes Mysterium TequilaAPI on host port 4050 and the runtime health endpoint on port 8080.

    curl http://127.0.0.1:4050/healthcheck
    curl http://127.0.0.1:8080/health
    curl "$CLOUDFLARE_API_URL/v1/nodes/$NODE_ID"
    curl "$CLOUDFLARE_API_URL/v1/nodes/$NODE_ID/runtime"

The Cloudflare node should move from provisioning to online once the runtime is healthy and heartbeating.

Do not commit .env or any Mysterium onboarding key.
