# Headless v86 runtime: preflight status

This is a diagnostic milestone, **not a browserless Linux runtime**. It adds a Worker API that checks whether the configured R2 baseline is intact and can optionally test whether the Worker can compile the repository's v86 WebAssembly module. It does not create a Container, open a browser, instantiate v86, restore the guest, or run Linux commands.

## Call the preflight API

From a trusted machine:

```sh
curl -sS -X POST 'https://YOUR-WORKER-DOMAIN/v1/runtime/preflight' \
  -H 'Authorization: Bearer YOUR_VM_API_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"compile_wasm":true}'
```

`compile_wasm` is optional and defaults to false. Set it to true to fetch `/v86/v86.wasm` from Worker Assets and run `WebAssembly.compile` in the Worker isolate. The request is authenticated against the token stored in the private R2 object `config/vm-api-token.txt` in the Worker-bound `cloudflare-container-vm-snapshots` bucket. No `VM_API_TOKEN` Worker secret is required. Keep the R2 bucket private and do not expose the token in browser code.

The response reports baseline manifest validity, missing or incorrectly-sized snapshot chunks, total snapshot bytes, and the WASM compilation result. A successful result only proves those preflight checks succeeded.

## What remains unproven

The saved R2 object is a serialized v86 emulator state, not a standalone Linux disk image. Actual HTTP shell execution still requires a server-side v86 execution path that can:

1. instantiate the existing v86 build without DOM, canvas, keyboard, clipboard, or other browser-only dependencies;
2. restore the exact snapshot using compatible v86 options;
3. execute a real TinyCore command and return stdout, stderr, and exit status;
4. save updated state back to the account's own R2 snapshot identity;
5. stay within Worker CPU and memory limits.

The current browser-agent `/v1/vm/exec` route is unchanged and still needs its connected browser VM. The preflight endpoint intentionally does not claim otherwise. The existing `public/vm.html` path is not modified.

## Snapshot size warning

The current saved state has been reported as 103,896,296 bytes (about 99.1 MiB). That is already a substantial allocation before accounting for v86's WebAssembly linear memory, guest RAM, JS objects, snapshot decoding, and execution overhead. The preflight endpoint avoids reading all chunks into memory and only uses R2 object metadata. A real restore/command test is required before selecting Workers as the execution backend.

## Configure the API token in R2 (no Worker secret)

From the repository's `cloudflare` directory, use a trusted local PowerShell session. This prompts for the token without echoing it, writes a temporary UTF-8 file without a BOM, uploads it to the private R2 bucket, then removes the local file:

```powershell
$SecureToken = Read-Host "Enter a strong VM API token" -AsSecureString
$Ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureToken)
try {
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Ptr)
  [System.IO.File]::WriteAllText(
    "$PWD\vm-api-token.txt",
    $Token,
    [System.Text.UTF8Encoding]::new($false)
  )
  npx wrangler r2 object put cloudflare-container-vm-snapshots/config/vm-api-token.txt --file .\vm-api-token.txt
  if ($LASTEXITCODE -ne 0) { throw "R2 upload failed; do not continue until it succeeds." }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Ptr)
  Remove-Item .\vm-api-token.txt -ErrorAction SilentlyContinue
  Remove-Variable Token, SecureToken -ErrorAction SilentlyContinue
}
```

Then deploy the code change so the Worker reads this object. The R2 object is a plaintext token to Worker code (R2 provides encryption at rest, but anyone with sufficient bucket access can retrieve it). Restrict bucket access and rotate the token by uploading a replacement object. The object key is not exposed by any public route.
