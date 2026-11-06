import test from "node:test";
import assert from "node:assert/strict";
import { handleMarketplaceRequest } from "../src/marketplace-directory.ts";

const account = "acct-11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);
const siteNear = "11111111111141118111111111111111";
const siteFar = "22222222222242228222222222222222";
const projectNear = "orlando-store";

function memoryEnv() {
  const values = new Map<string, string>();
  const bucket = {
    async get(key: string) {
      const raw = values.get(key);
      return raw === undefined ? null : { async json() { return JSON.parse(raw); } };
    },
    async put(key: string, body: string) { values.set(key, String(body)); },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  };
  const authNamespace = {
    idFromName(name: string) { return name; },
    get() {
      return { async fetch(_url: string, init: RequestInit) {
        const body = JSON.parse(String(init.body));
        return new Response(null, { status: body.account_id === account && body.token === token ? 200 : 401 });
      } };
    },
  };
  const ledgerNamespace = {
    idFromName(name: string) { return name; },
    get(name: string) {
      return { async fetch() {
        if (name !== account) return Response.json({ products: [] });
        return Response.json({ products: [
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sku: "HOOD-01", name: "Orlando hoodie", description: "Soft cotton hoodie", category: "Clothing", price: 34.5, quantity: 3, in_stock: true, variations: [{ name: "Large", color: "Black" }] },
          { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sku: "TEE-00", name: "Out of stock tee", description: "", category: "Clothing", price: 18, quantity: 0, in_stock: false, variations: [] },
        ] });
      } };
    },
  };
  const env = { PROJECT_STORAGE: bucket, ACCOUNT_REGISTRY: authNamespace, INVENTORY_LEDGER: ledgerNamespace };
  values.set("accounts/" + account + "/projects/" + projectNear + ".json", JSON.stringify({
    id: projectNear, name: "Orlando Threads", kind: "Store", publishSlug: siteNear,
  }));
  values.set("published-sites/index/" + siteNear + ".json", JSON.stringify({ account_id: account, project_id: projectNear }));
  values.set("marketplace/merchants/" + account + ".json", JSON.stringify({
    account_id: account, project_id: projectNear, site_id: siteNear, store_name: "Orlando Threads",
    street_address: "100 Main Street", city: "Orlando", state: "FL", latitude: 28.5383, longitude: -81.3792, active: true,
  }));
  const farAccount = "acct-22222222-2222-4222-8222-222222222222";
  values.set("marketplace/merchants/" + farAccount + ".json", JSON.stringify({
    account_id: account, project_id: "far-store", site_id: siteFar, store_name: "Far Shop",
    street_address: "20 miles away", city: "Orlando", state: "FL", latitude: 28.5383, longitude: -81.02, active: true,
  }));
  values.set("published-sites/index/" + siteFar + ".json", JSON.stringify({ account_id: account, project_id: "far-store" }));
  return { env, values };
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
  const response = await handleMarketplaceRequest(req, env);
  assert.ok(response, "marketplace route should handle this path");
  return { response, data: await response.json() };
}

test("public marketplace search returns live in-stock products within ten miles", async () => {
  const { env } = memoryEnv();
  const { response, data } = await call(env, request("/api/marketplace/products?lat=28.5383&lng=-81.3792"));
  assert.equal(response.status, 200);
  assert.equal(data.radius_miles, 10);
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].site_id, siteNear);
  assert.equal(data.products[0].name, "Orlando hoodie");
  assert.equal(data.products[0].quantity, 3);
  assert.equal(data.products[0].store.name, "Orlando Threads");
  assert.equal("street_address" in data.products[0].store, false);
});

test("marketplace search filters products by text and category", async () => {
  const { env } = memoryEnv();
  const { data } = await call(env, request("/api/marketplace/products?lat=28.5383&lng=-81.3792&q=hoodie&category=Clothing"));
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].sku, "HOOD-01");
  const none = await call(env, request("/api/marketplace/products?lat=28.5383&lng=-81.3792&q=denim"));
  assert.equal(none.data.products.length, 0);
});

test("marketplace search requires explicit valid customer coordinates", async () => {
  const { env } = memoryEnv();
  let result = await call(env, request("/api/marketplace/products"));
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "valid_location_required");
  result = await call(env, request("/api/marketplace/products?lat=100&lng=-81"));
  assert.equal(result.response.status, 400);
});

test("merchant marketplace profile requires an authenticated account session", async () => {
  const { env } = memoryEnv();
  const result = await call(env, request("/api/marketplace/profile?account_id=" + account, { auth: false }));
  assert.equal(result.response.status, 401);
  assert.equal(result.data.error, "unauthorized");
});

test("merchant can list only a published Store project owned by that account", async () => {
  const { env } = memoryEnv();
  const result = await call(env, request("/api/marketplace/profile?account_id=" + account, {
    method: "PUT",
    body: {
      project_id: projectNear,
      street_address: "100 Main Street",
      city: "Orlando",
      state: "FL",
      postal_code: "32801",
      latitude: 28.5383,
      longitude: -81.3792,
      active: true,
    },
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.profile.site_id, siteNear);
  assert.equal(result.data.profile.store_name, "Orlando Threads");
  const invalid = await call(env, request("/api/marketplace/profile?account_id=" + account, {
    method: "PUT",
    body: {
      project_id: "not-published",
      street_address: "100 Main Street",
      city: "Orlando",
      state: "FL",
      postal_code: "32801",
      latitude: 28.5383,
      longitude: -81.3792,
    },
  }));
  assert.equal(invalid.response.status, 409);
  assert.equal(invalid.data.error, "published_store_not_found");
});
