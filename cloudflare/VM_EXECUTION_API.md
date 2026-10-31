# VM Execution API PoC

This API lets an authenticated HTTP client submit a shell command to the **currently connected admin v86 VM in the browser dashboard** and receive the visible terminal output and exit code. It is for runtime and network testing only.

**Important runtime boundary:** v86 currently executes in the browser. The browser tab must stay open, the admin VM must finish its initial bootstrap or restore a saved snapshot, and the API agent must show as connected. This API does not run Linux inside the Worker and cannot execute commands while the browser VM is offline. Output comes from the VM's text terminal buffer and can be truncated for long output. A timeout does not guarantee that a guest command was terminated.

## Configure

From the `cloudflare/` directory, set a strong API token and deploy the branch:

```sh
npx wrangler secret put VM_API_TOKEN
npx wrangler secret put ADMIN_ACCESS_CODE
npm run check
npm run deploy
```

The admin code is now read from the `ADMIN_ACCESS_CODE` Worker secret; set it before using admin login or agent tickets. Keep it private. The agent ticket endpoint validates this secret and issues a one-use ticket. The current PoC supports only VM ID `admin`; the existing regular-user accounts are browser-local and are not suitable as server-side API identities.

## Connect the VM agent

1. Open `/vm.html` on the deployed site.
2. Sign in with the admin option and the admin code.
3. Wait for the VM to restore its saved state or finish the full initial bootstrap.
4. Check the page status for `VM ready; API execution agent connected.`

The browser receives a one-use agent ticket after admin-code validation. The ticket expires after 60 seconds and is consumed when the WebSocket connects.

## API

All `/v1/vm/*` calls require `Authorization: Bearer $VM_API_TOKEN`. The default VM ID is `admin`; optionally send `X-VM-ID: admin`.

### Check runtime availability

```sh
curl -sS 'https://YOUR-WORKER-DOMAIN/v1/vm/status' \
  -H "Authorization: Bearer $VM_API_TOKEN" \
  -H 'X-VM-ID: admin'
```

An offline VM returns `status: offline` and `execution_available: false`.

### Execute a shell command

```sh
curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/vm/exec' \
  -H "Authorization: Bearer $VM_API_TOKEN" \
  -H 'X-VM-ID: admin' \
  -H 'Content-Type: application/json' \
  -d '{"command":"id; uname -a; ip route 2>/dev/null || route -n","timeout_ms":15000}'
```

Request fields:
- `command`: required shell command, 1–4096 characters.
- `timeout_ms`: optional, 1000–20000; defaults to 15000.

Response includes `stdout`, `stderr`, `exit_code`, `execution_id`, and `runtime: browser-v86`. The first commands to try are `echo API_OK`, `id`, `uname -a`, and the network diagnostics above. Start with read-only diagnostics, not privileged or destructive commands.

## Current PoC limitations

- One shared bearer token and one admin VM; no per-merchant API keys, user isolation, quotas or billing.
- Arbitrary shell execution is powerful. Treat the token like a root-equivalent credential and never embed it in the dashboard.
- The browser VM must remain connected; refresh/reconnect behavior is best-effort. If a command times out, check the terminal before submitting another command.
- Output is scraped from the current v86 text-screen buffer, not a full stdout/stderr pipe; long output can be truncated and terminal redraws can affect parsing.
- No durable execution queue or server-side v86 runtime is provided.
- This is not a payment API and does not move money. Do not send cardholder data, banking credentials or production transaction commands through this PoC.
- Before production: replace the hard-coded admin code and local-only accounts with real authentication, use per-VM/per-customer authorization, rate-limit execution, audit every command, add a robust guest-agent protocol with structured output, and isolate commands in a server-side runtime if execution must continue after the browser closes.
