import test from "node:test";
import assert from "node:assert/strict";
import { commitGuestSnapshot, readCommittedGuestSnapshot, splitSnapshot, SNAPSHOT_CHUNK_BYTES } from "../src/headless-snapshot-store.ts";

const checks = { guest_booted: true, shell_command_passed: true, dhcp_passed: true, dns_passed: true, https_passed: true };
function memoryBucket() {
  const values = new Map<string, Uint8Array>();
  const bucket = {
    async get(key: string) {
      const bytes = values.get(key);
      if (!bytes) return null;
      return { async arrayBuffer() { return bytes.slice().buffer; }, async json() { return JSON.parse(new TextDecoder().decode(bytes)); } };
    },
    async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      values.set(key, bytes.slice());
    },
  };
  return { bucket: bucket as unknown as R2Bucket, values };
}
test("splits state into 8 MiB chunks", () => {
  const bytes = new Uint8Array(SNAPSHOT_CHUNK_BYTES + 19);
  bytes[SNAPSHOT_CHUNK_BYTES] = 9;
  const chunks = splitSnapshot(bytes);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].byteLength, SNAPSHOT_CHUNK_BYTES);
  assert.equal(chunks[1].byteLength, 19);
  assert.equal(chunks[1][0], 9);
});
test("refuses to commit until all guest acceptance checks pass", async () => {
  const { bucket, values } = memoryBucket();
  await assert.rejects(commitGuestSnapshot(bucket, "test-nope", "gen-1", new Uint8Array([1]), { ...checks, https_passed: false }), /guest_acceptance_checks_failed/);
  assert.equal(values.has("vm-snapshots/test-nope/manifest.json"), false);
});
test("commits only after byte read-back and returns the same snapshot", async () => {
  const { bucket, values } = memoryBucket();
  const state = new Uint8Array(2 * 1024 * 1024 + 37);
  for (let i = 0; i < state.length; i += 7919) state[i] = (i * 17) & 255;
  const manifest = await commitGuestSnapshot(bucket, "test-roundtrip", "gen-2", state, checks);
  assert.equal(manifest.byteLength, state.byteLength);
  assert.equal(manifest.chunks, 1);
  assert.ok(values.has("vm-snapshots/test-roundtrip/manifest.json"));
  const restored = await readCommittedGuestSnapshot(bucket, "test-roundtrip");
  assert.deepEqual(restored.state, state);
  assert.equal(restored.manifest.sha256, manifest.sha256);
});
test("detects corrupted stored bytes", async () => {
  const { bucket, values } = memoryBucket();
  await commitGuestSnapshot(bucket, "test-corrupt", "gen-3", new Uint8Array([1, 2, 3]), checks);
  values.set("vm-snapshots/test-corrupt/gen-3/0.bin", new Uint8Array([9, 9, 9]));
  await assert.rejects(readCommittedGuestSnapshot(bucket, "test-corrupt"), /snapshot_(chunk_digest_invalid|digest_invalid)/);
});
