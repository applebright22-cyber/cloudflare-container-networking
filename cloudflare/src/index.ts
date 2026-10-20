import { connect } from "cloudflare:sockets";
import { TunnelHub } from "./tunnel-hub";
import { NodeRegistry } from "./node-registry";
import { NodeRuntime } from "./node-runtime";
import { VmExecution } from "./vm-execution";
import { AccountRegistry } from "./account-registry";
import { readCommittedGuestSnapshot } from "./headless-snapshot-store";
import { AccountProvisioner } from "./account-provisioner";
import { WispRelay } from "./wisp-relay";
export { TunnelHub, NodeRegistry, NodeRuntime, VmExecution, AccountRegistry, AccountProvisioner, WispRelay };

export interface Env {
  TUNNEL_HUB: DurableObjectNamespace<TunnelHub>;
  NODE_REGISTRY: DurableObjectNamespace<NodeRegistry>;
  NODE_RUNTIME: DurableObjectNamespace<NodeRuntime>;
  VM_EXECUTION: DurableObjectNamespace<VmExecution>;
  ACCOUNT_REGISTRY: DurableObjectNamespace<AccountRegistry>;
  ACCOUNT_PROVISIONER: DurableObjectNamespace<AccountProvisioner>;
  WISP_RELAY: DurableObjectNamespace<WispRelay>;
  VM_BASELINE_ID?: string;
  ADMIN_ACCESS_CODE?: string;
  VM_SNAPSHOTS: R2Bucket;
  ASSETS: Fetcher;
  TUNNEL_TOKEN: string;
  CLIENT_TOKEN: string;
}

