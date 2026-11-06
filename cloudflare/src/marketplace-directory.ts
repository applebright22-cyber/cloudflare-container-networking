import type { InventoryLedger } from "./inventory-ledger";

export interface MarketplaceEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  INVENTORY_LEDGER: DurableObjectNamespace<InventoryLedger>;
  PROJECT_STORAGE: R2Bucket;
}

const ACCOUNT_ID = /^acct-[a-f0-9-]{36}$/;
const SITE_ID = /^[a-f0-9]{32}$/;
const PROJECT_ID = /^[a-z0-9-]{3,80}$/;
const PROFILE_PREFIX = "marketplace/merchants/";
const MARKET_RADIUS_MILES = 10;
const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { "cache-control": "no-store" },
});

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try { return await object.json<T>(); } catch { return null; }
}

async function authenticate(request: Request, env: MarketplaceEnv, accountId: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!ACCOUNT_ID.test(accountId) || !token) return false;
  const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const response = await registry.fetch("https://account-registry.internal/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: accountId, token }),
  });
  return response.ok;
}

function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function distanceMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(bLat - aLat);
  const dLng = radians(bLng - aLng);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(aLat)) * Math.cos(radians(bLat)) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

type PublishedStore = { project_id: string; name: string; site_id: string; published_url: string };

