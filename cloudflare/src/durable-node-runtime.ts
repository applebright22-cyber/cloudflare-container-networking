import { DurableObject } from "cloudflare:workers";

interface RuntimeState {
  node_id: string;
  status: "stopped" | "starting" | "running" | "error";
  started_at: string | null;
  last_error: string | null;
}

const HEALTH_PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

export class DurableNodeRuntime extends DurableObject {
  private starting: Promise<void> | undefined;
  private monitoring: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    if (this.ctx.container?.running) {
      void this.ctx.blockConcurrencyWhile(async () => {
        await this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      });
      this.observeExit();
    }
  }

  private async state(): Promise<RuntimeState> {
    return (await this.ctx.storage.get<RuntimeState>("runtime")) ?? {
      node_id: this.ctx.id.toString(),
      status: "stopped",
      started_at: null,
      last_error: null,
    };
  }

  private async persist(state: RuntimeState): Promise<void> {
    await this.ctx.storage.put("runtime", state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status" && request.method === "GET") {
      const current = await this.state();
      return Response.json({
        ...current,
        container_running: Boolean(this.ctx.container?.running),
        health_port: HEALTH_PORT,
      });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      try {
        await this.ensureStarted();
        const current = await this.state();
        return Response.json(
          { ...current, container_running: Boolean(this.ctx.container?.running) },
          { status: 202 }
        );
      } catch (error) {
        const current = await this.state();
        const failed: RuntimeState = {
          ...current,
          status: "error",
          last_error: error instanceof Error ? error.message : String(error),
        };
        await this.persist(failed);
        return Response.json(failed, { status: 502 });
      }
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      if (this.ctx.container?.running) {
        await this.ctx.container.destroy("virtual node stopped");
      }
      const current = await this.state();
      const stopped: RuntimeState = { ...current, status: "stopped" };
      await this.persist(stopped);
      return Response.json({ ...stopped, container_running: false });
    }

    if (url.pathname === "/probe" && request.method === "GET") {
      if (!this.ctx.container?.running) {
        return Response.json({ error: "container_not_running" }, { status: 409 });
      }
      try {
        const response = await this.ctx.container.getTcpPort(HEALTH_PORT).fetch("http://container/health");
        return new Response(response.body, { status: response.status, headers: response.headers });
      } catch (error) {
        return Response.json(
          { error: "container_not_ready", detail: error instanceof Error ? error.message : String(error) },
          { status: 503 }
        );
      }
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async ensureStarted(): Promise<void> {
    this.starting ??= this.startAndWaitForHealth().finally(() => {
      this.starting = undefined;
    });
    await this.starting;
  }

  private async startAndWaitForHealth(): Promise<void> {
    const current = await this.state();

    if (this.ctx.container?.running) {
      this.observeExit();
      await this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      await this.waitForHealth();
      if (current.status !== "running") {
        await this.persist({
          ...current,
          status: "running",
          started_at: current.started_at ?? new Date().toISOString(),
          last_error: null,
        });
      }
      return;
    }

    const starting: RuntimeState = { ...current, status: "starting", last_error: null };
    await this.persist(starting);

    await this.ctx.container.start({
      image: "cloudflare/debian-trixie",
      entrypoint: [
        "node",
        "-e",
        "require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',runtime:'cloudflare-container'}))}).listen(8080,'0.0.0.0')",
      ],
      enableInternet: true,
      instance: "lite",
    });

    this.observeExit();
    await this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    await this.waitForHealth();

    await this.persist({
      ...starting,
      status: "running",
      started_at: new Date().toISOString(),
      last_error: null,
    });
  }

  private async waitForHealth(): Promise<void> {
    const port = this.ctx.container.getTcpPort(HEALTH_PORT);
    let lastError: unknown;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await port.fetch("http://container/health", { signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Health check returned ${response.status}`);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    throw new Error("Container did not become ready on port 8080", { cause: lastError });
  }

  private observeExit(): void {
    if (this.monitoring) return;
    this.monitoring = this.ctx.container
      .monitor()
      .then(async () => {
        const current = await this.state();
        await this.persist({ ...current, status: "stopped" });
      })
      .catch(async (error: unknown) => {
        const current = await this.state();
        await this.persist({
          ...current,
          status: "error",
          last_error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.monitoring = undefined;
      });
  }
}
