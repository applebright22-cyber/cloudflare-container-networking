export interface ProjectStorageEnv {
  ACCOUNT_REGISTRY: DurableObjectNamespace;
  PROJECT_STORAGE: R2Bucket;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
  }});
}

/** Handles account-scoped project document requests. Returns null for unrelated paths. */
export async function handleProjectStorageRequest(request: Request, env: ProjectStorageEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/studio/projects" && !/^\/api\/studio\/projects\/[a-z0-9-]{3,80}$/.test(url.pathname)) return null;
  if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") return json({ error: "method_not_allowed" }, 405);
  const accountId = url.searchParams.get("account_id") ?? "";
  const sessionToken = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7) : "";
  if (!/^acct-[a-f0-9-]{36}$/.test(accountId) || !/^[a-f0-9]{64}$/.test(sessionToken)) return json({ error: "unauthorized" }, 401);
  const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
  const verified = await authRegistry.fetch("https://account-registry.internal/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId, token: sessionToken }),
  });
  if (!verified.ok) return json({ error: "unauthorized" }, 401);

  const prefix = "accounts/" + accountId + "/projects/";
  const projectId = url.pathname === "/api/studio/projects" ? "" : url.pathname.slice("/api/studio/projects/".length);
  if (request.method === "GET") {
    const projects: unknown[] = [];
    let cursor: string | undefined;
    let usedBytes = 0;
    do {
      const page = await env.PROJECT_STORAGE.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const item of page.objects) {
        usedBytes += item.size;
        const object = await env.PROJECT_STORAGE.get(item.key);
        if (!object) continue;
        try { projects.push(await object.json()); } catch { /* skip corrupt documents */ }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ ok: true, projects, usage: { projects: projects.length, bytes: usedBytes, limit_bytes: 20 * 1024 * 1024, limit_projects: 50 } });
  }
  if (!projectId) return json({ error: "project_id_required" }, 400);
  const key = prefix + projectId + ".json";
  if (request.method === "DELETE") {
    await env.PROJECT_STORAGE.delete(key);
    return json({ ok: true, deleted: projectId });
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 1024 * 1024) return json({ error: "project_too_large", max_bytes: 1024 * 1024 }, 413);
  let project: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) return json({ error: "project_too_large", max_bytes: 1024 * 1024 }, 413);
    project = JSON.parse(raw) as Record<string, unknown>;
  } catch { return json({ error: "invalid_project_json" }, 400); }
  if (!project || project.id !== projectId || typeof project.name !== "string" || project.name.trim().length < 1 ||
      project.name.length > 80 || typeof project.kind !== "string" || project.kind.length > 40) return json({ error: "invalid_project_document" }, 400);
  const body = JSON.stringify(project);
  const size = new TextEncoder().encode(body).byteLength;
  const existing = await env.PROJECT_STORAGE.head(key);
  let totalBytes = 0, count = 0, cursor: string | undefined;
  do {
    const page = await env.PROJECT_STORAGE.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    count += page.objects.length;
    for (const item of page.objects) totalBytes += item.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (!existing && count >= 50) return json({ error: "project_limit_reached", limit_projects: 50 }, 409);
  if (totalBytes - (existing?.size ?? 0) + size > 20 * 1024 * 1024) return json({ error: "storage_limit_reached", limit_bytes: 20 * 1024 * 1024 }, 413);
  await env.PROJECT_STORAGE.put(key, body, { httpMetadata: { contentType: "application/json; charset=utf-8" }, customMetadata: { accountId, projectId, updatedAt: new Date().toISOString() } });
  return json({ ok: true, project_id: projectId, bytes: size });
}
