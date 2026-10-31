#!/bin/sh
# VampireSquid Website Preview — TinyCore guest program.
# Usage: ./website-builder.sh [project-directory] [port]
ROOT=${1:-/home/tc/vs-site}
PORT=${2:-8080}
case "$PORT" in ''|*[!0-9]*) echo "Port must be numeric."; exit 2;; esac
[ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || { echo "Choose a port from 1024 to 65535."; exit 2; }
mkdir -p "$ROOT" || exit 1
if [ ! -f "$ROOT/index.html" ]; then
cat > "$ROOT/index.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VampireSquid Site Preview</title><style>*{box-sizing:border-box}body{margin:0;background:#10152b;color:#f5f6ff;font:16px/1.6 system-ui,sans-serif}.nav{padding:22px 8%;border-bottom:1px solid #ffffff22;font-weight:800}.hero{padding:12vh 10%;background:radial-gradient(ellipse at 80% 20%,#a33cff66,transparent 55%)}h1{font-size:clamp(38px,7vw,72px);line-height:1.05;max-width:850px;margin:18px 0}p{color:#c3cbe0;max-width:680px}.cta{display:inline-block;margin-top:18px;padding:12px 20px;border-radius:8px;background:#a33cff;color:white;text-decoration:none;font-weight:700}.section{padding:70px 10%;border-top:1px solid #ffffff18}</style></head><body><nav class="nav">YOUR BUSINESS</nav><main><section class="hero"><small>WELCOME</small><h1>Your business website starts here.</h1><p>Replace this starter page with your customized Studio export.</p><a class="cta" href="#contact">Get in touch</a></section><section class="section"><h2>What we do</h2><p>Describe your services and what makes your business special.</p></section><section class="section" id="contact"><h2>Contact</h2><p>Add your business contact details here.</p></section></main></body></html>
HTML
fi
if ! command -v busybox >/dev/null 2>&1; then echo "BusyBox is required."; exit 127; fi
echo "VampireSquid preview: $ROOT on port $PORT"
echo "Copy your exported Studio index.html into $ROOT to preview your customized site."
exec busybox httpd -f -p "$PORT" -h "$ROOT"
