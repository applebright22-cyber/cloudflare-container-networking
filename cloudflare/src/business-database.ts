import { DurableObject } from "cloudflare:workers";
import { InventoryLedger } from "./inventory-ledger";

export interface BusinessDatabaseEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  BUSINESS_DATABASE: DurableObjectNamespace<BusinessDatabase>;
  INVENTORY_LEDGER: DurableObjectNamespace<InventoryLedger>;
  PROJECT_STORAGE: R2Bucket;
  STOCKROOM_ORIGIN?: string;
  STOCKROOM_GATEWAY_TOKEN?: string;
}
type ProductStatus = "active" | "draft" | "archived";
interface ProductInput {
  sku?: unknown; name?: unknown; description?: unknown; category?: unknown;
  image_url?: unknown; price?: unknown; cost?: unknown; quantity?: unknown;
  status?: unknown; variations?: unknown; external_url?: unknown;
}
interface ProductRow {
  id: string; sku: string; name: string; description: string; category: string;
  image_url: string; price_cents: number; cost_cents: number; quantity: number;
  status: ProductStatus; variations_json: string; external_url: string;
  created_at: string; updated_at: string;
}
const ACCOUNT_ID = /^acct-[a-f0-9-]{36}$/;
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function cents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100000000) return null;
  return Math.round(parsed * 100);
}
function safeUrl(value: unknown): string {
  const raw = text(value, 2048);
  if (!raw) return "";
  if (/^\/api\/media\/acct-[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(?:jpg|png|webp|gif)$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch { return ""; }
}
function mapProduct(row: ProductRow) {
  let variations: unknown[] = [];
  try { const parsed = JSON.parse(row.variations_json); if (Array.isArray(parsed)) variations = parsed; } catch {}
  return {
    id: row.id, sku: row.sku, name: row.name, description: row.description,
    category: row.category, image_url: row.image_url,
    price: row.price_cents / 100, cost: row.cost_cents / 100,
    quantity: row.quantity, status: row.status, variations,
    external_url: row.external_url, created_at: row.created_at, updated_at: row.updated_at,
  };
}

/** One SQLite-backed Durable Object per business account. */
export class BusinessDatabase extends DurableObject {
  private ensureSchema(): void {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS business_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, sku TEXT NOT NULL COLLATE NOCASE UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', image_url TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL DEFAULT 0, cost_cents INTEGER NOT NULL DEFAULT 0, quantity INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','draft','archived')), variations_json TEXT NOT NULL DEFAULT '[]', external_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS inventory_movements (id TEXT PRIMARY KEY, product_id TEXT NOT NULL, quantity_delta INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS inventory_consumptions (checkout_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS business_orders (order_id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, applied_at TEXT NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS products_status_updated ON products(status, updated_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS inventory_product_created ON inventory_movements(product_id, created_at)");
    sql.exec("INSERT OR IGNORE INTO business_meta(key, value) VALUES('schema_version', '1')");
    sql.exec("INSERT OR IGNORE INTO business_meta(key, value) VALUES('initialized_at', ?)", new Date().toISOString());
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);
    if (url.pathname === "/initialize" && request.method === "POST") {
      const meta = this.ctx.storage.sql.exec("SELECT key, value FROM business_meta").toArray() as Array<{key:string;value:string}>;
      const count = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM products").toArray()[0] as {count:number};
      return json({ ok: true, database: "ready", engine: "cloudflare-durable-object-sqlite", schema_version: 1,
        initialized_at: meta.find(x => x.key === "initialized_at")?.value ?? null,
        product_count: Number(count?.count ?? 0) });
    }
    if (url.pathname === "/purge" && request.method === "POST") {
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS inventory_consumptions");
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS inventory_movements");
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS products");
      this.ctx.storage.sql.exec("DROP TABLE IF EXISTS business_meta");
      return json({ ok: true, database_cleared: true });
    }
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, database: "ready", schema_version: 1 });
    }
    if (url.pathname === "/public-products" && request.method === "GET") {
      const rows = this.ctx.storage.sql.exec(
        "SELECT id,sku,name,description,category,image_url,price_cents,quantity,variations_json,external_url FROM products WHERE status='active' ORDER BY name LIMIT 250",
      ).toArray() as Array<{id:string;sku:string;name:string;description:string;category:string;image_url:string;price_cents:number;quantity:number;variations_json:string;external_url:string}>;
      return json({ ok: true, products: rows.map(row => {
        let variations: unknown[] = [];
        try { const parsed = JSON.parse(row.variations_json); if (Array.isArray(parsed)) variations = parsed; } catch {}
        return { id: row.id, sku: row.sku, name: row.name, description: row.description, category: row.category,
          image_url: row.image_url, price: row.price_cents / 100, in_stock: row.quantity > 0,
          variations, external_url: row.external_url };
      }) });
    }
    if (url.pathname === "/consume" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { checkout_id?: unknown; items?: unknown } | null;
      const checkoutId = typeof body?.checkout_id === "string" ? body.checkout_id : "";
      if (!/^[a-f0-9-]{36}$/.test(checkoutId) || !Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 20) {
        return json({ error: "invalid_inventory_consumption" }, 400);
      }
      const prior = this.ctx.storage.sql.exec("SELECT checkout_id FROM inventory_consumptions WHERE checkout_id=?", checkoutId).toArray()[0];
      if (prior) return json({ ok: true, already_consumed: true });
      const requested = new Map<string, number>();
      for (const item of body.items) {
        if (!item || typeof item !== "object") return json({ error: "invalid_inventory_item" }, 400);
        const value = item as { product_id?: unknown; quantity?: unknown };
        if (typeof value.product_id !== "string" || !/^[a-f0-9-]{36}$/.test(value.product_id) ||
            !Number.isInteger(value.quantity) || Number(value.quantity) < 1 || Number(value.quantity) > 99) {
          return json({ error: "invalid_inventory_item" }, 400);
        }
        requested.set(value.product_id, (requested.get(value.product_id) ?? 0) + Number(value.quantity));
      }
      const checked: Array<{id:string;quantity:number;delta:number}> = [];
      for (const [productId, quantity] of requested) {
        const row = this.ctx.storage.sql.exec("SELECT id,quantity FROM products WHERE id=? AND status='active'", productId).toArray()[0] as {id:string;quantity:number} | undefined;
        if (!row || Number(row.quantity) < quantity) return json({ error: "insufficient_stock", product_id: productId }, 409);
        checked.push({ id: row.id, quantity: Number(row.quantity), delta: quantity });
      }
      const now = new Date().toISOString();
      for (const item of checked) {
        this.ctx.storage.sql.exec("UPDATE products SET quantity=?,updated_at=? WHERE id=?", item.quantity - item.delta, now, item.id);
        this.recordMovement(item.id, -item.delta, "paid checkout " + checkoutId);
      }
      this.ctx.storage.sql.exec("INSERT INTO inventory_consumptions(checkout_id,created_at) VALUES(?,?)", checkoutId, now);
      return json({ ok: true, consumed: checked.length });
    }
    if (url.pathname === "/apply-orders" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { orders?: unknown } | null;
      if (!Array.isArray(body?.orders) || body.orders.length > 250) return json({ error: "invalid_order_batch" }, 400);
      const applied: string[] = [];
      const sql = this.ctx.storage.sql;
      try {
        this.ctx.storage.transactionSync(() => {
        for (const raw of body.orders) {
          if (!raw || typeof raw !== "object") throw new Error("invalid_order");
          const order = raw as { order_id?: unknown; items?: unknown };
          const orderId = typeof order.order_id === "string" ? order.order_id : "";
          if (!/^[a-f0-9-]{36}$/.test(orderId) || !Array.isArray(order.items) || order.items.length < 1 || order.items.length > 20) throw new Error("invalid_order");
          if (sql.exec("SELECT order_id FROM business_orders WHERE order_id=?", orderId).toArray().length) { applied.push(orderId); continue; }
          const requested = new Map<string, number>();
          for (const item of order.items) {
            if (!item || typeof item !== "object") throw new Error("invalid_order_item");
            const value = item as { product_id?: unknown; quantity?: unknown };
            if (typeof value.product_id !== "string" || !/^[a-f0-9-]{36}$/.test(value.product_id) || !Number.isInteger(value.quantity) || Number(value.quantity) < 1 || Number(value.quantity) > 99) throw new Error("invalid_order_item");
            requested.set(value.product_id, (requested.get(value.product_id) ?? 0) + Number(value.quantity));
          }
          const checked: Array<{ id: string; quantity: number }> = [];
          for (const [productId, quantity] of requested) {
            const row = sql.exec("SELECT quantity FROM products WHERE id=?", productId).toArray()[0] as { quantity: number } | undefined;
            if (!row || Number(row.quantity) < quantity) throw new Error("local_inventory_conflict:" + productId);
            checked.push({ id: productId, quantity });
          }
          for (const item of checked) {
            sql.exec("UPDATE products SET quantity=quantity-?,updated_at=? WHERE id=?", item.quantity, now, item.id);
            this.recordMovement(item.id, -item.quantity, "synced paid order " + orderId);
          }
          sql.exec("INSERT INTO business_orders(order_id,payload_json,applied_at) VALUES(?,?,?)", orderId, JSON.stringify(raw), now);
          applied.push(orderId);
        }
        });
      } catch (error) {
        const message = String(error);
        if (message === "invalid_order" || message === "invalid_order_item") return json({ error: message }, 400);
        if (message.startsWith("local_inventory_conflict:")) return json({ error: "local_inventory_conflict", product_id: message.split(":")[1] }, 409);
        throw error;
      }
      return json({ ok: true, applied_order_ids: applied });
    }
    if (url.pathname === "/products" && request.method === "GET") {
      const query = text(url.searchParams.get("q"), 100);
      const status = text(url.searchParams.get("status"), 16);
      const rows = query
        ? this.ctx.storage.sql.exec("SELECT * FROM products WHERE status != 'archived' AND (name LIKE ? OR sku LIKE ? OR category LIKE ?) ORDER BY updated_at DESC LIMIT 250", "%" + query + "%", "%" + query + "%", "%" + query + "%").toArray()
        : this.ctx.storage.sql.exec("SELECT * FROM products WHERE (? = '' OR status = ?) ORDER BY updated_at DESC LIMIT 250", status, status).toArray();
      const summary = this.ctx.storage.sql.exec("SELECT COUNT(*) AS product_count, COALESCE(SUM(quantity),0) AS units, SUM(CASE WHEN quantity <= 5 AND status = 'active' THEN 1 ELSE 0 END) AS low_stock FROM products WHERE status != 'archived'").toArray()[0] as {product_count:number;units:number;low_stock:number};
      return json({ ok: true, products: (rows as ProductRow[]).map(mapProduct), summary: {
        product_count: Number(summary?.product_count ?? 0), units: Number(summary?.units ?? 0), low_stock: Number(summary?.low_stock ?? 0),
      }});
    }
    if (url.pathname === "/products" && request.method === "POST") {
      const body = await request.json().catch(() => null) as ProductInput | null;
      const parsed = this.validateProduct(body);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      const now = new Date().toISOString(), id = crypto.randomUUID();
      try {
        this.ctx.storage.sql.exec("INSERT INTO products(id,sku,name,description,category,image_url,price_cents,cost_cents,quantity,status,variations_json,external_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id, parsed.sku, parsed.name, parsed.description, parsed.category, parsed.image_url, parsed.price_cents, parsed.cost_cents, parsed.quantity, parsed.status, parsed.variations_json, parsed.external_url, now, now);
      } catch (error) {
        if (String(error).toLowerCase().includes("unique")) return json({ error: "sku_already_exists" }, 409);
        throw error;
      }
      const row = this.ctx.storage.sql.exec("SELECT * FROM products WHERE id = ?", id).toArray()[0] as ProductRow;
      if (parsed.quantity !== 0) this.recordMovement(id, parsed.quantity, "initial stock");
      return json({ ok: true, product: mapProduct(row) }, 201);
    }
    const match = url.pathname.match(/^\/products\/([a-f0-9-]{36})$/);
    if (match && request.method === "PUT") {
      const body = await request.json().catch(() => null) as ProductInput | null;
      const parsed = this.validateProduct(body);
      if ("error" in parsed) return json({ error: parsed.error }, 400);
      const current = this.ctx.storage.sql.exec("SELECT * FROM products WHERE id = ?", match[1]).toArray()[0] as ProductRow | undefined;
      if (!current) return json({ error: "product_not_found" }, 404);
      try {
        this.ctx.storage.sql.exec("UPDATE products SET sku=?,name=?,description=?,category=?,image_url=?,price_cents=?,cost_cents=?,quantity=?,status=?,variations_json=?,external_url=?,updated_at=? WHERE id=?",
          parsed.sku, parsed.name, parsed.description, parsed.category, parsed.image_url, parsed.price_cents, parsed.cost_cents, parsed.quantity, parsed.status, parsed.variations_json, parsed.external_url, new Date().toISOString(), match[1]);
      } catch (error) {
        if (String(error).toLowerCase().includes("unique")) return json({ error: "sku_already_exists" }, 409);
        throw error;
      }
      if (parsed.quantity !== current.quantity) this.recordMovement(match[1], parsed.quantity - current.quantity, "stock adjustment");
      const updated = this.ctx.storage.sql.exec("SELECT * FROM products WHERE id = ?", match[1]).toArray()[0] as ProductRow;
      return json({ ok: true, product: mapProduct(updated) });
    }
    if (match && request.method === "DELETE") {
      const existing = this.ctx.storage.sql.exec("SELECT id FROM products WHERE id = ?", match[1]).toArray()[0];
      if (!existing) return json({ error: "product_not_found" }, 404);
      this.ctx.storage.sql.exec("UPDATE products SET status='archived', updated_at=? WHERE id=?", new Date().toISOString(), match[1]);
      return json({ ok: true, archived: match[1] });
    }
    if (url.pathname === "/movements" && request.method === "GET") {
      const rows = this.ctx.storage.sql.exec("SELECT m.id,m.product_id,p.name,p.sku,m.quantity_delta,m.reason,m.created_at FROM inventory_movements m LEFT JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC LIMIT 100").toArray();
      return json({ ok: true, movements: rows });
    }
    return json({ error: "not_found" }, 404);
  }

  private validateProduct(body: ProductInput | null) {
    if (!body || typeof body !== "object") return { error: "invalid_product" } as const;
    const sku = text(body.sku, 64).toUpperCase(), name = text(body.name, 120);
    const price_cents = cents(body.price), cost_cents = cents(body.cost), quantity = Number(body.quantity);
    const status: ProductStatus = body.status === "draft" || body.status === "archived" ? body.status : "active";
    const variations = Array.isArray(body.variations) ? body.variations.slice(0, 100) : [];
    if (!sku || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(sku) || !name || price_cents === null || cost_cents === null ||
        !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000000000) return { error: "invalid_product_fields" } as const;
    const safeVariations = variations.map(v => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const item = v as Record<string, unknown>, variationPrice = cents(item.price);
      return { name: text(item.name, 80), sku: text(item.sku, 64).toUpperCase(), price: variationPrice === null ? null : variationPrice / 100 };
    }).filter(Boolean);
    return {
      sku, name, description: text(body.description, 2000), category: text(body.category, 80),
      image_url: safeUrl(body.image_url), price_cents, cost_cents, quantity, status,
      variations_json: JSON.stringify(safeVariations), external_url: safeUrl(body.external_url),
    };
  }
  private recordMovement(productId: string, delta: number, reason: string): void {
    this.ctx.storage.sql.exec("INSERT INTO inventory_movements(id,product_id,quantity_delta,reason,created_at) VALUES(?,?,?,?,?)",
      crypto.randomUUID(), productId, delta, reason, new Date().toISOString());
  }
}


