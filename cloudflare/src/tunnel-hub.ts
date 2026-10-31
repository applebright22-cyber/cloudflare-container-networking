import { DurableObject } from "cloudflare:workers";
import { decodeFrame, encodeFrame, FrameType, MAX_PAYLOAD_BYTES } from "./protocol";

interface SessionInfo {
  nodeId: string;
  role: "gateway" | "client";
  connectedAt: number;
  lastSeenAt: number;
}

function errorFrame(nodeId: string, streamId: number, code: string): Uint8Array {
  return encodeFrame({
    type: FrameType.ERROR,
    flags: 0,
    nodeId,
    streamId,
    sequence: 0,
    payload: new TextEncoder().encode(JSON.stringify({ code })),
  });
}

export class TunnelHub extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/tunnel") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
      }
      const nodeId = request.headers.get("x-node-id") ?? "";
      const role = request.headers.get("x-tunnel-role");
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(nodeId) || (role !== "gateway" && role !== "client")) {
        return Response.json({ error: "invalid_session" }, { status: 400 });
      }
      for (const existing of this.ctx.getWebSockets(nodeId)) {
        const attachment = existing.deserializeAttachment() as SessionInfo | null;
        if (attachment?.role === role) existing.close(1012, "session replaced");
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const now = Date.now();
      server.serializeAttachment({ nodeId, role, connectedAt: now, lastSeenAt: now } satisfies SessionInfo);
      this.ctx.acceptWebSocket(server, [nodeId]);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/nodes" && request.method === "GET") {
      const active = new Map<string, SessionInfo>();
      for (const socket of this.ctx.getWebSockets()) {
        try {
          const session = socket.deserializeAttachment() as SessionInfo | null;
          if (session?.nodeId && session.role) active.set(session.nodeId + ":" + session.role, session);
        } catch {
          // A malformed attachment should not make the status endpoint unavailable.
        }
      }
      return Response.json({ nodes: Array.from(active.values()).map((session) => ({
        node_id: session.nodeId,
        role: session.role,
        connected: true,
        connected_at: new Date(session.connectedAt).toISOString(),
        last_seen_at: new Date(session.lastSeenAt).toISOString(),
      })) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = socket.deserializeAttachment() as SessionInfo | null;
    if (!session?.nodeId || !session.role) {
      socket.close(1011, "missing session");
      return;
    }
    if (typeof message === "string" || message.byteLength > 20 + 64 + MAX_PAYLOAD_BYTES) {
      socket.send(errorFrame(session.nodeId, 0, "invalid_frame"));
      return;
    }

    let frame;
    try {
      frame = decodeFrame(message);
    } catch {
      socket.send(errorFrame(session.nodeId, 0, "invalid_frame"));
      return;
    }
    if (frame.nodeId !== session.nodeId) {
      socket.send(errorFrame(session.nodeId, frame.streamId, "node_id_mismatch"));
      return;
    }
    session.lastSeenAt = Date.now();
    socket.serializeAttachment(session);

    if (frame.type === FrameType.PING) {
      socket.send(encodeFrame({ ...frame, type: FrameType.PONG, payload: new Uint8Array() }));
      return;
    }
    if (frame.type === FrameType.PONG) return;

    const allowedFromClient = [FrameType.OPEN_TCP, FrameType.TCP_DATA, FrameType.CLOSE];
    const allowedFromGateway = [FrameType.TCP_OPENED, FrameType.TCP_DATA, FrameType.CLOSE, FrameType.ERROR];
    const allowed = session.role === "client" ? allowedFromClient : allowedFromGateway;
    if (!allowed.includes(frame.type)) {
      socket.send(errorFrame(session.nodeId, frame.streamId, "direction_not_allowed"));
      return;
    }

    const peerRole = session.role === "client" ? "gateway" : "client";
    const peer = this.ctx.getWebSockets(session.nodeId).find((candidate) => {
      if (candidate === socket) return false;
      const attachment = candidate.deserializeAttachment() as SessionInfo | null;
      return attachment?.role === peerRole;
    });
    if (!peer) {
      socket.send(errorFrame(session.nodeId, frame.streamId, "peer_offline"));
      return;
    }
    peer.send(encodeFrame(frame));
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "websocket error");
  }
}
