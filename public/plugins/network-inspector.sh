#!/bin/sh
# VampireSquid Network Inspector — read-only guest network inspection.
echo "=== VAMPIRESQUID NETWORK INSPECTOR ==="
echo "--- Interfaces ---"
ifconfig -a 2>/dev/null || ip addr 2>/dev/null || echo "No interface inspection command found."
echo "--- Routes ---"
route -n 2>/dev/null || ip route 2>/dev/null || echo "No route inspection command found."
echo "--- DNS configuration ---"
cat /etc/resolv.conf 2>/dev/null || true
echo "--- DNS lookup ---"
if command -v nslookup >/dev/null 2>&1; then nslookup google.com; else echo "nslookup is not installed."; fi
echo "--- External reachability ---"
if command -v ping >/dev/null 2>&1; then ping -c 1 1.1.1.1; else echo "ping is not installed."; fi
