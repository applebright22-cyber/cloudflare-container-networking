import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const index = fs.readFileSync(new URL("../cloudflare/src/index.ts", import.meta.url), "utf8");
const coordinator = fs.readFileSync(new URL("../cloudflare/src/vm-execution.ts", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("../public/vm.html", import.meta.url), "utf8");

test("authenticated account execution validates the session before forwarding its account ID", () => {
  const routeAt = index.indexOf('if (url.pathname === "/api/account/exec")');
  assert.notEqual(routeAt, -1);
  const route = index.slice(routeAt, routeAt + 3000);
  assert.ok(route.includes('env.ORACLE_ACCOUNT_EXEC_ENABLED !== "true"'), "regular-account shell access must fail closed until isolation is enabled");
  assert.ok(route.includes('/auth/verify'), "session token must be verified");
  assert.ok(route.includes('"x-account-id": accountId'), "authenticated account ID must reach the coordinator");
  assert.ok(route.includes('idFromName("oracle")'), "account commands must use the persistent Oracle transport");
});

test("account execution capability is authenticated and does not execute commands", () => {
  const routeAt = index.indexOf('if (url.pathname === "/api/account/exec/status")');
  assert.notEqual(routeAt, -1);
  const route = index.slice(routeAt, routeAt + 1800);
  assert.ok(route.includes('/auth/verify'), "capability probe validates the account session");
  assert.ok(route.includes('env.ORACLE_ACCOUNT_EXEC_ENABLED === "true"'), "feature availability comes from the explicit deployment gate");
  assert.ok(!route.includes('coordinator.fetch'), "capability probe must not execute a shell command");
});

test("Oracle coordinator includes account_id in each execution message", () => {
  assert.ok(coordinator.includes('request.headers.get("x-account-id")'));
  assert.ok(coordinator.includes('account_id: accountId'));
  assert.ok(coordinator.includes("vm_id: pending.accountId"), "result must report the selected account session, not the shared transport identity");
});

test("the existing terminal surface routes regular-account commands to Oracle without adding another panel", () => {
  assert.ok(dashboard.includes('id="screen_container"'), "the existing TinyCore guest remains available for the relay");
  assert.ok(dashboard.includes('id="myst-log"'), "the existing terminal output surface is reused");
  assert.ok(dashboard.includes("function activateOracleTerminal()"), "the existing terminal surface can explicitly switch to Oracle");
  assert.ok(dashboard.includes("fetch('/api/account/exec/status'"), "Oracle availability is checked using the authenticated account session");
  assert.ok(dashboard.includes("function checkAccountExecution()"), "regular-account Oracle availability is selected from server capability status");
  assert.ok(dashboard.includes("oracleExecutionAvailable=true;"), "the Oracle terminal is offered only when the server reports it enabled");
  assert.ok(dashboard.includes("toggle.hidden=false;"), "the Oracle terminal control appears only when Oracle is available");
  assert.ok(dashboard.includes("function deactivateOracleTerminal()"), "the user can return to the Tiny Core shell");
  assert.ok(dashboard.includes("document.getElementById('oracle-terminal-toggle').addEventListener('click'"), "Oracle mode requires an explicit user click");
  assert.ok(!dashboard.includes("if(response.ok&&data.status==='online'){\n        activateOracleTerminal();"), "an online Oracle agent must not automatically replace the Tiny Core shell");
  assert.ok(!dashboard.includes("if(data.enabled===true){\n      activateOracleTerminal();"), "an enabled account must not automatically replace the Tiny Core shell");
  assert.ok(dashboard.includes(":'/api/account/exec'"), "regular terminal commands use the authenticated Cloudflare endpoint");
  assert.ok(dashboard.includes("const endpoint=isAdmin?'/api/admin/oracle-exec':'/api/account/exec'"), "admin terminal commands use the existing admin Oracle endpoint");
  assert.ok(dashboard.includes("headers['x-admin-code']=window.snapshotAdminCode"), "admin commands use the validated admin code");
  assert.ok(dashboard.includes("window.snapshotIdentity==='admin'&&Boolean(window.snapshotAdminCode)"), "admin terminal switches only with admin credentials");
  assert.ok(dashboard.includes("session_token:window.snapshotAuthToken"), "the account session token accompanies each command");
  assert.ok(dashboard.includes("document.body.classList.add('oracle-terminal-mode')"), "regular account mode hides guest-shell input");
  assert.ok(dashboard.includes("if(oracleTerminalMode)return;"), "TinyCore screen mirroring does not overwrite Oracle output");
  assert.ok(!dashboard.includes("oracle-terminal-panel"), "do not add a second terminal UI");
});
test("long snapshot round-trip workflow is manual-only during Oracle integration", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/headless-v86-snapshot-roundtrip.yml", import.meta.url), "utf8");
  const triggers = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("\njobs:"));
  assert.ok(triggers.includes("workflow_dispatch:"));
  assert.ok(!triggers.includes("\n  push:"));
  assert.ok(!triggers.includes("\n  pull_request:"));
});

test("TinyCore startup checks Oracle bridge health without adding another terminal", () => {
  assert.ok(index.includes('url.pathname === "/api/vm/oracle-status"'), "Cloudflare exposes a read-only Oracle connection status");
  assert.ok(index.includes('idFromName("oracle")'), "status check targets the existing Oracle coordinator");
  assert.ok(dashboard.includes("function checkOracleBridge()"), "dashboard polls bridge health");
  assert.ok(dashboard.includes("startOracleBridgeStatus();"), "bridge check starts on fresh and restored VM startup");
  assert.ok(dashboard.includes('id="oracle-bridge-status"'), "connection state is visible in the existing dashboard");
});

test("Oracle coordinator registers pending work before sending and leaves delivery margin", () => {
  const registerAt = coordinator.indexOf("this.pending.set(id, {");
  const sendAt = coordinator.indexOf("socket.send(JSON.stringify({ type: \"exec\"");
  assert.notEqual(registerAt, -1);
  assert.notEqual(sendAt, -1);
  assert.ok(registerAt < sendAt, "fast Oracle responses must have a registered pending request");
  assert.ok(coordinator.includes("}, timeout + 5000);"), "coordinator leaves time for Oracle to return a timeout result");
});