/** Convert an incoming Request to the subset accepted by the Request constructor. */
function stockroomRequestInit(init?: RequestInit | Request): RequestInit | undefined {
  if (!(init instanceof Request)) return init;
  return { method: init.method, headers: init.headers, body: init.body };
}

/** Route Stockroom operations to persistent TinyCore SQLite when configured; otherwise retain the DO backend. */
export async function businessDatabaseFetch(env: BusinessDatabaseEnv, accountId: string, path: string, init?: RequestInit | Request): Promise<Response> {
  if (env.STOCKROOM_ORIGIN && env.STOCKROOM_GATEWAY_TOKEN) {
    let origin: URL;
    try { origin = new URL(env.STOCKROOM_ORIGIN); } catch { return json({ error: "stockroom_origin_invalid" }, 503); }
    if (origin.protocol !== "https:") return json({ error: "stockroom_origin_must_use_https" }, 503);
    const target = new URL("/v1/" + (path.startsWith("/") ? path.slice(1) : path), origin);
    const outgoing = init instanceof Request ? new Request(target, stockroomRequestInit(init)) : new Request(target, init);
    outgoing.headers.delete("authorization");
    outgoing.headers.set("x-stockroom-gateway-token", env.STOCKROOM_GATEWAY_TOKEN);
    outgoing.headers.set("x-stockroom-account-id", accountId);
    try { return await fetch(outgoing); } catch { return json({ error: "tinycore_stockroom_unavailable" }, 503); }
  }
  const database = env.BUSINESS_DATABASE.get(env.BUSINESS_DATABASE.idFromName(accountId));
  const internalUrl = "https://business-database.internal/" + (path.startsWith("/") ? path.slice(1) : path);
  return database.fetch(new Request(internalUrl, stockroomRequestInit(init)));
}

