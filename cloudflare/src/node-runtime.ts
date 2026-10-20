import { DurableObject } from "cloudflare:workers";

interface RuntimeState {
  node_id: string;
  status: "stopped" | "starting" | "running" | "error";
  started_at: string | null;
  last_error: string | null;
  runner_seen_at: string | null;
  runner_status: "offline" | "online";
}

export class NodeRuntime extends DurableObject {
  private async state(): Promise<RuntimeState> {
    return (await this.ctx.storage.get<RuntimeState>("runtime")) ?? {
      node_id: this.ctx.id.toString(),
      // A persistent Tiny Core runner should start the node as soon as it boots.
      status: "starting",
      started_at: null,
      last_error: null,
      runner_seen_at: null,
      runner_status: "offline",
    };
  }

  private async persist(state: RuntimeState): Promise<void> {
    await this.ctx.storage.put("runtime", state);
  }

  private async withRunnerLiveness(state: RuntimeState): Promise<RuntimeState> {
    if (state.runner_status === "online" && state.runner_seen_at) {
      const age = Date.now() - Date.parse(state.runner_seen_at);
      if (!Number.isFinite(age) || age > 30_000) {
        const offline = { ...state, runner_status: "offline" as const };
        await this.persist(offline);
        return offline;
      }
    }
    return state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const current = await this.state();

    if (url.pathname === "/status" && request.method === "GET") {
      return Response.json({
        ...current,
        runtime: "external-gateway",
        container_running: false,
      });
    }

    if (url.pathname === "/start" && request.method === "POST") {
      const next: RuntimeState = {
        ...current,
        status: "starting",
        started_at: current.started_at ?? new Date().toISOString(),
        last_error: null,
      };
      await this.persist(next);
      return Response.json({
        ...next,
        runtime: "external-gateway",
        container_running: false,
      }, { status: 202 });
    }

    if (url.pathname === "/stop" && request.method === "POST") {
      const next: RuntimeState = {
        ...current,
        status: "stopped",
        runner_status: current.runner_status,
      };
      await this.persist(next);
      return Response.json({
        ...next,
        runtime: "external-gateway",
        container_running: false,
      });
    }

    if (url.pathname === "/probe" && request.method === "GET") {
      return Response.json({
        node_id: current.node_id,
        status: current.status,
        runtime: "external-gateway",
        container_running: false,
        runner_status: current.runner_status,
        runner_seen_at: current.runner_seen_at,
      });
    }

    if (url.pathname === "/heartbeat" && request.method === "POST") {
      const next: RuntimeState = {
        ...current,
        runner_status: "online",
        runner_seen_at: new Date().toISOString(),
      };
      await this.persist(next);
      return Response.json({
        node_id: next.node_id,
        desired_status: next.status,
        runner_status: next.runner_status,
        runner_seen_at: next.runner_seen_at,
      });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
