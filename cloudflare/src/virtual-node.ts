import { DurableObject } from "cloudflare:workers";
import type { NodeStatus, VirtualNodeRecord } from "./node-registry";

export interface VirtualNodeEnv {
  NODE_REGISTRY: DurableObjectNamespace;
}

export class VirtualNode extends DurableObject {
  private async state(): Promise<VirtualNodeRecord | undefined> {
    return this.ctx.storage.get<VirtualNodeRecord>("state");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/state" && request.method === "GET") {
      const state = await this.state();
      return state
        ? Response.json(state)
        : Response.json({ error: "node_not_initialized" }, { status: 404 });
    }

    if (url.pathname === "/initialize" && request.method === "POST") {
      const incoming = await request.json().catch(() => null) as VirtualNodeRecord | null;
      if (!incoming?.node_id || !incoming.private_ip) {
        return Response.json({ error: "invalid_node_state" }, { status: 400 });
      }

      const current = await this.state();
      if (current && current.node_id !== incoming.node_id) {
        return Response.json({ error: "node_identity_conflict" }, { status: 409 });
      }

      const state: VirtualNodeRecord = {
        ...incoming,
        status: current?.status ?? "provisioning",
        runtime: current?.runtime ?? "control-plane-only",
        updated_at: new Date().toISOString(),
      };

      await this.ctx.storage.put("state", state);
      return Response.json(state, { status: current ? 200 : 201 });
    }

    if (url.pathname === "/health" && request.method === "POST") {
      const current = await this.state();
      if (!current) return Response.json({ error: "node_not_initialized" }, { status: 404 });

      const body = await request.json().catch(() => ({})) as {
        status?: NodeStatus;
        egress_ip?: string | null;
        error?: string | null;
      };

      const state: VirtualNodeRecord = {
        ...current,
        status: body.status ?? "online",
        egress_ip: body.egress_ip ?? current.egress_ip,
        error: body.error ?? null,
        last_health_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await this.ctx.storage.put("state", state);
      return Response.json(state);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