async function getPublishedStores(env: MarketplaceEnv, accountId: string): Promise<PublishedStore[]> {
  const prefix = "accounts/" + accountId + "/projects/";
  const stores: PublishedStore[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PROJECT_STORAGE.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const item of page.objects) {
      const project = await readJson<Record<string, unknown>>(env.PROJECT_STORAGE, item.key);
      if (!project || project.kind !== "Store" || typeof project.id !== "string" ||
          !PROJECT_ID.test(project.id) || typeof project.publishSlug !== "string" || !SITE_ID.test(project.publishSlug)) continue;
      const mapping = await readJson<{ account_id?: string; project_id?: string }>(
        env.PROJECT_STORAGE, "published-sites/index/" + project.publishSlug + ".json",
      );
      if (mapping?.account_id !== accountId || mapping.project_id !== project.id) continue;
      stores.push({
        project_id: project.id,
        name: typeof project.name === "string" ? project.name.slice(0, 80) : "Local store",
        site_id: project.publishSlug,
        published_url: "/sites/" + project.publishSlug + "/",
      });
      if (stores.length >= 100) return stores;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return stores;
}

/**
 * Marketplace directory records only merchant discovery details. Product, price,
 * availability, and reservation data always come from each merchant's InventoryLedger.
 */
export async function handleMarketplaceRequest(request: Request, env: MarketplaceEnv): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/marketplace/profile") {
    const accountId = url.searchParams.get("account_id") ?? "";
    if (!await authenticate(request, env, accountId)) return json({ error: "unauthorized" }, 401);
    if (request.method === "GET") {
      const [profile, stores] = await Promise.all([
        readJson<Record<string, unknown>>(env.PROJECT_STORAGE, PROFILE_PREFIX + accountId + ".json"),
        getPublishedStores(env, accountId),
      ]);
      return json({ ok: true, profile: profile ?? null, stores });
    }
    if (request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const latitude = body?.latitude;
    const longitude = body?.longitude;
    if (!body || typeof body.project_id !== "string" || !PROJECT_ID.test(body.project_id) ||
        typeof body.street_address !== "string" || body.street_address.trim().length < 4 || body.street_address.length > 180 ||
        typeof body.city !== "string" || body.city.trim().length < 2 || body.city.length > 80 ||
        typeof body.state !== "string" || !/^[A-Z]{2}$/.test(body.state.trim().toUpperCase()) ||
        typeof body.postal_code !== "string" || body.postal_code.length > 12 ||
        typeof latitude !== "number" || typeof longitude !== "number" || !validCoordinates(latitude, longitude)) {
      return json({ error: "invalid_marketplace_profile" }, 400);
    }
    const stores = await getPublishedStores(env, accountId);
    const selected = stores.find((store) => store.project_id === body.project_id);
    if (!selected) return json({ error: "published_store_not_found", note: "Publish a Store project before listing it in the marketplace." }, 409);
    const profile = {
      account_id: accountId,
      project_id: selected.project_id,
      site_id: selected.site_id,
      store_name: selected.name,
      street_address: body.street_address.trim(),
      city: body.city.trim().replace(/\s+/g, " "),
      state: body.state.trim().toUpperCase(),
      postal_code: body.postal_code.trim(),
      latitude: body.latitude,
      longitude: body.longitude,
      active: body.active !== false,
      updated_at: new Date().toISOString(),
    };
    await env.PROJECT_STORAGE.put(PROFILE_PREFIX + accountId + ".json", JSON.stringify(profile), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return json({ ok: true, profile: { ...profile, street_address: profile.street_address } });
  }
  if (url.pathname !== "/api/marketplace/products") return null;
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const latitudeText = url.searchParams.get("lat");
  const longitudeText = url.searchParams.get("lng");
  if (latitudeText === null || longitudeText === null || !latitudeText.trim() || !longitudeText.trim()) {
    return json({ error: "valid_location_required" }, 400);
  }
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  if (!validCoordinates(latitude, longitude)) return json({ error: "valid_location_required" }, 400);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, 100).toLowerCase();
  const category = (url.searchParams.get("category") ?? "").trim().slice(0, 60).toLowerCase();
  const matches: Array<Record<string, unknown>> = [];
  const categories = new Set<string>();
  let cursor: string | undefined;
  let storesChecked = 0;

  do {
    const page = await env.PROJECT_STORAGE.list({
      prefix: PROFILE_PREFIX,
      limit: 250,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.objects) {
      if (storesChecked >= 500) break;
      storesChecked += 1;
      const profile = await readJson<Record<string, unknown>>(env.PROJECT_STORAGE, item.key);
      const storeLatitude = profile?.latitude;
      const storeLongitude = profile?.longitude;
      if (!profile || profile.active !== true || typeof profile.account_id !== "string" ||
          !ACCOUNT_ID.test(profile.account_id) || typeof profile.site_id !== "string" ||
          !SITE_ID.test(profile.site_id) || typeof storeLatitude !== "number" ||
          typeof storeLongitude !== "number" || !validCoordinates(storeLatitude, storeLongitude)) continue;
      const distance = distanceMiles(latitude, longitude, storeLatitude, storeLongitude);
      if (distance > MARKET_RADIUS_MILES) continue;
      const mapping = await readJson<{ account_id?: string; project_id?: string }>(
        env.PROJECT_STORAGE, "published-sites/index/" + profile.site_id + ".json",
      );
      if (mapping?.account_id !== profile.account_id || mapping.project_id !== profile.project_id) continue;
      const ledger = env.INVENTORY_LEDGER.get(env.INVENTORY_LEDGER.idFromName(profile.account_id));
      const catalogResponse = await ledger.fetch("https://inventory-ledger.internal/catalog");
      if (!catalogResponse.ok) continue;
      const catalog = await catalogResponse.json() as {
        products?: Array<{
          id: string; sku: string; name: string; description?: string; category?: string;
          image_url?: string; variations?: unknown[]; external_url?: string;
          price: number; quantity: number; in_stock: boolean;
        }>;
      };
      for (const product of catalog.products ?? []) {
        if (!product.in_stock || Number(product.quantity) < 1) continue;
        const productCategory = String(product.category ?? "").trim();
        if (productCategory) categories.add(productCategory);
        if (category && productCategory.toLowerCase() !== category) continue;
        const haystack = [product.name, product.description, product.sku, productCategory]
          .concat((product.variations ?? []).map((variation) => {
            if (!variation || typeof variation !== "object") return "";
            const value = variation as Record<string, unknown>;
            return [value.name, value.size, value.color, value.sku].filter(Boolean).join(" ");
          })).join(" ").toLowerCase();
        if (query && !haystack.includes(query)) continue;
        matches.push({
          id: product.id,
          product_id: product.id,
          site_id: profile.site_id,
          name: product.name,
          description: product.description ?? "",
          category: productCategory,
          sku: product.sku,
          image_url: product.image_url ?? "",
          price: product.price,
          quantity: product.quantity,
          in_stock: true,
          variations: product.variations ?? [],
          store: {
            name: String(profile.store_name ?? "Local store"),
            city: String(profile.city ?? "Orlando"),
            state: String(profile.state ?? "FL"),
          },
          distance_miles: Number(distance.toFixed(1)),
        });
      }
    }
    if (storesChecked >= 500) break;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  matches.sort((a, b) => Number(a.distance_miles) - Number(b.distance_miles));
  return json({
    ok: true,
    market: "Orlando, FL",
    radius_miles: MARKET_RADIUS_MILES,
    result_count: matches.length,
    categories: Array.from(categories).sort((a, b) => a.localeCompare(b)),
    products: matches.slice(0, 300),
  });
}
