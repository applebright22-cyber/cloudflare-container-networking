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
  const publicSiteMatch = url.pathname.match(/^\/sites\/([a-f0-9]{32})\/?$/);
  if (publicSiteMatch && request.method === "GET") {
    const mapping = await env.PROJECT_STORAGE.get("published-sites/index/" + publicSiteMatch[1] + ".json");
    if (!mapping) return json({ error: "site_not_found" }, 404);
    const object = await env.PROJECT_STORAGE.get("published-sites/" + publicSiteMatch[1] + "/index.html");
    if (!object) return json({ error: "published_file_missing" }, 404);
    return new Response(object.body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" } });
  }
  const publishMatch = url.pathname === "/api/studio/publish";
  if (publishMatch) {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const accountId = url.searchParams.get("account_id") ?? "";
    const sessionToken = request.headers.get("authorization")?.startsWith("Bearer ") ? request.headers.get("authorization")!.slice(7) : "";
    if (!/^acct-[a-f0-9-]{36}$/.test(accountId) || !/^[a-f0-9]{64}$/.test(sessionToken)) return json({ error: "unauthorized" }, 401);
    const authRegistry = env.ACCOUNT_REGISTRY.get(env.ACCOUNT_REGISTRY.idFromName("auth-users"));
    const verified = await authRegistry.fetch("https://account-registry.internal/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account_id: accountId, token: sessionToken }) });
    if (!verified.ok) return json({ error: "unauthorized" }, 401);
    const body = await request.json().catch(() => null) as { project_id?: unknown; html?: unknown } | null;
    if (typeof body?.project_id !== "string" || !/^[a-z0-9-]{3,80}$/.test(body.project_id) || typeof body.html !== "string") return json({ error: "invalid_publish_request" }, 400);
    const htmlBytes = new TextEncoder().encode(body.html);
    if (htmlBytes.byteLength < 30 || htmlBytes.byteLength > 1024 * 1024) return json({ error: "published_site_size_invalid", max_bytes: 1048576 }, 413);
    const projectKey = "accounts/" + accountId + "/projects/" + body.project_id + ".json";
    const projectObject = await env.PROJECT_STORAGE.get(projectKey);
    if (!projectObject) return json({ error: "project_not_found" }, 404);
    let project: Record<string, unknown>;
    try { project = await projectObject.json() as Record<string, unknown>; } catch { return json({ error: "project_record_invalid" }, 500); }
    if (project.id !== body.project_id) return json({ error: "project_owner_mismatch" }, 403);
    const slug = typeof project.publishSlug === "string" && /^[a-f0-9]{32}$/.test(project.publishSlug) ? project.publishSlug : crypto.randomUUID().replace(/-/g, "");
    const publishedUrl = new URL("/sites/" + slug + "/", request.url).toString();
    project.publishSlug = slug;
    project.publishedUrl = publishedUrl;
    project.publishedAt = new Date().toISOString();
    await env.PROJECT_STORAGE.put("published-sites/" + slug + "/index.html", htmlBytes, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await env.PROJECT_STORAGE.put("published-sites/index/" + slug + ".json", JSON.stringify({ account_id: accountId, project_id: body.project_id, published_at: project.publishedAt }), { httpMetadata: { contentType: "application/json" } });
    await env.PROJECT_STORAGE.put(projectKey, JSON.stringify(project), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
    return json({ ok: true, project_id: body.project_id, published_at: project.publishedAt, url: publishedUrl });
  }

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
