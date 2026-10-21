import { DurableObject } from "cloudflare:workers";
import { VIRTUAL_NETWORK, isVirtualPrivateIp, virtualIpForOrdinal } from "./virtual-network";

export type AccountStatus = "provisioning" | "ready" | "error";

export interface AccountRecord {
  account_id: string;
  name: string;
  status: AccountStatus;
  baseline_id: string;
  snapshot_identity: string;
  virtual_ip: string;
  virtual_mac: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

interface StoredAccount extends AccountRecord {
  api_key_sha256: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function validAccountId(value: string): boolean {
  return /^acct-[a-f0-9-]{36}$/.test(value);
}

export class AccountRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    // Internal-only Worker binding route: remove all user accounts, sessions, and IP allocations.
    if (url.pathname === "/admin/clear-accounts" && request.method === "POST") {
      const accounts: Array<{ username: string; account_id: string }> = [];
      let cursor: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({ prefix: "auth-user:", limit: 1000, cursor });
        for (const [key, value] of page) {
          const username = key.slice("auth-user:".length);
          if (typeof value.account_id === "string") accounts.push({ username, account_id: value.account_id });
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);

      const prefixes = ["auth-session:", "network-allocation:", "auth-user:"];
      for (const prefix of prefixes) {
        let deleteCursor: string | undefined;
        do {
          const page = await this.ctx.storage.list({ prefix, limit: 1000, cursor: deleteCursor });
          const keys = Array.from(page.keys());
          if (keys.length) await this.ctx.storage.delete(keys);
          deleteCursor = page.list_complete ? undefined : page.cursor;
        } while (deleteCursor);
      }
      return json({ ok: true, accounts, accounts_removed: accounts.length });
    }

