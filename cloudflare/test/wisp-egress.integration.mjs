import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import tls from "node:tls";
import { Duplex } from "node:stream";

const base = process.env.WORKER_BASE_URL ?? "http://127.0.0.1:8789";
const identity = "test-wisp-egress";
const timeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(label + "_timeout")), ms)),
]);

const ticketResponse = await fetch(base + "/test-ticket", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identity }),
});
assert.equal(ticketResponse.status, 201, "WISP test ticket endpoint must create a ticket");
const { ticket } = await ticketResponse.json();
assert.match(ticket, /^[a-f0-9]{64}$/, "WISP ticket must be a 64-character hex token");

const socketUrl = new URL("/api/network/wisp/", base);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
socketUrl.searchParams.set("identity", identity);
socketUrl.searchParams.set("ticket", ticket);
const ws = new WebSocket(socketUrl);
ws.binaryType = "arraybuffer";

let resolveInitialCredit;
let rejectInitialCredit;
const initialCredit = new Promise((resolve, reject) => {
  resolveInitialCredit = resolve;
  rejectInitialCredit = reject;
});
const streams = new Map();

function sendPacket(packet) {
  if (ws.readyState !== WebSocket.OPEN) throw new Error("wisp_websocket_not_open");
  ws.send(packet);
}

function connectPacket(streamId, ipv4, port) {
  const host = new TextEncoder().encode(ipv4);
  const packet = new Uint8Array(8 + host.length);
  const view = new DataView(packet.buffer);
  view.setUint8(0, 1);
  view.setUint32(1, streamId, true);
  view.setUint8(5, 1);
  view.setUint16(6, port, true);
  packet.set(host, 8);
  return packet;
}

function dataPacket(streamId, payload) {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const packet = new Uint8Array(5 + bytes.length);
  const view = new DataView(packet.buffer);
  view.setUint8(0, 2);
  view.setUint32(1, streamId, true);
  packet.set(bytes, 5);
  return packet;
}

function closePacket(streamId, reason = 2) {
  const packet = new Uint8Array(6);
  const view = new DataView(packet.buffer);
  view.setUint8(0, 4);
  view.setUint32(1, streamId, true);
  view.setUint8(5, reason);
  return packet;
}

function handleMessage(event) {
  const bytes = new Uint8Array(event.data);
  if (bytes.length < 5) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  const streamId = view.getUint32(1, true);

  if (type === 3) {
    if (bytes.length < 9) return;
    const credit = view.getUint32(5, true);
    if (streamId === 0) {
      resolveInitialCredit(credit);
      return;
    }
    const stream = streams.get(streamId);
    if (stream) {
      stream.credit = credit;
      stream.onCredit?.(credit);
      for (const resolve of stream.creditWaiters.splice(0)) resolve();
    }
  } else if (type === 2) {
    const stream = streams.get(streamId);
    if (stream) stream.onData?.(bytes.slice(5));
  } else if (type === 4) {
    const stream = streams.get(streamId);
    if (stream) {
      stream.closed = true;
      stream.onClose?.();
      for (const reject of stream.closeWaiters.splice(0)) reject(new Error("wisp_stream_closed"));
    }
  }
}

ws.addEventListener("message", handleMessage);
ws.addEventListener("error", () => rejectInitialCredit(new Error("wisp_websocket_error")));
await timeout(new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("wisp_websocket_open_failed")), { once: true });
}), 10000, "wisp_websocket_open");
const initial = await timeout(initialCredit, 10000, "wisp_initial_credit");
assert.ok(initial > 0, "WISP server must grant initial stream credit");

async function openStream(streamId, hostname, port) {
  const address = (await lookup(hostname, { family: 4 })).address;
  const stream = {
    id: streamId,
    credit: 0,
    creditWaiters: [],
    closeWaiters: [],
    onData: null,
    onClose: null,
    onCredit: null,
    closed: false,
  };
  streams.set(streamId, stream);
  sendPacket(connectPacket(streamId, address, port));
  await timeout(new Promise((resolve, reject) => {
    if (stream.credit > 0) return resolve();
    stream.creditWaiters.push(resolve);
    stream.closeWaiters.push(reject);
  }), 15000, "wisp_tcp_connect_" + hostname + "_" + port);
  return stream;
}

