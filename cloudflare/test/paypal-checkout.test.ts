import test from "node:test";
import assert from "node:assert/strict";
import { handlePayments } from "../src/payments.ts";

const account = "acct-11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);
const siteId = "11111111111141118111111111111111";
const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function memoryEnv() {
  const values = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const raw = values.get(key);
      return raw === undefined ? null : { async json() { return JSON.parse(raw); } };
    },
    async head(key: string) {
      return values.has(key) ? { size: values.get(key)!.length } : null;
    },
    async put(key: string, body: string) { values.set(key, String(body)); },
    async delete(key: string) { values.delete(key); },
  };
  const accountNamespace = {
    idFromName(name: string) { return name; },
    get() {
      return { async fetch(_url: string, init: RequestInit) {
        const body = JSON.parse(String(init.body));
        return new Response(null, { status: body.account_id === account && body.token === token ? 200 : 401 });
      } };
    },
  };
  let commits = 0;
  const inventoryNamespace = {
    idFromName(name: string) { return name; },
    get(name: string) {
      return { async fetch(url: string, init?: RequestInit) {
        if (name !== account) return Response.json({ error: "unknown_inventory" }, { status: 404 });
        const path = new URL(url).pathname;
        if (path === "/catalog") return Response.json({ products: [
          { id: productId, name: "Vampirequid test hoodie", price: 29.99, quantity: 4 },
        ] });
        if (path === "/reserve") return Response.json({
          amount_cents: 5998,
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          items: [{ product_id: productId, name: "Vampirequid test hoodie", quantity: 2, unit_amount_usd: "29.99" }],
        });
        if (path === "/commit") {
          commits += 1;
          return Response.json({ ok: true, order_id: "inventory-order-123" });
        }
        if (path === "/release") return Response.json({ ok: true });
        return Response.json({ error: "not_found" }, { status: 404 });
      } };
    },
  };
  values.set("published-sites/index/" + siteId + ".json", JSON.stringify({ account_id: account, project_id: "store-project" }));
  const env = {
    ACCOUNT_REGISTRY: accountNamespace,
    INVENTORY_LEDGER: inventoryNamespace,
    PROJECT_STORAGE: bucket,
    PAYMENTS_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  };
  return { env, values, commitCount: () => commits };
}

function request(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}) {
  const headers = new Headers();
  if (options.auth !== false) headers.set("authorization", "Bearer " + token);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request("https://worker.test" + path, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function call(env: any, req: Request) {
  const response = await handlePayments(req, env);
  assert.ok(response, "payment route should handle this URL");
  return { response, data: await response.json() };
}

test("PayPal merchant connection, buyer checkout, capture and inventory commit use the pinned environment", async (t) => {
  const originalFetch = globalThis.fetch;
  let orderCreates = 0;
  let captureCalls = 0;
  let captureHost = "";
  const oauthClients: string[] = [];
  let createRequestId = "";
  let captureRequestId = "";
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) {
      const authorization = new Headers(init?.headers).get("authorization") || "";
      const client = atob(authorization.replace(/^Basic\s+/i, "")).split(":")[0];
      oauthClients.push(client);
      return Response.json({ access_token: "paypal-test-access-token" });
    }
    if (url.endsWith("/v2/checkout/orders")) {
      orderCreates += 1;
      createRequestId = new Headers(init?.headers).get("PayPal-Request-Id") || "";
      return Response.json({ id: "PAYPAL-ORDER-123", status: "CREATED" });
    }
    if (url.endsWith("/v2/checkout/orders/PAYPAL-ORDER-123/capture")) {
      captureCalls += 1;
      captureHost = url;
      captureRequestId = new Headers(init?.headers).get("PayPal-Request-Id") || "";
      return Response.json({
        id: "PAYPAL-ORDER-123",
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [{
          id: "PAYPAL-CAPTURE-123",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "59.98" },
        }] } }],
      });
    }
    throw new Error("Unexpected PayPal request: " + url);
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const { env, commitCount } = memoryEnv();
  const accountQuery = "?account_id=" + account;

  let result = await call(env, request("/api/payments/paypal/connect" + accountQuery, {
    method: "PUT",
    body: { client_id: "sandbox-client-id", client_secret: "sandbox-client-secret", mode: "sandbox" },
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.connected, true);
  assert.equal(result.data.mode, "sandbox");

  result = await call(env, request("/api/payments/paypal/test" + accountQuery, {
    method: "POST", body: { mode: "sandbox" },
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.verified, true);
  assert.equal(result.data.mode, "sandbox");
  assert.match(result.data.message, /No payment was taken/);

  result = await call(env, request("/api/payments/paypal/status" + accountQuery + "&mode=sandbox"));
  assert.equal(result.data.connected, true);
  assert.equal(result.data.available_modes.sandbox, true);

  result = await call(env, request("/api/payments/public/checkout/" + siteId, {
    method: "POST",
    body: { items: [{ product_id: productId, quantity: 2 }] },
  }));
  assert.equal(result.response.status, 201);
  const checkoutId = result.data.checkout.id;
  assert.equal(result.data.checkout.paypal_mode, "sandbox");
  assert.equal(result.data.checkout.amount_usd, "59.98");

  result = await call(env, request("/api/payments/checkout/" + checkoutId + "/paypal/create-order", { method: "POST", body: {} }));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.order_id, "PAYPAL-ORDER-123");
  assert.equal(orderCreates, 1);
  assert.equal(createRequestId, checkoutId);

  const repeatedOrder = await call(env, request("/api/payments/checkout/" + checkoutId + "/paypal/create-order", { method: "POST", body: {} }));
  assert.equal(repeatedOrder.data.reused, true);
  assert.equal(orderCreates, 1);

  result = await call(env, request("/api/payments/paypal/connect" + accountQuery, {
    method: "PUT",
    body: { client_id: "live-client-id", client_secret: "live-client-secret", mode: "live" },
  }));
  assert.equal(result.response.status, 200);
  await call(env, request("/api/payments/paypal/connect" + accountQuery, { method: "POST", body: { mode: "live" } }));

  result = await call(env, request("/api/payments/checkout/" + checkoutId + "/paypal/capture", {
    method: "POST", body: { order_id: "PAYPAL-ORDER-123" },
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.status, "paid");
  assert.equal(result.data.inventory_status, "queued_for_tinycore_sync");
  assert.equal(result.data.order_id, "inventory-order-123");
  assert.equal(captureCalls, 1);
  assert.equal(captureRequestId, checkoutId + "-capture");
  assert.equal(oauthClients.at(-1), "sandbox-client-id");
  assert.match(captureHost, /api-m\.sandbox\.paypal\.com/);
  const savedCheckout = await call(env, request("/api/payments/checkout/" + checkoutId));
  assert.equal(savedCheckout.response.status, 200);
  assert.equal(savedCheckout.data.checkout.paypal_mode, "sandbox");
  assert.equal(savedCheckout.data.checkout.status, "paid");

  const duplicateCapture = await call(env, request("/api/payments/checkout/" + checkoutId + "/paypal/capture", {
    method: "POST", body: { order_id: "PAYPAL-ORDER-123" },
  }));
  assert.equal(duplicateCapture.data.status, "paid");
  assert.equal(captureCalls, 1);
  assert.equal(commitCount(), 1);
});
