/**
 * Cloudflare Workers cannot compile arbitrary WebAssembly bytes at runtime.
 * Wrangler packages this import as a CompiledWasm module instead.
 */
import wasmModule from "./generated/v86.wasm";

export function getCompiledV86WasmInfo() {
  return {
    module_loaded: wasmModule instanceof WebAssembly.Module,
    imports: WebAssembly.Module.imports(wasmModule),
    exports: WebAssembly.Module.exports(wasmModule),
  };
}

/** Adapter for v86's wasm_fn callback; actual guest initialization is separate. */
export function createCompiledV86WasmFn(): (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports> {
  return async (imports) => {
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    return instance.exports;
  };
}