/** Authenticates account requests before routing to that account's private SQL database. */
export async function handleBusinessDatabaseRequest(request: Request, env: BusinessDatabaseEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const publicMatch = url.pathname.match(/^\/api\/stockroom\/public\/([a-f0-9]{32})$/);
  if (publicMatch) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const mappingObject = await env.PROJECT_STORAGE.get("published-sites/index/" + publicMatch[1] + ".json");
    if (!mappingObject) return json({ error: "site_not_found" }, 404);
    const mapping = await mappingObject.json<{ account_id?: unknown }>().catch(() => null);
    const accountId = typeof mapping?.account_id === "string" ? mapping.account_id : "";
    if (!ACCOUNT_ID.test(accountId)) return json({ error: "site_not_found" }, 404);
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(accountId));
    let catalogResponse = await ledger.fetch("https://inventory-ledger.internal/catalog");
    let catalog = await catalogResponse.json() as { products?: Array<{id:string;sku:string;name:string;description:string;category:string;image_url:string;variations:unknown[];external_url:string;price:number;in_stock:boolean}> };
    if (!catalogResponse.ok) return json({ error: "store_catalog_unavailable" }, 503);
    return json({ ok: true, products: (catalog.products ?? []).map(p => ({
      id:p.id, sku:p.sku, name:p.name, description:p.description, category:p.category,
      image_url:p.image_url, price:p.price, in_stock:p.in_stock, variations:p.variations, external_url:p.external_url,
    })) });
  }
  const mediaMatch = url.pathname.match(/^\/api\/media\/(acct-[a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\.(jpg|png|webp|gif)$/);
  if (mediaMatch) {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const [, accountId, productId, imageId, extension] = mediaMatch;
    const key = "merchants/" + accountId + "/products/" + productId + "/" + imageId + "." + extension;
    const object = await env.PROJECT_STORAGE.get(key);
    if (!object) return json({ error: "media_not_found" }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("cache-control", "public, max-age=31536000, immutable");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  }
  const uploadMatch = url.pathname.match(/^\/api\/stockroom\/media\/([a-f0-9-]{36})$/);
  if (uploadMatch) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const accountId = url.searchParams.get("account_id") ?? "";
    const token = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7) : "";
    if (!ACCOUNT_ID.test(accountId) || !/^[a-f0-9]{64}$/.test(token)) return json({ error: "unauthorized" }, 401);
    const auth = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
    const verified = await auth.fetch("https://account-registry.internal/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId, token }),
    });
    if (!verified.ok) return json({ error: "unauthorized" }, 401);
    const form = await request.formData().catch(() => null);
    const file = form?.get("image");
    if (!(file instanceof File) || file.size < 1 || file.size > 5 * 1024 * 1024) return json({ error: "image_must_be_under_5mb" }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
    let extension = "", contentType = "";
    if (starts(0xff, 0xd8, 0xff)) { extension = "jpg"; contentType = "image/jpeg"; }
    else if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) { extension = "png"; contentType = "image/png"; }
    else if (starts(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") { extension = "webp"; contentType = "image/webp"; }
    else if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) { extension = "gif"; contentType = "image/gif"; }
    if (!extension || file.type !== contentType) return json({ error: "unsupported_or_mismatched_image_type" }, 415);
    const productId = uploadMatch[1], imageId = crypto.randomUUID();
    const prefix = "merchants/" + accountId + "/products/" + productId + "/";
    const key = prefix + imageId + "." + extension;
    await env.PROJECT_STORAGE.put(key, bytes, {
      httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" },
      customMetadata: { account_id: accountId, product_id: productId, image_id: imageId },
    });
    // The new reference is attached to the product in the following authenticated PUT; retain older media until that update succeeds.
    return json({ ok: true, image_url: "/api/media/" + accountId + "/" + productId + "/" + imageId + "." + extension });
  }
  if (!url.pathname.startsWith("/api/stockroom/")) return null;
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
  const accountId = url.searchParams.get("account_id") ?? "";
  const token = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7) : "";
  if (!ACCOUNT_ID.test(accountId) || !/^[a-f0-9]{64}$/.test(token)) return json({ error: "unauthorized" }, 401);
  const auth = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const verified = await auth.fetch("https://account-registry.internal/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId, token }),
  });
  if (!verified.ok) return json({ error: "unauthorized" }, 401);
  url.searchParams.delete("account_id");
  const internalPath = url.pathname.replace(/^\/api\/stockroom/, "") || "/";
  if (internalPath === "/sync/orders" && request.method === "POST") {
    return synchronizePendingOrders(env, accountId);
  }
  if (internalPath === "/offline-allowance" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(accountId));
    return ledger.fetch("https://inventory-ledger.internal/offline/allocate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
  }
  if (internalPath === "/offline-sales" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(accountId));
    return ledger.fetch("https://inventory-ledger.internal/offline/consume", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
    });
  }
  const response = await businessDatabaseFetch(env, accountId, internalPath + (url.search ? url.search : ""), request);
  const shouldSync = response.ok && (
    (internalPath === "/initialize" && request.method === "POST") ||
    (internalPath === "/products" && ["POST", "PUT"].includes(request.method)) ||
    (/^\/products\/[a-f0-9-]{36}$/.test(internalPath) && request.method === "DELETE")
  );
  if (shouldSync) {
    // Apply pending paid orders before accepting a newer local quantity snapshot.
    // Otherwise a stale offline edit could overwrite central sales deductions.
    const orders = await synchronizePendingOrders(env, accountId);
    if (orders.ok) {
      try { await syncInventoryCatalog(env, accountId); } catch { /* Keep the central catalog unchanged until sync succeeds. */ }
    }
  }
  return response;
}