async function sendStreamData(stream, payload) {
  await timeout(new Promise((resolve, reject) => {
    if (stream.credit > 0) return resolve();
    stream.creditWaiters.push(resolve);
    stream.closeWaiters.push(reject);
  }), 10000, "wisp_stream_credit_" + stream.id);
  stream.credit -= 1;
  sendPacket(dataPacket(stream.id, payload));
}

async function testHttp() {
  const stream = await openStream(1, "example.com", 80);
  const chunks = [];
  let responseResolve;
  let responseReject;
  const responsePromise = new Promise((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  stream.onData = (chunk) => {
    chunks.push(Buffer.from(chunk));
    const response = Buffer.concat(chunks).toString("latin1");
    if (response.includes("\r\n\r\n")) responseResolve(response);
  };
  stream.onClose = () => responseResolve(Buffer.concat(chunks).toString("latin1"));
  const request = "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n";
  await sendStreamData(stream, new TextEncoder().encode(request));
  const response = await timeout(responsePromise, 15000, "external_http_response");
  assert.match(response, /^HTTP\/1\.[01] [23]\d\d/m, "external HTTP request must receive a 2xx or 3xx response");
  sendPacket(closePacket(stream.id));
  streams.delete(stream.id);
  console.log("PASS: WISP TCP/HTTP egress to example.com");
}

class WispDuplex extends Duplex {
  constructor(stream) {
    super({ allowHalfOpen: true });
    this.stream = stream;
    this.pending = [];
    stream.onData = (chunk) => this.push(Buffer.from(chunk));
    stream.onClose = () => this.push(null);
    stream.onCredit = () => this.flush();
  }
  _read() {}
  _write(chunk, _encoding, callback) {
    this.pending.push({ chunk: Buffer.from(chunk), callback });
    this.flush();
  }
  flush() {
    while (this.pending.length && this.stream.credit > 0 && !this.stream.closed) {
      const item = this.pending.shift();
      this.stream.credit -= 1;
      try {
        sendPacket(dataPacket(this.stream.id, item.chunk));
        item.callback();
      } catch (error) {
        item.callback(error);
      }
    }
  }
  _final(callback) {
    try { sendPacket(closePacket(this.stream.id)); } catch {}
    callback();
  }
  _destroy(error, callback) {
    try { if (!this.stream.closed) sendPacket(closePacket(this.stream.id)); } catch {}
    callback(error);
  }
}

async function testHttps() {
  const stream = await openStream(2, "www.google.com", 443);
  const transport = new WispDuplex(stream);
  const secure = tls.connect({
    socket: transport,
    servername: "www.google.com",
    rejectUnauthorized: true,
  });
  await timeout(new Promise((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  }), 20000, "external_https_tls_handshake");
  const chunks = [];
  let responseResolve;
  let responseReject;
  const responsePromise = new Promise((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  secure.on("data", (chunk) => {
    chunks.push(Buffer.from(chunk));
    const response = Buffer.concat(chunks).toString("latin1");
    if (response.includes("\r\n\r\n")) responseResolve(response);
  });
  secure.once("end", () => responseResolve(Buffer.concat(chunks).toString("latin1")));
  secure.once("error", responseReject);
  secure.write("GET /robots.txt HTTP/1.1\r\nHost: www.google.com\r\nConnection: close\r\n\r\n");
  const response = await timeout(responsePromise, 20000, "external_https_response");
  assert.match(response, /^HTTP\/1\.[01] 200\b/m, "external HTTPS request must receive HTTP 200");
  secure.destroy();
  streams.delete(stream.id);
  console.log("PASS: WISP TCP/HTTPS egress to www.google.com (TLS certificate verified)");
}

try {
  await testHttp();
  await testHttps();
  console.log("PASS: WISP relay external TCP HTTP and HTTPS egress");
} finally {
  for (const stream of streams.values()) {
    try { sendPacket(closePacket(stream.id)); } catch {}
  }
  try { ws.close(); } catch {}
}
