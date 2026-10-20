#!/bin/sh
set +e
MARKER="__NETWORK_INIT_DONE"
LOG=/tmp/network-init.log
: > "$LOG"
echo "===== Tiny Core network initialization ====="
echo "--- kernel ---"; uname -a; uname -r
echo "--- pci ---"; lspci -nn 2>&1 || true
echo "--- modules before ---"; lsmod 2>&1 || true
echo "--- interfaces before ---"; ifconfig -a 2>&1 || true
echo "--- proc net ---"; cat /proc/net/dev 2>&1 || true

MODPROBE=/sbin/modprobe
UDHCPC=/sbin/udhcpc
IFCONFIG=/sbin/ifconfig
ROUTE=/sbin/route

echo "--- loading NE2000 modules ---"
"$MODPROBE" 8390 2>&1 || true
"$MODPROBE" ne2k-pci 2>&1 || true
sleep 1
echo "--- modules after ---"; lsmod 2>&1 || true
echo "--- kernel log after module load ---"; dmesg | tail -80 2>&1 || true

eth=""
for i in $(seq 1 10); do
  if "$IFCONFIG" -a 2>/dev/null | grep -q '^eth[0-9]'; then
    eth=$("$IFCONFIG" -a 2>/dev/null | sed -n 's/^\(eth[0-9]\).*/\1/p' | head -1)
    break
  fi
  sleep 1
done

if [ -z "$eth" ]; then
  echo "ERROR: no eth interface appeared after loading ne2k-pci."
  echo "--- final interfaces ---"; "$IFCONFIG" -a 2>&1 || true
  echo "--- final kernel NIC log ---"; dmesg | grep -Ei 'eth|ne2k|ne2000|8390|pci|network|nic' 2>&1 || true
  printf '%s:%s\n' "$MARKER" "NO_ETH"
  exit 10
fi

echo "Detected interface: $eth"
"$IFCONFIG" "$eth" up 2>&1 || true

rc=1
for attempt in 1 2 3; do
  echo "--- DHCP attempt $attempt/3 ---"
  "$UDHCPC" -n -q -i "$eth" 2>&1
  rc=$?
  [ "$rc" -eq 0 ] && break
  sleep 1
done

echo "--- interfaces after DHCP ---"; "$IFCONFIG" -a 2>&1 || true
echo "--- routes ---"; "$ROUTE" -n 2>&1 || true
echo "--- DNS ---"; cat /etc/resolv.conf 2>&1 || true

if [ "$rc" -eq 0 ] && "$ROUTE" -n 2>/dev/null | grep -q '0.0.0.0'; then
  printf '%s:%s:%s\n' "$MARKER" "READY" "$eth"
  exit 0
fi

printf '%s:%s:%s\n' "$MARKER" "DHCP_FAILED" "$rc"
exit 11
