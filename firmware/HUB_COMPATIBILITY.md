# Stock hub and Connect compatibility notes

This document records observed behavior from the two administrator-provided HTN
badges. It separates facts observed from the stock console or images from
protocol work that still requires a controlled capture.

## Recovery inventory

| Badge USB MAC | Recovery image | SHA-256 |
|---|---|---|
| `E8:3D:C1:29:87:00` | `../badge-backup/htn-badge-flash-full-4MB.bin` | `1ec5147178a92cb1c60e711ece314d49547da1f2d8841d681dedf481faa3272e` |
| `68:EE:8F:01:07:DC` | `../badge-backup/htn-badge-flash-full-4MB-68EE8F0107DC.bin` | `10b64159cf2a97628bb92248e1818f9604c23d1824914ca43c5ea57fa0ac1680` |

Both images are 4 MiB full-flash reads. Neither may be used as a generic image
for the other badge because they differ in firmware and/or badge-specific state.

## Confirmed stock hub contract

The stock USB console offers these relevant commands:

| Surface | Confirmed behavior |
|---|---|
| `snapshot [stats]` | Packs a filesystem JSON snapshot for transfer. |
| `xfer` | Reports transfer state, server status, frame counts, repairs, sent bytes, elapsed time, and recently heard station RSSI. |
| `radio [probe]` | Radio diagnostic. On the observed first-badge revision, invoking it from an active Connect session caused a rebooting load-access fault; do not use it for capture. |
| `badge_profile apply` | Applies a server profile supplied through the console. |
| `badge_token` | Manages a USB upload credential. |
| `put`, `reload`, `apps` | Upload, rescan, and list Lua applications. |

The first badge boot log additionally confirms that Connect starts BLE 5 extended
advertising and extended discovery. The stock image contains the marker
`HTNSYNC1`, and the Sync UI instructs badges to create a filesystem snapshot and
look for a station. This supports the following model:

```text
Badge snapshot -> BLE sync-station transfer -> station/backend ingest
```

The payload format, station advertisement fields, acknowledgement scheme, and
backend API are **not yet characterized**. They must be captured rather than
guessed.

## Existing passive capture app

The first badge already has an installed `Sniff` Lua app at
`/littlefs/apps/sniff/main.lua`. It enables the Lua radio API, registers
`badge.radio.on_recv`, and appends received callback arguments to
`/littlefs/appdata/sniff/sniff.log` (visible as `sniff.log` in the app sandbox).
It is the safest available starting point for a controlled two-badge capture.

## Capture plan

1. Leave one badge on stock firmware in **Connect**.
2. Launch **Sniff** on the other badge and keep it nearby.
3. Run one successful Connect bump, then wait 60 seconds.
4. Export only the Sniff log through USB and label it with the test case.
5. Repeat for: idle Connect, failed/no-peer bump, and successful repeat bump.
6. Compare callback arguments and timestamps to identify discovery fields and
   state transitions.
7. Only after the wire format is measured, implement a `connect_compat` module
   in native Bump firmware and test it against the stock Connect app.

## Safe duplication target

The first replacement should be a laptop-backed Bump hub, not an attempt to
emulate the whole existing station blindly:

```text
Custom Bump badge -> durable edge log -> USB laptop gateway -> mosaic API
```

Once the measured `HTNSYNC1` transfer is understood, a BLE station emulator can
be added behind the same gateway. Keep the receiver and storage transaction
separate from the web API so either transport can feed the mosaic.
