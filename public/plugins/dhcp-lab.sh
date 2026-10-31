#!/bin/sh
# VampireSquid DHCP Lab. Default mode is read-only; renew is explicit.
ACTION=$1
[ -n "$ACTION" ] || ACTION=status
IFACE=$2
[ -n "$IFACE" ] || IFACE=eth0
case "$ACTION" in
  status)
    echo "=== VAMPIRESQUID DHCP LAB ==="
    echo "Interface: $IFACE"
    ifconfig "$IFACE" 2>/dev/null || ip addr show "$IFACE" 2>/dev/null || true
    echo "--- Default route ---"
    route -n 2>/dev/null || ip route 2>/dev/null || true
    echo "--- DHCP client ---"
    ps | grep '[u]dhcpc' || echo "No udhcpc process currently visible."
    echo "To request a fresh lease: $0 renew $IFACE"
    ;;
  renew)
    if ! command -v udhcpc >/dev/null 2>&1; then echo "udhcpc is not installed."; exit 127; fi
    echo "Requesting a DHCP lease on $IFACE..."
    if command -v sudo >/dev/null 2>&1; then exec sudo udhcpc -i "$IFACE" -n -q -f; else exec udhcpc -i "$IFACE" -n -q -f; fi
    ;;
  *) echo "Usage: $0 [status|renew] [interface]"; exit 2 ;;
esac
