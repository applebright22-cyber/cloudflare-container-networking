# Relay frame protocol v1

Each WebSocket binary message carries exactly one complete frame. The current proof relays TCP streams only. Payload limit is 65,536 bytes; implementations must reject an oversized frame rather than buffer it without limit.

## Header

All integers are unsigned and big-endian. Fixed header is 20 bytes, followed by node ID bytes, followed by payload.

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | Magic ASCII RLY1 |
| 4 | 1 | Version, currently 1 |
| 5 | 1 | Frame type |
| 6 | 1 | Flags, currently zero |
| 7 | 1 | Node ID byte length, 1 through 64 |
| 8 | 4 | Stream ID |
| 12 | 4 | Sequence number |
| 16 | 4 | Payload byte length |
| 20 | variable | ASCII node ID matching [A-Za-z0-9._-]{1,64} |
| 20 + node ID length | variable | Payload |

The total WebSocket message length must equal 20 + node ID length + payload length. TCP_DATA payload bytes are opaque and maintain stream order; TCP frames never merge or split TCP stream boundaries beyond normal chunking. OPEN_TCP and TCP_OPENED payloads are UTF-8 JSON with host and port. ERROR payloads are UTF-8 JSON with a short code.

## Type IDs

| ID | Name | Direction | Purpose |
|---:|---|---|---|
| 1 | HELLO | Reserved | Future protocol negotiation |
| 2 | OPEN_TCP | client to gateway | JSON destination request |
| 3 | TCP_OPENED | gateway to client | Destination connected |
| 4 | TCP_DATA | either | Raw bytes for stream ID |
| 5 | CLOSE | either | Close that TCP stream |
| 6 | ERROR | gateway to client | JSON failure code |
| 7 | PING | either | Application heartbeat |
| 8 | PONG | either | Heartbeat reply |

## Session rules in this proof

The HTTPS handshake authenticates a role (client or gateway) and node ID separately from frame contents. The Durable Object allows one live WebSocket per role and node ID. A client OPEN_TCP is routed only to the matching node's gateway; gateway data and close frames return only to clients for that node. The gateway enforces an exact host:port allowlist before making a socket. This is an early TCP proof, not production multi-tenant authentication or a complete stream lifecycle implementation.

UDP is not included. A future UDP association must preserve datagram boundaries and use a verified UDP-capable egress path.
