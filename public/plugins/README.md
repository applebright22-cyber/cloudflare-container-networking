# VampireSquid Plugin Kit

VampireSquid plugins are versioned tools with declared runtime targets. TinyCore/Linux is the primary cockpit runtime; Android-compatible tools can target Android through Termux.

## Included plugins

- **Network Inspector (TinyCore)** — read-only interface and route inspection; tests the configured DNS resolver first, then falls back to Google Public DNS at 8.8.8.8 and 8.8.4.4.
- **DHCP Lab (TinyCore)** — inspect current DHCP state; request a new lease only when explicitly run with `renew`.
- **Backend Starter (TinyCore)** — creates a starter HTML application and serves it using BusyBox httpd on port 8080 inside the guest.
- **Oracle Bridge Connector (TinyCore)** — reads bridge status through the Cloudflare Worker.
- **Android Companion (Termux)** — reads Android build/network properties and tests Google's DNS-over-HTTPS JSON endpoint.

## TinyCore

```sh
chmod +x /home/tc/network-inspector.sh
/home/tc/network-inspector.sh
/home/tc/dhcp-lab.sh status eth0
/home/tc/dhcp-lab.sh renew eth0
/home/tc/backend-starter.sh
/home/tc/oracle-bridge-status.sh
```

Google DNS fallback uses direct resolver queries to 8.8.8.8 and 8.8.4.4. Network policies can block direct DNS on port 53; in that case, the Android Companion demonstrates Google's HTTPS DNS endpoint at `https://dns.google/resolve`, which requires HTTPS access and curl in Termux.

## Android / Termux

Install Termux on the Android device, copy `android-companion.sh` into Termux, then run:

```sh
pkg install curl
chmod +x android-companion.sh
./android-companion.sh
```

This is an Android shell plugin for Termux, not a native APK. Native Android app plugins can be added later using the same plugin IDs, versioning, and capability manifest with an Android app package as the runtime artifact.

## Runtime boundary

TinyCore plugins execute in the TinyCore guest. Android Companion executes on an Android device in Termux. Backend Starter currently serves only inside TinyCore. These plugins do not claim to deploy a persistent Oracle application. The Oracle deployment/runtime API and public application ingress must be implemented before a project can be marked as independently deployed. Never put account API keys or session tokens in plugin files.
