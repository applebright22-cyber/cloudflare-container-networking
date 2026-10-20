#!/bin/sh
# Tiny Core final-boot gate: network + verified HTTPS, then persist state.
# This deliberately does not start Fineproxy, Mysterium, or the Cloudflare runner.

set -u

LOG_FILE="/var/log/tinycore-final-boot.log"
IFACE="${NODE_INTERFACE:-eth0}"
HTTPS_TEST_URL="${BOOT_HTTPS_TEST_URL:-https://example.com/}"
ROUTE_WAIT_SECONDS=60
TLS_ATTEMPTS=10
TLS_TIMEOUT_SECONDS=8

mkdir -p /var/log
log() {
  printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG_FILE"
}
fail() {
  log "FAIL: $*"
  exit 1
}

[ "$(id -u)" = "0" ] || fail "must run as root"

log "Final boot checks started; interface=$IFACE"

# The custom ISO is responsible for DHCP. Here we only wait for the interface
# and default route, with a hard upper bound.
if command -v ip >/dev/null 2>&1; then
  ip link show "$IFACE" >/dev/null 2>&1 || fail "interface $IFACE not found"
  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig "$IFACE" up >>"$LOG_FILE" 2>&1 || true
  fi
  route_ready() { ip route show default 2>/dev/null | grep -q '^default '; }
elif command -v ifconfig >/dev/null 2>&1 && command -v route >/dev/null 2>&1; then
  ifconfig "$IFACE" >/dev/null 2>&1 || fail "interface $IFACE not found"
  ifconfig "$IFACE" up >>"$LOG_FILE" 2>&1 || true
  route_ready() { route -n 2>/dev/null | grep -q '^0[.]0[.]0[.]0[[:space:]]'; }
else
  fail "neither ip-route nor ifconfig/route tools are available"
fi

elapsed=0
while ! route_ready; do
  [ "$elapsed" -lt "$ROUTE_WAIT_SECONDS" ] || fail "no default route after ${ROUTE_WAIT_SECONDS}s"
  sleep 2
  elapsed=$((elapsed + 2))
done
log "Default route ready"

# Require a real HTTPS request with normal certificate validation. HTTP status
# does not matter here; a completed request proves DNS/TCP/TLS worked.
tls_ok=0
attempt=1
while [ "$attempt" -le "$TLS_ATTEMPTS" ]; do
  if command -v curl >/dev/null 2>&1; then
    if curl -sS -o /dev/null --connect-timeout 4 --max-time "$TLS_TIMEOUT_SECONDS" "$HTTPS_TEST_URL" >>"$LOG_FILE" 2>&1; then
      tls_ok=1
      break
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -T "$TLS_TIMEOUT_SECONDS" -q -O /dev/null "$HTTPS_TEST_URL" >>"$LOG_FILE" 2>&1; then
      tls_ok=1
      break
    fi
  else
    fail "curl or wget is required for the HTTPS/TLS check"
  fi
  log "HTTPS/TLS attempt $attempt/$TLS_ATTEMPTS failed"
  attempt=$((attempt + 1))
  [ "$attempt" -le "$TLS_ATTEMPTS" ] && sleep 2
done
[ "$tls_ok" -eq 1 ] || fail "HTTPS/TLS check failed for $HTTPS_TEST_URL"

log "HTTPS/TLS check passed: $HTTPS_TEST_URL"

# Persist only after all readiness checks pass and a backup target is configured.
# Refuse an obviously volatile /tmp target so a RAM-only backup is not reported
# as persistent state.
command -v filetool.sh >/dev/null 2>&1 || fail "filetool.sh not found; state was not saved"
[ -r /opt/.backup_device ] || fail "/opt/.backup_device missing; backup target is unknown"
BACKUP_DEVICE="$(cat /opt/.backup_device)"
[ -n "$BACKUP_DEVICE" ] || fail "backup target is empty; state was not saved"
case "$BACKUP_DEVICE" in
  /tmp|/tmp/*|tmp|tmp/*|/dev/shm|/dev/shm/*)
    fail "backup target is volatile ($BACKUP_DEVICE); state was not saved"
    ;;
esac
log "Configured Tiny Core backup target: $BACKUP_DEVICE"
if filetool.sh -b >>"$LOG_FILE" 2>&1; then
  log "PASS: final boot checks passed and Tiny Core state backup completed"
else
  fail "filetool.sh backup failed"
fi

exit 0
