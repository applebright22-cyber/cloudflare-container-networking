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
  oracle_execution_enabled?: boolean;
}

interface StoredAccount extends AccountRecord {
  api_key_sha256: string;
  api_key?: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function validAccountId(value: string): boolean {
  return /^acct-[a-f0-9-]{36}$/.test(value);
}

export class AccountRegistry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Internal-only Worker binding route: list account IDs without changing Durable Object storage.
    if (url.pathname === "/admin/list-accounts" && request.method === "GET") {
      const accounts: Array<{ username: string; account_id: string }> = [];
      let startAfter: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({ prefix: "auth-user:", limit: 1000, startAfter });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          const username = key.slice("auth-user:".length);
          if (typeof value.account_id === "string" && validAccountId(value.account_id)) {
            accounts.push({ username, account_id: value.account_id });
          }
        }
        startAfter = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (startAfter);
      accounts.sort((left, right) => left.account_id.localeCompare(right.account_id));
      return json({ ok: true, accounts, account_ids: accounts.map((account) => account.account_id), count: accounts.length });
    }

    // Internal-only Worker binding route: remove all user accounts, sessions, and IP allocations.
    if (url.pathname === "/admin/clear-accounts" && request.method === "POST") {
      const accounts: Array<{ username: string; account_id: string }> = [];
      let startAfter: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({ prefix: "auth-user:", limit: 1000, startAfter });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          const username = key.slice("auth-user:".length);
          if (typeof value.account_id === "string") accounts.push({ username, account_id: value.account_id });
        }
        startAfter = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (startAfter);

      const prefixes = ["auth-session:", "network-allocation:", "auth-user:"];
      for (const prefix of prefixes) {
        const keys: string[] = [];
        let after: string | undefined;
        do {
          const page = await this.ctx.storage.list({ prefix, limit: 1000, startAfter: after });
          const pageKeys = Array.from(page.keys());
          keys.push(...pageKeys);
          after = page.list_complete || pageKeys.length === 0 ? undefined : pageKeys[pageKeys.length - 1];
        } while (after);
        for (let offset = 0; offset < keys.length; offset += 128) {
          await this.ctx.storage.delete(keys.slice(offset, offset + 128));
        }
      }
      return json({ ok: true, accounts, accounts_removed: accounts.length });
    }

    // Remove only shared-registry entries belonging to one validated account ID.
    // The network-next-host counter is intentionally retained to prevent IP reuse collisions.
    if (url.pathname === "/admin/purge-account" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown } | null;
      const accountId = typeof body?.account_id === "string" ? body.account_id : "";
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);

      const usernamesToDelete: string[] = [];
      let afterUser: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({
          prefix: "auth-user:", limit: 1000, startAfter: afterUser,
        });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          if (value.account_id === accountId) usernamesToDelete.push(key);
        }
        afterUser = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (afterUser);

      const sessionKeysToDelete: string[] = [];
      let afterSession: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({
          prefix: "auth-session:", limit: 1000, startAfter: afterSession,
        });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          if (value.account_id === accountId) sessionKeysToDelete.push(key);
        }
        afterSession = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (afterSession);

      const allocationKey = "network-allocation:" + accountId;
      const keys = [...usernamesToDelete, ...sessionKeysToDelete, allocationKey];
      for (let offset = 0; offset < keys.length; offset += 128) {
        await this.ctx.storage.delete(keys.slice(offset, offset + 128));
      }

      // Read back the affected records before reporting success.
      const remainingUsers: string[] = [];
      let verifyAfterUser: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({
          prefix: "auth-user:", limit: 1000, startAfter: verifyAfterUser,
        });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          if (value.account_id === accountId) remainingUsers.push(key);
        }
        verifyAfterUser = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (verifyAfterUser);

      const remainingSessions: string[] = [];
      let verifyAfterSession: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({
          prefix: "auth-session:", limit: 1000, startAfter: verifyAfterSession,
        });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          if (value.account_id === accountId) remainingSessions.push(key);
        }
        verifyAfterSession = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (verifyAfterSession);
      const allocationRemains = await this.ctx.storage.get(allocationKey) !== undefined;
      const verified = remainingUsers.length === 0 && remainingSessions.length === 0 && !allocationRemains;
      return json({
        ok: verified, account_id: accountId,
        auth_users_deleted: usernamesToDelete.length,
        sessions_deleted: sessionKeysToDelete.length,
        network_allocation_deleted: !allocationRemains,
        verification: {
          passed: verified,
          remaining_auth_users: remainingUsers.length,
          remaining_sessions: remainingSessions.length,
          network_allocation_remains: allocationRemains,
        },
        network_next_host_counter_preserved: true,
      }, verified ? 200 : 500);
    }

    // Internal-only route: clear storage attached to this account-specific object.
    // The Worker calls this only on idFromName(accountId), never on "auth-users".
    if (url.pathname === "/admin/purge-account-data" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id)) {
        return json({ error: "invalid_account_id" }, 400);
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      const remaining = await this.ctx.storage.list({ limit: 1 });
      const storageCleared = remaining.size === 0;
      return json({
        ok: storageCleared, account_id: body.account_id,
        storage_cleared: storageCleared, alarm_deleted: true,
        verification: { passed: storageCleared, remaining_key_count_at_least: remaining.size },
      }, storageCleared ? 200 : 500);
    }

    // Ambassador identities and sessions are stored separately from merchant auth.
    // They deliberately use a different ID namespace and cannot pass merchant session verification.
    if (url.pathname === "/ambassador/signup" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || password.length < 8 || password.length > 128) {
        return json({ error: "invalid_signup_fields" }, 400);
      }
      const key = "ambassador-user:" + username;
      if (await this.ctx.storage.get(key)) return json({ error: "username_unavailable" }, 409);
      const saltBytes = crypto.getRandomValues(new Uint8Array(16));
      const salt = Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const passwordHash = await this.passwordHash(password, salt);
      const ambassadorId = "amb-" + crypto.randomUUID();
      await this.ctx.storage.put(key, { username, ambassador_id: ambassadorId, salt, password_hash: passwordHash, created_at: new Date().toISOString() });
      return json({ ok: true, ambassador_id: ambassadorId }, 201);
    }

    if (url.pathname === "/ambassador/login" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
      const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const user = await this.ctx.storage.get<{ ambassador_id: string; salt: string; password_hash: string }>("ambassador-user:" + username);
      if (!user || !password || password.length > 128 || !this.constantTimeEqual(await this.passwordHash(password, user.salt), user.password_hash)) {
        return json({ error: "invalid_credentials" }, 401);
      }
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const tokenHash = await this.sha256(token);
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await this.ctx.storage.put("ambassador-session:" + tokenHash, { ambassador_id: user.ambassador_id, username, expires_at: expiresAt });
      return json({ ambassador_id: user.ambassador_id, username, session_token: token, expires_at: new Date(expiresAt).toISOString() });
    }

    if (url.pathname === "/ambassador/verify" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { ambassador_id?: unknown; token?: unknown } | null;
      if (typeof body?.ambassador_id !== "string" || !/^amb-[a-f0-9-]{36}$/.test(body.ambassador_id) ||
          typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return json({ error: "unauthorized" }, 401);
      const tokenHash = await this.sha256(body.token);
      const key = "ambassador-session:" + tokenHash;
      const session = await this.ctx.storage.get<{ ambassador_id: string; username: string; expires_at: number }>(key);
      if (!session || session.ambassador_id !== body.ambassador_id || session.expires_at <= Date.now()) {
        if (session) await this.ctx.storage.delete(key);
        return json({ error: "unauthorized" }, 401);
      }
      return json({ ok: true, ambassador_id: session.ambassador_id, username: session.username });
    }

    // Ambassador deal records live in the shared auth-users object but use a
    // completely separate keyspace and are always scoped to the authenticated ambassador.
    if (url.pathname === "/ambassador/deals" && (request.method === "GET" || request.method === "POST")) {
      const body = request.method === "POST"
        ? await request.json().catch(() => null) as Record<string, unknown> | null
        : null;
      const ambassadorId = request.method === "GET"
        ? url.searchParams.get("ambassador_id") ?? ""
        : (typeof body?.ambassador_id === "string" ? body.ambassador_id : "");
      const token = request.method === "GET"
        ? url.searchParams.get("token") ?? ""
        : (typeof body?.token === "string" ? body.token : "");
      if (!/^amb-[a-f0-9-]{36}$/.test(ambassadorId) || !/^[a-f0-9]{64}$/.test(token)) {
        return json({ error: "unauthorized" }, 401);
      }
      const tokenHash = await this.sha256(token);
      const session = await this.ctx.storage.get<{ ambassador_id: string; expires_at: number }>("ambassador-session:" + tokenHash);
      if (!session || session.ambassador_id !== ambassadorId || session.expires_at <= Date.now()) {
        if (session) await this.ctx.storage.delete("ambassador-session:" + tokenHash);
        return json({ error: "unauthorized" }, 401);
      }
      const prefix = "ambassador-deal:" + ambassadorId + ":";
      if (request.method === "GET" || body?.action === "list") {
        const page = await this.ctx.storage.list<Record<string, unknown>>({ prefix, limit: 500 });
        const deals = Array.from(page.values()).sort((a, b) =>
          String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
        return json({ ok: true, deals });
      }
      const businessName = typeof body?.business_name === "string" ? body.business_name.trim() : "";
      const merchantAccountId = typeof body?.account_id === "string" ? body.account_id : "";
      const contactName = typeof body?.contact_name === "string" ? body.contact_name.trim() : "";
      const contactEmail = typeof body?.contact_email === "string" ? body.contact_email.trim().toLowerCase() : "";
      const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
      const notes = typeof body?.notes === "string" ? body.notes.trim() : "";
      if (businessName.length < 2 || businessName.length > 120 || !validAccountId(merchantAccountId) ||
          contactName.length > 120 || contactEmail.length > 254 ||
          (contactEmail && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(contactEmail)) ||
          phone.length > 40 || notes.length > 2000) {
        return json({ error: "invalid_deal_fields" }, 400);
      }
      const dealId = "deal-" + crypto.randomUUID();
      const now = new Date().toISOString();
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const invitationToken = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const invitationHash = await this.sha256(invitationToken);
      const invitationExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const deal = {
        deal_id: dealId, ambassador_id: ambassadorId, business_name: businessName,
        contact_name: contactName, contact_email: contactEmail, phone, notes,
        account_id: merchantAccountId, status: "provisioning", created_at: now, updated_at: now,
        invitation_expires_at: new Date(invitationExpiresAt).toISOString(),
      };
      await this.ctx.storage.put(prefix + dealId, deal);
      await this.ctx.storage.put("merchant-invite:" + invitationHash, {
        deal_id: dealId, ambassador_id: ambassadorId, account_id: merchantAccountId,
        expires_at: invitationExpiresAt, status: "open",
      });
      return json({ ok: true, deal, invitation_token: invitationToken }, 201);
    }

    if (url.pathname === "/ambassador/deal/status" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        ambassador_id?: unknown; token?: unknown; deal_id?: unknown; account_id?: unknown; status?: unknown;
      } | null;
      if (typeof body?.ambassador_id !== "string" || !/^amb-[a-f0-9-]{36}$/.test(body.ambassador_id) ||
          typeof body.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token) ||
          typeof body.deal_id !== "string" || !/^deal-[a-f0-9-]{36}$/.test(body.deal_id) ||
          typeof body.account_id !== "string" || !validAccountId(body.account_id) ||
          (body.status !== "account_created" && body.status !== "error")) return json({ error: "invalid_deal_status_update" }, 400);
      const session = await this.ctx.storage.get<{ ambassador_id: string; expires_at: number }>(
        "ambassador-session:" + await this.sha256(body.token),
      );
      if (!session || session.ambassador_id !== body.ambassador_id || session.expires_at <= Date.now()) {
        return json({ error: "unauthorized" }, 401);
      }
      const key = "ambassador-deal:" + body.ambassador_id + ":" + body.deal_id;
      const deal = await this.ctx.storage.get<Record<string, unknown>>(key);
      if (!deal || deal.account_id !== body.account_id) return json({ error: "deal_not_found" }, 404);
      deal.status = body.status;
      deal.updated_at = new Date().toISOString();
      await this.ctx.storage.put(key, deal);
      return json({ ok: true, deal });
    }

    if (url.pathname === "/merchant-invite/lookup" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { token?: unknown } | null;
      if (typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return json({ error: "invalid_invitation" }, 400);
      const invite = await this.ctx.storage.get<{ deal_id: string; ambassador_id: string; account_id: string; expires_at: number; status: string }>(
        "merchant-invite:" + await this.sha256(body.token),
      );
      if (!invite || invite.expires_at <= Date.now() || invite.status === "claimed" || !validAccountId(invite.account_id)) {
        return json({ error: "invitation_invalid_or_expired" }, 404);
      }
      return json({ ok: true, account_id: invite.account_id, deal_id: invite.deal_id });
    }

    if (url.pathname === "/merchant-invite/reserve" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        token?: unknown; account_id?: unknown; reservation_id?: unknown;
      } | null;
      if (typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token) ||
          typeof body.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body.reservation_id !== "string" || !/^[a-f0-9-]{36}$/.test(body.reservation_id)) {
        return json({ error: "invalid_invitation" }, 400);
      }
      const key = "merchant-invite:" + await this.sha256(body.token);
      const now = Date.now();
      const result = await this.ctx.storage.transaction(async (txn) => {
        const invite = await txn.get<{ deal_id: string; ambassador_id: string; account_id: string; expires_at: number; status: string; reserved_account_id?: string; reservation_expires_at?: number }>(key);
        if (!invite || invite.expires_at <= now || invite.status === "claimed" || invite.account_id !== body.account_id) return { error: "invitation_invalid_or_expired" };
        if (invite.status === "reserved" && (invite.reservation_expires_at ?? 0) > now &&
            invite.reservation_id !== body.reservation_id) return { error: "invitation_already_in_use" };
        invite.status = "reserved";
        invite.reserved_account_id = body.account_id;
        invite.reservation_id = body.reservation_id;
        invite.reservation_expires_at = now + 15 * 60 * 1000;
        await txn.put(key, invite);
        return { ok: true, deal_id: invite.deal_id };
      });
      return "error" in result ? json({ error: result.error }, 409) : json(result);
    }

    if (url.pathname === "/merchant-invite/complete" && request.method === "POST") {
      const body = await request.json().catch(() => null) as {
        token?: unknown; account_id?: unknown; username?: unknown; reservation_id?: unknown;
      } | null;
      if (typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token) ||
          typeof body.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body.username !== "string" || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(body.username) ||
          typeof body.reservation_id !== "string" || !/^[a-f0-9-]{36}$/.test(body.reservation_id)) {
        return json({ error: "invalid_invitation_claim" }, 400);
      }
      const key = "merchant-invite:" + await this.sha256(body.token);
      const result = await this.ctx.storage.transaction(async (txn) => {
        const invite = await txn.get<{ deal_id: string; ambassador_id: string; expires_at: number; status: string; reserved_account_id?: string; reservation_expires_at?: number; claimed_at?: number }>(key);
        if (!invite || invite.expires_at <= Date.now() || invite.status !== "reserved" ||
            invite.reserved_account_id !== body.account_id || invite.reservation_id !== body.reservation_id ||
            (invite.reservation_expires_at ?? 0) <= Date.now()) return { error: "invitation_reservation_invalid" };
        const dealKey = "ambassador-deal:" + invite.ambassador_id + ":" + invite.deal_id;
        const deal = await txn.get<Record<string, unknown>>(dealKey);
        if (!deal || (deal.account_id && deal.account_id !== body.account_id)) return { error: "deal_link_conflict" };
        invite.status = "claimed";
        invite.claimed_at = Date.now();
        await txn.put(key, invite);
        deal.account_id = body.account_id;
        deal.merchant_username = body.username;
        deal.status = "claimed";
        deal.updated_at = new Date().toISOString();
        await txn.put(dealKey, deal);
        return { ok: true, deal_id: invite.deal_id, account_id: body.account_id };
      });
      return "error" in result ? json({ error: result.error }, 409) : json(result);
    }

    if (url.pathname === "/auth/rate-limit" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { ip?: unknown; action?: unknown } | null;
      if (typeof body?.ip !== "string" || body.ip.length < 1 || body.ip.length > 80 ||
          (body.action !== "signup" && body.action !== "login")) return json({ error: "invalid_rate_limit_key" }, 400);
      const now = Date.now();
      const windowMs = body.action === "signup" ? 60 * 60 * 1000 : 15 * 60 * 1000;
      // Per-IP limits keep automated signup and password guessing bounded.
      const limit = body.action === "signup" ? 5 : 10;
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
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || password.length < 8 || password.length > 128 ||
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

    // Provisioning status follows the permanent merchant account ID, not a
    // temporary display username, so an owner can claim before or after VM setup.
    if (url.pathname === "/auth/status-by-account" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown; status?: unknown } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id) ||
          (body.status !== "ready" && body.status !== "error")) return json({ error: "invalid_auth_status" }, 400);
      const updates: string[] = [];
      let after: string | undefined;
      do {
        const page = await this.ctx.storage.list<Record<string, unknown>>({
          prefix: "auth-user:", limit: 1000, startAfter: after,
        });
        const entries = Array.from(page.entries());
        for (const [key, value] of entries) {
          if (value.account_id === body.account_id) {
            value.status = body.status;
            await this.ctx.storage.put(key, value);
            updates.push(key);
          }
        }
        after = page.list_complete || entries.length === 0 ? undefined : entries[entries.length - 1][0];
      } while (after);
      return json({ ok: true, account_id: body.account_id, updated: updates.length });
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
      await this.ctx.storage.put("auth-session:" + tokenHash, { account_id: user.account_id, username, expires_at: expiresAt });
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
      await this.ctx.storage.put("auth-session:" + tokenHash, { account_id: user.account_id, username, expires_at: expiresAt });
      return json({ account_id: user.account_id, session_token: token, expires_at: new Date(expiresAt).toISOString() });
    }

    if (url.pathname === "/auth/verify" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown; token?: unknown } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return json({ error: "unauthorized" }, 401);
      const tokenHash = await this.sha256(body.token);
      const session = await this.ctx.storage.get<{ account_id: string; username?: string; expires_at: number }>("auth-session:" + tokenHash);
      if (!session || session.account_id !== body.account_id || session.expires_at <= Date.now()) {
        if (session) await this.ctx.storage.delete("auth-session:" + tokenHash);
        return json({ error: "unauthorized" }, 401);
      }
      return json({ ok: true, account_id: session.account_id, ...(session.username ? { username: session.username } : {}) });
    }

    if (url.pathname === "/auth/logout" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { account_id?: unknown; token?: unknown } | null;
      if (typeof body?.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body?.token !== "string" || !/^[a-f0-9]{64}$/.test(body.token)) return json({ error: "unauthorized" }, 401);
      const tokenHash = await this.sha256(body.token);
      const key = "auth-session:" + tokenHash;
      const session = await this.ctx.storage.get<{ account_id: string; expires_at: number }>(key);
      if (!session || session.account_id !== body.account_id) return json({ ok: true, revoked: false });
      await this.ctx.storage.delete(key);
      return json({ ok: true, revoked: true });
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
          typeof body.virtual_mac !== "string" || !/^02(?::[0-9a-f]{2}){5}$/.test(body.virtual_mac) ||
          (body.oracle_execution_enabled !== undefined && typeof body.oracle_execution_enabled !== "boolean")) {
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
        snapshot_identity?: unknown; api_key_sha256?: unknown; api_key?: unknown; virtual_ip?: unknown; virtual_mac?: unknown;
        oracle_execution_enabled?: unknown;
      } | null;
      if (!body || typeof body.account_id !== "string" || !validAccountId(body.account_id) ||
          typeof body.name !== "string" || body.name.length < 1 || body.name.length > 80 ||
          typeof body.baseline_id !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(body.baseline_id) ||
          typeof body.snapshot_identity !== "string" || !/^acct-[a-f0-9-]{36}$/.test(body.snapshot_identity) ||
          typeof body.api_key_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.api_key_sha256) ||
          typeof body.api_key !== "string" || !/^acct_[a-f0-9]{64}$/.test(body.api_key) ||
          typeof body.virtual_ip !== "string" || !/^10\.240\.(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/.test(body.virtual_ip) ||
          typeof body.virtual_mac !== "string" || !/^02(?::[0-9a-f]{2}){5}$/.test(body.virtual_mac) ||
          (body.oracle_execution_enabled !== undefined && typeof body.oracle_execution_enabled !== "boolean")) {
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
        ...(body.oracle_execution_enabled === true ? { oracle_execution_enabled: true } : {}),
        api_key_sha256: body.api_key_sha256,
        api_key: body.api_key,
      };
      await this.ctx.storage.put(key, record);
      return json({ account: this.publicRecord(record) }, 201);
    }

    // Internal Worker-only capability lookup. Missing flags remain disabled for legacy accounts.
    const oracleExecutionMatch = url.pathname.match(/^\/account\/([^/]+)\/oracle-execution$/);
    if (oracleExecutionMatch && request.method === "GET") {
      const accountId = decodeURIComponent(oracleExecutionMatch[1]);
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);
      const record = await this.ctx.storage.get<StoredAccount>("account:" + accountId);
      if (!record) return json({ error: "account_not_found" }, 404);
      return json({ account_id: accountId, enabled: record.oracle_execution_enabled === true });
    }

    // Internal Worker-only route: replace the active API-key hash for one account.
    const rotateKeyMatch = url.pathname.match(/^\/account\/([^/]+)\/api-key$/);
    if (rotateKeyMatch && request.method === "POST") {
      const accountId = decodeURIComponent(rotateKeyMatch[1]);
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);
      const body = await request.json().catch(() => null) as { api_key_sha256?: unknown; api_key?: unknown } | null;
      if (typeof body?.api_key_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.api_key_sha256) ||
          typeof body.api_key !== "string" || !/^acct_[a-f0-9]{64}$/.test(body.api_key)) {
        return json({ error: "invalid_api_key" }, 400);
      }
      const key = "account:" + accountId;
      const record = await this.ctx.storage.get<StoredAccount>(key);
      if (!record) return json({ error: "account_not_found" }, 404);
      const updated: StoredAccount = { ...record, api_key_sha256: body.api_key_sha256, api_key: body.api_key, updated_at: new Date().toISOString() };
      await this.ctx.storage.put(key, updated);
      return json({ ok: true, account_id: accountId, updated_at: updated.updated_at });
    }

    if (rotateKeyMatch && request.method === "GET") {
      const accountId = decodeURIComponent(rotateKeyMatch[1]);
      if (!validAccountId(accountId)) return json({ error: "invalid_account_id" }, 400);
      const record = await this.ctx.storage.get<StoredAccount>("account:" + accountId);
      if (!record) return json({ error: "account_not_found" }, 404);
      if (typeof record.api_key !== "string" || !/^acct_[a-f0-9]{64}$/.test(record.api_key)) {
        return json({ error: "api_key_not_retrievable" }, 404);
      }
      return json({ account_id: accountId, api_key: record.api_key });
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
    const { api_key_sha256: _secret, api_key: _rawKey, ...publicRecord } = record;
    return publicRecord;
  }

  private constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let difference = 0;
    for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
  }
}
