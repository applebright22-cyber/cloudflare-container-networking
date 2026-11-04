import { DurableObject } from "cloudflare:workers";

export interface BusinessDatabaseEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  BUSINESS_DATABASE: DurableObjectNamespace<BusinessDatabase>;
  PROJECT_STORAGE: R2Bucket;
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
    const database = env.BUSINESS_DATABASE.get(env.BUSINESS_DATABASE.idFromName(accountId));
    return database.fetch("https://business-database.internal/public-products");
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
  const internalUrl = "https://business-database.internal" + internalPath + (url.search ? url.search : "");
  const database = env.BUSINESS_DATABASE.get(env.BUSINESS_DATABASE.idFromName(accountId));
  return database.fetch(new Request(internalUrl, request));
}
