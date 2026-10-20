#!/usr/bin/env node
/**
 * Create a browser-test account through the public signup API.
 *
 * Required: TEST_PASSWORD
 * Optional: API_BASE_URL (defaults to the current workers.dev API),
 *           TEST_USERNAME (otherwise a unique test username is generated).
 *
 * This script never prints the password or session token.
 */
const baseUrl = (process.env.API_BASE_URL ||
  "https://cloudflare-container-networking.brightlambre22-6dd.workers.dev").replace(/\/$/, "");
const password = process.env.TEST_PASSWORD || "";
const username = (process.env.TEST_USERNAME ||
  `test-${Date.now().toString(36)}`).trim().toLowerCase();

if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username)) {
  console.error("TEST_USERNAME must be 2-32 characters: lowercase letters, digits, _ or -.");
  process.exit(2);
}
if (password.length < 4 || password.length > 128) {
  console.error("Set TEST_PASSWORD to a value between 4 and 128 characters.");
  process.exit(2);
}

const endpoint = `${baseUrl}/api/auth/signup`;
let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30_000),
  });
} catch (error) {
  console.error(`Signup request failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const raw = await response.text();
let result;
try { result = JSON.parse(raw); }
catch {
  console.error(`API returned non-JSON (HTTP ${response.status}): ${raw.slice(0, 500)}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`Signup failed (HTTP ${response.status}):`);
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log("Test user created via API.");
console.log(`API: ${endpoint}`);
console.log(`Username: ${result.username || username}`);
console.log(`Account ID: ${result.account_id || "(not returned)"}`);
console.log(`Status: ${result.status || "unknown"}`);
if (result.expires_at) console.log(`Signup session expires: ${result.expires_at}`);
if (result.snapshot_identity) console.log(`Snapshot identity: ${result.snapshot_identity}`);
if (result.snapshot_initialization_required === true) {
  console.warn("NOTE: signup says snapshot initialization is still required.");
  console.warn("This confirms account creation, not that a VM snapshot has been saved.");
}
console.log("");
console.log("Use the username and the TEST_PASSWORD value to sign in through the browser.");
console.log("For a meaningful one-hour persistence test, confirm the account's snapshot initialization/save step has completed first.");
