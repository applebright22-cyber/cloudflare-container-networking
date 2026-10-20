import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

interface TicketRecord { ticket: string; expires_at: number; }
interface TcpStream {
  socket: Awaited<ReturnType<typeof connect>>;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  sendCredit: number;
  creditWaiters: Set<() => void>;
}

const INITIAL_BUFFER = 64;
const MAX_STREAMS = 32;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function packet(type: number, streamId: number, payload = new Uint8Array()): ArrayBuffer {
  const result = new Uint8Array(5 + payload.byteLength);
  result[0] = type;
  new DataView(result.buffer).setUint32(1, streamId >>> 0, true);
  result.set(payload, 5);
  return result.buffer;
}

function continuePacket(streamId: number, count: number): ArrayBuffer {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, count, true);
  return packet(0x03, streamId, payload);
}

function closePacket(streamId: number, reason: number): ArrayBuffer {
  return packet(0x04, streamId, new Uint8Array([reason]));
}

function isAllowedDestination(host: string, port: number): boolean {
  if (port !== 80 && port !== 443) return false;
  // v86's WISP adapter sends the resolved IPv4 destination, not the original hostname.
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 ||
      a === 192 && b === 2 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
      a === 203 && b === 0 && c === 113 || a === 198 && b === 51 && c === 100) return false;
  return true;
}

/**
 * Authenticated WISP-v1 TCP relay for v86. The synthetic DHCP/DNS/router are provided
 * by v86's WISP backend; this Durable Object only forwards authenticated TCP streams.
 * Egress is restricted to public IPv4 destinations on HTTP(S) ports; tickets expire after eight hours.
 */
