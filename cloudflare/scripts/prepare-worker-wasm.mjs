import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("..", "public", "v86", "v86.wasm");
const destination = resolve("src", "generated", "v86.wasm");
const maxBytes = 8 * 1024 * 1024;

const info = await stat(source);
if (!info.isFile() || info.size < 1 || info.size > maxBytes) {
  throw new Error(`v86_wasm_source_size_invalid:${info.size}`);
}
await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Prepared statically compiled Worker WASM module (${info.size} bytes).`);
