#!/bin/sh
# VampireSquid Network Inspector — DNS fallback uses Google Public DNS.
echo "=== VAMPIRESQUID NETWORK INSPECTOR ==="
echo "--- Interfaces ---"
ifconfig -a 2>/dev/null || ip addr 2>/dev/null || echo "No interface inspection command found."
echo "--- Routes ---"
route -n 2>/dev/null || ip route 2>/dev/null || echo "No route inspection command found."
echo "--- Configured DNS ---"
cat /etc/resolv.conf 2>/dev/null || true
echo "--- DNS resolution ---"
if ! command -v nslookup >/dev/null 2>&1; then
  echo "nslookup is not installed; DNS checks skipped."
else
  echo "Trying configured resolver..."
  if nslookup google.com; then
    echo "DNS_OK=configured"
  else
    echo "Configured resolver failed; trying Google Public DNS 8.8.8.8..."
    if nslookup google.com 8.8.8.8; then
      echo "DNS_OK=google-8.8.8.8"
    else
      echo "Trying Google Public DNS 8.8.4.4..."
      if nslookup google.com 8.8.4.4; then
        echo "DNS_OK=google-8.8.4.4"
      else
        echo "DNS_FAILED=configured,8.8.8.8,8.8.4.4"
      fi
    fi
  fi
fi
echo "--- External reachability ---"
if command -v ping >/dev/null 2>&1; then ping -c 1 1.1.1.1 || ping -c 1 8.8.8.8; else echo "ping is not installed."; fi
