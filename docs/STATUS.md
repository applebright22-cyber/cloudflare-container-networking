# Project status

## Main user workflow

1. The Cloudflare Worker creates an account and clones a baseline VM snapshot into that account's R2 namespace.
2. The user logs in through the browser dashboard.
3. public/vm.html restores the account's v86 snapshot, runs TinyCore in the browser, and saves snapshot chunks back to R2.
4. The Worker can connect to the Oracle host executor over its outbound WebSocket agent connection. This is a separate host-shell execution path, not a TinyCore guest shell.

## Implemented paths

- Account signup, login, registration status, and session validation.
- Per-account snapshot manifests and chunk storage in R2.
- Browser-based v86 VM restore/save.
- WISP WebSocket relay for the guest's network path.
- Oracle Admin agent ticket and WebSocket routes.
- A separate authenticated /tunnel and /v1/nodes TCP-tunnel prototype.

## Known blockers and boundaries

- **Guest DNS/connectivity is not yet reliable.** Recent tests restored the snapshot and ran shell commands, but repeated guest DNS lookups failed. An ICMP test to a public IP also failed, which alone does not prove all TCP traffic is unavailable. Diagnose the guest network path before making more architecture changes.
- **There is no browserless TinyCore execution runtime.** The current v86 guest runs in the browser.
- **Oracle account execution remains disabled** unless the Worker setting ORACLE_ACCOUNT_EXEC_ENABLED is exactly true. Do not enable it until per-account OS/container isolation and identity validation are implemented and tested.
- The Oracle host executor runs commands as its service account; account-named directories do not provide operating-system isolation.
- The TCP-tunnel prototype is separate from the VM and Oracle-agent path. Its successful tests do not prove the guest VM's DNS or Internet works.

## Useful checks

From cloudflare/:

~~~sh
npm run test:headless
npm run check
~~~

From the repository root:

~~~sh
node --test tests/*.test.mjs
~~~

From the Oracle executor repository:

~~~sh
npm test
npm run check
curl -fsS http://127.0.0.1:8787/health
~~~

The Cloudflare check script uses a Wrangler dry run. It is not a deployment.

## Do not infer full success from a single check

- Account signup does not prove the guest can reach the Internet.
- A restored snapshot does not prove DNS is working.
- An online Oracle agent does not prove per-account Oracle execution is enabled.
- A working Oracle host shell does not prove commands are running inside TinyCore.
- The TCP tunnel prototype is not the guest's WISP network relay.
