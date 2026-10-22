# Browser VM assets

The active dashboard is vm.html. It loads the v86 browser runtime from /v86/libv86.js and /v86/v86.wasm, then restores the selected user's saved emulator state through the Cloudflare snapshot API.

The current vm.html code does not select a boot ISO by filename. Files under boot/ are checked-in reference/experimental images, not the active snapshot-restore source. Do not treat an ISO's presence as proof that the browser VM boots from it.

## Assets

- bios/seabios.bin and bios/vgabios.bin: BIOS assets for v86.
- v86/libv86.js and v86/v86.wasm: browser emulator runtime.
- v86/backup-pre-x64/: retained older runtime backup; not loaded by the current dashboard.
- boot/: experimental/reference TinyCore ISO files and checksum metadata.

The VM's guest state is stored in Cloudflare R2 per snapshot identity. The browser VM is not an always-on server runtime: guest execution stops when the browser session stops.
