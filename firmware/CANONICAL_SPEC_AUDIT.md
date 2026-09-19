# Canonical 2026 badge-spec audit

This audit treats the Hack the North custom-flash specification supplied on
2026-09-19 as authoritative over previous binary reverse-engineering.

## Corrected contradictions

| Area | Previous source | Canonical requirement | Correction |
| --- | --- | --- | --- |
| LCD color inversion | `badge-scanner/main/badge_display.c` used `invert_color(false)` | `invert_color(true)` | Changed to `true` and flashed Badge A. |
| LCD DMA | One 320 x 30 RGB565 DMA stripe | Two roughly 30-row DMA stripes | Allocates and alternates two 19,200-byte DMA stripes. |
| Flash target | Scanner SDK config generated a 2 MiB image header | 4 MiB, DIO, 80 MHz | Both project defaults and scanner's active config use 4 MiB / DIO / 80 MHz. |
| USB console | Base `firmware/` config had no USB-Serial-JTAG selection | Native USB-Serial-JTAG console | Added `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG=y`. |
| BLE mode | Base `firmware/` used legacy advertising/discovery APIs | NimBLE extended advertising and passive extended scan, 1M only | Converted base firmware to `ble_gap_ext_adv_*` and `ble_gap_ext_disc`; disabled 2M, coded PHY, and periodic advertising/sync. |
| BLE memory | Scanner used default-large extended-advertising pools | Trim connectionless pools to avoid OOM | Reduced advertised buffer limit and NimBLE mbuf / ACL / event pools. |
| ESP-IDF 5.5.3 | Base protocol omitted `esp_mac.h` and used invalid zero connection count | Pinned IDF v5.5.3-compatible configuration | Added `esp_mac.h`; set the minimum accepted connection count of one. |

The LCD GPIOs in the scanner already matched the canonical map: MOSI 10, CLK
1, CS 2, DC 0, reset 4, SPI2 mode 0 at 40 MHz. `swap_xy(true)` and
`mirror(true, false)` were also already correct.

## Not implemented, therefore not pin-mismatches

The current native sources do **not** contain a button, I2C accelerometer,
NFC, or WS2812 HAL. There is no existing GPIO/address/register value to
correct for these blocks. When these drivers are added, they must use:

- I2C: SDA 5, SCL 6, 400 kHz; SC7A20HTR `0x19`; MFRC522 `0x26`.
- HC165: DATA 7, LOAD 20, CLK 21; sample A, B, Home, Down, Left, Right, Up,
  Aux1 in that exact active-low order. Start is separate GPIO 9, active-low.
- SC7A20HTR: WHO_AM_I `0x0F == 0x11`; `CTRL_REG1=0x57`,
  `CTRL_REG4=0x80`; read `0x28 | 0x80` after STATUS `0x27` bit 3.
- LEDs: GPIO 3 through RMT, GRB order; physical sequence UpperLeft,
  UpperRight, MiddleRight, BottomRight, BottomLeft, MiddleLeft.
- NFC must be duty-cycled and must suspend accelerometer polling while active.

## Assumptions that remain unverified by the canonical hardware spec

- `firmware/main/bump_protocol.*` defines a project-local `BUMP` manufacturer
  advertisement (`company ID 0xFFFF`). The hardware spec does not define the
  venue's Connect handshake, so this is **not** proven interoperable with
  standard badge firmware and must not be used to declare a stock connection.
- The scanner's old `FOCUS_OUI` comment assumed the USB MAC would closely map
  to the on-air address. Captures showed rotating BLE addresses, so identity
  must come from an authenticated/verified protocol field, not a MAC prefix.
- The spec's flash-layout sentence is internally inconsistent: an app at
  `0x10000` with size `0x2A0000` ends at `0x2B0000`, which overlaps storage
  claimed to start at `0x140000`. Both projects deliberately retain their
  existing partition table until HTN supplies a non-overlapping CSV or an
  unambiguous app size. Do not flash a guessed partition table.

## Verified deployed state

Badge A (`E8:3D:C1:29:87:00`) received only its application image at
`0x10000`; its bootloader and partition table were not rewritten. The final
application readback SHA-256 was:

```
5b800706823b751497b3ca897008161ae63a713630e78778f7d83384f4bdf5b4
```
