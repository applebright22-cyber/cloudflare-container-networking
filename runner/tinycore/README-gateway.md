# FineProxy / Mysterium gateway

The boot image is intended to operate as a two-interface virtual routing
gateway:

- eth0: WAN/upstream Internet. DHCP is used here only for upstream connectivity.
- eth1: isolated MystNode LAN. The gateway uses 10.240.0.1/24 and serves
  10.240.0.2-10.240.0.101 through BusyBox udhcpd.

FineProxy is an upstream SOCKS5 service, not a DHCP provider. Each node's
FineProxy endpoint and credentials must be injected at deployment time.

The transparent proxy layer should provide TCP forwarding and SOCKS5
UDP-associate handling. HevSocks5TProxy supports transparent TCP and UDP
forwarding through a SOCKS5 upstream.

Security:
- Never commit FineProxy usernames, passwords, API keys, or port mappings.
- Node traffic must fail closed rather than silently use the ISP path.
- Public inbound mapping is assumed to be supplied by FineProxy.

This repository contains the boot-time gateway foundation and configuration
contract. Credentials and per-node mappings remain runtime inputs.
