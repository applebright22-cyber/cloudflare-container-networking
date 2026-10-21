# Cloudflare Container Networking

A Cloudflare-first control and tunnel foundation for the larger networking design. The current milestone proves two separately authenticated WebSocket roles, binary framing, multi-stream TCP relay through the Oracle gateway, and automatic reconnect for the gateway.

## Implemented

- Worker health route, authenticated gateway/client tunnel route, and authenticated live-session listing.
- Hibernatable Durable Object that brokers bounded binary frames between a gateway and client for the same node.
- Versioned frame codec shared by TypeScript and Python.
- Python gateway client that opens allowlisted TCP connections and multiplexes stream IDs over one WebSocket.
- Local TCP echo service and a two-stream end-to-end smoke-test client.
- Wrangler SQLite-backed Durable Object configuration and local secret template.

Still not implemented: UDP datagram transport, Docker lifecycle management, container IP assignment, proxy adapters, egress enforcement, public-IP verification, inbound public service ingress, dashboard, and production key rotation. See docs/STATUS.md before relying on this for workloads.

## Architecture boundary

Cloudflare is the HTTP/WebSocket control and tunnel layer. The gateway at 141.148.53.68 is a separate Linux host and remains responsible for Docker, raw networking, and any eventual TCP/UDP bridge. Workers accept HTTP and WebSockets; Workers can open outbound TCP sockets, but Cloudflare documents inbound direct TCP as not yet supported. Do not assume an HTTP/WebSocket endpoint can accept arbitrary public UDP. No IP spoofing is used.

## Deploy the Worker

On a development machine with Node.js, clone this repository, then run:

   ~~~sh
   cd cloudflare
   npm install
   npx wrangler login
   npm run deploy
   ~~~

Wrangler prints the deployed Workers URL. Gateway and client connections use the same account credential format: account ID plus that account API key. The node registry is temporarily unauthenticated while we finish the node lifecycle implementation.

## Run the TCP proof on the Oracle gateway

On the Oracle host, install the Python dependency:

   ~~~sh
   cd gateway
   python -m venv .venv
   . .venv/bin/activate
   pip install -r requirements.txt
   ~~~

Set these environment values in the gateway shell (use the actual Workers URL and the account ID/API key issued by the application):

   ~~~sh
   export TUNNEL_URL=wss://YOUR-WORKER.workers.dev/tunnel
   export ACCOUNT_ID='acct-your-account-id'
   export ACCOUNT_API_KEY='acct_your_account_api_key'
   export NODE_ID=oracle-gateway
   ~~~

Start three terminals on the Oracle host:

   ~~~sh
   cd gateway && python echo_server.py
   cd gateway && python client.py
   cd gateway && python tcp_smoke.py
   ~~~

The echo target binds only to 127.0.0.1:9000. The gateway client defaults to allowing only that exact TCP destination. The smoke test opens two TCP streams across the same WebSocket and verifies echoed payloads. No inbound port on Oracle is needed for this proof; the gateway opens outbound TLS/WebSocket traffic to Cloudflare. Set TCP_ALLOWLIST only to explicit host:port destinations you intend to permit.

Check GET /health on the deployed URL. Node registry endpoints are temporarily unauthenticated during this PoC phase.

For local Worker development, copy cloudflare/.dev.vars.example to cloudflare/.dev.vars, set disposable local-only secrets, and run npm run dev. The Python clients must be able to reach Wrangler's local WebSocket endpoint.

## Replit and Cloudflare cost

This source repository and deployment flow do not require a Replit plan upgrade. Cloudflare has its own plan limits: as checked against the official docs on 2026-10-07, the Workers Free plan supports SQLite-backed Durable Objects with 100,000 DO requests/day and 13,000 GB-s/day; exceeding a free limit causes further operations of that type to fail. WebSocket message accounting and storage quotas also apply. Hibernation reduces idle duration charges, but heartbeats and traffic still consume quota. Check Cloudflare's current limits before production use. This starter does not use Cloudflare Containers, which are not included in the Workers Free plan.

## Commands

- cd cloudflare && npm run dev - local Worker development.
- cd cloudflare && npm run check - Wrangler dry-run bundle/config check.
- cd cloudflare && npm run deploy - deploy to the Cloudflare account logged into Wrangler.
- cd gateway && python -m unittest -v - run Python frame codec tests.

See docs/STATUS.md and protocol/frame-v1.md for scope and wire format.
