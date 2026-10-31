#!/usr/bin/env node
/**
 * Calls the Workerd snapshot-readback endpoint and asserts the same contract
 * as the experiment/workerd-snapshot-api-readback probe:
 * committed R2 snapshot -> reassemble/read back chunks -> verify per-chunk and
 * whole-snapshot SHA-256 -> return manifest/check metadata.
 *
 * This verifies persisted snapshot bytes. It does not boot Linux or restore v86.
 */
const baseUrl = process.env.WORKER_BASE_URL?.replace(/\/+$/, "");
const token = process.env.VM_API_TOKEN;
const identity = process.env.SNAPSHOT_IDENTITY?.trim().toLowerCase();

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

if (!baseUrl || !token || !identity) {
  console.error("Set WORKER_BASE_URL, VM_API_TOKEN, and SNAPSHOT_IDENTITY.");
  process.exit(2);
}
if (!/^(acct-[a-f0-9-]{36}|test-[a-z0-9-]{1,32})$/.test(identity)) {
  console.error("SNAPSHOT_IDENTITY must be an acct- UUID or test- identity.");
  process.exit(2);
}

try {
  console.log("POST /v1/runtime/snapshot-readback");
  console.log(`Identity: ${identity}`);
  const response = await fetch(`${baseUrl}/v1/runtime/snapshot-readback`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ identity }),
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { throw new Error(`Endpoint returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${data.error ?? raw.slice(0, 300) ?? "unknown_error"}`);
  }

  const checks = data.guest_checks ?? {};
  const failures = [];
  if (data.probe !== "headless-snapshot-api-readback") failures.push("unexpected probe name");
  if (data.runtime !== "workerd") failures.push("runtime is not workerd");
  if (data.passed !== true) failures.push("passed is not true");
  if (data.identity !== identity) failures.push("identity mismatch");
  if (typeof data.generation !== "string" || !/^[a-z0-9-]{1,40}$/.test(data.generation)) failures.push("invalid generation");
  if (!Number.isInteger(data.chunks) || data.chunks < 1 || data.chunks > 128) failures.push("invalid chunk count");
  if (!Number.isInteger(data.byte_length) || data.byte_length < 1 || data.byte_length > 536870912) failures.push("invalid snapshot byte length");
  if (data.readback_byte_length !== data.byte_length) failures.push("read-back byte length mismatch");
  if (data.readback_digest_verified !== true) failures.push("digest verification was not confirmed");
  if (typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)) failures.push("invalid SHA-256");
  for (const key of ["guest_booted", "shell_command_passed", "dhcp_passed", "dns_passed", "https_passed"]) {
    if (checks[key] !== true) failures.push(`guest check ${key} is not true in manifest metadata`);
  }
  if (failures.length) throw new Error(failures.join("; "));

  console.log("PASS: API read-back and SHA-256 verification");
  console.log(JSON.stringify({
    result: "PASS",
    probe: data.probe,
    runtime: data.runtime,
    identity: data.identity,
    generation: data.generation,
    chunks: data.chunks,
    byte_length: data.byte_length,
    readback_byte_length: data.readback_byte_length,
    sha256: data.sha256,
    readback_digest_verified: data.readback_digest_verified,
    guest_checks: checks,
    scope: "R2 persistence/read-back only; not Linux boot or v86 restore proof",
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
