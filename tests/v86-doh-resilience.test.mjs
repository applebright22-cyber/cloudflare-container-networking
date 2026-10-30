import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/v86/libv86.js", import.meta.url), "utf8");
const start = source.indexOf("function Jb(a,b){");
const end = source.indexOf("\nfunction Kb", start);
assert.ok(start >= 0 && end > start, "v86 DoH handler should remain discoverable in the checked-in browser bundle");
const handlerSource = source.slice(start, end) + "\nglobalThis.__dohHandler = Jb;";

function response(status, bytes = new Uint8Array(), contentType = "application/dns-message") {
  const copy = Uint8Array.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
  };
}

function queryPacket() {
  return {
    eth: { src: "guest-mac" },
    ipv4: { src: [10, 240, 0, 2] },
    udp: { sport: 53000, data: new Uint8Array([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]) },
    dns: { id: 0x1234, flags: 256, questions: [{ name: "example.com", type: 1, class: 1 }] },
  };
}

function networkFor(receive) {
  return {
    doh_server: "cloudflare-dns.com",
    router_mac: "52:54:00:01:02:03",
    router_ip: [10, 240, 0, 1],
    vm_ip: [10, 240, 0, 2],
    eth_encoder_buf: {},
    receive,
  };
}

function loadHandler(fetchImpl, warnings = []) {
  const context = {
    fetch: fetchImpl,
    AbortSignal,
    Uint8Array,
    console: { warn: (...args) => warnings.push(args) },
    Ib: (_buffer, packet) => packet,
  };
  vm.runInNewContext(handlerSource, context);
  return context.__dohHandler;
}

test("DoH HTTP failure retries an alternate resolver and returns its DNS answer", async () => {
  const calls = [];
  const input = queryPacket();
  const answer = Uint8Array.from(input.udp.data);
  answer[2] = 0x81; // QR + RD
  answer[3] = 0x80; // RA, NOERROR
  const handler = loadHandler(async (url) => {
    calls.push(String(url));
    return calls.length === 1
      ? response(503, new Uint8Array([1, 2, 3]), "text/plain")
      : response(200, answer);
  });
  const output = await new Promise((resolve) => {
    handler(input, networkFor(resolve));
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /cloudflare-dns\.com/);
  assert.match(calls[1], /dns\.google/);
  assert.deepEqual(Array.from(output.udp.data), Array.from(answer));
});

test("DoH response must be a successful DNS wire-format response", async () => {
  const calls = [];
  const input = queryPacket();
  const handler = loadHandler(async (url) => {
    calls.push(String(url));
    return response(200, new Uint8Array([60, 60, 60]), "text/html");
  });
  const output = await new Promise((resolve) => {
    handler(input, networkFor(resolve));
  });
  assert.equal(calls.length, 2);
  assert.equal(output.dns.flags, 33154); // QR + RD + RA + SERVFAIL
  assert.deepEqual(output.dns.questions, input.dns.questions);
  assert.deepEqual(Array.from(output.dns.answers), []);
  assert.ok(!output.udp.data, "do not pass an HTTP error body off as a DNS response");
});

test("a rejected DoH fetch retries the alternate resolver", async () => {
  const calls = [];
  const input = queryPacket();
  const answer = Uint8Array.from(input.udp.data);
  answer[2] = 0x81;
  answer[3] = 0x80;
  const handler = loadHandler(async (url) => {
    calls.push(String(url));
    if (calls.length === 1) throw new TypeError("network request failed");
    return response(200, answer);
  });
  const output = await new Promise((resolve) => {
    handler(input, networkFor(resolve));
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /dns\.google/);
  assert.deepEqual(Array.from(output.udp.data), Array.from(answer));
});

test("a DoH SERVFAIL from the primary resolver triggers failover", async () => {
  const calls = [];
  const input = queryPacket();
  const servfail = Uint8Array.from(input.udp.data);
  servfail[2] = 0x81;
  servfail[3] = 0x82;
  const answer = Uint8Array.from(input.udp.data);
  answer[2] = 0x81;
  answer[3] = 0x80;
  const handler = loadHandler(async (url) => {
    calls.push(String(url));
    return calls.length === 1 ? response(200, servfail) : response(200, answer);
  });
  const output = await new Promise((resolve) => {
    handler(input, networkFor(resolve));
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(Array.from(output.udp.data), Array.from(answer));
});


test("async DoH lookup keeps the original guest DNS packet when v86 reuses its packet buffer", async () => {
  const input = queryPacket();
  const originalQuery = Array.from(input.udp.data);
  const originalAnswer = Uint8Array.from(input.udp.data);
  originalAnswer[2] = 0x81;
  originalAnswer[3] = 0x80;
  const handler = loadHandler(async (_url, init) => {
    await Promise.resolve();
    assert.deepEqual(Array.from(init.body), originalQuery, "fetch must receive a private copy of the DNS query");
    return response(200, originalAnswer);
  });
  const result = new Promise((resolve) => handler(input, networkFor(resolve)));

  // Simulate v86 recycling/mutating its decoded packet as soon as the handler returns.
  input.udp.data.fill(0);
  input.dns.id = 0xffff;
  input.dns.questions[0].name = "reused-buffer.invalid";
  input.eth.src = "reused-mac";
  input.ipv4.src = [10, 240, 0, 99];
  input.udp.sport = 54000;

  const output = await result;
  assert.deepEqual(Array.from(output.udp.data), Array.from(originalAnswer));
  assert.equal(output.eth.dest, "guest-mac");
  assert.deepEqual(output.ipv4.dest, [10, 240, 0, 2]);
  assert.equal(output.udp.dport, 53000);
});