export class WispRelay extends DurableObject {
  private streams = new Map<number, TcpStream>();
  private clients = new Set<WebSocket>();
  private pendingStreams = new Set<number>();
  private closedStreams = new Set<number>();
  private loggedGuestData = new Set<number>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ticket" && request.method === "POST") {
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const ticket = Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      await this.ctx.storage.put("active-ticket", { ticket, expires_at: Date.now() + 8 * 60 * 60 * 1000 } satisfies TicketRecord);
      return json({ ticket, expires_in_seconds: 8 * 60 * 60 }, 201);
    }

    if ((url.pathname !== "/wisp" && url.pathname !== "/api/network/wisp/") || request.method !== "GET") return json({ error: "not_found" }, 404);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "websocket_upgrade_required" }, 426);
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!/^[a-f0-9]{64}$/.test(ticket)) return json({ error: "invalid_network_ticket" }, 401);
    const record = await this.ctx.storage.get<TicketRecord>("active-ticket");
    if (!record || record.ticket !== ticket || record.expires_at <= Date.now()) return json({ error: "expired_network_ticket" }, 401);

    for (const existing of this.clients) {
      try { existing.close(1012, "network session replaced"); } catch { /* already closed */ }
    }
    this.clients.clear();
    await Promise.all(Array.from(this.streams.keys(), (streamId) => this.closeStream(streamId)));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.binaryType = "arraybuffer";
    // This relay keeps live TCP Socket objects in memory. Use a non-hibernating
    // WebSocket accept so the Durable Object cannot evict those streams while idle.
    server.accept();
    this.clients.add(server);
    server.addEventListener("message", (event) => {
      void this.webSocketMessage(server, event.data as string | ArrayBuffer);
    });
    server.addEventListener("close", () => { void this.webSocketClose(server); });
    server.addEventListener("error", () => { void this.webSocketError(server); });
    // Sending CONTINUE first selects WISP v1, which is supported by v86.
    server.send(continuePacket(0, INITIAL_BUFFER));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" || message.byteLength < 5 || message.byteLength > 1024 * 1024) {
      socket.close(1003, "binary WISP packets required");
      return;
    }
    const bytes = new Uint8Array(message);
    const view = new DataView(message);
    const type = bytes[0];
    const streamId = view.getUint32(1, true);
    const payload = bytes.subarray(5);

    if (type === 0x01) {
      await this.openTcp(socket, streamId, payload);
      return;
    }
    if (type === 0x02) {
      const stream = this.streams.get(streamId);
      if (!stream) {
        socket.send(closePacket(streamId, 0x41));
        return;
      }
      try {
        if (!this.loggedGuestData.has(streamId)) {
          console.log("WISP_FIRST_GUEST_DATA", JSON.stringify({ streamId, bytes: payload.byteLength, prefix: new TextDecoder().decode(payload.subarray(0, 80)) }));
          this.loggedGuestData.add(streamId);
        }
        await stream.writer.write(payload);
        socket.send(continuePacket(streamId, INITIAL_BUFFER));
      } catch {
        socket.send(closePacket(streamId, 0x03));
        await this.closeStream(streamId, stream);
      }
      return;
    }
    if (type === 0x03) {
      // CONTINUE grants the relay permission to send response bytes to the guest.
      // Treating this control packet as unsupported closed HTTP(S) streams before
      // the guest could receive package downloads or HTTPS responses.
      if (streamId === 0) return;
      if (payload.byteLength < 4) { socket.send(closePacket(streamId, 0x01)); return; }
      const credit = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
      console.log("WISP_CONTINUE_RECEIVED", JSON.stringify({ streamId, credit }));
      const stream = this.streams.get(streamId);
      if (stream && credit > 0) {
        stream.sendCredit = Math.min(4 * 1024 * 1024, stream.sendCredit + credit);
        for (const wake of stream.creditWaiters) wake();
        stream.creditWaiters.clear();
      }
      return;
    }
    if (type === 0x04) {
      if (this.pendingStreams.has(streamId)) this.closedStreams.add(streamId);
      await this.closeStream(streamId);
      return;
    }
    // WISP clients may send INFO before v1 fallback; ignore unsupported control frames.
    if (type !== 0x05 && streamId !== 0) socket.send(closePacket(streamId, 0x01));
  }

  private async openTcp(socket: WebSocket, streamId: number, payload: Uint8Array): Promise<void> {
    this.closedStreams.delete(streamId);
    if (streamId === 0 || payload.byteLength < 4 || this.streams.size + this.pendingStreams.size >= MAX_STREAMS) {
      socket.send(closePacket(streamId, 0x41));
      return;
    }
    const port = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(1, true);
    const host = new TextDecoder().decode(payload.subarray(3)).trim();
    if (payload[0] !== 0x01 || !isAllowedDestination(host, port)) {
      console.warn("WISP_CONNECT_REJECTED", JSON.stringify({ streamId, host, port, protocol: payload[0] }));
      socket.send(closePacket(streamId, 0x48));
      return;
    }
    console.log("WISP_CONNECT_REQUEST", JSON.stringify({ streamId, host, port }));
    if (this.streams.has(streamId)) await this.closeStream(streamId);

    this.pendingStreams.add(streamId);
    try {
      const tcp = connect({ hostname: host, port });
      await tcp.opened;
      console.log("WISP_CONNECT_OPENED", JSON.stringify({ streamId, host, port }));
      this.pendingStreams.delete(streamId);
      if (this.closedStreams.has(streamId) || socket.readyState !== WebSocket.OPEN) {
        this.closedStreams.delete(streamId);
        try { tcp.close(); } catch { /* already closed */ }
        return;
      }
      const stream: TcpStream = {
        socket: tcp,
        writer: tcp.writable.getWriter(),
        reader: tcp.readable.getReader(),
        sendCredit: 0,
        creditWaiters: new Set(),
      };
      this.streams.set(streamId, stream);
      // v86's WISP adapter waits for per-stream send credit before emitting DATA.
      // Defer the initial credit briefly so the adapter can finish registering the
      // stream after its CONNECT packet; sending it synchronously can race that setup.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (socket.readyState !== WebSocket.OPEN || !this.streams.has(streamId)) {
        await this.closeStream(streamId, stream);
        return;
      }
      socket.send(continuePacket(streamId, INITIAL_BUFFER));
      console.log("WISP_STREAM_CREDIT_SENT", JSON.stringify({ streamId, buffer: INITIAL_BUFFER }));
      void this.pumpTcpToWebSocket(socket, streamId, stream);
    } catch (error) {
      console.error("WISP_CONNECT_FAILED", JSON.stringify({ streamId, host, port, error: String(error) }));
      this.pendingStreams.delete(streamId);
      this.closedStreams.delete(streamId);
      socket.send(closePacket(streamId, 0x42));
    }
  }

  private async pumpTcpToWebSocket(socket: WebSocket, streamId: number, stream: TcpStream): Promise<void> {
    let loggedFirstRead = false;
    try {
      while (socket.readyState === WebSocket.OPEN) {
        const { value, done } = await stream.reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (!loggedFirstRead) {
          console.log("WISP_FIRST_TCP_DATA", JSON.stringify({ streamId, bytes: value.byteLength }));
          loggedFirstRead = true;
        }
        let offset = 0;
        while (offset < value.byteLength && socket.readyState === WebSocket.OPEN) {
          if (stream.sendCredit <= 0) {
            await new Promise<void>((resolve) => stream.creditWaiters.add(() => resolve()));
            if (socket.readyState !== WebSocket.OPEN) break;
          }
          const count = Math.min(value.byteLength - offset, stream.sendCredit, 64 * 1024);
          if (count <= 0) continue;
          stream.sendCredit -= count;
          socket.send(packet(0x02, streamId, value.subarray(offset, offset + count)));
          offset += count;
        }
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(closePacket(streamId, 0x02));
    } catch {
      if (socket.readyState === WebSocket.OPEN) socket.send(closePacket(streamId, 0x03));
    } finally {
      await this.closeStream(streamId, stream);
    }
  }

  private async closeStream(streamId: number, expected?: TcpStream): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream || expected && stream !== expected) return;
    this.streams.delete(streamId);
    this.loggedGuestData.delete(streamId);
    for (const wake of stream.creditWaiters) wake();
    stream.creditWaiters.clear();
    try { await stream.writer.close(); } catch { /* already closed */ }
    try { await stream.reader.cancel(); } catch { /* already closed */ }
    try { stream.socket.close(); } catch { /* already closed */ }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.clients.delete(socket);
    await Promise.all(Array.from(this.streams.keys(), (streamId) => this.closeStream(streamId)));
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.clients.delete(socket);
    try { if (socket.readyState === WebSocket.OPEN) socket.close(1011, "WISP relay error"); } catch { /* already closed */ }
    await Promise.all(Array.from(this.streams.keys(), (streamId) => this.closeStream(streamId)));
  }
}
