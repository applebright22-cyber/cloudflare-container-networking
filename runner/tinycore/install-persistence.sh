#!/bin/sh
set -eu

# Install the network-only final-boot gate as Tiny Core's /opt/bootlocal.sh.
# Usage: sudo ./install-persistence.sh [runner-source-directory]
SRC="${1:-/tmp/cloudflare-node}"
BOOT_SRC="$SRC/bootlocal.sh"
DEST="/opt/bootlocal.sh"

[ -f "$BOOT_SRC" ] || {
  echo "bootlocal.sh not found in source directory: $SRC" >&2
  exit 1
}
[ -d /opt ] || { echo "/opt is unavailable" >&2; exit 1; }

cp "$BOOT_SRC" "$DEST"
chmod 755 "$DEST"

# Ensure /opt is included in Tiny Core's filetool backup list so this boot hook
# itself survives the successful save. Do not trigger a backup during install:
# the boot hook performs it only after route and verified HTTPS checks pass.
if [ ! -f /opt/.filetool.lst ]; then
  printf '%s\n' 'opt' > /opt/.filetool.lst
elif ! grep -qx 'opt' /opt/.filetool.lst; then
  printf '%s\n' 'opt' >> /opt/.filetool.lst
fi

echo "Installed network-only final-boot gate at $DEST"
echo "On the next boot it will wait for a default route, verify HTTPS/TLS,"
echo "and run filetool.sh -b only if those checks pass."
