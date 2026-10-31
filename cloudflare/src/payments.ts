export interface PaymentEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  PROJECT_STORAGE: R2Bucket;
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
  if (!url.pathname.startsWith("/api/payments/")) return null;
  const settingsMatch = url.pathname === "/api/payments/settings";
  const createMatch = url.pathname === "/api/payments/checkout";
  const publicMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})$/);
  const verifyMatch = url.pathname.match(/^\/api\/payments\/checkout\/([a-f0-9-]{36})\/verify$/);
  if (!settingsMatch && !createMatch && !publicMatch && !verifyMatch) return json({ error: "not_found" }, 404);
  if (settingsMatch || createMatch) {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    const settingsKey = keyFor(accountId, "settings");
    if (settingsMatch && request.method === "GET") return json({ ok: true, settings: await readJson(env.PROJECT_STORAGE, settingsKey) ?? { wallet_address: "", paypal_url: "", crypto_enabled: false, paypal_enabled: false } });
    if (settingsMatch && request.method === "PUT") {
      const body = await request.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || (body.wallet_address !== "" && !addressOk(body.wallet_address)) || (body.paypal_url !== "" && !validPayPalUrl(body.paypal_url)) ||
        typeof body.crypto_enabled !== "boolean" || typeof body.paypal_enabled !== "boolean" ||
        (body.crypto_enabled && !addressOk(body.wallet_address)) || (body.paypal_enabled && !validPayPalUrl(body.paypal_url))) return json({ error: "invalid_payment_settings" }, 400);
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
      return json({ ok: true, checkout: record, url: new URL("/pay/" + id, url.origin).toString() }, 201);
    }
    return json({ error: "method_not_allowed" }, 405);
  }
  if (publicMatch && request.method === "GET") {
    const id = publicMatch[1];
    const page = await findCheckout(env.PROJECT_STORAGE, id);
    if (!page) return json({ error: "checkout_not_found" }, 404);
    const settings = await readJson<any>(env.PROJECT_STORAGE, keyFor(page.account_id, "settings"));
    return json({ ok: true, checkout: page, methods: { crypto: Boolean(settings?.crypto_enabled), paypal: Boolean(settings?.paypal_enabled) }, wallet_address: settings?.crypto_enabled ? settings.wallet_address : null, paypal_url: settings?.paypal_enabled ? settings.paypal_url : null, network: "Base", token: "USDC", token_contract: USDC_BASE });
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
    const expected = BigInt(Math.round(Number(page.amount_usd) * 1_000_000));
    const paid = (receipt.logs ?? []).some(log => log.address?.toLowerCase() === USDC_BASE.toLowerCase() && log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && log.topics?.[2]?.toLowerCase() === recipientTopic && typeof log.data === "string" && BigInt(log.data) >= expected);
    if (!paid) return json({ error: "matching_usdc_transfer_not_found" }, 400);
    const updated = { ...page, status: "paid", transaction_hash: hash, paid_at: new Date().toISOString(), network: "Base", token: "USDC" };
    await env.PROJECT_STORAGE.put(keyFor(page.account_id, "checkout-" + id), JSON.stringify(updated), { httpMetadata: { contentType: "application/json" } });
    return json({ ok: true, status: "paid", transaction_hash: hash });
  }
  return json({ error: "method_not_allowed" }, 405);
}
async function findCheckout(bucket: R2Bucket, id: string): Promise<any | null> {
  // IDs are random UUIDs; locate the merchant record without exposing account IDs to the shopper.
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "accounts/", limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) if (item.key.endsWith("/checkout-" + id + ".json")) return readJson(bucket, item.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return null;
}
