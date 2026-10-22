# TinyCore VM and Oracle Executor

This repository contains the Cloudflare side of the project: account login, browser-based TinyCore VM sessions, snapshot storage, and guest networking.

## How the pieces fit together

- **Cloudflare Worker** (cloudflare/src/index.ts) provides the account API, session validation, snapshot endpoints, VM-agent endpoints, and WISP relay.
- **Browser VM** (public/vm.html) runs v86 in the user's browser. It restores and saves the user's VM state in Cloudflare R2. Guest execution depends on the browser VM being open.
- **Oracle executor** lives in the separate [racle-vm-executor repository](https://github.com/applebright22-cyber/racle-vm-executor). It maintains an outbound connection to Cloudflare and runs persistent commands on the Oracle Linux host. It is **not** a shell inside TinyCore, a mirror of guest RAM, or the guest's network bridge.

## Current behavior

- Account signup clones the configured baseline snapshot into an account-specific R2 namespace.
- Login and session validation are handled by the Worker.
- The browser VM restores and saves snapshot chunks through the Worker.
- The Oracle agent supports the existing Admin execution path when connected.
- The WISP relay is a separate guest-networking path; it is not provided by the Oracle host-shell executor.

## Known limitations

- **TinyCore guest execution is browser-based.** A browserless/server-side v86 Linux runtime is not implemented. Closing the browser stops guest execution.
- **Oracle account-shell execution is disabled by default.** The Worker requires ORACLE_ACCOUNT_EXEC_ENABLED=true, but this must not be enabled until real per-account OS/container isolation and identity validation are implemented and tested. Separate directories alone are not isolation.
- **Guest DNS has been intermittent in testing.** A successful snapshot restore or an online Oracle agent does not prove guest DNS or Internet connectivity works.
- The older /tunnel and /v1/nodes routes are a separate TCP-tunnel/node prototype. They are not the browser VM's snapshot or Oracle execution path.

## Development checks

From cloudflare/:

~~~sh
npm install
npm run test:headless
npm run check
~~~

npm run check runs the build and Wrangler dry-run check; it does not deploy the Worker.

From the repository root, run the browser/session regression tests with:

~~~sh
node --test tests/*.test.mjs
~~~

For the separate Oracle executor, see its README for installation, health checks, and tests.

## Important

Do not treat a green build, successful signup, snapshot restore, connected Oracle agent, or TCP-tunnel smoke test as proof that the full user VM workflow works. Validate the browser VM, guest DNS/HTTPS, snapshot persistence, and Oracle connection independently. No automatic deployment is required for these checks.
