import { businessDatabaseFetch } from "./business-database";
import { InventoryLedger } from "./inventory-ledger";
export interface PaymentEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  PROJECT_STORAGE: R2Bucket;
  BUSINESS_DATABASE: DurableObjectNamespace;
  INVENTORY_LEDGER: DurableObjectNamespace<InventoryLedger>;
  STOCKROOM_ORIGIN?: string;
  STOCKROOM_GATEWAY_TOKEN?: string;
  PAYMENTS_ENCRYPTION_KEY?: string;
}
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const accountOk = (id: string) => /^acct-[a-f0-9-]{36}$/.test(id);
const addressOk = (value: unknown): value is string => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
const keyFor = (account: string, suffix: string) => `accounts/${account}/payments/${suffix}.json`;

async function authenticate(request: Request, env: PaymentEnv, accountId: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!accountOk(accountId) || !token) return false;
  const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const response = await registry.fetch("https://account-registry.internal/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId, token }),
  });
  return response.ok;
}
async function commitInventory(env: PaymentEnv, checkout: { id: string; account_id: string }, paymentReference: string, paymentMethod: string): Promise<{ ok: boolean; order_id?: string }> {
  try {
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(checkout.account_id));
    const response = await ledger.fetch("https://inventory-ledger.internal/commit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkout_id: checkout.id, payment_reference: paymentReference, payment_method: paymentMethod }),
    });
    const result = await response.json() as { order_id?: string };
    return { ok: response.ok, order_id: result.order_id };
  } catch {
    return { ok: false };
  }
}
async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key); if (!obj) return null;
  try { return await obj.json<T>(); } catch { return null; }
}
function validPayPalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try { const u = new URL(value); return u.protocol === "https:" && (u.hostname === "paypal.me" || u.hostname.endsWith(".paypal.com") || u.hostname === "www.paypal.com"); } catch { return false; }
}
export async function handlePayments(request: Request, env: PaymentEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const publicStoreMatch = url.pathname.match(/^\/api\/payments\/public\/checkout\/([a-f0-9]{32})$/);
  if (publicStoreMatch) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const siteId = publicStoreMatch[1];
    const mapping = await readJson<{ account_id?: string; project_id?: string }>(env.PROJECT_STORAGE, "published-sites/index/" + siteId + ".json");
    if (!mapping?.account_id || !accountOk(mapping.account_id)) return json({ error: "site_not_found" }, 404);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(mapping.account_id, "settings"));
    const credentials = await getPaypalCredentials(env, mapping.account_id);
    if (!settings?.paypal_enabled || !credentials) return json({ error: "merchant_paypal_not_configured" }, 409);
    const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(mapping.account_id));
    let catalogResponse = await ledger.fetch("https://inventory-ledger.internal/catalog");
    let catalogData = await catalogResponse.json() as { products?: Array<{ id: string; name: string; price: number; quantity: number }> };
    let catalog = new Map<string, { name: string; price: number; quantity: number }>();
    const loadCatalog = () => {
      catalog = new Map();
      for (const product of catalogData.products ?? []) {
        if (typeof product.id === "string" && Number.isFinite(product.price) && product.price > 0) {
          catalog.set(product.id, { name: product.name, price: product.price, quantity: Number(product.quantity) || 0 });
        }
      }
    };
    loadCatalog();
    // First-time catalog bootstrap requires TinyCore to be online. Once synced,
    // checkout reads only from this always-available ledger.
    if (!catalog.size) {
      const source = await businessDatabaseFetch(env, mapping.account_id, "products?status=active");
      if (source.ok) {
        const local = await source.json() as { products?: Array<{id:string;sku:string;name:string;price:number;quantity:number;status:string;updated_at:string}> };
        const products = (local.products ?? []).map(p => ({ id:p.id,sku:p.sku,name:p.name,price_cents:Math.round(Number(p.price)*100),quantity:Number(p.quantity),status:p.status,updated_at:p.updated_at }));
        await ledger.fetch("https://inventory-ledger.internal/catalog/sync", { method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({products}) });
        catalogResponse = await ledger.fetch("https://inventory-ledger.internal/catalog");
        catalogData = await catalogResponse.json() as { products?: Array<{ id: string; name: string; price: number; quantity: number }> };
        loadCatalog();
      }
    }
    if (!catalogResponse.ok) return json({ error: "inventory_service_unavailable" }, 503);
    if (!catalog.size) return json({ error: "store_catalog_empty_or_tinycore_offline" }, 409);
    const body = await request.json().catch(() => null) as { items?: unknown } | null;
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 20) return json({ error: "invalid_cart" }, 400);
    const quantities = new Map<string, number>();
    for (const item of body.items) {
      if (!item || typeof item !== "object") return json({ error: "invalid_cart_item" }, 400);
      const productId = (item as { product_id?: unknown }).product_id;
      const quantity = (item as { quantity?: unknown }).quantity;
      if (typeof productId !== "string" || !catalog.has(productId) || !Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 99) return json({ error: "invalid_cart_item" }, 400);
      const requested = (quantities.get(productId) ?? 0) + Number(quantity);
      if (requested > catalog.get(productId)!.quantity) return json({ error: "insufficient_stock", product_id: productId }, 409);
      quantities.set(productId, requested);
    }
    let amount = 0;
    const lineItems = Array.from(quantities, ([product_id, quantity]) => {
      const product = catalog.get(product_id)!;
      amount += product.price * quantity;
      return { product_id, name: product.name, quantity, unit_amount_usd: product.price.toFixed(2) };
    });
    amount = Math.round(amount * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999) return json({ error: "cart_total_invalid" }, 400);
    const id = crypto.randomUUID();
    const reservedResponse = await ledger.fetch("https://inventory-ledger.internal/reserve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkout_id: id, items: Array.from(quantities, ([product_id, quantity]) => ({ product_id, quantity })), ttl_seconds: 1800 }),
    });
    const reserved = await reservedResponse.json() as { amount_cents?: number; expires_at?: string; items?: Array<{product_id:string;name:string;quantity:number;unit_amount_usd:string}> };
    if (!reservedResponse.ok || !Array.isArray(reserved.items) || !Number.isSafeInteger(reserved.amount_cents)) return json({ error: "inventory_reservation_failed", detail: (reserved as any).error ?? "reservation_unavailable" }, 409);
    amount = Number(reserved.amount_cents) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999) {
      await ledger.fetch("https://inventory-ledger.internal/release", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({checkout_id:id})});
      return json({error:"cart_total_invalid"},400);
    }
    const reservedLineItems = reserved.items.map(x => ({ product_id:x.product_id,name:x.name,quantity:x.quantity,unit_amount_usd:x.unit_amount_usd }));
    const record = { id, account_id: mapping.account_id, site_id: siteId, amount_usd: amount.toFixed(2), description: reservedLineItems.map(x => x.quantity + " × " + x.name).join(", ").slice(0, 120), items: reservedLineItems, status: "pending", created_at: new Date().toISOString(), expires_at: reserved.expires_at ?? new Date(Date.now() + 30 * 60 * 1000).toISOString() };
    try {
      await env.PROJECT_STORAGE.put(keyFor(mapping.account_id, "checkout-" + id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
      await env.PROJECT_STORAGE.put("payment-index/" + id + ".json", JSON.stringify({ account_id: mapping.account_id }), { httpMetadata: { contentType: "application/json" } });
    } catch (error) {
      await ledger.fetch("https://inventory-ledger.internal/release", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({checkout_id:id})});
      throw error;
    }
    return json({ ok: true, checkout: record, url: new URL("/checkout.html?id=" + id, url.origin).toString() }, 201);
  }
  if (!url.pathname.startsWith("/api/payments/")) return null;
  const settingsMatch = url.pathname === "/api/payments/settings";
  const createMatch = url.pathname === "/api/payments/checkout";
  const paypalConnectMatch = url.pathname === "/api/payments/paypal/connect";
  const paypalStatusMatch = url.pathname === "/api/payments/paypal/status";
  const paypalCreateMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/paypal\/create-order$/);
  const paypalCaptureMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/paypal\/capture$/);
  const publicMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})$/);
  const verifyMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/verify$/);
  if (!settingsMatch && !createMatch && !publicMatch && !verifyMatch && !paypalConnectMatch && !paypalStatusMatch && !paypalCreateMatch && !paypalCaptureMatch) return json({ error: "not_found" }, 404);
  if (paypalConnectMatch || paypalStatusMatch) {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    const key = keyFor(accountId, "paypal-credentials");
    const selectedMode = url.searchParams.get("mode") === "live" ? "live" : "sandbox";
    const modeKey = (mode: "sandbox" | "live") => keyFor(accountId, "paypal-credentials-" + mode);
    if (paypalStatusMatch && request.method === "GET") {
      const saved = await readJson<{ mode: string; client_id: string }>(env.PROJECT_STORAGE, modeKey(selectedMode))
        ?? await readJson<{ mode: string; client_id: string }>(env.PROJECT_STORAGE, key).then(x => x?.mode === selectedMode ? x : null);
      const sandbox = await readJson<{ client_id?: string }>(env.PROJECT_STORAGE, modeKey("sandbox"));
      const live = await readJson<{ client_id?: string }>(env.PROJECT_STORAGE, modeKey("live"));
      return json({ ok: true, connected: Boolean(saved), mode: selectedMode, client_id: saved?.client_id ?? null, available_modes: { sandbox: Boolean(sandbox), live: Boolean(live) } });
    }
    if (paypalConnectMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { mode?: unknown } | null;
      if (body?.mode !== "sandbox" && body?.mode !== "live") return json({ error: "invalid_paypal_mode" }, 400);
      const saved = await readJson<any>(env.PROJECT_STORAGE, modeKey(body.mode));
      if (!saved?.iv || !saved?.ciphertext) return json({ error: "paypal_mode_not_connected", mode: body.mode }, 409);
      await env.PROJECT_STORAGE.put(key, JSON.stringify(saved), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, connected: true, mode: body.mode, client_id: saved.client_id });
    }
    if (paypalConnectMatch && request.method === "DELETE") {
      await Promise.all([env.PROJECT_STORAGE.delete(key), env.PROJECT_STORAGE.delete(modeKey("sandbox")), env.PROJECT_STORAGE.delete(modeKey("live"))]);
      const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(accountId, "settings")) ?? {};
      settings.paypal_enabled = false;
      await env.PROJECT_STORAGE.put(keyFor(accountId, "settings"), JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, connected: false });
    }
    if (paypalConnectMatch && request.method === "PUT") {
      if (!env.PAYMENTS_ENCRYPTION_KEY) return json({ error: "payments_encryption_key_not_configured" }, 503);
      const body = await request.json().catch(() => null) as { client_id?: unknown; client_secret?: unknown; mode?: unknown } | null;
      if (typeof body?.client_id !== "string" || body.client_id.length < 8 || body.client_id.length > 200 || typeof body.client_secret !== "string" || body.client_secret.length < 8 || body.client_secret.length > 300 || !["sandbox", "live"].includes(String(body.mode))) return json({ error: "invalid_paypal_credentials" }, 400);
      const credentials = { client_id: body.client_id.trim(), client_secret: body.client_secret.trim(), mode: body.mode as "sandbox" | "live" };
      const host = credentials.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
      let tokenResponse: Response;
      try {
        tokenResponse = await fetch(host + "/v1/oauth2/token", { method: "POST", headers: { authorization: "Basic " + btoa(credentials.client_id + ":" + credentials.client_secret), "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
      } catch {
        return json({ error: "paypal_validation_unavailable" }, 502);
      }
      if (!tokenResponse.ok) return json({ error: "paypal_credentials_rejected", paypal_status: tokenResponse.status }, 400);
      let encrypted: { iv: string; ciphertext: string };
      try { encrypted = await encryptCredentials(env.PAYMENTS_ENCRYPTION_KEY, credentials); }
      catch { return json({ error: "payments_encryption_key_invalid" }, 503); }
      const savedCredential = { ...encrypted, mode: credentials.mode, client_id: credentials.client_id, connected_at: new Date().toISOString() };
      await env.PROJECT_STORAGE.put(modeKey(credentials.mode), JSON.stringify(savedCredential), { httpMetadata: { contentType: "application/json" } });
      await env.PROJECT_STORAGE.put(key, JSON.stringify(savedCredential), { httpMetadata: { contentType: "application/json" } });
      const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(accountId, "settings")) ?? { wallet_address: "", crypto_enabled: false };
      settings.paypal_enabled = true;
      await env.PROJECT_STORAGE.put(keyFor(accountId, "settings"), JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, connected: true, mode: credentials.mode, client_id: credentials.client_id });
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (paypalCreateMatch || paypalCaptureMatch) {
    const id = (paypalCreateMatch ?? paypalCaptureMatch)![1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    if (page.status === "paid") return json({ ok: true, status: "paid" });
    if (Date.now() > Date.parse(page.expires_at)) return json({ error: "checkout_expired" }, 410);
    const credentials = await getPaypalCredentials(env, page.account_id);
    if (!credentials) return json({ error: "paypal_not_connected" }, 409);
    const host = credentials.mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
    let access: string;
    try { access = await paypalAccessToken(host, credentials); }
    catch { return json({ error: "paypal_authentication_unavailable" }, 502); }
    if (paypalCreateMatch && request.method === "POST") {
      const created = await fetch(host + "/v2/checkout/orders", { method: "POST", headers: { authorization: "Bearer " + access, "content-type": "application/json", prefer: "return=representation" }, body: JSON.stringify({ intent: "CAPTURE", purchase_units: [{ reference_id: id, custom_id: id, description: String(page.description).slice(0, 127), amount: { currency_code: "USD", value: Number(page.amount_usd).toFixed(2) } }] }) });
      const order = await created.json() as { id?: string };
      if (!created.ok || !order.id) return json({ error: "paypal_order_creation_failed", paypal_status: created.status }, 502);
      await env.PROJECT_STORAGE.put(keyFor(page.account_id, "paypal-order-" + id), JSON.stringify({ order_id: order.id }), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, order_id: order.id });
    }
    if (paypalCaptureMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { order_id?: unknown } | null;
      const saved = await readJson<{ order_id: string }>(env.PROJECT_STORAGE, keyFor(page.account_id, "paypal-order-" + id));
      if (!saved || body?.order_id !== saved.order_id) return json({ error: "paypal_order_mismatch" }, 400);
      const captured = await fetch(host + "/v2/checkout/orders/" + encodeURIComponent(saved.order_id) + "/capture", { method: "POST", headers: { authorization: "Bearer " + access, "content-type": "application/json", prefer: "return=representation" }, body: "{}" });
      const result = await captured.json() as { status?: string; purchase_units?: Array<{ payments?: { captures?: Array<{ status?: string; amount?: { value?: string; currency_code?: string }; id?: string }> } }> };
      if (!captured.ok) return json({ error: "paypal_capture_failed", paypal_status: captured.status }, 502);
      const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
      if (result.status !== "COMPLETED" || capture?.status !== "COMPLETED" || capture.amount?.currency_code !== "USD" || Number(capture.amount.value) !== Number(page.amount_usd)) return json({ error: "paypal_payment_not_completed" }, 409);
      const committed = await commitInventory(env, page, saved.order_id, "paypal");
      const inventory_status = committed.ok ? "queued_for_tinycore_sync" : "needs_review";
      const updated = { ...page, status: "paid", inventory_status, order_id: committed.order_id ?? null, payment_method: "paypal", paypal_order_id: saved.order_id, paypal_capture_id: capture.id ?? null, paid_at: new Date().toISOString() };
      await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, status: "paid", inventory_status, order_id: committed.order_id ?? null, capture_id: capture.id ?? null });
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (settingsMatch || createMatch) {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    const settingsKey = keyFor(accountId, "settings");
    if (settingsMatch && request.method === "GET") return json({ ok: true, settings: await readJson(env.PROJECT_STORAGE, settingsKey) ?? { wallet_address: "", paypal_url: "", crypto_enabled: false, paypal_enabled: false } });
    if (settingsMatch && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || (body.wallet_address !== "" && !addressOk(body.wallet_address)) || (body.paypal_url !== "" && !validPayPalUrl(body.paypal_url)) ||
        typeof body.crypto_enabled !== "boolean" || typeof body.paypal_enabled !== "boolean" ||
        (body.crypto_enabled && !addressOk(body.wallet_address)) || (body.paypal_enabled && !validPayPalUrl(body.paypal_url) && !await readJson(env.PROJECT_STORAGE, keyFor(accountId, "paypal-credentials")))) return json({ error: "invalid_payment_settings" }, 400);
      const settings = { wallet_address: body.wallet_address, paypal_url: body.paypal_url, crypto_enabled: body.crypto_enabled, paypal_enabled: body.paypal_enabled, network: "Base", token: "USDC", updated_at: new Date().toISOString() };
      await env.PROJECT_STORAGE.put(settingsKey, JSON.stringify(settings), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, settings });
    }
    if (createMatch && request.method === "POST") {
      const body = await request.json().catch(() => null) as { amount_usd?: unknown; description?: unknown } | null;
      const amount = typeof body?.amount_usd === "string" ? body.amount_usd : String(body?.amount_usd ?? "");
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || typeof body?.description !== "string" || body.description.trim().length < 1 || body.description.length > 120) return json({ error: "invalid_checkout_details" }, 400);
      const settings = await readJson<any>(env.PROJECT_STORAGE, settingsKey);
      if (!settings || (!settings.crypto_enabled && !settings.paypal_enabled)) return json({ error: "no_payment_method_configured" }, 409);
      const id = crypto.randomUUID();
      const record = { id, account_id: accountId, amount_usd: Number(amount).toFixed(2), description: body.description.trim(), status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString() };
      await env.PROJECT_STORAGE.put(keyFor(accountId, "checkout-" + id), JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
      await env.PROJECT_STORAGE.put("payment-index/" + id + ".json", JSON.stringify({ account_id: accountId }), { httpMetadata: { contentType: "application/json" } });
      return json({ ok: true, checkout: record, url: new URL("/checkout.html?id=" + id, url.origin).toString() }, 201);
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (publicMatch && request.method === "GET") {
    const id = publicMatch[1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(page.account_id, "settings"));
    const paypalConfig = await readJson<{ client_id: string; mode: string }>(env.PROJECT_STORAGE, keyFor(page.account_id, "paypal-credentials"));
    return json({ ok: true, checkout: page, methods: { crypto: Boolean(settings?.crypto_enabled), paypal: Boolean(settings?.paypal_enabled && paypalConfig) }, paypal: paypalConfig ? { client_id: paypalConfig.client_id, mode: paypalConfig.mode } : null, wallet_address: settings?.crypto_enabled ? settings.wallet_address : null, paypal_url: settings?.paypal_enabled ? settings.paypal_url : null, network: "Base", token: "USDC", token_contract: USDC_BASE });
  }
  if (verifyMatch && request.method === "POST") {
    const id = verifyMatch[1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    if (page.status === "paid") return json({ ok: true, status: "paid" });
    if (Date.now() > Date.parse(page.expires_at)) return json({ error: "checkout_expired" }, 410);
    const body = await request.json().catch(() => null) as { transaction_hash?: unknown } | null;
    const hash = body?.transaction_hash;
    if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return json({ error: "invalid_transaction_hash" }, 400);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(page.account_id, "settings"));
    if (!settings?.crypto_enabled || !addressOk(settings.wallet_address)) return json({ error: "crypto_not_enabled" }, 409);
    const rpc = await fetch("https://mainnet.base.org", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }) });
    if (!rpc.ok) return json({ error: "network_verification_unavailable" }, 502);
    const result = await rpc.json() as { result?: { status?: string; logs?: Array<{ address?: string; topics?: string[]; data?: string }> } | null };
    const receipt = result.result;
    if (!receipt) return json({ ok: true, status: "pending", message: "Transaction not yet confirmed." });
    if (receipt.status !== "0x1") return json({ error: "transaction_failed" }, 400);
    const recipientTopic = "0x" + settings.wallet_address.slice(2).toLowerCase().padStart(64, "0");
    const usedKey = "payment-used-transactions/" + hash.toLowerCase() + ".json";
    if (await env.PROJECT_STORAGE.head(usedKey)) return json({ error: "transaction_already_used" }, 409);
    const expected = BigInt(Math.round(Number(page.amount_usd) * 1_000_000));
    const paid = (receipt.logs ?? []).some(log => log.address?.toLowerCase() === USDC_BASE.toLowerCase() && log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics?.[2]?.toLowerCase() === recipientTopic && typeof log.data === "string" && BigInt(log.data) >= expected);
    if (!paid) return json({ error: "matching_usdc_transfer_not_found" }, 400);
    const committed = await commitInventory(env, page, hash, "usdc");
    const inventory_status = committed.ok ? "queued_for_tinycore_sync" : "needs_review";
    const updated = { ...page, status: "paid", inventory_status, order_id: committed.order_id ?? null, transaction_hash: hash, paid_at: new Date().toISOString(), network: "Base", token: "USDC" };
    await env.PROJECT_STORAGE.put(usedKey, JSON.stringify({ checkout_id: id, account_id: page.account_id }), { httpMetadata: { contentType: "application/json" } });
    await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, status: "paid", inventory_status, transaction_hash: hash });
  }
  return json({ error: "method_not_allowed" }, 405);
}
async function findCheckout(bucket: R2Bucket, id: string): Promise<any | null> {
  const index = await readJson<{ account_id?: string }>(bucket, "payment-index/" + id + ".json");
  if (!index?.account_id || !accountOk(index.account_id)) return null;
  return readJson(bucket, keyFor(index.account_id, "checkout-" + id));
}


