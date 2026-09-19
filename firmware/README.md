# Bump base firmware

This is a clean ESP-IDF starting point for a controlled Bump badge fleet. It
does **not** reuse or modify the Hack the North firmware image. The supplied
`../badge-backup/htn-badge-flash-full-4MB.bin` remains an untouched recovery
artifact.

## Current behavior

On an ESP32-C3, the firmware starts a BLE observer and non-connectable
advertiser. It sends a small Bump discovery packet containing an ephemeral
device identity and nonce, and logs nearby Bump packets over USB serial.

It intentionally does not initialize the screen, NFC reader, LEDs, or buttons
yet. Their canonical GPIO mappings are now documented in
[`CANONICAL_SPEC_AUDIT.md`](CANONICAL_SPEC_AUDIT.md); drivers still need to be
implemented before those peripherals are enabled.

## Provisioning model

Every badge must receive this base firmware through an authorized physical
provisioning workflow before it can receive a seamless Bump package. A stock
badge cannot safely or legitimately install a custom app just from a BLE packet.

The next implementation stages are:

1. Verify display/button/NFC pin mapping on one sacrificial development badge.
2. Replace discovery-only BLE with a mutual-confirmation GATT session.
3. Add a signed package format and transactional LittleFS install.
4. Put the distributor signing key only on the organizer device; recipients
   receive its public key and may verify/install but not redistribute.
5. Add a USB export command for `edges.jsonl`, consumed by the mosaic laptop.

## Build prerequisites

Install and activate ESP-IDF 5.5.x (the backup reports the original firmware
was built with 5.5.3), then run:

```bash
cd firmware
idf.py set-target esp32c3
idf.py build
```

Do not flash this to the event badge until its board pinout and boot/recovery
procedure have been tested. The current badge partition layout has one factory
application slot and no OTA fallback.
