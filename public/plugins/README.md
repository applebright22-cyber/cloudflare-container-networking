# VampireSquid Plugin Kit

VampireSquid plugins are small, versioned tools designed for the TinyCore guest. The Studio Cockpit installs their entrypoint and manifest into a project so the project can carry its own developer tools.

## Included plugins

- **Network Inspector** — read-only interface, route, DNS, and reachability inspection.
- **DHCP Lab** — inspect current DHCP state; request a new lease only when explicitly run with `renew`.
- **Backend Starter** — creates a starter HTML application and serves it using BusyBox httpd on port 8080.

## Run inside TinyCore

Copy a selected script to the guest, then run:

```sh
chmod +x /home/tc/network-inspector.sh
/home/tc/network-inspector.sh
```

DHCP Lab defaults to read-only status:

```sh
/home/tc/dhcp-lab.sh status eth0
/home/tc/dhcp-lab.sh renew eth0
```

Backend Starter:

```sh
/home/tc/backend-starter.sh
```

## Runtime boundary

These first plugins execute in TinyCore. Backend Starter serves only inside the guest environment. They do not claim to deploy a persistent Oracle application. The Oracle deployment/runtime API and public application ingress must be implemented before a project can be marked as independently deployed. Never put account API keys or session tokens in plugin files.
