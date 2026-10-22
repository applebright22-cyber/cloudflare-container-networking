import { DurableObject } from "cloudflare:workers";

interface AgentAttachment {
  identity: string;
  connectedAt: number;
  lastSeenAt: number;
}
interface Ticket { identity: string; expiresAt: number; }

interface ExecRequest {
  command: string;
  timeout_ms?: number;
}
interface ExecResult {
  type: "result";
  id: string;
  stdout: string;
  stderr?: string;
  exit_code: number | null;
  timed_out?: boolean;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function validIdentity(value: string | null): value is string {
  return !!value && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

export class VmExecution extends DurableObject {
  private pending = new Map<string, (response: Response) => void>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ticket" && request.method === "POST") {
      let body: { ticket?: unknown; identity?: unknown };
      try { body = await request.json() as typeof body; }
      catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body.ticket !== "string" || !/^[a-f0-9-]{36}$/.test(body.ticket) ||
          typeof body.identity !== "string" || !validIdentity(body.identity)) {
        return json({ error: "invalid_ticket_request" }, 400);
      }
      await this.ctx.storage.put(`ticket:${body.ticket}`, {
        identity: body.identity,
        expiresAt: Date.now() + 60_000,
      } satisfies Ticket);
      return json({ ok: true, expires_in_seconds: 60 });
    }

    if ((url.pathname === "/agent" || url.pathname === "/api/vm/agent") && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket_upgrade_required" }, 426);
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      const record = await this.ctx.storage.get<Ticket>(`ticket:${ticket}`);
      if (!record || record.expiresAt < Date.now()) {
        if (record) await this.ctx.storage.delete(`ticket:${ticket}`);
        return json({ error: "invalid_or_expired_agent_ticket" }, 401);
      }
      await this.ctx.storage.delete(`ticket:${ticket}`);
      for (const socket of this.ctx.getWebSockets(record.identity)) {
        socket.close(1012, "VM agent replaced");
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const attachment: AgentAttachment = {
        identity: record.identity,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      server.serializeAttachment(attachment);
      this.ctx.acceptWebSocket(server, [record.identity]);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const identity = url.searchParams.get("identity");
      if (!validIdentity(identity)) return json({ error: "invalid_vm_id" }, 400);
      const socket = this.ctx.getWebSockets(identity).find((candidate) => candidate.readyState === WebSocket.OPEN);
      if (!socket) return json({ vm_id: identity, status: "offline", execution_available: false });
      const attachment = socket.deserializeAttachment() as AgentAttachment;
      return json({
        vm_id: identity,
        status: "online",
        execution_available: true,
        connected_at: new Date(attachment.connectedAt).toISOString(),
        last_seen_at: new Date(attachment.lastSeenAt).toISOString(),
        runtime: attachment.identity === "oracle" ? "oracle-host" : "browser-v86",
        limitation: attachment.identity === "oracle"
          ? "Commands execute on the connected persistent Oracle host."
          : "The browser tab must remain open for browser-v86 command execution.",
      });
    }

    if (url.pathname === "/exec" && request.method === "POST") {
      const identity = request.headers.get("x-vm-id");
      if (!validIdentity(identity)) return json({ error: "invalid_or_missing_vm_id" }, 400);
      let body: ExecRequest;
      try { body = await request.json() as ExecRequest; }
      catch { return json({ error: "invalid_json" }, 400); }
      if (typeof body.command !== "string" || body.command.trim().length === 0 || body.command.length > 4096) {
        return json({ error: "command_must_be_1_to_4096_characters" }, 400);
      }
      const timeout = body.timeout_ms === undefined ? 15_000 : body.timeout_ms;
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 20_000) {
        return json({ error: "timeout_ms_must_be_1000_to_20000" }, 400);
      }
      // The Oracle connection is a single transport, but each command must name
      // the authenticated account session that Oracle will execute in.
      const requestedAccount = request.headers.get("x-account-id");
      const accountId = identity === "admin" ? "admin" : (requestedAccount ?? "");
      if (identity === "admin" && accountId !== "admin") return json({ error: "invalid_account_id" }, 400);
      if (identity === "oracle" && accountId !== "admin" && !/^acct-[a-f0-9-]{36}$/.test(accountId)) {
        return json({ error: "invalid_or_missing_account_id" }, 400);
      }
      if (identity !== "admin" && identity !== "oracle") {
        return json({ error: "unsupported_execution_transport" }, 400);
      }
      const socket = this.ctx.getWebSockets(identity).find((candidate) => candidate.readyState === WebSocket.OPEN);
      if (!socket) return json({ error: "vm_offline", vm_id: identity, hint: "The Oracle outbound agent must be connected before execution." }, 503);

      const id = crypto.randomUUID();
      try {
        socket.send(JSON.stringify({ type: "exec", id, account_id: accountId, command: body.command, timeout_ms: timeout }));
      } catch {
        return json({ error: "vm_agent_send_failed" }, 502);
      }
      return await new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve(json({ error: "execution_timeout", id, timeout_ms: timeout }, 504));
        }, timeout + 1500);
        this.pending.set(id, (response) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(response);
        });
      });
    }

    return json({ error: "not_found" }, 404);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as AgentAttachment | null;
    if (!attachment?.identity || typeof message !== "string" || message.length > 64 * 1024) {
      socket.close(1008, "invalid agent message");
      return;
    }
    attachment.lastSeenAt = Date.now();
    socket.serializeAttachment(attachment);
    let body: ExecResult | { type: "heartbeat" };
    try { body = JSON.parse(message) as typeof body; }
    catch { socket.close(1008, "invalid JSON"); return; }
    if (body.type === "heartbeat") return;
    if (body.type !== "result" || typeof body.id !== "string" ||
        typeof body.stdout !== "string" ||
        !(body.exit_code === null || Number.isInteger(body.exit_code))) {
      socket.close(1008, "invalid result");
      return;
    }
    this.pending.get(body.id)?.(json({
      vm_id: attachment.identity,
      execution_id: body.id,
      stdout: body.stdout,
      stderr: typeof body.stderr === "string" ? body.stderr : "",
      exit_code: body.exit_code,
      timed_out: body.timed_out === true,
      runtime: attachment.identity === "oracle" ? "oracle-host" : "browser-v86",
      notice: attachment.identity === "oracle"
        ? "Command executed by the connected Oracle host executor."
        : "Command executed in the connected browser v86 agent.",
    }));
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    socket.close(1000, "closed");
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "agent websocket error");
  }
}
