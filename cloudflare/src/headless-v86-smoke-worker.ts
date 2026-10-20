import V86 from "../dist/headless-v86-bundle.js";
import { createCompiledV86WasmFn, getCompiledV86WasmInfo } from "./headless-v86-wasm";

type InstantiationOutcome = { instantiated: boolean; error?: string };
type InitializationOutcome = { initialized: boolean; error?: string };

export default {
  async fetch() {
    const wasm = getCompiledV86WasmInfo();
    let finishInstantiation!: (value: InstantiationOutcome) => void;
    const instantiationObserved = new Promise<InstantiationOutcome>((resolve) => {
      finishInstantiation = resolve;
    });
    let finishInitialization!: (value: InitializationOutcome) => void;
    const initializationObserved = new Promise<InitializationOutcome>((resolve) => {
      finishInitialization = resolve;
    });

    const compiledWasmFn = createCompiledV86WasmFn();
    const wasmFn = async (imports: WebAssembly.Imports) => {
      try {
        const exports = await compiledWasmFn(imports);
        finishInstantiation({ instantiated: true });
        return exports;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        finishInstantiation({ instantiated: false, error: message });
        finishInitialization({ initialized: false, error: message });
        return {} as WebAssembly.Exports;
      }
    };

    let constructorError: string | undefined;
    try {
      const emulator = new V86({
        wasm_fn: wasmFn,
        memory_size: 16 * 1024 * 1024,
        vga_memory_size: 1024 * 1024,
        autostart: false,
        disable_keyboard: true,
        disable_mouse: true,
      } as ConstructorParameters<typeof V86>[0]);
      emulator.add_listener("emulator-loaded", () => {
        finishInitialization({ initialized: true });
      });
    } catch (error) {
      constructorError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      finishInstantiation({ instantiated: false, error: constructorError });
      finishInitialization({ initialized: false, error: constructorError });
    }

    const instantiation = await Promise.race<InstantiationOutcome>([
      instantiationObserved,
      new Promise<InstantiationOutcome>((resolve) => setTimeout(() => resolve({
        instantiated: false,
        error: "v86_did_not_call_wasm_fn_within_5000ms",
      }), 5000)),
    ]);
    const initialization = await Promise.race<InitializationOutcome>([
      initializationObserved,
      new Promise<InitializationOutcome>((resolve) => setTimeout(() => resolve({
        initialized: false,
        error: "v86_emulator_loaded_event_not_seen_within_10000ms",
      }), 10000)),
    ]);

    return new Response(JSON.stringify({
      probe: "headless-v86-emulator-initialization",
      runtime: "workerd",
      wasm_module_loaded: wasm.module_loaded,
      wasm_import_count: wasm.imports.length,
      wasm_export_count: wasm.exports.length,
      static_module_instantiated: instantiation.instantiated,
      emulator_initialized: initialization.initialized,
      guest_booted: false,
      ...(instantiation.error ? { instantiation_error: instantiation.error } : {}),
      ...(initialization.error ? { initialization_error: initialization.error } : {}),
      ...(constructorError ? { constructor_error: constructorError } : {}),
      note: "Tests static WASM instantiation and v86 emulator initialization in Workerd with a small RAM allocation; does not restore a snapshot or boot Linux.",
    }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
