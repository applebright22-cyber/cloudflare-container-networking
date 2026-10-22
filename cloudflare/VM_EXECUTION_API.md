# VM Execution API

The authenticated /v1/vm/status and /v1/vm/exec endpoints send requests to a connected execution agent managed by the VM_EXECUTION Durable Object. The default identity is **oracle**, which runs commands on the Oracle Linux host through the Oracle executor. It does not run commands inside the TinyCore browser VM.

## Runtime boundaries

- **oracle**: persistent Bash session on the Oracle Linux host. Commands run as the executor service user, normally opc.
- **admin**: the separate browser-v86 Admin agent. It requires the browser dashboard to be open and the Admin agent connected.
- **account-level Oracle execution**: the dashboard's /api/account/exec endpoint is blocked unless ORACLE_ACCOUNT_EXEC_ENABLED is exactly true. Do not enable it until real per-account OS/container isolation and identity validation have been implemented and tested.

The browser VM remains a separate runtime. This API does not run Linux inside the Worker and does not make the Oracle host shell a TinyCore guest shell.

## Configure the API token

The Worker reads the API token from the private R2 object:

- Bucket: cloudflare-container-vm-snapshots
- Key: config/vm-api-token.txt

The token is not read from a VM_API_TOKEN Worker secret by the current implementation. Keep the R2 bucket private and do not put the token in browser code. Rotate it by replacing the R2 object with a new random token.

The separate ADMIN_ACCESS_CODE Worker secret is used for the Admin/Oracle agent-ticket flow. Keep it private as well.

## Check Oracle execution availability

~~~sh
curl -sS 'https://YOUR-WORKER-DOMAIN/v1/vm/status' \
  -H "Authorization: Bearer $VM_API_TOKEN"
~~~

The default VM ID is oracle. To request a specific supported identity, send X-VM-ID: oracle or X-VM-ID: admin.

## Execute a command

~~~sh
curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/vm/exec' \
  -H "Authorization: Bearer $VM_API_TOKEN" \
  -H 'X-VM-ID: oracle' \
  -H 'Content-Type: application/json' \
  -d '{"command":"pwd; uname -a","timeout_ms":15000}'
~~~

Commands must be 1–4096 characters. timeout_ms is optional and limited to 1,000–20,000 ms. Use read-only diagnostics first. A timeout does not guarantee that a running shell command was terminated.

## Current limitations

- The Oracle identity executes on the shared host as the service user; it is not an isolated user container.
- The browser Admin VM is only available while its v86 session and agent connection are active.
- Browser terminal output is read from the guest's visible terminal buffer and can be truncated.
- Account-level Oracle execution remains disabled by default for safety.
- A successful API response does not prove that TinyCore guest DNS or guest Internet access works.

The API is for development diagnostics, not a production multi-tenant shell service.
