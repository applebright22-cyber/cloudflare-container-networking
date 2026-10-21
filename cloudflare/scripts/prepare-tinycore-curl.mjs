import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public/boot/extensions");
const mirrors = [
  "https://distro.ibiblio.org/tinycorelinux/11.x/x86_64/tcz/",
  "http://repo.tinycorelinux.net/11.x/x86_64/tcz/",
];
const visited = new Set();
const downloaded = new Set();

async function get(url) {
  let lastError;
  for (const candidate of [url, ...mirrors.map((base) => base + url.split("/").pop())]) {
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(30000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      lastError = new Error(`HTTP ${response.status} for ${candidate}`);
    } catch (error) { lastError = error; }
  }
  throw lastError ?? new Error(`Could not fetch ${url}`);
}

async function fetchExtension(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const base = mirrors[0];
  const depBytes = await get(base + name + ".dep").catch(() => Buffer.from(""));
  const deps = depBytes.toString("utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.endsWith(".tcz"));
  for (const dep of deps) await fetchExtension(dep);
  const binary = await get(base + name);
  await writeFile(path.join(root, name), binary);
  downloaded.add(name);
  await writeFile(path.join(root, name + ".dep"), depBytes);
  const md5 = await get(base + name + ".md5.txt").catch(() => null);
  if (md5) await writeFile(path.join(root, name + ".md5.txt"), md5);
  console.log(`Bundled ${name} (${binary.length} bytes)`);
}

await mkdir(root, { recursive: true });
await fetchExtension("curl.tcz");
const names = [...downloaded].sort();
const install = [
  "#!/bin/sh",
  "# Generated at build time from the Tiny Core 11.x x86_64 extension repository.",
  "set -eu",
  'BASE_URL="${ORACLE_WORKER_URL%/}/boot/extensions"',
  'TCE_DIR="/tmp/oracle-tce"',
  'mkdir -p "$TCE_DIR/optional"',
  'export TCEDIR="$TCE_DIR"',
  ...names.flatMap((name) => [
    `wget -q -O "$TCE_DIR/optional/${name}" "$BASE_URL/${name}" || { echo "BUNDLED_EXTENSION_DOWNLOAD_FAILED=${name}"; exit 1; }`,
    `wget -q -O "$TCE_DIR/optional/${name}.dep" "$BASE_URL/${name}.dep" 2>/dev/null || rm -f "$TCE_DIR/optional/${name}.dep"`,
    `wget -q -O "$TCE_DIR/optional/${name}.md5.txt" "$BASE_URL/${name}.md5.txt" 2>/dev/null || rm -f "$TCE_DIR/optional/${name}.md5.txt"`
  ]),
  'cd "$TCE_DIR/optional"',
  'for f in *.tcz; do [ -f "$f" ] || continue; md5file="$f.md5.txt"; if [ -f "$md5file" ]; then expected="$(awk \'NR==1 {print $1}\' "$md5file")"; actual="$(md5sum "$f" | awk \'{print $1}\')"; [ "$expected" = "$actual" ] || { echo "BUNDLED_EXTENSION_CHECKSUM_FAILED=$f"; exit 1; }; fi; done',
  'tce-load -i curl.tcz',
  'command -v curl >/dev/null 2>&1 || { echo ORACLE_CURL_LOAD_FAILED; exit 1; }',
  'echo ORACLE_CURL_READY',
  ""
].join("\n");
await writeFile(path.join(root, "install-curl.sh"), install);
console.log(`Generated install-curl.sh with ${names.length} extensions: ${names.join(", ")}`);
