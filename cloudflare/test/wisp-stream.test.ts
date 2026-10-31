import test from "node:test";
import assert from "node:assert/strict";
import { closeTcpResources } from "../src/wisp-stream.ts";

test("TCP cleanup force-closes the socket before releasing stream locks", async () => {
  const events: string[] = [];
  await closeTcpResources(
    { close: async () => { events.push("socket.close"); } },
    { releaseLock: () => { events.push("writer.releaseLock"); } },
    { releaseLock: () => { events.push("reader.releaseLock"); } },
  );
  assert.deepEqual(events, ["socket.close", "writer.releaseLock", "reader.releaseLock"]);
});

test("TCP cleanup still releases both locks if the socket was already closed", async () => {
  const events: string[] = [];
  await closeTcpResources(
    { close: async () => { events.push("socket.close"); throw new Error("already closed"); } },
    { releaseLock: () => { events.push("writer.releaseLock"); } },
    { releaseLock: () => { events.push("reader.releaseLock"); } },
  );
  assert.deepEqual(events, ["socket.close", "writer.releaseLock", "reader.releaseLock"]);
});

test("TCP cleanup tolerates locks that cannot yet be released", async () => {
  const events: string[] = [];
  await assert.doesNotReject(closeTcpResources(
    { close: async () => { events.push("socket.close"); } },
    { releaseLock: () => { throw new Error("writer has a pending write"); } },
    { releaseLock: () => { events.push("reader.releaseLock"); } },
  ));
  assert.deepEqual(events, ["socket.close", "reader.releaseLock"]);
});