async function synchronizePendingOrders(env: BusinessDatabaseEnv, accountId: string): Promise<Response> {
  const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(accountId));
  const pendingResponse = await ledger.fetch("https://inventory-ledger.internal/orders");
  if (!pendingResponse.ok) return json({ error: "order_queue_unavailable" }, 503);
  const pending = await pendingResponse.json() as { orders?: Array<{ order_id: string }> };
  const orders = pending.orders ?? [];
  if (!orders.length) return json({ ok: true, synchronized: 0, pending: 0 });
  const applied = await businessDatabaseFetch(env, accountId, "apply-orders", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orders }),
  });
  if (!applied.ok) return json({ error: "local_order_sync_failed", detail: await applied.text().catch(() => "") }, applied.status);
  const result = await applied.json() as { applied_order_ids?: string[] };
  const orderIds = result.applied_order_ids ?? [];
  const ack = await ledger.fetch("https://inventory-ledger.internal/orders/ack", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order_ids: orderIds }),
  });
  if (!ack.ok) return json({ error: "order_acknowledgement_failed", synchronized: orderIds.length }, 503);
  return json({ ok: true, synchronized: orderIds.length, pending: Math.max(0, orders.length - orderIds.length) });
}

/** Publish a versioned catalog snapshot to the always-online inventory authority. */
export async function syncInventoryCatalog(env: BusinessDatabaseEnv, accountId: string): Promise<void> {
  const response = await businessDatabaseFetch(env, accountId, "products");
  if (!response.ok) throw new Error("stockroom_catalog_unavailable");
  const data = await response.json() as { products?: Array<{id:string;sku:string;name:string;description?:string;category?:string;image_url?:string;variations?:unknown[];external_url?:string;price:number;quantity:number;status:string;updated_at:string}> };
  const products = (data.products ?? []).map(p => ({
    id: p.id, sku: p.sku, name: p.name, description: p.description, category: p.category,
    image_url: p.image_url, variations_json: JSON.stringify(p.variations ?? []), external_url: p.external_url,
    price_cents: Math.round(Number(p.price) * 100), quantity: Number(p.quantity), status: p.status, updated_at: p.updated_at,
  }));
  const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(accountId));
  const synced = await ledger.fetch("https://inventory-ledger.internal/catalog/sync", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ products }),
  });
  if (!synced.ok) throw new Error("inventory_catalog_sync_failed");
}
