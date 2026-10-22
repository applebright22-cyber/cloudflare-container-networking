# Account signup and snapshot provisioning

The Worker currently exposes two account-creation paths. They are different APIs and should not be confused.

## Browser signup (current dashboard path)

The dashboard uses these same-origin endpoints:

- POST /api/auth/signup — validates a username/password, creates a server-side user record, and queues a copy of the configured baseline snapshot into a unique account namespace.
- POST /api/auth/registration-status — checks the background snapshot-copy job.
- POST /api/auth/login — verifies the password and issues a session token.
- POST /api/auth/session — validates the session after a same-tab refresh.

Passwords are hashed in the AccountRegistry Durable Object. The browser keeps the session token in sessionStorage, not localStorage. Signup and login are rate-limited by source IP.

The Worker setting VM_BASELINE_ID currently defaults to admin in cloudflare/wrangler.toml. The code accepts that baseline; it does not currently enforce that admin is sanitized. **Before public use, make sure the Admin snapshot contains no private data, or configure and verify a separate clean baseline.** A successful signup only proves that snapshot data was copied; it does not start a server-side Linux VM.

The browser VM restores and runs TinyCore using v86 in the browser, then saves that account's snapshot to R2. Guest execution stops when the browser session stops.

## Legacy API-token provisioning path

POST /v1/accounts creates an account using a shared bearer token and copies the baseline snapshot synchronously. GET /v1/accounts/{account_id} reads that account's metadata with its account API key. The API token is read from the private R2 object config/vm-api-token.txt.

The legacy path defaults to the same VM_BASELINE_ID setting (currently admin). It does not start a container or execute Linux commands. It returns metadata indicating that headless VM execution is not wired.

## Snapshot format

The manifest contains version, generation, chunks, byteLength, and savedAt. Snapshot chunks are 8 MiB each. The chunk count must equal the ceiling of byteLength divided by 8 MiB. The snapshot must be compatible with the v86 build and options used by the browser VM.

The Worker stores snapshots under vm-snapshots/{identity}/. Account snapshot endpoints check that the identity matches the authenticated account or authorized Admin. Never expose another account's snapshot identity or API key.

## What this does not provide

- It does not run TinyCore inside Cloudflare Workers.
- It does not make the Oracle host shell an isolated per-account shell.
- It does not prove guest DNS or Internet connectivity.
- It does not provide a persistent guest process after the browser closes.

Account-level Oracle host execution remains disabled until per-account OS/container isolation and end-to-end identity validation are implemented and tested.
