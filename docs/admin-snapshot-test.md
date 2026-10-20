# VM snapshot test sheet

Print this page or keep it for the first snapshot test.

## Accounts
- **Admin** — snapshot key: `admin` — requires the five-digit admin code — marker: `ADMIN-TEST`
- **Regular User A** — snapshot key: `regular-user-a` — no code — marker: `USER-A-TEST`
- **Regular User B** — snapshot key: `regular-user-b` — no code — marker: `USER-B-TEST`

## Test steps
1. Open the VM and select **Admin**. Enter the five-digit admin code.
2. Wait for startup and network preflight to finish and for the snapshot save status to appear.
3. Add `ADMIN-TEST` inside the VM and click **Save VM state**.
4. Close the page, clear browser site data, reopen the page, sign in as **Admin**, and confirm the marker is restored.
5. Repeat for **Regular User A** using marker `USER-A-TEST`; no code should be requested.
6. Repeat for **Regular User B** using marker `USER-B-TEST`; no code should be requested.
7. Switch between all three accounts. Each account must restore only its own marker; no account should restore another account's marker.

## Record
- Date: ____________________
- Admin snapshot restored after browser data clear: Pass / Fail
- Regular User A snapshot restored after browser data clear: Pass / Fail
- Regular User B snapshot restored after browser data clear: Pass / Fail
- All three snapshots remain separate: Pass / Fail
- Save occurs only after startup finishes: Pass / Fail

**One-time setup before deployment:** Create the R2 bucket with `npx wrangler r2 bucket create cloudflare-container-vm-snapshots` (skip this if it already exists). Snapshot files live in Cloudflare R2, not browser storage. Regular-user accounts are fixed identifiers, not secure authentication; don't store private data under them.