#!/bin/sh
# VampireSquid Network Inspector — configured DNS, Google DNS IPs, then Google DoH.
echo "=== VAMPIRESQUID NETWORK INSPECTOR ==="
echo "--- Interfaces ---"
ifconfig -a 2>/dev/null || ip addr 2>/dev/null || echo "No interface inspection command found."
echo "--- Routes ---"
route -n 2>/dev/null || ip route 2>/dev/null || echo "No route inspection command found."
echo "--- Configured DNS ---"
cat /etc/resolv.conf 2>/dev/null || true
DNS_OK=0
if command -v nslookup >/dev/null 2>&1; then
  echo "--- Trying configured resolver ---"
  if nslookup google.com; then DNS_OK=1; echo "DNS_OK=configured"; fi
  if [ "$DNS_OK" -eq 0 ]; then
    echo "--- Trying Google Public DNS 8.8.8.8 ---"
    if nslookup google.com 8.8.8.8; then DNS_OK=1; echo "DNS_OK=google-8.8.8.8"; fi
  fi
  if [ "$DNS_OK" -eq 0 ]; then
    echo "--- Trying Google Public DNS 8.8.4.4 ---"
    if nslookup google.com 8.8.4.4; then DNS_OK=1; echo "DNS_OK=google-8.8.4.4"; fi
  fi
else
  echo "nslookup unavailable; skipping DNS-over-UDP checks."
fi
if [ "$DNS_OK" -eq 0 ] && command -v wget >/dev/null 2>&1; then
  echo "--- Trying Google DNS over HTTPS ---"
  if wget -T 8 -t 1 -qO- 'https://dns.google/resolve?name=google.com&type=A'; then
    DNS_OK=1
    echo
    echo "DNS_OK=google-doh"
  fi
fi
if [ "$DNS_OK" -eq 0 ]; then echo "DNS_FAILED=configured,8.8.8.8,8.8.4.4,google-doh"; fi
echo "--- External reachability ---"
if command -v ping >/dev/null 2>&1; then ping -c 1 1.1.1.1 || ping -c 1 8.8.8.8; else echo "ping is not installed."; fi
