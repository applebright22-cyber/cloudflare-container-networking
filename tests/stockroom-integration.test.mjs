import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const database = read("cloudflare/src/business-database.ts");
const worker = read("cloudflare/src/index.ts");
const payments = read("cloudflare/src/payments.ts");
const studioHtml = read("public/studio.html");
const studioJs = read("public/studio.js");
const vmPage = read("public/vm.html");
const storefront = read("public/stockroom-storefront.js");
const workerConfig = read("cloudflare/wrangler.toml");
const rootConfig = read("wrangler.toml");

test("Stockroom replaces the former Cockpit navigation and view", () => {
  assert.match(studioHtml, /data-view="stockroom"/);
  assert.match(studioHtml, /id="view-stockroom"/);
  assert.doesNotMatch(studioHtml + studioJs, /cockpit/i);
  assert.match(studioJs, /function renderStockroom/);
  assert.match(studioJs, /stockroom-product-form/);
});

test("each business gets a persistent SQLite database with product and inventory tables", () => {
  assert.match(database, /class BusinessDatabase extends DurableObject/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS products/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS inventory_movements/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS inventory_consumptions/);
  assert.match(database, /COLLATE NOCASE UNIQUE/);
  assert.match(database, /price_cents/);
  assert.match(database, /variations_json/);
  assert.match(worker, /BUSINESS_DATABASE\.idFromName\(accountId\)/);
  assert.match(workerConfig, /name = "BUSINESS_DATABASE"/);
  assert.match(rootConfig, /name = "BUSINESS_DATABASE"/);
});

test("signup and TinyCore startup initialize the business database idempotently", () => {
  assert.match(worker, /Provision the account's isolated SQLite business database during signup/);
  assert.match(worker, /businessDatabase\.fetch\("https:\/\/business-database\.internal\/initialize"/);
  assert.match(vmPage, /async function initializeBusinessDatabase/);
  assert.match(vmPage, /void initializeBusinessDatabase\(\)/);
  assert.match(studioJs, /stockroomUrl\("\\/initialize"\)/);
});

test("Stockroom API authenticates private account requests and isolates public catalog fields", () => {
  assert.match(database, /auth\/verify/);
  assert.match(database, /BUSINESS_DATABASE\.idFromName\(accountId\)/);
  assert.match(database, /\/api\/stockroom\/public/);
  assert.match(database, /\/public-products/);
  assert.match(database, /price: row\.price_cents \/ 100/);
  assert.doesNotMatch(database.slice(database.indexOf('if (url.pathname === "/public-products"'), database.indexOf('if (url.pathname === "/products" && request.method === "GET")')), /cost_cents/);
});

test("published stores load Stockroom products and checkout validates and consumes inventory", () => {
  assert.match(studioJs, /stockroom-storefront\.js/);
  assert.match(storefront, /\/api\/stockroom\/public\//);
  assert.match(payments, /BUSINESS_DATABASE: DurableObjectNamespace/);
  assert.match(payments, /products\?status=active/);
  assert.match(payments, /insufficient_stock/);
  assert.match(payments, /consumeInventory\(env, page\)/);
  assert.match(database, /paid checkout/);
});

test("account deletion purges the business database", () => {
  assert.match(worker, /businessDatabasePurge/);
  assert.match(database, /DROP TABLE IF EXISTS products/);
});
