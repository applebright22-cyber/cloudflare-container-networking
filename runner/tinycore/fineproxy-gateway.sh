#!/bin/sh
set -eu

# FineProxy/Mysterium gateway bootstrap.
# WAN = upstream Internet connection.
# LAN = isolated MystNode network.
# FineProxy credentials/configuration are supplied at runtime only.

ENV_FILE="${GATEWAY_ENV_FILE:-/etc/cloudflare-node/gateway.env}"
LOG_FILE="${GATEWAY_LOG_FILE:-/var/log/fineproxy-gateway.log}"

mkdir -p /etc/cloudflare-node /var/log /var/run
log() { printf '%s %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE"; }

if [ ! -f "$ENV_FILE" ]; then
  log "gateway disabled: missing $ENV_FILE"
  exit 0
fi

. "$ENV_FILE"

: "${WAN_INTERFACE:=eth0}"
: "${LAN_INTERFACE:=eth1}"
: "${LAN_ADDRESS:=10.240.0.1}"
: "${LAN_NETMASK:=255.255.255.0}"
: "${DHCP_START:=10.240.0.2}"
: "${DHCP_END:=10.240.0.101}"
: "${DHCP_LEASE:=86400}"

IFCONFIG=${IFCONFIG:-/sbin/ifconfig}
UDHCPC=${UDHCPC:-/sbin/udhcpc}
UDHCPD=${UDHCPD:-/sbin/udhcpd}
GATEWAY_BIN=${GATEWAY_BIN:-/usr/local/bin/hev-socks5-tproxy}

if [ -x "$IFCONFIG" ]; then
  "$IFCONFIG" "$WAN_INTERFACE" up >>"$LOG_FILE" 2>&1 || true
fi
if [ -x "$UDHCPC" ]; then
  "$UDHCPC" -n -q -i "$WAN_INTERFACE" >>"$LOG_FILE" 2>&1 || true
fi

"$IFCONFIG" "$LAN_INTERFACE" "$LAN_ADDRESS" netmask "$LAN_NETMASK" up >>"$LOG_FILE" 2>&1

cat >/etc/udhcpd.conf <<EOF
start $DHCP_START
end $DHCP_END
interface $LAN_INTERFACE
option subnet $LAN_NETMASK
option lease $DHCP_LEASE
lease_file /var/run/udhcpd.leases
pidfile /var/run/udhcpd.pid
EOF

if [ -x "$UDHCPD" ] && ! "$UDHCPD" /etc/udhcpd.conf >>"$LOG_FILE" 2>&1; then
  log "udhcpd failed"
  exit 1
fi

if [ ! -x "$GATEWAY_BIN" ]; then
  log "FineProxy transparent gateway not installed: $GATEWAY_BIN"
  log "LAN/DHCP is ready; proxy routing remains fail-closed."
  exit 0
fi

if [ -z "${FINEPROXY_CONFIG:-}" ] || [ ! -f "$FINEPROXY_CONFIG" ]; then
  log "FineProxy config missing; proxy routing remains fail-closed."
  exit 0
fi

exec "$GATEWAY_BIN" "$FINEPROXY_CONFIG" >>"$LOG_FILE" 2>&1
