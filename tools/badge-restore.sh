#!/usr/bin/env bash
# Restore a HTN badge to stock from its OWN verified backup image.
#
# Safety model: the image is chosen by the badge's MAC, never by port number.
# Ports renumber on replug; MACs do not. The script refuses to write an image
# whose recorded MAC does not match the chip actually on the wire, which makes
# cross-flashing badge A's identity onto badge B structurally impossible.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="$REPO/badge-backup"

# MAC -> backup image. Add a row here when a new badge is dumped.
map_image() {
  case "$1" in
    e8:3d:c1:29:87:00) echo "htn-badge-flash-full-4MB.bin" ;;
    68:ee:8f:01:07:dc) echo "htn-badge-flash-full-4MB-68EE8F0107DC.bin" ;;
    *) return 1 ;;
  esac
}

PORT="${1:-}"
if [[ -z "$PORT" ]]; then
  PORTS="$(ls /dev/cu.usbmodem* 2>/dev/null | sort -u)"
  if [ "$(printf '%s\n' "$PORTS" | grep -c .)" -ne 1 ]; then
    echo "error: specify a port explicitly. Found: ${PORTS:-none}" >&2
    exit 2
  fi
  PORT="$PORTS"
fi

command -v esptool.py >/dev/null || { echo "error: esptool.py not on PATH; run: . ~/esp/esp-idf/export.sh" >&2; exit 2; }

echo "==> Reading chip identity on $PORT"
MAC="$(esptool.py -p "$PORT" read_mac 2>/dev/null | awk '/^MAC:/{print tolower($2); exit}')"
[[ -n "$MAC" ]] || { echo "error: could not read MAC from $PORT" >&2; exit 1; }
echo "    MAC: $MAC"

IMG="$(map_image "$MAC")" || {
  echo "REFUSING: no backup image recorded for MAC $MAC." >&2
  echo "Dump this badge first; do NOT write another badge's image to it." >&2
  exit 1; }
PATH_IMG="$BACKUP/$IMG"
echo "    Image for this badge: $IMG"

[[ -f "$PATH_IMG" ]] || { echo "REFUSING: $PATH_IMG is missing." >&2; exit 1; }

echo "==> Verifying image integrity"
SIZE=$(stat -f%z "$PATH_IMG")
[[ "$SIZE" -eq 4194304 ]] || { echo "REFUSING: $IMG is $SIZE bytes, expected 4194304." >&2; exit 1; }

WANT="$(awk -v f="$IMG" '$2==f{print $1}' "$BACKUP/SHA256SUMS")"
[[ -n "$WANT" ]] || { echo "REFUSING: no recorded SHA-256 for $IMG." >&2; exit 1; }
GOT="$(shasum -a 256 "$PATH_IMG" | awk '{print $1}')"
[[ "$WANT" == "$GOT" ]] || { echo "REFUSING: checksum mismatch, backup is corrupt." >&2; exit 1; }
echo "    OK 4 MiB, sha256 $GOT"

if [[ "${ASSUME_YES:-}" != "1" ]]; then
  echo
  echo "About to overwrite ALL 4 MiB of flash on $MAC ($PORT) with $IMG."
  read -r -p "Type the last 4 MAC hex digits to confirm: " reply
  [[ "$reply" == "${MAC//:/}" || "$reply" == "$(echo "$MAC" | tr -d ':' | tail -c 5)" ]] \
    || { echo "aborted."; exit 1; }
fi

echo "==> Writing flash (byte-exact: keep mode/freq/size so the image is not patched)"
esptool.py -p "$PORT" write_flash --flash_mode keep --flash_freq keep --flash_size keep 0x0 "$PATH_IMG"

echo "==> Verifying by reading flash back"
TMP="$(mktemp -t badge-readback)"
trap 'rm -f "$TMP"' EXIT
esptool.py -p "$PORT" read_flash 0x0 0x400000 "$TMP" >/dev/null
BACK="$(shasum -a 256 "$TMP" | awk '{print $1}')"
if [[ "$BACK" == "$WANT" ]]; then
  echo "SUCCESS: badge $MAC restored and verified byte-for-byte."
else
  echo "WARNING: read-back hash $BACK != expected $WANT" >&2
  exit 1
fi
