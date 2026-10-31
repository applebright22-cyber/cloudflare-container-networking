#!/bin/sh
# VampireSquid Backend Starter — creates a local TinyCore web app.
ROOT=$1
[ -n "$ROOT" ] || ROOT=/home/tc/vs-app
mkdir -p "$ROOT" || exit 1
if [ ! -f "$ROOT/index.html" ]; then
  cat > "$ROOT/index.html" <<'HTML'
<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VampireSquid App</title>
<style>body{font:16px system-ui;background:#10152b;color:#f4f6ff;padding:12vh 10vw}h1{font-size:clamp(2rem,7vw,4rem)}p{color:#aab8d4}</style>
<h1>Your VampireSquid app is alive.</h1><p>Built in TinyCore. Customize this file, then prepare it for deployment.</p>
</html>
HTML
fi
if ! command -v busybox >/dev/null 2>&1; then echo "BusyBox is required for the local web server."; exit 127; fi
echo "Serving $ROOT on port 8080. Open http://<TinyCore-IP>:8080"
busybox httpd -p 8080 -h "$ROOT"