async function encryptCredentials(secret: string, credentials: { client_id: string; client_secret: string; mode: "sandbox" | "live" }): Promise<{ iv: string; ciphertext: string }> {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("PAYMENTS_ENCRYPTION_KEY must be base64-encoded 32-byte key");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(credentials)));
  return { iv: btoa(String.fromCharCode(...iv)), ciphertext: btoa(String.fromCharCode(...new Uint8Array(encrypted))) };
}
async function decryptCredentials(secret: string, record: { iv: string; ciphertext: string }): Promise<{ client_id: string; client_secret: string; mode: "sandbox" | "live" }> {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(record.iv), c => c.charCodeAt(0)) }, key, Uint8Array.from(atob(record.ciphertext), c => c.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function getPaypalCredentials(env: PaymentEnv, accountId: string) {
  if (!env.PAYMENTS_ENCRYPTION_KEY) return null;
  const record = await readJson<{ iv: string; ciphertext: string }>(env.PROJECT_STORAGE, keyFor(accountId, "paypal-credentials"));
  if (!record?.iv || !record.ciphertext) return null;
  try { return await decryptCredentials(env.PAYMENTS_ENCRYPTION_KEY, record); } catch { return null; }
}
async function paypalAccessToken(host: string, credentials: { client_id: string; client_secret: string }) {
  const response = await fetch(host + "/v1/oauth2/token", { method: "POST", headers: { authorization: "Basic " + btoa(credentials.client_id + ":" + credentials.client_secret), "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const data = await response.json() as { access_token?: string };
  if (!response.ok || !data.access_token) throw new Error("PayPal OAuth token request failed");
  return data.access_token;
}
