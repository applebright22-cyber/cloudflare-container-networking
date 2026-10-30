import test from "node:test";
import assert from "node:assert/strict";
import { handleProjectStorageRequest } from "../src/project-storage.ts";

const token = "a".repeat(64);
const accountA = "acct-11111111-1111-4111-8111-111111111111";
const accountB = "acct-22222222-2222-4222-8222-222222222222";
function memoryEnv(validToken = true) {
  const values = new Map();
  const bucket = {
    async list({ prefix }) {
      const objects = [...values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, body]) => ({ key, size: new TextEncoder().encode(body).byteLength }));
      return { objects, truncated: false };
    },
    async get(key) {
      const body = values.get(key);
      return body === undefined ? null : { async json() { return JSON.parse(body); } };
    },
    async head(key) {
      const body = values.get(key);
      return body === undefined ? null : { size: new TextEncoder().encode(body).byteLength };
    },
    async put(key, body) { values.set(key, String(body)); },
    async delete(key) { values.delete(key); },
  };
  const namespace = {
    idFromName(name) { return name; },
    get() { return { async fetch(_url, init) {
      const parsed = JSON.parse(init.body);
      return new Response(null, { status: validToken && parsed.token === token ? 200 : 401 });
    } }; },
  };
  return { env: { PROJECT_STORAGE: bucket, ACCOUNT_REGISTRY: namespace }, values };
}
function request(method, path = "", body, accountId = accountA, authToken = token) {
  return new Request("https://worker.test/api/studio/projects" + path + "?account_id=" + accountId, {
    method,
    headers: { authorization: "Bearer " + authToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
async function call(env, req) {
  const response = await handleProjectStorageRequest(req, env);
  assert.ok(response, "project route should handle this URL");
  return { response, data: await response.json() };
}
test("requires a valid account session before touching project storage", async () => {
  const { env, values } = memoryEnv(false);
  const { response, data } = await call(env, request("GET", "", undefined, accountA));
  assert.equal(response.status, 401);
  assert.equal(data.error, "unauthorized");
  assert.equal(values.size, 0);
});
test("saves, lists, updates, and deletes a project document", async () => {
  const { env, values } = memoryEnv();
  const project = { id: "site-001", name: "My site", kind: "website", pages: [] };
  let result = await call(env, request("PUT", "/site-001", project));
  assert.equal(result.response.status, 200);
  assert.equal(result.data.project_id, "site-001");
  result = await call(env, request("GET"));
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.projects, [project]);
  assert.equal(result.data.usage.projects, 1);
  const updated = { ...project, name: "Updated site" };
  await call(env, request("PUT", "/site-001", updated));
  result = await call(env, request("GET"));
  assert.deepEqual(result.data.projects, [updated]);
  result = await call(env, request("DELETE", "/site-001"));
  assert.equal(result.data.deleted, "site-001");
  assert.equal(values.size, 0);
});
test("isolates project documents between customer accounts", async () => {
  const { env } = memoryEnv();
  await call(env, request("PUT", "/shared-id", { id: "shared-id", name: "A", kind: "website" }, accountA));
  await call(env, request("PUT", "/shared-id", { id: "shared-id", name: "B", kind: "website" }, accountB));
  const a = await call(env, request("GET", "", undefined, accountA));
  const b = await call(env, request("GET", "", undefined, accountB));
  assert.equal(a.data.projects[0].name, "A");
  assert.equal(b.data.projects[0].name, "B");
});
test("rejects malformed project documents and invalid JSON", async () => {
  const { env } = memoryEnv();
  let result = await call(env, request("PUT", "/bad-id", "{"));
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "invalid_project_json");
  result = await call(env, request("PUT", "/bad-id", { id: "different", name: "Bad", kind: "website" }));
  assert.equal(result.response.status, 400);
  assert.equal(result.data.error, "invalid_project_document");
});
test("enforces the 50-project account quota", async () => {
  const { env } = memoryEnv();
  for (let i = 0; i < 50; i++) {
    const id = "project-" + String(i).padStart(3, "0");
    const result = await call(env, request("PUT", "/" + id, { id, name: "Project " + i, kind: "website" }));
    assert.equal(result.response.status, 200);
  }
  const result = await call(env, request("PUT", "/project-overflow", { id: "project-overflow", name: "Overflow", kind: "website" }));
  assert.equal(result.response.status, 409);
  assert.equal(result.data.error, "project_limit_reached");
});
test("enforces the 1 MiB per-project document limit", async () => {
  const { env } = memoryEnv();
  const body = { id: "too-large", name: "Large", kind: "website", payload: "x".repeat(1024 * 1024) };
  const result = await call(env, request("PUT", "/too-large", body));
  assert.equal(result.response.status, 413);
  assert.equal(result.data.error, "project_too_large");
});
