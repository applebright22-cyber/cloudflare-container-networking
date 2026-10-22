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

test("Oracle coordinator includes account_id in each execution message", () => {
  assert.ok(coordinator.includes('request.headers.get("x-account-id")'));
  assert.ok(coordinator.includes('account_id: accountId'));
});

test("dashboard has a terminal that sends commands through the Oracle API", () => {
  assert.ok(dashboard.includes('id="oracle-command"'));
  assert.ok(dashboard.includes("'/api/admin/oracle-exec'"));
  assert.ok(dashboard.includes("'/api/account/exec'"));
});
