/**
 * Experimental Worker-compatible asset loading primitives for a future v86 port.
 *
 * This module is intentionally not wired into /v1/vm/exec: upstream v86 still
 * calls its own load_file() paths for disk images and other resources. These
 * helpers solve only the asset-fetch and WASM-initialization seams.
 */

export interface WorkerV86AssetOptions {
  /** Worker ASSETS binding, not the public Worker fetch handler. */
  assets: Fetcher;
  /** Absolute URL of the incoming request, used to resolve same-deployment assets. */
  requestUrl: string;
}

const V86_ASSET_LIMITS: Readonly<Record<string, number>> = {
  "/v86/v86.wasm": 8 * 1024 * 1024,
  "/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso": 24 * 1024 * 1024,
};

export async function fetchWorkerV86Asset(
  options: WorkerV86AssetOptions,
  path: string,
): Promise<ArrayBuffer> {
  const maxBytes = V86_ASSET_LIMITS[path];
  if (maxBytes === undefined) {
    throw new Error("v86_asset_path_not_allowlisted");
  }

  const url = new URL(path, options.requestUrl);
  const response = await options.assets.fetch(new Request(url.toString(), {
    method: "GET",
    headers: { "accept": "application/octet-stream" },
  }));

  if (!response.ok) {
    throw new Error("v86_asset_http_" + response.status);
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      await response.body?.cancel();
      throw new Error("v86_asset_size_limit_exceeded");
    }
  }

  if (!response.body) {
    throw new Error("v86_asset_body_missing");
  }

  // Do not call arrayBuffer() on an untrusted/incorrectly sized response:
  // stream it with a hard cap so a missing Content-Length cannot bypass the limit.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("v86_asset_size_limit_exceeded");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw new Error("v86_asset_size_limit_exceeded");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/**
 * Shape expected by v86's V86Options.wasm_fn callback. This bypasses the
 * upstream default local-path loader for v86.wasm, but does not replace
 * load_file() for the guest ISO/disk and therefore is not a complete port.
 */
export function createWorkerV86WasmFn(
  options: WorkerV86AssetOptions,
): (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports> {
  return async (imports) => {
    const bytes = await fetchWorkerV86Asset(options, "/v86/v86.wasm");
    const result = await WebAssembly.instantiate(bytes, imports);
    return result.instance.exports;
  };
}


export interface WorkerV86LoadOptions {
  method?: string;
  as_json?: boolean;
  range?: { start: number; length: number };
  headers?: Record<string, string>;
  signal?: AbortSignal;
  done?: (result: ArrayBuffer | Uint8Array | unknown, response?: Response) => void;
  progress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void;
}

/**
 * Callback-compatible loader for the subset of upstream load_file() used by
 * v86. It supports whole-file reads and bounded byte ranges. A Worker-specific
 * v86 fork must wire this function into src/lib.js; this module cannot replace
 * the upstream import from outside that source graph.
 */
export async function loadWorkerV86File(
  options: WorkerV86AssetOptions,
  path: string,
  loadOptions: WorkerV86LoadOptions,
): Promise<void> {
  const maxBytes = V86_ASSET_LIMITS[path];
  if (maxBytes === undefined) throw new Error("v86_asset_path_not_allowlisted");
  if (loadOptions.signal?.aborted) return;

  const headers = new Headers(loadOptions.headers);
  const range = loadOptions.range;
  if (range) {
    if (!Number.isSafeInteger(range.start) || range.start < 0 ||
        !Number.isSafeInteger(range.length) || range.length < 1 ||
        range.start + range.length > maxBytes) {
      throw new Error("v86_asset_range_invalid");
    }
    headers.set("Range", `bytes=${range.start}-${range.start + range.length - 1}`);
    headers.set("Accept-Encoding", "identity");
  }

  const url = new URL(path, options.requestUrl);
  const response = await options.assets.fetch(new Request(url.toString(), {
    method: loadOptions.method ?? "GET",
    headers,
    signal: loadOptions.signal,
  }));
  if (!response.ok || (range && response.status !== 206)) {
    throw new Error("v86_asset_http_" + response.status);
  }

  if (range) {
    const contentRange = response.headers.get("content-range") ?? "";
    const rangeEnd = range.start + range.length - 1;
    const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
    const totalSize = match && match[3] !== "*" ? Number(match[3]) : null;
    if (!match || Number(match[1]) !== range.start || Number(match[2]) !== rangeEnd ||
        (totalSize !== null && (!Number.isSafeInteger(totalSize) || rangeEnd >= totalSize))) {
      await response.body?.cancel();
      throw new Error("v86_asset_content_range_invalid");
    }
  }

  if (loadOptions.as_json) {
    if (range) throw new Error("v86_json_range_unsupported");
    const declaredJsonLength = response.headers.get("content-length");
    if (declaredJsonLength !== null) {
      const parsedJsonLength = Number(declaredJsonLength);
      if (!Number.isSafeInteger(parsedJsonLength) || parsedJsonLength < 0 || parsedJsonLength > maxBytes) {
        await response.body?.cancel();
        throw new Error("v86_asset_size_limit_exceeded");
      }
    }
    if (!response.body) throw new Error("v86_asset_body_missing");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let jsonBytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        jsonBytes += part.value.byteLength;
        if (jsonBytes > maxBytes) {
          await reader.cancel();
          throw new Error("v86_asset_size_limit_exceeded");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(jsonBytes);
    let jsonOffset = 0;
    for (const part of chunks) {
      bytes.set(part, jsonOffset);
      jsonOffset += part.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    loadOptions.done?.(value, response);
    return;
  }

  const expectedBytes = range?.length;
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 ||
        parsed > (expectedBytes ?? maxBytes) ||
        (expectedBytes !== undefined && parsed !== expectedBytes)) {
      await response.body?.cancel();
      throw new Error("v86_asset_size_limit_exceeded");
    }
  }

  if (!response.body) throw new Error("v86_asset_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > (expectedBytes ?? maxBytes)) {
        await reader.cancel();
        throw new Error("v86_asset_size_limit_exceeded");
      }
      chunks.push(part.value);
      loadOptions.progress?.({
        loaded: total,
        total: expectedBytes ?? maxBytes,
        lengthComputable: expectedBytes !== undefined,
      });
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedBytes !== undefined && total !== expectedBytes) {
    throw new Error("v86_asset_range_length_mismatch");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  loadOptions.done?.(range ? bytes : bytes.buffer, response);
}

/** Determine an allowlisted asset's byte length using a one-byte range. */
export async function getWorkerV86FileSize(
  options: WorkerV86AssetOptions,
  path: string,
): Promise<number> {
  const maxBytes = V86_ASSET_LIMITS[path];
  if (maxBytes === undefined) throw new Error("v86_asset_path_not_allowlisted");
  const url = new URL(path, options.requestUrl);
  const response = await options.assets.fetch(new Request(url.toString(), {
    headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
  }));
  if (response.status !== 206) {
    await response.body?.cancel();
    throw new Error("v86_asset_range_not_supported");
  }
  await response.body?.cancel();
  const contentRange = response.headers.get("content-range") ?? "";
  const match = /^bytes 0-0\/(\d+)$/.exec(contentRange);
  if (!match) throw new Error("v86_asset_content_range_invalid");
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw new Error("v86_asset_size_limit_exceeded");
  }
  return size;
}
