#!/data/data/com.termux/files/usr/bin/sh
# VampireSquid Android Companion — designed for Termux on Android.
echo "=== VAMPIRESQUID ANDROID COMPANION ==="
echo "--- Android build ---"
getprop ro.build.version.release 2>/dev/null || echo "Android build properties unavailable."
echo "--- Device network ---"
ip addr 2>/dev/null || ifconfig 2>/dev/null || echo "Install iproute2 or net-tools in Termux."
echo "--- DNS properties ---"
getprop net.dns1 2>/dev/null
getprop net.dns2 2>/dev/null
echo "--- Google DNS HTTPS resolver ---"
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 8 -H 'accept: application/dns-json' 'https://dns.google/resolve?name=google.com&type=A' || echo "Google DNS HTTPS query failed."
else
  echo "Install curl in Termux with: pkg install curl"
fi
echo "--- Android environment ---"
echo "Termux: $(command -v termux-info 2>/dev/null || echo unavailable)"
