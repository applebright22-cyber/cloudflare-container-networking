#!/bin/sh
echo "===== NETWORK REPORT $(date) ====="
echo "--- id ---"
id
echo "--- interfaces ---"
ifconfig -a 2>&1
echo "--- ipv4 routes ---"
route -n 2>&1
echo "--- ipv6 routes ---"
route -A inet6 -n 2>&1
echo "--- kernel NIC ---"
dmesg | grep -Ei "eth|ne2k|ne2000|network|nic" 2>&1
echo "--- modules ---"
lsmod | grep -Ei "ne|8390|ether" 2>&1
echo "--- sockets ---"
netstat -lnptu 2>&1
echo "--- DNS ---"
cat /etc/resolv.conf 2>&1
echo "--- hostname ---"
hostname 2>&1
echo "--- busybox network ---"
busybox | grep -E "ifconfig|route|udhcpc|ping|ping6|netstat" 2>&1
echo "--- addresses via /proc ---"
cat /proc/net/dev 2>&1

echo "--- default gateway ---"
route -n 2>&1 | grep -E '^0[.]0[.]0[.]0[[:space:]]' || echo "NO_DEFAULT_GATEWAY"
echo "--- DNS lookup (if nslookup is installed) ---"
if command -v nslookup >/dev/null 2>&1; then
  nslookup raw.githubusercontent.com 2>&1
  echo "DNS_TEST_RC=$?"
else
  echo "DNS_TEST=nslookup_unavailable"
fi
echo "--- outbound HTTPS: example.com ---"
if command -v wget >/dev/null 2>&1; then
  wget -T 12 -q -O /dev/null https://example.com
  echo "EXAMPLE_HTTPS_RC=$?"
  echo "--- outbound HTTPS: raw.githubusercontent.com (bootstrap host) ---"
  wget -T 12 -q -O /dev/null https://raw.githubusercontent.com/brightlambre22-sketch/cloudflare-container-networking/main/README.md
  echo "GITHUB_HTTPS_RC=$?"
else
  echo "HTTPS_TEST=wget_unavailable"
fi
echo "===== END NETWORK REPORT ====="