    if (url.pathname === "/auth/rate-limit" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { ip?: unknown; action?: unknown } | null;
      if (typeof body?.ip !== "string" || body.ip.length < 1 || body.ip.length > 80 ||
          (body.action !== "signup" && body.action !== "login")) return json({ error: "invalid_rate_limit_key" }, 400);
      const now = Date.now();
      const windowMs = body.action === "signup" ? 60 * 60 * 1000 : 15 * 60 * 1000;
      // Testing phase: allow repeated signup attempts while still bounding accidental loops.
      const limit = body.action === "signup" ? 500 : 2000;
      const key = "auth-rate:" + body.action + ":" + await this.sha256(body.ip);
      const old = await this.ctx.storage.get<number[]>(key) ?? [];
      const recent = old.filter((time) => Number.isFinite(time) && now - time < windowMs);
      if (recent.length >= limit) {
        await this.ctx.storage.put(key, recent);
        return json({ error: "rate_limited", retry_after_seconds: Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000)) }, 429);
      }
      recent.push(now);
      await this.ctx.storage.put(key, recent);
      return json({ ok: true });
    }

    // Global username/password registry. The same Durable Object class is also used
    // per-account for API-key metadata; this route family is stored under separate keys.
    if (url.pathname === "/auth/signup" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown; account_id?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || password.length < 4 || password.length > 128 ||
          typeof body?.account_id !== "string" || !validAccountId(body.account_id)) {
        return json({ error: "invalid_signup_fields" }, 400);
      }
      const userKey = "auth-user:" + username;
      const existing = await this.ctx.storage.get<{ status?: string }>(userKey);
      if (existing && existing.status !== "error") return json({ error: "username_unavailable" }, 409);
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const salt = Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const passwordHash = await this.passwordHash(password, salt);
      await this.ctx.storage.put(userKey, {
        username, account_id: body.account_id, salt, password_hash: passwordHash,
        status: "provisioning", created_at: new Date().toISOString(),
      });
      return json({ ok: true, account_id: body.account_id }, 201);
    }

    if (url.pathname === "/auth/status" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; status?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || !["ready", "error"].includes(String(body?.status))) {
        return json({ error: "invalid_auth_status" }, 400);
      }
      const key = "auth-user:" + username;
      const user = await this.ctx.storage.get<Record<string, unknown>>(key);
      if (!user) return json({ error: "user_not_found" }, 404);
      user.status = body.status;
      await this.ctx.storage.put(key, user);
      return json({ ok: true });
    }

    if (url.pathname === "/auth/provisioning-session" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || !password || password.length > 128) return json({ error: "invalid_credentials" }, 401);
      const user = await this.ctx.storage.get<{ account_id: string; salt: string; password_hash: string; status: string }>("auth-user:" + username);
      if (!user || user.status !== "provisioning") return json({ error: "account_not_provisioning" }, 409);
      const candidate = await this.passwordHash(password, user.salt);
      if (!this.constantTimeEqual(candidate, user.password_hash)) return json({ error: "invalid_credentials" }, 401);
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await this.sha256(token);
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await this.ctx.storage.put("auth-session:" + tokenHash, { account_id: user.account_id, expires_at: expiresAt });
      return json({ account_id: user.account_id, session_token: token, expires_at: new Date(expiresAt).toISOString() });
    }

    if (url.pathname === "/auth/login" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || !password || password.length > 128) {
        return json({ error: "invalid_credentials" }, 401);
      }
      const user = await this.ctx.storage.get<{ account_id: string; salt: string; password_hash: string; status: string }>("auth-user:" + username);
      if (!user || user.status !== "ready") return json({ error: "invalid_credentials_or_account_not_ready" }, 401);
      const candidate = await this.passwordHash(password, user.salt);
      if (!this.constantTimeEqual(candidate, user.password_hash)) return json({ error: "invalid_credentials" }, 401);
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await this.sha256(token);
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await this.ctx.storage.put("auth-session:" + tokenHash, { account_id: user.account_id, expires_at: expiresAt });
      return json({ account_id: user.account_id, session_token: token, expires_at: new Date(expiresAt).toISOString() });
    }

    if (url.pathname === "/auth/verify" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown; token?: unknown } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return json({ error: "unauthorized" }, 401);
      const tokenHash = await this.sha256(body.token);
      const session = await this.ctx.storage.get<{ account_id: string; expires_at: number }>("auth-session:" + tokenHash);
      if (!session || session.account_id !== body.account_id || session.expires_at <= Date.now()) {
        if (session) await this.ctx.storage.delete("auth-session:" + tokenHash);
        return json({ error: "unauthorized" }, 401);
      }
      return json({ ok: true, account_id: session.account_id });
    }

    // Serialized Durable Object allocation makes signup retries idempotent and
    // prevents concurrent accounts from receiving the same virtual IPv4 address.
    if (url.pathname === "/network/allocate" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id)) {
        return json({ error: "invalid_account_id" }, 400);
      }
      const allocationKey = "network-allocation:" + body.account_id;
      // The counter and account mapping must be committed atomically. Requests to a
      // Durable Object can interleave across awaits; a plain get/put sequence can duplicate IPs.
      const result = await this.ctx.storage.transaction(async (txn) => {
        const existing = await txn.get<{ account_id: string; virtual_ip: string; virtual_mac: string }>(allocationKey);
        if (existing) return { allocation: existing, reused: true };
        const nextHost = await txn.get<number>("network-next-host") ?? VIRTUAL_NETWORK.first_allocatable_ordinal;
        if (!Number.isInteger(nextHost) || nextHost < VIRTUAL_NETWORK.first_allocatable_ordinal ||
            nextHost > VIRTUAL_NETWORK.last_allocatable_ordinal) return null;
        const virtualIp = virtualIpForOrdinal(nextHost);
        if (!virtualIp) return null;
        // Encode the unique allocation ordinal in the locally administered MAC so
        // it is collision-free within this pool, not merely hash-derived.
        const virtualMac = [0x02, 0, 0, 0, Math.floor(nextHost / 256), nextHost % 256]
          .map((part) => part.toString(16).padStart(2, "0")).join(":");
        const allocation = { account_id: body.account_id, virtual_ip: virtualIp, virtual_mac: virtualMac };
        await txn.put(allocationKey, allocation);
        await txn.put("network-next-host", nextHost + 1);
        return { allocation, reused: false };
      });
      if (!result) return json({ error: "virtual_ipv4_pool_exhausted" }, 409);
      return json(result, result.reused ? 200 : 201);
    }

    const networkIdentityMatch = url.pathname.match(/^\/network\/identity\/([^/]+)$/);
    if (networkIdentityMatch && request.method === "GET") {
      const accountId = decodeURIComponent(networkIdentityMatch[1]);
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);
      const record = await this.ctx.storage.get<StoredAccount>("account:" + accountId);
      if (!record) return json({ error: "account_not_found" }, 404);
      return json({ account_id: record.account_id, virtual_ip: record.virtual_ip, virtual_mac: record.virtual_mac });
    }

    if (url.pathname === "/network/assign" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        account_id?: unknown; virtual_ip?: unknown; virtual_mac?: unknown;
      } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body.virtual_ip !== "string" || !isVirtualPrivateIp(body.virtual_ip) ||
          typeof body.virtual_mac !== "string" || !/^02(?::[0-9a-f]{2}){5}$/.test(body.virtual_mac)) {
        return json({ error: "invalid_network_identity" }, 400);
      }
      const key = "account:" + body.account_id;
      const record = await this.ctx.storage.get<StoredAccount>(key);
      if (!record) return json({ error: "account_not_found" }, 404);
      if (record.virtual_ip && record.virtual_mac) {
        return json({ account_id: record.account_id, virtual_ip: record.virtual_ip, virtual_mac: record.virtual_mac, reused: true });
      }
      const updated: StoredAccount = {
        ...record, virtual_ip: body.virtual_ip, virtual_mac: body.virtual_mac,
        updated_at: new Date().toISOString(),
      };
      await this.ctx.storage.put(key, updated);
      return json({ account_id: updated.account_id, virtual_ip: updated.virtual_ip, virtual_mac: updated.virtual_mac, reused: false });
    }

    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        account_id?: unknown; name?: unknown; baseline_id?: unknown;
        snapshot_identity?: unknown; api_key_sha256?: unknown; virtual_ip?: unknown; virtual_mac?: unknown;
      } | null;
      if (!body || typeof body.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body.name !== "string" || body.name.length < 1 || body.name.length > 80 ||
          typeof body.baseline_id !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(body.baseline_id) ||
          typeof body.snapshot_identity !== "string" || !/^acct-[a-f0-9-]{36}$/.test(body.snapshot_identity) ||
          typeof body.api_key_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.api_key_sha256) ||
          typeof body.virtual_ip !== "string" || !/^10\.240\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(body.virtual_ip) ||
          typeof body.virtual_mac !== "string" || !/^02(?::[0-9a-f]{2}){5}$/.test(body.virtual_mac)) {
        return json({ error: "invalid_account_record" }, 400);
      }
      const key = "account:" + body.account_id;
      if (await this.ctx.storage.get(key)) return json({ error: "account_exists" }, 409);
      const now = new Date().toISOString();
      const record: StoredAccount = {
        account_id: body.account_id,
        name: body.name,
        status: "provisioning",
        baseline_id: body.baseline_id,
        snapshot_identity: body.snapshot_identity,
        virtual_ip: body.virtual_ip,
        virtual_mac: body.virtual_mac,
        created_at: now,
        updated_at: now,
        error: null,
        api_key_sha256: body.api_key_sha256,
      };
      await this.ctx.storage.put(key, record);
      return json({ account: this.publicRecord(record) }, 201);
    }

    const match = url.pathname.match(/^\/account\/([^/]+)$/);
    if (match) {
      const accountId = decodeURIComponent(match[1]);
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);
      const key = "account:" + accountId;
      if (request.method === "DELETE") {
        const existed = await this.ctx.storage.get(key);
        await this.ctx.storage.delete(key);
        return json({ ok: true, deleted: Boolean(existed), account_id: accountId });
      }
      const record = await this.ctx.storage.get<StoredAccount>(key);
      if (!record) return json({ error: "account_not_found" }, 404);

      if (request.method === "GET") {
        const suppliedHash = request.headers.get("x-account-key-sha256") ?? "";
        if (!/^[a-f0-9]{64}$/.test(suppliedHash) || !this.constantTimeEqual(suppliedHash, record.api_key_sha256)) {
          return json({ error: "unauthorized" }, 401);
        }
        return json({ account: this.publicRecord(record) });
      }

      if (request.method === "PATCH") {
        const body = await request.json().catch(() => ({})) as { status?: unknown; error?: unknown };
        if (body.status !== "ready" && body.status !== "error" && body.status !== "provisioning") {
          return json({ error: "invalid_account_status" }, 400);
        }
        const updated: StoredAccount = {
          ...record,
          status: body.status,
          error: typeof body.error === "string" ? body.error.slice(0, 500) : null,
          updated_at: new Date().toISOString(),
        };
        await this.ctx.storage.put(key, updated);
        return json({ account: this.publicRecord(updated) });
      }
    }

    return json({ error: "not_found" }, 404);
  }


  private async passwordHash(password: string, saltHex: string): Promise<string> {
    const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
    return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private async sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  private publicRecord(record: StoredAccount): AccountRecord {
    const { api_key_sha256: _secret, ...publicRecord } = record;
    return publicRecord;
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }
}
