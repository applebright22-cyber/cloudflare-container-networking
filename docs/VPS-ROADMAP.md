# VPS replacement roadmap: Tiny Core + v86 + Cloudflare

## Current status

The browser VM obtains a DHCP lease and default route, and outbound internet access has been verified by the project owner. This establishes outbound connectivity, not a complete VPS.

A recent bootstrap run downloaded both `openssl-1.1.1.tcz` and `ca-certificates.tcz`, then stopped after Tiny Core printed `Updating certificates in /usr/local/etc/ssl/certs...` and `Hangcheck: hangcheck value past margin!`. This output alone does **not** prove disk exhaustion. The next VM-page change should print filesystem and memory diagnostics before package installation and split OpenSSL and CA-certificate installation into separately marked steps.

## Diagnose the stall before changing storage

Capture these from the guest before and after package installation:

```sh
echo '=== FILESYSTEMS ==='
df -h
mount
echo '=== MEMORY ==='
free
cat /proc/meminfo
echo '=== PACKAGE CACHE ==='
ls -lah /tmp /usr/local/tce /etc/sysconfig/tcedir 2>&1
```

Tiny Core can use RAM-backed filesystems, persistent storage, and extension directories that have different capacity limits. R2 capacity does not enlarge guest `/tmp`; increasing guest RAM does not enlarge an emulated disk. Diagnose the specific layer first. If certificate processing hangs again, capture process state and the exact mount backing `/usr/local/etc/ssl/certs` before deleting caches or snapshots.

Longer term, avoid installing packages on every boot. After validating the required extensions and CA bundle, bake them into the ISO or persist the extension list and extension cache. Keep setup idempotent, print an exit code for every stage, and stop immediately when a required marker is missing.

## Storage and snapshot design

Treat these as separate layers:

- **Guest filesystem:** use `df -h` and `mount` to identify actual capacity and backing storage.
- **Guest memory:** use `free` and `/proc/meminfo` to identify RAM pressure.
- **v86 state:** explicitly call the emulator's save-state API and verify that the resulting state can be persisted and restored after a page reload. A browser tab closing otherwise stops execution.
- **Browser storage:** use IndexedDB for larger local binary data rather than localStorage; handle quota errors and show a useful message.
- **Cloudflare R2:** store compressed snapshots with metadata, size limits, per-user/node authorization, and a retention policy. Reject corrupt or unsupported snapshots before attempting restore.

## Public IPs: an important architectural distinction

The guest address (for example, `10.5.166.5`) is private. The Worker endpoint `/debug/egress-ip` reports the Cloudflare Worker's outbound IPv4 address; it does **not** report a public address assigned to the Tiny Core guest. Adding private aliases such as `10.240.0.x` to `eth0` does not create public IPv4 addresses.

A multi-public-IP design needs an address source and a packet path for every address:

1. Obtain a routable IPv4 allocation from a host/provider that explicitly supports multiple addresses or routed prefixes.
2. Route that allocation to a gateway/host you control.
3. Configure guest addresses and routes according to the provider's model; some providers require proxy ARP, routed prefixes, or per-address virtual MACs.
4. Ensure inbound packets reach the guest and outbound packets use the intended source address, using policy routing or source NAT when required.
5. Test inbound and outbound reachability independently for every address.

Cloudflare Workers, Durable Objects, and R2 can provide control-plane APIs, coordination, and snapshots, but do not themselves give an arbitrary v86 guest a dedicated public IPv4 interface or act as a general-purpose VPS hypervisor. A browser-hosted v86 instance also stops executing when its page closes and shares the browser's resources. It is a useful test environment, but not yet a reliable always-on VPS replacement.

## Recommended milestones

- **M1 — Stable boot:** capture resource diagnostics, split bootstrap stages, verify outbound HTTPS, and prevent silent continuation after failures.
- **M2 — Durable state:** authenticated save/list/restore/delete endpoints backed by R2, compressed snapshots, size limits, and restore validation.
- **M3 — Dashboard security:** single-user login, short-lived signed HttpOnly/Secure/SameSite session cookie, CSRF protection on state-changing routes, rate limiting, and protected snapshot routes. Keep node/tunnel credentials server-side.
- **M4 — Operational VM:** prove save/restore across browser reloads, document RAM/CPU/storage ceilings, and report heartbeat/last-seen accurately.
- **M5 — Networked VPS prototype:** use a persistent host or provider that supports routed public IPs; prove one public IP end-to-end before attempting multiple addresses.

## Acceptance checks before deployment

- Local Worker dry-run succeeds for both `cloudflare/wrangler.toml` and the root `wrangler.toml`.
- Unauthenticated snapshot list/read/write/delete operations return 401.
- Save → list → restore succeeds using Wrangler's local R2 emulator.
- Invalid, oversized, corrupt, and unsupported snapshot payloads fail safely.
- Each VM bootstrap stage either emits its marker or stops with a captured timeout report.
- A full v86 browser boot and restore test passes.
- Public-IP tests confirm routed inbound reachability and source-address behavior, not merely a Worker egress address.

No deployment is performed as part of this roadmap.