function authorized(header: string | null, expected: string | undefined): boolean {
  if (!header || !expected || !header.startsWith("Bearer ")) return false;
  const value = header.slice(7);
  if (value.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < value.length; i += 1) {
    difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

const VM_API_TOKEN_R2_KEY = "config/vm-api-token.txt";

async function getVmApiToken(env: Env): Promise<string | undefined> {
  try {
    const object = await env.VM_SNAPSHOTS.get(VM_API_TOKEN_R2_KEY);
    if (!object) return undefined;
    const token = (await object.text()).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function validNodeId(nodeId: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(nodeId);
}

async function getOrAllocateAccountNetworkIdentity(
  env: Env, accountId: string,
): Promise<{ virtual_ip: string; virtual_mac: string } | null> {
  const accountRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName(accountId));
  const read = await accountRegistry.fetch("https://account-registry.internal/network/identity/" + accountId);
  if (read.ok) {
    const current = await read.json() as { virtual_ip?: unknown; virtual_mac?: unknown };
    if (typeof current.virtual_ip === "string" && typeof current.virtual_mac === "string") {
      return { virtual_ip: current.virtual_ip, virtual_mac: current.virtual_mac };
    }
  }
  // Existing accounts created before this feature are assigned an address on first login.
  const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const allocationResponse = await authRegistry.fetch("https://account-registry.internal/network/allocate", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: accountId }),
  });
  if (!allocationResponse.ok) return null;
  const allocationBody = await allocationResponse.json() as {
    allocation?: { virtual_ip?: unknown; virtual_mac?: unknown };
  };
  const allocation = allocationBody.allocation;
  if (typeof allocation?.virtual_ip !== "string" || typeof allocation.virtual_mac !== "string") return null;
  const assigned = await accountRegistry.fetch("https://account-registry.internal/network/assign", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account_id: accountId, virtual_ip: allocation.virtual_ip, virtual_mac: allocation.virtual_mac }),
  });
  if (!assigned.ok) return null;
  const identity = await assigned.json() as { virtual_ip?: unknown; virtual_mac?: unknown };
  if (typeof identity.virtual_ip !== "string" || typeof identity.virtual_mac !== "string") return null;
  return { virtual_ip: identity.virtual_ip, virtual_mac: identity.virtual_mac };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Authenticated API read-back verification for a snapshot written by Workerd.
    // This validates R2 bytes only; it does not claim that v86 restored the guest.
    if (url.pathname === "/v1/runtime/snapshot-readback") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const vmApiToken = await getVmApiToken(env);
      if (!vmApiToken) return json({ error: "vm_api_not_configured" }, 503);
      if (!authorized(request.headers.get("authorization"), vmApiToken)) return json({ error: "unauthorized" }, 401);
      let body: { identity?: unknown };
      try { body = await request.json() as typeof body; }
      catch { return json({ error: "invalid_json" }, 400); }
      const identity = typeof body.identity === "string" ? body.identity.toLowerCase() : "";
      if (!/^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(identity)) return json({ error: "invalid_snapshot_identity" }, 400);
      try {
        const result = await readCommittedGuestSnapshot(env.VM_SNAPSHOTS, identity);
        return json({
          probe: "headless-snapshot-api-readback", runtime: "workerd", passed: true,
          identity: result.manifest.identity, generation: result.manifest.generation,
          chunks: result.manifest.chunks, byte_length: result.manifest.byteLength,
          sha256: result.manifest.sha256, readback_byte_length: result.state.byteLength,
          readback_digest_verified: true, guest_checks: result.manifest.checks,
          note: "R2 read-back and digest verification passed; a fresh-emulator restore and guest marker check are still required.",
        });
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
        return json({ probe: "headless-snapshot-api-readback", passed: false, error: message }, message === "snapshot_manifest_missing" ? 404 : 409);
      }
    }

    // Diagnostic only: this checks the persisted snapshot and optionally compiles the v86 WASM
    // module in the Worker runtime. It intentionally does not instantiate a VM or claim shell execution.
    if (url.pathname === "/v1/runtime/preflight") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const vmApiToken = await getVmApiToken(env);
      if (!vmApiToken) return json({ error: "vm_api_not_configured" }, 503);
      if (!authorized(request.headers.get("authorization"), vmApiToken)) return json({ error: "unauthorized" }, 401);

      let body: { compile_wasm?: unknown };
      try { body = await request.json() as typeof body; }
      catch { return json({ error: "invalid_json" }, 400); }
      if (body.compile_wasm !== undefined && typeof body.compile_wasm !== "boolean") {
        return json({ error: "compile_wasm_must_be_boolean" }, 400);
      }

      const baselineId = env.VM_BASELINE_ID ?? "admin";
      const prefix = "vm-snapshots/" + baselineId + "/";
      const manifestObject = await env.VM_SNAPSHOTS.get(prefix + "manifest.json");
      if (!manifestObject) {
        return json({
          probe: "headless-v86-preflight",
          headless_linux_execution: "not_implemented",
          snapshot: { baseline_id: baselineId, available: false },
          next_blocker: "Upload a valid baseline snapshot to R2 before runtime feasibility testing.",
        }, 409);
      }

      let manifest: { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown; savedAt?: unknown };
      try { manifest = await manifestObject.json() as typeof manifest; }
      catch {
        return json({ error: "baseline_manifest_invalid", probe: "headless-v86-preflight" }, 500);
      }
      if (manifest.version !== 1 || typeof manifest.generation !== "string" ||
          !/^[a-z0-9-]{1,40}$/.test(manifest.generation) ||
          !Number.isInteger(manifest.chunks) || (manifest.chunks as number) < 1 ||
          (manifest.chunks as number) > 128 ||
          !Number.isInteger(manifest.byteLength) || (manifest.byteLength as number) < 1 ||
          (manifest.byteLength as number) > 536870912 ||
          manifest.chunks !== Math.ceil((manifest.byteLength as number) / 8388608)) {
        return json({ error: "baseline_manifest_invalid", probe: "headless-v86-preflight" }, 500);
      }

      const count = manifest.chunks as number;
      const totalBytes = manifest.byteLength as number;
      const generationPrefix = prefix + manifest.generation + "/";
      const chunks = await Promise.all(Array.from({ length: count }, async (_, part) => {
        const expectedBytes = Math.min(8388608, totalBytes - part * 8388608);
        const object = await env.VM_SNAPSHOTS.head(generationPrefix + part + ".bin");
        return {
          part,
          exists: object !== null,
          expected_bytes: expectedBytes,
          actual_bytes: object?.size ?? null,
          valid_size: object !== null && object.size === expectedBytes,
        };
      }));
      const missingParts = chunks.filter((part) => !part.exists).map((part) => part.part);
      const invalidSizeParts = chunks.filter((part) => part.exists && !part.valid_size).map((part) => part.part);

      let wasm: { requested: boolean; compiled: boolean | null; bytes?: number; error?: string } = {
        requested: body.compile_wasm === true,
        compiled: null,
      };
      if (body.compile_wasm === true) {
        try {
          const wasmResponse = await env.ASSETS.fetch(new Request(new URL("/v86/v86.wasm", request.url)));
          if (!wasmResponse.ok) {
            wasm = { requested: true, compiled: false, error: "v86_wasm_asset_http_" + wasmResponse.status };
          } else {
            const wasmBytes = await wasmResponse.arrayBuffer();
            await WebAssembly.compile(wasmBytes);
            wasm = { requested: true, compiled: true, bytes: wasmBytes.byteLength };
          }
        } catch (error) {
          wasm = {
            requested: true,
            compiled: false,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          };
        }
      }

      const snapshotValid = missingParts.length === 0 && invalidSizeParts.length === 0;
      return json({
        probe: "headless-v86-preflight",
        browser_required_for_current_exec_api: true,
        headless_linux_execution: "not_implemented",
        snapshot: {
          baseline_id: baselineId,
          available: true,
          valid: snapshotValid,
          generation: manifest.generation,
          chunks: count,
          byte_length: totalBytes,
          saved_at: typeof manifest.savedAt === "string" ? manifest.savedAt : null,
          missing_parts: missingParts,
          invalid_size_parts: invalidSizeParts,
        },
        wasm,
        conclusion: snapshotValid && (wasm.compiled !== false)
          ? "R2 snapshot integrity preflight passed; this does not prove the VM can boot or execute shell commands in Workers."
          : "Preflight found an issue; inspect snapshot and WASM results before attempting VM initialization.",
        next_blocker: "A separate test must instantiate v86 without DOM/browser host APIs, restore this state, run a real TinyCore shell command, and measure Worker memory/CPU. This endpoint deliberately does not allocate guest RAM or execute commands.",
      });
    }


    // Signup clones the verified Admin baseline; it never starts a Linux boot.
    if (url.pathname === "/api/auth/signup" && request.method === "POST") {
      let body: { username?: unknown; password?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || password.length < 4 || password.length > 128) {
        return json({ error: "username_must_be_2_to_32_chars_and_password_4_to_128_chars" }, 400);
      }

      const baselineId = env.VM_BASELINE_ID ?? "admin";
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(baselineId) || baselineId.startsWith("acct-")) {
        return json({ error: "invalid_vm_baseline_id" }, 500);
      }
      const baselinePrefix = "vm-snapshots/" + baselineId + "/";
      const baselineObject = await env.VM_SNAPSHOTS.get(baselinePrefix + "manifest.json");
      if (!baselineObject) return json({ error: "admin_baseline_snapshot_not_found", baseline_id: baselineId }, 409);
      let baseline: { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown; savedAt?: unknown; adminReady?: unknown; checks?: { guest_booted?: unknown; shell_command_passed?: unknown; dhcp_passed?: unknown; ca_certificates_passed?: unknown } };
      try { baseline = await baselineObject.json() as typeof baseline; }
      catch { return json({ error: "admin_baseline_manifest_invalid" }, 500); }
      if (baseline.version !== 1 || typeof baseline.generation !== "string" ||
          !/^[a-z0-9-]{1,40}$/.test(baseline.generation) ||
          !Number.isInteger(baseline.chunks) || (baseline.chunks as number) < 1 ||
          (baseline.chunks as number) > 128 ||
          !Number.isInteger(baseline.byteLength) || (baseline.byteLength as number) < 1 ||
          (baseline.byteLength as number) > 536870912 ||
          baseline.chunks !== Math.ceil((baseline.byteLength as number) / 8388608)) {
        return json({ error: "admin_baseline_manifest_invalid" }, 500);
      }
      const checks = baseline.checks;
      if (baseline.adminReady !== true || !checks || checks.guest_booted !== true ||
          checks.shell_command_passed !== true || checks.dhcp_passed !== true || checks.ca_certificates_passed !== true) {
        return json({ error: "admin_baseline_not_ready", detail: "Save the Admin snapshot only after startup, DHCP, DNS, SSL and CA checks have completed." }, 409);
      }

      const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
      const rateLimit = await authRegistry.fetch("https://account-registry.internal/auth/rate-limit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip: request.headers.get("cf-connecting-ip") ?? "unknown", action: "signup" }),
      });
      if (!rateLimit.ok) return json(await rateLimit.json(), rateLimit.status);

      const accountId = "acct-" + crypto.randomUUID();
      const generation = crypto.randomUUID();
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const accountApiKey = "acct_" + Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountApiKey));
      const apiKeyHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");

      const claim = await authRegistry.fetch("https://account-registry.internal/auth/signup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, account_id: accountId }),
      });
      if (!claim.ok) return json(await claim.json(), claim.status);

      const accountRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName(accountId));
      const allocationResponse = await authRegistry.fetch("https://account-registry.internal/network/allocate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
      if (!allocationResponse.ok) {
        await authRegistry.fetch("https://account-registry.internal/auth/status", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, status: "error" }),
        });
        return json({ error: "virtual_network_allocation_failed", detail: (await allocationResponse.text()).slice(0, 160) }, 503);
      }
      const allocationBody = await allocationResponse.json() as { allocation: { virtual_ip: string; virtual_mac: string } };
      const allocation = allocationBody.allocation;
      const created = await accountRegistry.fetch("https://account-registry.internal/create", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId, name: username, baseline_id: baselineId,
          snapshot_identity: accountId, api_key_sha256: apiKeyHash,
          virtual_ip: allocation.virtual_ip, virtual_mac: allocation.virtual_mac }),
      });
      if (!created.ok) {
        await authRegistry.fetch("https://account-registry.internal/auth/status", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, status: "error" }),
        });
        return json({ error: "account_record_creation_failed" }, 502);
      }

      // Issue the browser session before marking the auth record ready.
      const signupSession = await authRegistry.fetch("https://account-registry.internal/auth/provisioning-session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!signupSession.ok) return json({ error: "account_created_but_signup_session_failed" }, 502);

      const provisioner = env.ACCOUNT_PROVISIONER.get(env.ACCOUNT_PROVISIONER.idFromName(accountId));
      const queued = await provisioner.fetch("https://account-provisioner.internal/start", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identity: accountId, username, baseline_id: baselineId }),
      });
      if (!queued.ok || queued.status !== 202) {
        const message = await queued.text().catch(() => "snapshot_clone_queue_failed");
        await accountRegistry.fetch("https://account-registry.internal/account/" + accountId, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "error", error: "snapshot_clone_queue_failed" }),
        });
        await authRegistry.fetch("https://account-registry.internal/auth/status", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, status: "error" }),
        });
        return json({ error: "snapshot_clone_queue_failed", detail: message.slice(0, 200) }, 502);
      }

      const session = await signupSession.json() as { account_id: string; session_token: string; expires_at: string };
      return json({ ...session, username, status: "provisioning", snapshot_identity: accountId,
        virtual_ip: allocation.virtual_ip, virtual_mac: allocation.virtual_mac,
        snapshot_cloned: false, baseline_id: baselineId, progress_endpoint: "/api/auth/registration-status",
        provisioning: "The verified Admin snapshot is being copied to this account in the background; Linux is not booted during signup." }, 202);
    }

    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      let body: { username?: unknown; password?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
      const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) || !password || password.length > 128) {
        return json({ error: "invalid_credentials" }, 401);
      }
      const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
      const rateLimit = await authRegistry.fetch("https://account-registry.internal/auth/rate-limit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip: request.headers.get("cf-connecting-ip") ?? "unknown", action: "login" }),
      });
      if (!rateLimit.ok) return json({ error: "rate_limited" }, 429);
      const response = await authRegistry.fetch("https://account-registry.internal/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!response.ok) return json({ error: "invalid_credentials" }, 401);
      const login = await response.json() as Record<string, unknown>;
      const accountId = typeof login.account_id === "string" ? login.account_id : "";
      if (!/^acct-[a-f0-9-]{36}$/.test(accountId)) return json({ error: "invalid_account_session" }, 500);
      const identity = await getOrAllocateAccountNetworkIdentity(env, accountId);
      if (!identity) return json({ error: "account_network_identity_unavailable" }, 409);
      return json({ ...login, username, virtual_ip: identity.virtual_ip, virtual_mac: identity.virtual_mac });
    }

    if (url.pathname === "/api/auth/registration-status" && request.method === "POST") {
      let body: { account_id?: unknown; session_token?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body.account_id !== "string" || typeof body.session_token !== "string" || !/^acct-[a-f0-9-]{36}$/.test(body.account_id)) return json({ error: "unauthorized" }, 401);
      const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
      const verified = await authRegistry.fetch("https://account-registry.internal/auth/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: body.account_id, token: body.session_token }),
      });
      if (!verified.ok) return json({ error: "unauthorized" }, 401);
      const object = await env.VM_SNAPSHOTS.get("runtime-jobs/" + body.account_id + ".json");
      if (!object) return json({ account_id: body.account_id, status: "queued", step: "queued", complete: false, ready_to_login: false, note: "Provisioning progress has not been written yet; continue polling." }, 202);
      const progress = await object.json() as Record<string, unknown>;
      return json({ ...progress, complete: progress.status === "complete", ready_to_login: progress.status === "complete" });
    }

    if (url.pathname === "/api/auth/session" && request.method === "POST") {
      let body: { account_id?: unknown; session_token?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body.account_id !== "string" || typeof body.session_token !== "string") return json({ error: "unauthorized" }, 401);
      const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
      const response = await authRegistry.fetch("https://account-registry.internal/auth/verify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: body.account_id, token: body.session_token }),
      });
      if (!response.ok) return json({ error: "unauthorized" }, 401);
      const identity = await getOrAllocateAccountNetworkIdentity(env, body.account_id);
      if (!identity) return json({ error: "account_network_identity_unavailable" }, 409);
      return json({ ok: true, ...identity });
    }

    if (url.pathname === "/api/network/ticket" && request.method === "POST") {
      let body: { account_id?: unknown; session_token?: unknown; admin_code?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
      const accountId = typeof body.account_id === "string" ? body.account_id : "";
      if (accountId === "admin") {
        if (!env.ADMIN_ACCESS_CODE || typeof body.admin_code !== "string" || body.admin_code !== env.ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);
      } else {
        if (!/^acct-[a-f0-9-]{36}$/.test(accountId) || typeof body.session_token !== "string") return json({ error: "unauthorized" }, 401);
        const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
        const verified = await authRegistry.fetch("https://account-registry.internal/auth/verify", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ account_id: accountId, token: body.session_token }),
        });
        if (!verified.ok) return json({ error: "unauthorized" }, 401);
      }
      const relay = env.WISP_RELAY.get(env.WISP_RELAY.idFromName(accountId));
      const ticketResponse = await relay.fetch("https://wisp-relay.internal/ticket", { method: "POST" });
      if (!ticketResponse.ok) return json({ error: "network_ticket_unavailable" }, 503);
      return json(await ticketResponse.json());
    }

    if (url.pathname === "/api/network/wisp/" && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_upgrade_required" }, 426);
      const accountId = url.searchParams.get("account_id") ?? "";
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!(accountId === "admin" || /^acct-[a-f0-9-]{36}$/.test(accountId)) || !/^[a-f0-9]{64}$/.test(ticket)) return json({ error: "invalid_network_ticket" }, 401);
      const relay = env.WISP_RELAY.get(env.WISP_RELAY.idFromName(accountId));
      return relay.fetch(request);
    }

    if (url.pathname === "/v1/accounts" && request.method === "POST") {
      const vmApiToken = await getVmApiToken(env);
      if (!vmApiToken) return json({ error: "account_api_not_configured" }, 503);
      if (!authorized(request.headers.get("authorization"), vmApiToken)) return json({ error: "unauthorized" }, 401);
      let body: { name?: unknown };
      try { body = await request.json() as { name?: unknown }; }
      catch { return json({ error: "invalid_json" }, 400); }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
        return json({ error: "name_must_be_1_to_80_printable_characters" }, 400);
      }

      const baselineId = env.VM_BASELINE_ID ?? "admin";
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(baselineId) || baselineId.startsWith("acct-")) {
        return json({ error: "invalid_vm_baseline_id" }, 500);
      }
      const baselinePrefix = "vm-snapshots/" + baselineId + "/";
      const baselineObject = await env.VM_SNAPSHOTS.get(baselinePrefix + "manifest.json");
      if (!baselineObject) return json({ error: "baseline_snapshot_not_found", baseline_id: baselineId }, 409);
      let baseline: { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown; adminReady?: unknown; checks?: { guest_booted?: unknown; shell_command_passed?: unknown; dhcp_passed?: unknown; ca_certificates_passed?: unknown } };
      try { baseline = await baselineObject.json() as typeof baseline; }
      catch { return json({ error: "baseline_manifest_invalid" }, 500); }
      if (baseline.version !== 1 || typeof baseline.generation !== "string" ||
          !/^[a-z0-9-]{1,40}$/.test(baseline.generation) ||
          !Number.isInteger(baseline.chunks) || (baseline.chunks as number) < 1 ||
          (baseline.chunks as number) > 128 ||
          !Number.isInteger(baseline.byteLength) || (baseline.byteLength as number) < 1 ||
          (baseline.byteLength as number) > 536870912 ||
          baseline.chunks !== Math.ceil((baseline.byteLength as number) / 8388608)) {
        return json({ error: "baseline_manifest_invalid" }, 500);
      }
      const baselineChecks = baseline.checks;
      if (baselineId === "admin" && (baseline.adminReady !== true || !baselineChecks ||
          baselineChecks.guest_booted !== true || baselineChecks.shell_command_passed !== true ||
          baselineChecks.dhcp_passed !== true || baselineChecks.ca_certificates_passed !== true)) {
        return json({ error: "admin_baseline_not_ready" }, 409);
      }

      const accountId = "acct-" + crypto.randomUUID();
      const generation = crypto.randomUUID();
      const keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const accountApiKey = "acct_" + Array.from(keyBytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountApiKey));
      const apiKeyHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName(accountId));
      const allocationResponse = await env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users")).fetch("https://account-registry.internal/network/allocate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
      if (!allocationResponse.ok) return json({ error: "virtual_network_allocation_failed" }, 503);
      const allocationBody = await allocationResponse.json() as { allocation: { virtual_ip: string; virtual_mac: string } };
      const allocation = allocationBody.allocation;
      const created = await registry.fetch("https://account-registry.internal/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: accountId, name, baseline_id: baselineId,
          snapshot_identity: accountId, api_key_sha256: apiKeyHash,
          virtual_ip: allocation.virtual_ip, virtual_mac: allocation.virtual_mac,
        }),
      });
      if (!created.ok) return json({ error: "account_record_creation_failed" }, 502);

      const accountPrefix = "vm-snapshots/" + accountId + "/";
      try {
        const count = baseline.chunks as number;
        const keys = Array.from({ length: count }, (_, part) => baselinePrefix + baseline.generation + "/" + part + ".bin");
        const chunks = await Promise.all(keys.map((key) => env.VM_SNAPSHOTS.get(key)));
        if (chunks.some((chunk) => !chunk)) throw new Error("baseline_snapshot_chunk_missing");
        await Promise.all(chunks.map(async (chunk, part) => {
          await env.VM_SNAPSHOTS.put(accountPrefix + generation + "/" + part + ".bin", chunk!.body, {
            httpMetadata: { contentType: "application/octet-stream" },
          });
        }));
        const savedAt = new Date().toISOString();
        await env.VM_SNAPSHOTS.put(accountPrefix + "manifest.json", JSON.stringify({
          version: 1, generation, chunks: count, byteLength: baseline.byteLength, savedAt, baselineId,
          ...(baselineId === "admin" ? { adminReady: true, checks: baseline.checks } : {}),
          baselineGeneration: baseline.generation,
        }), { httpMetadata: { contentType: "application/json" }, customMetadata: { savedAt, baselineId } });
        const ready = await registry.fetch("https://account-registry.internal/account/" + accountId, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "ready" }),
        });
        if (!ready.ok) throw new Error("account_ready_transition_failed");
      } catch (error) {
        let cursor: string | undefined;
        do {
          const page = await env.VM_SNAPSHOTS.list({ prefix: accountPrefix, limit: 1000, ...(cursor ? { cursor } : {}) });
          if (page.objects.length) await env.VM_SNAPSHOTS.delete(page.objects.map((object) => object.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        await registry.fetch("https://account-registry.internal/account/" + accountId, {
          method: "PATCH", headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "error", error: error instanceof Error ? error.message : String(error) }),
        });
        return json({ error: "account_snapshot_provisioning_failed" }, 502);
      }

      return json({
        account_id: accountId, name, status: "ready", baseline_id: baselineId,
        snapshot_identity: accountId, virtual_ip: allocation.virtual_ip, virtual_mac: allocation.virtual_mac,
        api_key: accountApiKey,
        api_key_notice: "Store this key securely; it is returned only once.",
        runtime: "snapshot-provisioned; no container started; headless VM execution not yet wired",
      }, 201);
    }

    const accountMatch = url.pathname.match(/^\/v1\/accounts\/(acct-[a-f0-9-]{36})$/);
    if (accountMatch) {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      const accountId = accountMatch[1];
      const authorization = request.headers.get("authorization") ?? "";
      if (!authorization.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
      const suppliedKey = authorization.slice(7);
      if (!/^acct_[a-f0-9]{64}$/.test(suppliedKey)) return json({ error: "unauthorized" }, 401);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedKey));
      const apiKeyHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName(accountId));
      return registry.fetch("https://account-registry.internal/account/" + accountId, {
        method: "GET", headers: { "x-account-key-sha256": apiKeyHash },
      });
    }

    if (url.pathname === "/api/admin/reset-snapshots") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!env.ADMIN_ACCESS_CODE || request.headers.get("x-admin-code") !== env.ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);
      let body: { confirm?: unknown };
      try { body = await request.json() as typeof body; } catch { return json({ error: "invalid_json" }, 400); }
      if (body.confirm !== "DELETE_ALL_VM_SNAPSHOTS") return json({ error: "confirmation_required", expected: "DELETE_ALL_VM_SNAPSHOTS" }, 400);
      let snapshotsDeleted = 0, progressDeleted = 0;
      for (const [prefix, kind] of [["vm-snapshots/", "snapshot"], ["runtime-jobs/", "progress"]] as const) {
        let cursor: string | undefined;
        do {
          const page = await env.VM_SNAPSHOTS.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
          if (page.objects.length) {
            await env.VM_SNAPSHOTS.delete(page.objects.map((object) => object.key));
            if (kind === "snapshot") snapshotsDeleted += page.objects.length;
            else progressDeleted += page.objects.length;
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      return json({ ok: true, snapshots_deleted: snapshotsDeleted, provisioning_records_deleted: progressDeleted,
        note: "Account registry records were not deleted. This operation removes R2 snapshot and runtime-job objects only." });
    }

    if (url.pathname === "/api/admin/access") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      let body: { code?: unknown };
      try { body = (await request.json()) as { code?: unknown }; }
      catch { return json({ error: "invalid_json" }, 400); }
      if (!env.ADMIN_ACCESS_CODE) return json({ error: "admin_access_not_configured" }, 503);
      if (typeof body.code !== "string" || body.code !== env.ADMIN_ACCESS_CODE) return json({ error: "invalid_admin_code" }, 401);
      return json({ ok: true });
    }

    if (url.pathname === "/api/vm/agent-ticket") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (!env.ADMIN_ACCESS_CODE) return json({ error: "admin_access_not_configured" }, 503);
      if (request.headers.get("x-admin-code") !== env.ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);
      const vmId = "admin";
      const ticket = crypto.randomUUID();
      const coordinator = env.VM_EXECUTION.get(env.VM_EXECUTION.idFromName(vmId));
      const ticketResponse = await coordinator.fetch("https://vm-execution.internal/ticket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket, identity: vmId }),
      });
      if (!ticketResponse.ok) return json({ error: "agent_ticket_creation_failed" }, 502);
      return json({ ticket, vm_id: vmId, expires_in_seconds: 60 });
    }

    if (url.pathname === "/api/vm/agent") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      const coordinator = env.VM_EXECUTION.get(env.VM_EXECUTION.idFromName("admin"));
      return coordinator.fetch(request);
    }

    if (url.pathname === "/v1/vm/status" || url.pathname === "/v1/vm/exec") {
      const vmApiToken = await getVmApiToken(env);
      if (!vmApiToken) return json({ error: "vm_api_not_configured" }, 503);
      if (!authorized(request.headers.get("authorization"), vmApiToken)) return json({ error: "unauthorized" }, 401);
      const vmId = request.headers.get("x-vm-id") ?? "admin";
      if (vmId !== "admin") return json({ error: "unknown_vm_id", supported_vm_ids: ["admin"] }, 404);
      const coordinator = env.VM_EXECUTION.get(env.VM_EXECUTION.idFromName(vmId));
      if (url.pathname.endsWith("/status")) {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return coordinator.fetch("https://vm-execution.internal/status?identity=admin");
      }
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      const raw = await request.text();
      if (raw.length > 8192) return json({ error: "body_too_large" }, 413);
      return coordinator.fetch(new Request("https://vm-execution.internal/exec", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vm-id": vmId },
        body: raw,
      }));
    }

    const snapshotChunkMatch = url.pathname.match(/^\/api\/vm-snapshots\/([a-z0-9._-]{1,64})\/chunks\/([a-z0-9-]{1,40})\/([0-9]{1,3})$/i);
    const snapshotMatch = url.pathname.match(/^\/api\/vm-snapshots\/([a-z0-9._-]{1,64})$/i);
    const snapshotIdentity = snapshotChunkMatch?.[1] ?? snapshotMatch?.[1];
    if (snapshotIdentity) {
      const identity = snapshotIdentity.toLowerCase();
      const isAdmin = identity === "admin";
      if (isAdmin && !env.ADMIN_ACCESS_CODE) return json({ error: "admin_access_not_configured" }, 503);
      if (isAdmin && request.headers.get("x-admin-code") !== env.ADMIN_ACCESS_CODE) return json({ error: "unauthorized" }, 401);

      // Account snapshots accept either the one-time provisioning API key or a
      // short-lived login session bound to this exact account ID.
      if (identity.startsWith("acct-")) {
        const authorization = request.headers.get("authorization") ?? "";
        const suppliedCredential = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        let accountAuthorized = false;
        if (/^acct_[a-f0-9]{64}$/.test(suppliedCredential)) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedCredential));
          const keyHash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
          const registry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName(identity));
          const accountAuth = await registry.fetch("https://account-registry.internal/account/" + identity, {
            method: "GET", headers: { "x-account-key-sha256": keyHash },
          });
          accountAuthorized = accountAuth.ok;
        } else if (/^[a-f0-9]{64}$/.test(suppliedCredential)) {
          const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
          const sessionAuth = await authRegistry.fetch("https://account-registry.internal/auth/verify", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ account_id: identity, token: suppliedCredential }),
          });
          accountAuthorized = sessionAuth.ok;
        }
        if (!accountAuthorized) return json({ error: "unauthorized" }, 401);
      }

      // Non-Admin baselines are managed with the provisioning token; the Admin baseline uses ADMIN_ACCESS_CODE.
      if (identity === (env.VM_BASELINE_ID ?? "admin") && identity !== "admin") {
        const vmApiToken = await getVmApiToken(env);
        if (!vmApiToken) return json({ error: "vm_api_not_configured" }, 503);
        if (!authorized(request.headers.get("authorization"), vmApiToken)) return json({ error: "unauthorized" }, 401);
      }

      if (snapshotChunkMatch) {
        if (request.method !== "GET" && request.method !== "PUT") return json({ error: "method_not_allowed" }, 405);
        const generation = snapshotChunkMatch[2];
        const part = Number(snapshotChunkMatch[3]);
        const key = `vm-snapshots/${identity}/${generation}/${part}.bin`;
        if (request.method === "GET") {
          const object = await env.VM_SNAPSHOTS.get(key);
          if (!object) return json({ error: "snapshot_chunk_not_found" }, 404);
          return new Response(object.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
        }
        if (!request.body) return json({ error: "empty_snapshot_chunk" }, 400);
        await env.VM_SNAPSHOTS.put(key, request.body, { httpMetadata: { contentType: "application/octet-stream" } });
        return json({ ok: true });
      }

      if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
      const prefix = `vm-snapshots/${identity}/`;
      const manifestKey = prefix + "manifest.json";
      if (request.method === "GET") {
        const object = await env.VM_SNAPSHOTS.get(manifestKey);
        if (!object) return json({ error: "snapshot_not_found" }, 404);
        const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        headers.set("x-snapshot-saved-at", object.customMetadata?.savedAt ?? object.uploaded.toISOString());
        return new Response(object.body, { headers });
      }
      if (request.method === "PUT") {
        let manifest: { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown; adminReady?: unknown; checks?: unknown };
        try { manifest = (await request.json()) as { version?: unknown; generation?: unknown; chunks?: unknown; byteLength?: unknown; adminReady?: unknown; checks?: unknown }; }
        catch { return json({ error: "invalid_manifest" }, 400); }
        if (
          manifest.version !== 1 ||
          typeof manifest.generation !== "string" ||
          !/^[a-z0-9-]{1,40}$/.test(manifest.generation) ||
          !Number.isInteger(manifest.chunks) || (manifest.chunks as number) < 1 || (manifest.chunks as number) > 128 ||
          !Number.isInteger(manifest.byteLength) || (manifest.byteLength as number) < 1 || (manifest.byteLength as number) > 536870912 || manifest.chunks !== Math.ceil((manifest.byteLength as number) / 8388608)
        ) return json({ error: "invalid_manifest" }, 400);
        const generation = manifest.generation;
        const count = manifest.chunks as number;
        const present = await Promise.all(Array.from({ length: count }, (_, part) =>
          env.VM_SNAPSHOTS.head(`${prefix}${generation}/${part}.bin`),
        ));
        if (present.some((part) => !part)) return json({ error: "snapshot_chunk_missing" }, 400);
        const savedAt = new Date().toISOString();
        await env.VM_SNAPSHOTS.put(manifestKey, JSON.stringify({
          version: 1, generation, chunks: count, byteLength: manifest.byteLength, savedAt,
          ...(typeof manifest.adminReady === "boolean" ? { adminReady: manifest.adminReady } : {}),
          ...(manifest.checks ? { checks: manifest.checks } : {}),
        }), {
          httpMetadata: { contentType: "application/json" },
          customMetadata: { savedAt },
        });
        // Keep previous generations immutable; only the manifest pointer moves to the new generation.
        return json({ ok: true, savedAt });
      }
      let cursor: string | undefined;
      do {
        const page = await env.VM_SNAPSHOTS.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        if (page.objects.length) await env.VM_SNAPSHOTS.delete(page.objects.map((object) => object.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return json({ ok: true });
    }

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return json({ status: "ok", service: "cloudflare-container-networking" });
    }

    if (url.pathname === "/debug/egress-ip") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

      try {
        const response = await fetch("https://api4.ipify.org?format=json");
        if (!response.ok) {
          return json({ error: "egress_ipv4_lookup_failed", upstream_status: response.status }, 502);
        }

        const data = (await response.json()) as { ip?: string };
        return json({ egress_ipv4: data.ip ?? null });
      } catch (error) {
        return json({
          error: "egress_ipv4_lookup_failed",
          detail: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    if (url.pathname === "/debug/fineproxy-tcp") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

      const target = { hostname: "104.245.241.241", port: 1085 };

      try {
        const socket = connect(target);
        const opened = await socket.opened;

        const writer = socket.writable.getWriter();
        const greeting = new Uint8Array([0x05, 0x01, 0x00]);
        await writer.write(greeting);

        const reader = socket.readable.getReader();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), 5000),
          ),
        ]);

        reader.releaseLock();
        writer.releaseLock();
        await socket.close();

        const bytes = result.value ? Array.from(result.value).map((b) => b.toString(16).padStart(2, "0")) : [];

        return json({
          target: "104.245.241.241:1085",
          tcp_connected: true,
          remote_address: opened.remoteAddress,
          local_address: opened.localAddress,
          socks5_greeting_response_hex: bytes.join(" "),
          socks5_no_auth_accepted: bytes.length >= 2 && bytes[0] === "05" && bytes[1] === "00",
        });
      } catch (error) {
        return json({
          target: "104.245.241.241:1085",
          tcp_connected: false,
          error: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }

    if (url.pathname === "/tunnel") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }

      const role = request.headers.get("x-tunnel-role");
      const nodeId = request.headers.get("x-node-id") ?? "";
      const expected =
        role === "gateway"
          ? env.TUNNEL_TOKEN
          : role === "client"
            ? env.CLIENT_TOKEN
            : undefined;

      if (!authorized(request.headers.get("authorization"), expected)) {
        return json({ error: "unauthorized" }, 401);
      }
      if (!validNodeId(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const hub = env.TUNNEL_HUB.get(env.TUNNEL_HUB.idFromName("global"));
      return hub.fetch(request);
    }

    if (url.pathname === "/v1/nodes") {
      if (request.method !== "GET" && request.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405);
      }

      const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));

      if (request.method === "GET") {
        return registry.fetch("https://node-registry.internal/list");
      }

      return registry.fetch(
        new Request("https://node-registry.internal/create", {
          method: "POST",
          headers: request.headers,
          body: request.body,
        }),
      );
    }

    const runtimeMatch = url.pathname.match(
      /^\/v1\/nodes\/([^/]+)\/runtime(?:\/(start|stop|probe|heartbeat))?$/,
    );

    if (runtimeMatch) {
      const nodeId = runtimeMatch[1];
      const action = runtimeMatch[2];

      if (!validNodeId(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const runtime = env.NODE_RUNTIME.get(env.NODE_RUNTIME.idFromName(nodeId));

      if (!action && request.method === "GET") {
        return runtime.fetch("https://node-runtime.internal/status");
      }

      if (action === "start") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch("https://node-runtime.internal/start", { method: "POST" });
      }

      if (action === "stop") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch("https://node-runtime.internal/stop", { method: "POST" });
      }

      if (action === "probe") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch("https://node-runtime.internal/probe");
      }

      if (action === "heartbeat") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return runtime.fetch(
          new Request("https://node-runtime.internal/heartbeat", {
            method: "POST",
            headers: request.headers,
            body: request.body,
          }),
        );
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    const nodeMatch = url.pathname.match(/^\/v1\/nodes\/([^/]+)$/);

    if (nodeMatch) {
      const nodeId = nodeMatch[1];
      if (!validNodeId(nodeId)) return json({ error: "invalid_node_id" }, 400);

      const registry = env.NODE_REGISTRY.get(env.NODE_REGISTRY.idFromName("global"));

      if (request.method === "GET") {
        return registry.fetch(
          `https://node-registry.internal/node/${encodeURIComponent(nodeId)}`,
        );
      }

      if (request.method === "PATCH") {
        return registry.fetch(
          new Request(
            `https://node-registry.internal/node/${encodeURIComponent(nodeId)}`,
            {
              method: "PATCH",
              headers: request.headers,
              body: request.body,
            },
          ),
        );
      }

      return json({ error: "method_not_allowed" }, 405);
    }

    return env.ASSETS.fetch(request);
  },
};
