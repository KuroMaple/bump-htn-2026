# Badge A Bump controller

Native ESP-IDF firmware for the single controller badge. It broadcasts a small
Bump presence beacon, passively listens for the observed stock Connect profile
signatures (`BMP2` / `BPA1`), and does not connect to, write to, or change
nearby badges.

## Encounter flow

1. The screen begins at `READY TO TAP`.
2. A complete Connect profile at RSSI -78 dBm or stronger passes the marker and
   short repeat filters.
3. Badge A shows `CONNECTION FOUND`, commits the complete raw profile
   advertisement locally, then shows `DATA SAVED`.
4. The record remains through restart and power loss until a laptop receives it
   and acknowledges the exact event ID.

The journal mounts the existing 1.25 MiB `storage` LittleFS partition at
`/bump`. It uses `format_if_mount_failed = false`: mount failure means no data
is erased and no encounter is accepted.

## USB sync

```text
laptop -> BUMP_SYNC
badge  -> BUMP/1 RECORD {"event_id":"...","rssi":-62,"uptime_ms":...,"profile_hex":"..."}
badge  -> BUMP/1 END {"records":1}
laptop -> BUMP_ACK <event_id>
```

Use [`../gateway/bump_forwarder.py`](../gateway/bump_forwarder.py). It upserts
the full recognised profile through the authenticated admin API, posts the
connection event, and only then sends the acknowledgement. The public mosaic
continues to use its server-side alias/opt-in policy; private contact data is
not displayed publicly.

## Wireless laptop sync

Badge A has no baked-in network credentials. Configure it over USB with a
laptop hotspot (or a shared local Wi-Fi network) and a token-protected gateway:

```text
laptop -> BUMP_WIFI {"ssid":"BumpDemo","password":"...","gateway_url":"http://<laptop-LAN-IP>:8788/bump/1/record","token":"<shared-token>"}
badge  -> BUMP/1 WIFI {"status":"configured"}
```

After each saved encounter, the badge attempts the upload immediately and then
every 60 seconds while configured. It marks an event synced only after the
laptop has durably accepted it and the mosaic API has returned success. If the
laptop is absent, Wi-Fi fails, or the API is down, the item remains in the same
local journal and USB `BUMP_SYNC` can upload it later. `BUMP_WIFI_CLEAR`
removes the saved Wi-Fi setup.

The prototype uses HTTP on the local event network and stores the hotspot
password and local gateway token in the badge's NVS in plaintext. Use an
event-specific hotspot/password, do not use it on an untrusted network, and
clear it after the demo. They are never put in the project source or firmware
image.

## Build and flash

ESP-IDF v5.5.3 is required. `dependencies.lock` pins the LittleFS dependency.
`partitions.csv` is the exact 4 MiB layout recovered from Badge A's backup;
it is used only for size checks.

```bash
. /Users/hassanh/esp/esp-idf/export.sh
cd badge-scanner
idf.py build
```

The controller image is written at `0x10000`; do **not** use `idf.py flash`,
because it would also write the generated partition table. The existing layout
and storage partition are preserved.

```bash
PORT="$(../tools/badge-port.sh e8:3d:c1:29:87:00)"
esptool.py --chip esp32c3 -p "$PORT" write_flash 0x10000 build/badge_scanner.bin
```

The full 4 MiB stock backup remains the rollback path:

```bash
../tools/badge-restore.sh
```

The restore tool identifies the attached badge before choosing that badge's
backup, preventing accidental cross-flashing of Badge A and Badge B.
