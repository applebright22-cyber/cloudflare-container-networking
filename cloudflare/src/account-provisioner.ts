import { DurableObject } from "cloudflare:workers";

interface ProvisionerEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  VM_SNAPSHOTS: R2Bucket;
  VM_BASELINE_ID?: string;
}
interface ProvisioningJob {
  identity: string;
  username: string;
  baseline_id: string;
  generation: string;
  status: "queued" | "running" | "complete" | "error";
  created_at: string;
  updated_at: string;
  attempts: number;
  error?: string;
}
interface BaselineManifest {
  version?: unknown;
  generation?: unknown;
  chunks?: unknown;
  byteLength?: unknown;
  savedAt?: unknown;
  adminReady?: unknown;
  checks?: {
    guest_booted?: unknown;
    shell_command_passed?: unknown;
    dhcp_passed?: unknown;
    ca_certificates_passed?: unknown;
  };
}

const SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNKS = 128;
const MAX_ATTEMPTS = 3;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
function validAccountId(value: string): boolean {
  return /^acct-[a-f0-9-]{36}$/.test(value);
}
function baselineIsReady(value: BaselineManifest): boolean {
  const checks = value.checks;
  return value.adminReady === true && Boolean(checks) &&
    checks!.guest_booted === true && checks!.shell_command_passed === true &&
    checks!.dhcp_passed === true && checks!.ca_certificates_passed === true;
}

/**
 * Durable coordinator for cloning the golden Admin snapshot into account-owned R2
 * storage. It intentionally does not import v86 or boot Linux. Chunk writes are
 * idempotent within the job's private generation, and the manifest is published last.
 */
