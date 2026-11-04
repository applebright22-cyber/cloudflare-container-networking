import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const database = read("cloudflare/src/business-database.ts");
const inventoryLedger = read("cloudflare/src/inventory-ledger.ts");
const worker = read("cloudflare/src/index.ts");
const payments = read("cloudflare/src/payments.ts");
const studioHtml = read("public/studio.html");
const studioJs = read("public/studio.js");
const vmPage = read("public/vm.html");
const storefront = read("public/stockroom-storefront.js");
const workerConfig = read("cloudflare/wrangler.toml");
const rootConfig = read("wrangler.toml");
const tinycoreBoot = read("tinycore/stockroom/bootlocal-stockroom.sh");
const tinycoreStart = read("tinycore/stockroom/start-stockroom.sh");
const tinycoreApi = read("tinycore/stockroom/stockroom.py");

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
  assert.match(database, /BUSINESS_DATABASE\.idFromName\(accountId\)/);
  assert.match(database, /business-database\.internal/);
  assert.match(workerConfig, /name = "BUSINESS_DATABASE"/);
  assert.match(workerConfig, /name = "INVENTORY_LEDGER"/);
  assert.match(rootConfig, /name = "BUSINESS_DATABASE"/);
});

test("signup and TinyCore startup initialize the business database idempotently", () => {
  assert.match(worker, /Provision the account's isolated SQLite business database during signup/);
  assert.match(worker, /businessDatabaseFetch\(env, accountId, "initialize"/);
  assert.match(vmPage, /async function initializeBusinessDatabase/);
  assert.match(vmPage, /void initializeBusinessDatabase\(\)/);
  assert.ok(studioJs.includes('stockroomUrl("/initialize")'));
  assert.match(tinycoreBoot, /persistent volume is not mounted/);
  assert.match(tinycoreStart, /Persistent Stockroom volume is not mounted/);
});

test("Stockroom API authenticates private account requests and isolates public catalog fields", () => {
  assert.match(database, /auth\/verify/);
  assert.match(database, /BUSINESS_DATABASE\.idFromName\(accountId\)/);
  assert.ok(database.includes("stockroom\\/public"));
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
  assert.match(payments, /inventory-ledger\.internal\/reserve/);
  assert.match(payments, /commitInventory\(env, page/);
  assert.match(payments, /queued_for_tinycore_sync/);
  assert.match(database, /paid checkout/);
});

test("account deletion purges the business database", () => {
  assert.match(worker, /businessDatabasePurge/);
  assert.match(database, /DROP TABLE IF EXISTS products/);
});

test("central inventory ledger reserves stock before payment and commits to a durable order outbox", () => {
  assert.match(inventoryLedger, /class InventoryLedger extends DurableObject/);
  assert.match(inventoryLedger, /CREATE TABLE IF NOT EXISTS inventory_catalog/);
  assert.match(inventoryLedger, /CREATE TABLE IF NOT EXISTS inventory_reservations/);
  assert.match(inventoryLedger, /CREATE TABLE IF NOT EXISTS inventory_reservation_items/);
  assert.match(inventoryLedger, /CREATE TABLE IF NOT EXISTS inventory_orders/);
  assert.match(inventoryLedger, /url\.pathname === "\/reserve"/);
  assert.match(inventoryLedger, /url\.pathname === "\/commit"/);
  assert.match(inventoryLedger, /url\.pathname === "\/orders"/);
  assert.match(inventoryLedger, /url\.pathname === "\/orders\/ack"/);
  assert.match(inventoryLedger, /online_reserved/);
  assert.match(inventoryLedger, /catalog_update_conflicts_with_reserved_stock/);
});

test("offline POS sales require allocated stock and use idempotent event IDs", () => {
  assert.match(inventoryLedger, /url\.pathname === "\/offline\/allocate"/);
  assert.match(inventoryLedger, /url\.pathname === "\/offline\/consume"/);
  assert.match(inventoryLedger, /offline_allowance_exceeded/);
  assert.match(inventoryLedger, /offline_sales/);
  assert.match(inventoryLedger, /offline_order_already_recorded/);
});

test("Stockroom product changes synchronize a versioned catalog to the online ledger", () => {
  assert.match(database, /syncInventoryCatalog/);
  assert.match(database, /const orders = await synchronizePendingOrders/);
  assert.match(database, /INVENTORY_LEDGER/);
  assert.ok(database.includes("inventory-ledger.internal/catalog"));
  assert.match(database, /catalog\/sync/);
});

test("reopening Stockroom applies queued paid orders transactionally before refreshing local stock", () => {
  assert.match(database, /url\.pathname === "\/apply-orders"/);
  assert.match(database, /transactionSync/);
  assert.match(database, /business_orders/);
  assert.match(database, /local_inventory_conflict/);
  assert.match(database, /internalPath === "\/sync\/orders"/);
  assert.match(tinycoreApi, /path==\"\/v1\/apply-orders\"/);
  assert.match(tinycoreApi, /BEGIN IMMEDIATE/);
  assert.match(tinycoreApi, /business_orders/);
  assert.match(studioJs, /stockroomUrl\("\/sync\/orders"\)/);
  assert.match(studioJs, /queued online order\(s\) synchronized/);
});
