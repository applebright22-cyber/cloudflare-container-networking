export const SNAPSHOT_CHUNK_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_BYTES = 512 * 1024 * 1024;
export const SNAPSHOT_MAX_CHUNKS = 128;

export interface GuestSnapshotManifest {
  version: 1;
  identity: string;
  generation: string;
  chunks: number;
  byteLength: number;
  sha256: string;
  chunkSha256: string[];
  savedAt: string;
  checks: { guest_booted: true; shell_command_passed: true; dhcp_passed: true; dns_passed: true; https_passed: true };
}
export interface GuestCheckResults {
  guest_booted: boolean;
  shell_command_passed: boolean;
  dhcp_passed: boolean;
  dns_passed: boolean;
  https_passed: boolean;
}
function validIdentity(value: string) {
  return /^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(value);
}
function validGeneration(value: string) { return /^[a-z0-9-]{1,40}$/.test(value); }

export function splitSnapshot(state: ArrayBuffer | Uint8Array): Uint8Array[] {
  const bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
  if (bytes.byteLength < 1 || bytes.byteLength > SNAPSHOT_MAX_BYTES) throw new Error("snapshot_size_out_of_range");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(offset + SNAPSHOT_CHUNK_BYTES, bytes.byteLength)));
  }
  if (chunks.length > SNAPSHOT_MAX_CHUNKS) throw new Error("snapshot_chunk_count_out_of_range");
  return chunks;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Write chunks, read them back and verify SHA-256, then publish the manifest last. */
export async function commitGuestSnapshot(
  bucket: R2Bucket, identity: string, generation: string,
  state: ArrayBuffer | Uint8Array, checks: GuestCheckResults,
): Promise<GuestSnapshotManifest> {
  if (!validIdentity(identity)) throw new Error("snapshot_identity_invalid");
  if (!validGeneration(generation)) throw new Error("snapshot_generation_invalid");
  if (!checks.guest_booted || !checks.shell_command_passed || !checks.dhcp_passed ||
      !checks.dns_passed || !checks.https_passed) throw new Error("guest_acceptance_checks_failed");

  const bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
  const chunks = splitSnapshot(bytes);
  const digest = await sha256Hex(bytes);
  const prefix = `vm-snapshots/${identity}/`;
  const generationPrefix = `${prefix}${generation}/`;
  const existingObject = await bucket.get(prefix + "manifest.json");
  if (existingObject) {
    const existing = await existingObject.json<GuestSnapshotManifest>();
    if (existing.generation === generation) throw new Error("snapshot_generation_already_committed");
  }

  const chunkSha256: string[] = [];
  // Keep memory bounded: write and read back one chunk at a time instead of
  // retaining another full snapshot-sized array beside v86's saved state.
  for (let part = 0; part < chunks.length; part += 1) {
    const chunk = chunks[part];
    const chunkDigest = await sha256Hex(chunk);
    await bucket.put(`${generationPrefix}${part}.bin`, chunk, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const object = await bucket.get(`${generationPrefix}${part}.bin`);
    if (!object) throw new Error("snapshot_chunk_readback_missing_" + part);
    const stored = new Uint8Array(await object.arrayBuffer());
    if (stored.byteLength !== chunk.byteLength) throw new Error("snapshot_chunk_readback_length_mismatch_" + part);
    if (await sha256Hex(stored) !== chunkDigest) throw new Error("snapshot_chunk_readback_digest_mismatch_" + part);
    chunkSha256.push(chunkDigest);
  }

  const manifest: GuestSnapshotManifest = {
    version: 1, identity, generation, chunks: chunks.length, byteLength: bytes.byteLength,
    sha256: digest, chunkSha256, savedAt: new Date().toISOString(),
    checks: { guest_booted: true, shell_command_passed: true, dhcp_passed: true, dns_passed: true, https_passed: true },
  };
  await bucket.put(prefix + "manifest.json", JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { savedAt: manifest.savedAt, generation, sha256: digest },
  });
  return manifest;
}

export async function readCommittedGuestSnapshot(
  bucket: R2Bucket, identity: string,
): Promise<{ manifest: GuestSnapshotManifest; state: Uint8Array }> {
  if (!validIdentity(identity)) throw new Error("snapshot_identity_invalid");
  const prefix = `vm-snapshots/${identity}/`;
  const object = await bucket.get(prefix + "manifest.json");
  if (!object) throw new Error("snapshot_manifest_missing");
  const manifest = await object.json<GuestSnapshotManifest>();
  if (manifest.version !== 1 || manifest.identity !== identity || !validGeneration(manifest.generation) ||
      !Number.isInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks > SNAPSHOT_MAX_CHUNKS ||
      !Number.isInteger(manifest.byteLength) || manifest.byteLength < 1 || manifest.byteLength > SNAPSHOT_MAX_BYTES ||
      manifest.chunks !== Math.ceil(manifest.byteLength / SNAPSHOT_CHUNK_BYTES) ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Array.isArray(manifest.chunkSha256) ||
      manifest.chunkSha256.length !== manifest.chunks || manifest.chunkSha256.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("snapshot_manifest_invalid");
  }
  // v86 requires a contiguous restore buffer, but avoid retaining all individual
  // R2 chunks simultaneously: allocate the final buffer once and copy serially.
  const state = new Uint8Array(manifest.byteLength);
  let offset = 0;
  for (let part = 0; part < manifest.chunks; part += 1) {
    const chunk = await bucket.get(`${prefix}${manifest.generation}/${part}.bin`);
    if (!chunk) throw new Error("snapshot_chunk_missing_" + part);
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    const expected = Math.min(SNAPSHOT_CHUNK_BYTES, manifest.byteLength - part * SNAPSHOT_CHUNK_BYTES);
    if (bytes.byteLength !== expected) throw new Error("snapshot_chunk_length_invalid_" + part);
    if (await sha256Hex(bytes) !== manifest.chunkSha256[part]) throw new Error("snapshot_chunk_digest_invalid_" + part);
    state.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (await sha256Hex(state) !== manifest.sha256) throw new Error("snapshot_digest_invalid");
  return { manifest, state };
}
