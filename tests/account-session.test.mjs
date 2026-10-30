import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(new URL("../cloudflare/src/account-registry.ts", import.meta.url), "utf8");
const provisioner = readFileSync(new URL("../cloudflare/src/account-provisioner.ts", import.meta.url), "utf8");
const wispRelay = readFileSync(new URL("../cloudflare/src/wisp-relay.ts", import.meta.url), "utf8");
const virtualNetwork = readFileSync(new URL("../cloudflare/src/virtual-network.ts", import.meta.url), "utf8");
const headlessRoundtrip = readFileSync(new URL("../cloudflare/src/headless-v86-snapshot-roundtrip-worker.ts", import.meta.url), "utf8");
const headlessRoundtripConfig = readFileSync(new URL("../cloudflare/wrangler.headless-v86-roundtrip.toml", import.meta.url), "utf8");
const worker = readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");

test("signup stores server-side PBKDF2 credentials and enforces unique usernames", () => {
  assert.match(registry, /PBKDF2/);
  assert.match(registry, /iterations: 100000/);
  assert.match(registry, /auth-user:/);
  assert.match(registry, /username_unavailable/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/signup"/);
  assert.match(worker, /url\.pathname === "\/api\/auth\/login"/);
  assert.doesNotMatch(dashboard, /vm-test-accounts-v1|function readAccounts\(\)/);
  assert.match(worker, /password\.length < 4/);
  assert.match(registry, /password\.length < 4/);
  assert.match(dashboard, /if\(creating&&pass\.length<4\)/);
  assert.match(worker, /virtual_network_allocation_failed/);
  assert.ok(worker.includes("/network/allocate"));
  assert.ok(worker.includes("virtual_ip: allocation.virtual_ip"));
  assert.match(worker, /snapshot_cloned: false/);
  assert.doesNotMatch(worker.slice(worker.indexOf('if (url.pathname === "\/api\/auth\/signup"'), worker.indexOf('if (url.pathname === "\/api\/auth\/login"')), /snapshot_initialization_required: true/);
  assert.match(dashboard, /snapshot_initialization_required===true/);
});

test("sessions expire and are bound to the account ID for every snapshot operation", () => {
  assert.match(registry, /auth-session:/);
  assert.match(registry, /session\.account_id !== body\.account_id/);
  assert.match(registry, /session\.expires_at <= Date\.now\(\)/);
  assert.match(worker, /auth\/verify/);
  assert.match(worker, /accountAuthorized/);
  assert.match(dashboard, /headers\.authorization='Bearer '\+window\.snapshotAuthToken/);
});

test("signup allocates a persistent virtual IP and queues cloning from a ready Admin baseline", () => {
  assert.match(worker, /const baselineId = env\.VM_BASELINE_ID \?\? "admin"/);
  assert.match(provisioner, /admin_baseline_not_ready/);
  const signup = worker.slice(worker.indexOf('if (url.pathname === "\/api\/auth\/signup"'), worker.indexOf('if (url.pathname === "\/api\/auth\/login"'));
  assert.match(signup, /baseline_id: baselineId/);
  assert.match(signup, /snapshot_cloned: false/);
  assert.match(signup, /status: "provisioning"/);
  assert.match(signup, /ACCOUNT_PROVISIONER/);
  assert.doesNotMatch(signup, /headlessV86Roundtrip|snapshot_initialization_required: true/);
  assert.match(registry, /network-allocation:/);
  assert.match(registry, /network-next-host/);
  assert.match(registry, /virtual_ipv4_pool_exhausted/);
  assert.match(dashboard, /vm-initial-snapshot-pending/);
  assert.match(dashboard, /snapshotNeedsInitialSave/);
  assert.match(dashboard, /window\.snapshotNeedsInitialSave=false/);
});

test("missing or unreadable account snapshots fail closed instead of booting a fresh account VM", () => {
  assert.match(dashboard, /No saved VM snapshot exists for this account; refusing to boot a fresh VM over missing user data/);
  assert.match(dashboard, /snapshotLoadFailed=true/);
  assert.match(dashboard, /Snapshot load failed; refusing to overwrite server state/);
  assert.match(dashboard, /Restore failed; no fresh bootstrap started/);
  assert.match(dashboard, /Account snapshot restore failed; stopped without starting a fresh VM/);
});

test("public auth routes are rate-limited and browser credentials are not persisted in localStorage", () => {
  assert.match(registry, /auth-rate:/);
  assert.match(registry, /body\.action === "signup" \? 500 : 2000/);
  assert.match(worker, /auth\/rate-limit/);
  assert.match(dashboard, /sessionStorage\.setItem\('vm-session-token'/);
  assert.doesNotMatch(dashboard, /localStorage\.setItem\(ACCOUNTS_KEY/);
  assert.match(dashboard, /mysterium-network-test-results:\x27\+\(window\.snapshotIdentity\|\|\x27admin\x27\)/);
});

test("restored VMs prove shell responsiveness without running extra network diagnostics", () => {
  assert.doesNotMatch(dashboard, /runDiagnostic\(/, "restore must not execute unsolicited diagnostic commands");
  assert.doesNotMatch(dashboard, /AUTOMATIC NETWORK TEST AFTER SNAPSHOT RESTORE/);
  assert.match(dashboard, /verifyRestoredGuestShell/);
  assert.match(dashboard, /snapshotLoadFailed=true/);
});test("account network identity feeds a stable synthetic DHCP lease through the authenticated Cloudflare WISP relay", () => {
  assert.ok(virtualNetwork.includes("first_allocatable_ordinal: 1"));
  assert.ok(virtualNetwork.includes("last_allocatable_ordinal: 64767"));
  assert.ok(virtualNetwork.includes("virtualIpForOrdinal"));
  assert.ok(virtualNetwork.includes("virtualGatewayForIp"));
  assert.ok(registry.includes("/network/allocate"));
  assert.ok(registry.includes("storage.transaction"));
  assert.ok(registry.includes("networkIdentityMatch"));
  assert.ok(worker.includes("WISP_RELAY"));
  assert.ok(worker.includes("/api/network/ticket"));
  assert.ok(worker.includes("/api/network/wisp"));
  assert.ok(worker.includes("virtual_ip: identity.virtual_ip"));
  assert.ok(wispRelay.includes("active-ticket"));
  assert.ok(wispRelay.includes("record.ticket !== ticket"));
  assert.ok(wispRelay.includes("connect({ hostname: host, port })"));
  assert.ok(wispRelay.includes("port !== 80 && port !== 443"));
  assert.ok(wispRelay.includes("INITIAL_BUFFER"));
  assert.ok(dashboard.includes("vm_ip:virtualIp"));
  assert.ok(dashboard.includes("router_ip:routerIp"));
  assert.ok(dashboard.includes("/api/network/ticket"));
  assert.ok(headlessRoundtrip.includes("vm_ip: virtualIp"));
  assert.ok(headlessRoundtrip.includes("router_ip: routerIp"));
  assert.ok(headlessRoundtrip.includes("/api/network/wisp/"));
  assert.ok(!headlessRoundtrip.includes("relay.widgetry.org"));
  assert.ok(headlessRoundtripConfig.includes("name = \"WISP_RELAY\""));
});
