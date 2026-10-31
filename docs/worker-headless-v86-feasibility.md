# Worker-only headless v86 feasibility spike

## Goal

Execute a real Linux shell command in the Cloudflare Worker runtime without a browser tab, browser WebSocket agent, container, or external VM host.

## Current implementation facts

- `/v1/vm/exec` forwards commands to the `VmExecution` Durable Object.
- `VmExecution` can execute only when an agent WebSocket is connected. Its status explicitly reports `runtime: "browser-v86"`.
- `public/v86/libv86.js` is a bundled browser/Node distribution, not a Cloudflare Workers build.
- The bundle chooses its filesystem loader when `XMLHttpRequest` is missing (or when Node's `process.versions.node` is present). That branch uses `require("fs")` or `import("node:fs/promises")`, neither of which is a Worker filesystem API.
- The bundled code also contains browser-specific DOM and `window` references. Compiling `v86.wasm` alone does not provide the host APIs needed to initialize the emulator.
- The existing saved VM snapshot is about 103 MB, before emulator allocations. Do not use it for the first runtime test; test a deliberately small guest and measure memory/CPU first.

## Additional upstream v86 finding

The upstream `copy/v86` source separates the emulator constructor in `src/browser/starter.js` from the browser UI in `src/browser/main.js`. The starter imports both `DummyScreenAdapter` and `ANSIScreenAdapter`, so a headless console is a plausible route; the browser page itself is not the required entry point. However, `starter.js` still imports a large dependency graph (including file-loading and filesystem abstractions), and contains some DOM access paths. A Worker build must prove those paths are not required or replace them; merely switching the screen adapter is not enough.

Cloudflare's current compatibility date (2026-10-07) enables Node compatibility by default, but that does not imply a general-purpose filesystem, DOM, worker-thread, or arbitrary Linux host environment. The emulator must be tested against the actual Worker runtime, not assumed compatible from Node API availability. See [Cloudflare Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) and [WebAssembly support](https://developers.cloudflare.com/workers/runtime-apis/webassembly/).


## Concrete blocker confirmed in upstream loader

The upstream loader in `src/lib.js` selects its Node filesystem branch whenever `XMLHttpRequest` is absent. That branch calls `require("fs")` or dynamically imports `node:fs/promises`, and performs `open/readFile/stat` against local paths. A Cloudflare Worker has no ordinary persistent local disk for these paths. The browser branch instead requires `XMLHttpRequest`, which Workers do not provide as a standard global. This means the stock loader cannot be used unchanged in a Worker. A real port must replace the loader with an injected Worker-aware loader (fetch/R2/Assets plus range reads) or patch/fork upstream v86 to accept an explicit loader. It must also supply the WASM bytes through `wasm_fn`/the supported module initialization path rather than rely on a local `v86.wasm` path.

## Implementation decision

Do not wire the existing browser bundle into `/v1/vm/exec` or advertise it as headless. The next code spike should be isolated behind a new experimental endpoint/class and should first boot a tiny test image with no snapshot restore. Only after a guest-shell marker is observed should command dispatch and network tests be added. If the upstream module cannot be bundled with a replaceable loader and bounded CPU/memory behavior, stop the spike rather than introducing a false-success endpoint.


## Viable integration seam identified

Upstream `V86Options` exposes `wasm_fn?: (options: WebAssembly.Imports) => Promise<WebAssembly.Exports>`. The starter uses this callback to obtain the WebAssembly exports before constructing the emulator. This is the cleanest seam for supplying WASM bytes fetched through Worker APIs, without depending on the starter's default path-based WASM loader. It does **not** solve the separate `load_file` calls used for guest media and other resources, so both seams must be addressed in a fork/build.

A minimal implementation should therefore:
- bundle upstream v86 source into the Worker rather than import the browser bundle blindly;
- provide a `wasm_fn` that fetches the chosen WASM asset and calls `WebAssembly.instantiate(bytes, imports)`;
- replace/inject the general resource loader for ISO/disk images and range reads;
- use `screen: { ... }` with the headless adapter and `serial_console: { type: "none" }` initially, and retrieve terminal output via emulator APIs or serial events;
- start with a tiny boot image and no snapshot restore, with a strict boot timeout and memory/CPU measurement.

The upstream starter currently initializes asynchronously and its constructor does not itself expose a promise that resolves when the guest shell is ready. The Worker wrapper must add a deterministic guest-ready handshake rather than equating emulator initialization or autostart with a working shell.

## Required implementation gates

1. Identify or build an emulator entry point that is compatible with Workers (no Node filesystem imports and no mandatory DOM/window APIs).
2. Load guest boot media through Worker-compatible fetch/asset APIs and ensure the emulator's resource loader uses them.
3. Boot a minimal guest and obtain a deterministic proof from the guest shell, such as a unique marker plus a zero exit code.
4. Add a command coordinator that reports ready only after the guest shell is responsive and startup commands complete.
5. Verify guest networking from inside the guest: NIC present, DHCP lease, default route, DNS resolution, and outbound HTTPS.
6. Measure memory, CPU time, and startup duration. Fail closed with a clear unsupported/limit error if Worker limits are exceeded.
7. Keep the current browser-agent path working until the headless path passes these gates.

## Acceptance criteria

A test must call the deployed Worker API with the browser closed and receive the output of a command executed by the guest shell. A successful snapshot integrity check, WASM compilation, direct Worker egress request, or Durable Object status response is not sufficient.

## First code spike: Worker asset/WASM adapter

`cloudflare/src/headless-v86-assets.ts` now implements a small, isolated adapter that:

- fetches only explicitly allowlisted v86 WASM and TinyCore ISO assets through the Worker's `ASSETS` binding;
- bounds streamed reads even when `Content-Length` is absent, and validates exact byte counts for range reads;
- exposes `createWorkerV86WasmFn()` in the shape of v86's `wasm_fn` callback;
- provides a callback-style `loadWorkerV86File()` for full-file, JSON, and byte-range reads, plus `getWorkerV86FileSize()` using `Content-Range`.

These APIs mirror the relevant loader behaviors, but they are not yet wired into upstream `src/lib.js`; that requires a Worker-specific v86 build/fork and bundling its source graph.

This is a useful integration seam, not a working emulator. It is deliberately not imported by `index.ts` and does not change `/v1/vm/exec`. In particular, it does not replace upstream `load_file()` calls for the ISO/disk and auxiliary resources, does not remove DOM dependencies from the bundled emulator, and has not been tested against a booting guest. The asset limits are guardrails for the current test artifacts, not a claim that those assets can fit alongside guest RAM within a Worker isolate's memory budget.

## Current status

An isolated loader/WASM adapter spike exists on this branch, but headless guest execution remains unimplemented and undeployed. The next meaningful step is to create a Worker-specific v86 entry point that injects this loader into every guest-resource path, then prove a tiny guest boots and returns a shell marker before adding command dispatch.