export class AccountProvisioner extends DurableObject<ProvisionerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/start" || request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => null) as { identity?: unknown; username?: unknown; baseline_id?: unknown } | null;
    const identity = typeof body?.identity === "string" ? body.identity.toLowerCase() : "";
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const baselineId = typeof body?.baseline_id === "string" ? body.baseline_id : (this.env.VM_BASELINE_ID ?? "admin");
    if (!validAccountId(identity) || !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(username) ||
        !/^[a-zA-Z0-9._-]{1,64}$/.test(baselineId) || baselineId.startsWith("acct-")) {
      return json({ error: "invalid_snapshot_clone_job" }, 400);
    }

    const existing = await this.ctx.storage.get<ProvisioningJob>("job");
    if (existing?.identity === identity && ["queued", "running", "complete"].includes(existing.status)) {
      return json({ accepted: true, status: existing.status, identity, generation: existing.generation }, 202);
    }
    const now = new Date().toISOString();
    const job: ProvisioningJob = {
      identity, username, baseline_id: baselineId, generation: crypto.randomUUID(),
      status: "queued", created_at: now, updated_at: now, attempts: 0,
    };
    await this.ctx.storage.put("job", job);
    await this.writeProgress(job, "queued", "queued", { snapshot_cloned: false });
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return json({ accepted: true, status: "queued", identity, generation: job.generation }, 202);
  }

  async alarm(): Promise<void> {
    let job = await this.ctx.storage.get<ProvisioningJob>("job");
    if (!job || job.status === "complete" || job.status === "error") {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    job = { ...job, status: "running", attempts: job.attempts + 1, updated_at: new Date().toISOString() };
    await this.ctx.storage.put("job", job);
    // Watchdog: if this alarm is hard-terminated, the next invocation can safely
    // repeat the copy using the same generation without publishing partial state.
    await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);

    try {
      const baselinePrefix = "vm-snapshots/" + job.baseline_id + "/";
      const manifestObject = await this.env.VM_SNAPSHOTS.get(baselinePrefix + "manifest.json");
      if (!manifestObject) throw new Error("admin_baseline_snapshot_not_found");
      const baseline = await manifestObject.json<BaselineManifest>();
      if (baseline.version !== 1 || typeof baseline.generation !== "string" ||
          !/^[a-z0-9-]{1,40}$/.test(baseline.generation) ||
          !Number.isInteger(baseline.chunks) || (baseline.chunks as number) < 1 ||
          (baseline.chunks as number) > MAX_CHUNKS ||
          !Number.isInteger(baseline.byteLength) || (baseline.byteLength as number) < 1 ||
          (baseline.byteLength as number) > 536870912 ||
          baseline.chunks !== Math.ceil((baseline.byteLength as number) / SNAPSHOT_CHUNK_BYTES)) {
        throw new Error("admin_baseline_manifest_invalid");
      }
      if (job.baseline_id === "admin" && !baselineIsReady(baseline)) {
        throw new Error("admin_baseline_not_ready");
      }

      const sourcePrefix = baselinePrefix + baseline.generation + "/";
      const accountPrefix = "vm-snapshots/" + job.identity + "/";
      const generationPrefix = accountPrefix + job.generation + "/";
      const count = baseline.chunks as number;
      for (let part = 0; part < count; part++) {
        const expectedBytes = Math.min(SNAPSHOT_CHUNK_BYTES, (baseline.byteLength as number) - part * SNAPSHOT_CHUNK_BYTES);
        const source = await this.env.VM_SNAPSHOTS.get(sourcePrefix + part + ".bin");
        if (!source || source.size !== expectedBytes) throw new Error("admin_baseline_chunk_missing_or_invalid_" + part);
        const targetKey = generationPrefix + part + ".bin";
        await this.env.VM_SNAPSHOTS.put(targetKey, source.body, {
          httpMetadata: { contentType: "application/octet-stream" },
        });
        const copied = await this.env.VM_SNAPSHOTS.head(targetKey);
        if (!copied || copied.size !== expectedBytes) throw new Error("account_snapshot_chunk_copy_verification_failed_" + part);
        job = { ...job, updated_at: new Date().toISOString() };
        await this.writeProgress(job, "running", "snapshot_cloning", {
          baseline_id: job.baseline_id, baseline_generation: baseline.generation,
          chunks_copied: part + 1, chunks_total: count,
          byte_length: baseline.byteLength, snapshot_cloned: false,
        });
        await this.ctx.storage.setAlarm(Date.now() + 15 * 60 * 1000);
      }

      const savedAt = new Date().toISOString();
      const clonedManifest = {
        version: 1, identity: job.identity, generation: job.generation,
        chunks: count, byteLength: baseline.byteLength, savedAt,
        baselineId: job.baseline_id, baselineGeneration: baseline.generation,
        clonedFrom: baselinePrefix + "manifest.json",
        baselineSavedAt: typeof baseline.savedAt === "string" ? baseline.savedAt : null,
        adminReady: baseline.adminReady === true, checks: baseline.checks ?? null,
      };
      await this.writeProgress(job, "running", "snapshot_verified", {
        baseline_id: job.baseline_id, baseline_generation: baseline.generation,
        chunks_copied: count, chunks_total: count, byte_length: baseline.byteLength,
        snapshot_cloned: false,
      });
      // Publish the account manifest last; readers never see an incomplete generation.
      await this.env.VM_SNAPSHOTS.put(accountPrefix + "manifest.json", JSON.stringify(clonedManifest), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { savedAt, baselineId: job.baseline_id, baselineGeneration: baseline.generation },
      });

      const account = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName(job.identity));
      const auth = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName("auth-users"));
      const accountReady = await account.fetch("https://account-registry.internal/account/" + job.identity, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "ready" }),
      });
      const authReady = await auth.fetch("https://account-registry.internal/auth/status", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: job.username, status: "ready" }),
      });
      if (!accountReady.ok || !authReady.ok) throw new Error("account_ready_transition_failed");

      job = { ...job, status: "complete", updated_at: new Date().toISOString() };
      await this.ctx.storage.put("job", job);
      await this.writeProgress(job, "complete", "complete", {
        complete: true, ready_to_login: true, snapshot_cloned: true,
        baseline_id: job.baseline_id, baseline_generation: baseline.generation,
        generation: job.generation, chunks: count, byte_length: baseline.byteLength,
      });
      await this.ctx.storage.deleteAlarm();
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      if (job.attempts < MAX_ATTEMPTS) {
        job = { ...job, status: "queued", error: message, updated_at: new Date().toISOString() };
        await this.ctx.storage.put("job", job);
        await this.writeProgress(job, "queued", "snapshot_cloning", {
          error: message, retry_attempt: job.attempts, retry_limit: MAX_ATTEMPTS,
          note: "Snapshot copy will retry; Linux is not being booted.",
        });
        await this.ctx.storage.setAlarm(Date.now() + 10_000);
        return;
      }

      job = { ...job, status: "error", error: message, updated_at: new Date().toISOString() };
      await this.ctx.storage.put("job", job);
      const account = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName(job.identity));
      const auth = this.env.ACCOUNT_REGISTRY.get(this.env.ACCOUNT_REGISTRY.idFromName("auth-users"));
      await account.fetch("https://account-registry.internal/account/" + job.identity, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "error", error: message }),
      });
      await auth.fetch("https://account-registry.internal/auth/status", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: job.username, status: "error" }),
      });
      await this.writeProgress(job, "error", "failed", { error: message, snapshot_cloned: false });
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async writeProgress(
    job: ProvisioningJob, status: string, step: string, details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.env.VM_SNAPSHOTS.put("runtime-jobs/" + job.identity + ".json", JSON.stringify({
      identity: job.identity, username: job.username, status, step,
      created_at: job.created_at, updated_at: new Date().toISOString(),
      baseline_id: job.baseline_id, generation: job.generation, attempts: job.attempts,
      ...details,
    }), { httpMetadata: { contentType: "application/json" } });
  }
}
