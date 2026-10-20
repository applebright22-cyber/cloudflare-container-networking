# Tiny Core / v86 boot assets

The repository's canonical Tiny Core boot image is the verified custom
DHCP-enabled Pure64 image:

`public/boot/TinyCore_Pure64-11.0.iso`

It is based on Tiny Core Pure64 11.1 and was remastered from the working
Pure64 base. Its startup hook brings up `eth0` and requests an IPv4 address
through DHCP.

Expected boot layout:

```text
public/
├── boot/
│   └── TinyCore_Pure64-11.0.iso
├── bios/
│   ├── seabios.bin
│   └── vgabios.bin
└── v86/
    ├── libv86.js
    └── v86.wasm
```

`TinyCore_Pure64-11.0.iso` is the canonical checked-in boot asset for the browser/v86 VM.

The browser/v86 VM remains a boot/reference PoC. It is not the always-on
runtime for the persistent Tiny Core node.
