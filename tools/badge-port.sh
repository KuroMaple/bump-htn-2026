#!/usr/bin/env bash
# Print the serial port currently belonging to the badge with the given MAC.
# Usage: badge-port.sh e8:3d:c1:29:87:00
set -euo pipefail
want="$(echo "${1:?usage: badge-port.sh <mac>}" | tr 'A-Z' 'a-z')"
for p in /dev/cu.usbmodem*; do
  mac="$(esptool.py -p "$p" read_mac 2>/dev/null | awk '/^MAC:/{print tolower($2); exit}')" || continue
  [ "$mac" = "$want" ] && { echo "$p"; exit 0; }
done
echo "no badge with MAC $want attached" >&2; exit 1
