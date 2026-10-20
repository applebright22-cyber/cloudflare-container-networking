import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWorkerV86Asset,
  getWorkerV86FileSize,
  loadWorkerV86File,
} from "../src/headless-v86-assets.ts";

function makeAssets(handler: (request: Request) => Response): Fetcher {
  return { fetch: handler } as unknown as Fetcher;
}

const options = (assets: Fetcher) => ({
  assets,
  requestUrl: "https://worker.example.test/v1/test",
});

test("asset loader rejects paths outside its explicit allowlist", async () => {
  const assets = makeAssets(() => new Response("should not be fetched"));
  await assert.rejects(
    fetchWorkerV86Asset(options(assets), "/etc/passwd"),
    /v86_asset_path_not_allowlisted/,
  );
});

test("asset loader reads a bounded allowlisted asset", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const assets = makeAssets(() => new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.byteLength) },
  }));
  const result = await fetchWorkerV86Asset(options(assets), "/v86/v86.wasm");
  assert.deepEqual(Array.from(new Uint8Array(result)), Array.from(bytes));
});

test("range loader requires matching Content-Range and exact byte count", async () => {
  let delivered: ArrayBuffer | Uint8Array | unknown;
  const assets = makeAssets((request) => {
    assert.equal(request.headers.get("range"), "bytes=2-4");
    return new Response(new Uint8Array([3, 4, 5]), {
      status: 206,
      headers: {
        "content-range": "bytes 2-4/8",
        "content-length": "3",
      },
    });
  });
  await loadWorkerV86File(options(assets), "/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso", {
    range: { start: 2, length: 3 },
    done: (result) => { delivered = result; },
  });
  assert.ok(delivered instanceof Uint8Array);
  assert.deepEqual(Array.from(delivered as Uint8Array), [3, 4, 5]);
});

test("range loader rejects a mismatched Content-Range", async () => {
  const assets = makeAssets(() => new Response(new Uint8Array([3, 4, 5]), {
    status: 206,
    headers: {
      "content-range": "bytes 1-3/8",
      "content-length": "3",
    },
  }));
  await assert.rejects(
    loadWorkerV86File(options(assets), "/boot/TinyCorePure64-11.0-v86-ne2k-dhcp-experimental.iso", {
      range: { start: 2, length: 3 },
    }),
    /v86_asset_content_range_invalid/,
  );
});

test("file-size helper reads a valid one-byte Content-Range", async () => {
  const assets = makeAssets((request) => {
    assert.equal(request.headers.get("range"), "bytes=0-0");
    return new Response(new Uint8Array([0]), {
      status: 206,
      headers: { "content-range": "bytes 0-0/1024" },
    });
  });
  assert.equal(
    await getWorkerV86FileSize(options(assets), "/v86/v86.wasm"),
    1024,
  );
});
