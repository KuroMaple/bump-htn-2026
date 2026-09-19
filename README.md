# Bump

Pairing on the Hack the North badge. Two badges bumping creates one edge in a
shared graph; the graph is the product.

## Repo layout

| Path | What |
|---|---|
| `bump-app/` | The Lua app that runs on the badge (`main.lua`, `manifest.cfg`) |
| `firmware/` | ESP-IDF C sources (`bump_protocol.c/h`, `app_main.c`) |
| `badge-backup/` | Original badge firmware backup — **binary is gitignored** |

## The badge

ESP32-C3-MINI-1, RISC-V RV32IMAC, **80 MHz** (not 160), 400 KB SRAM, **no PSRAM**,
4 MB flash. Wi-Fi 4 + BLE 5. Chip rev v0.4.

Verified on hardware:

- **Display** 2.0" ST7789, **320x240 RGB565**, 40 MHz SPI, LVGL 9 repainting
  dirty 30-row DMA stripes.
- **6x WS2812B-2020 RGB LEDs** on GPIO3, individually addressable, RMT-driven.
- **Accelerometer: Silan SC7A20H** over I2C (shared bus with the NFC reader).
- **NFC: NXP MFRC522** reader + 13.56 MHz copper loop antenna. Reader only —
  **cannot pair two badges**, only read passive tags.
- **7 face buttons** via a 74HC165 shift register. **START is GPIO9**, the BOOT
  strap: hold it while plugging in USB for download mode.
- USB-C with native USB-Serial-JTAG (no UART bridge). Sleeps after 300 s idle,
  wakes on START.
- **eFuses completely unburned**: no secure boot, no flash encryption, JTAG
  enabled, download mode enabled.

Stock firmware: ESP-IDF v5.5.3, project `hello_world`, `v0.1.2-392-gd3089c4`,
built 2026-09-17. Partitions: `nvs` 16 KB, `phy_init` 4 KB, `factory` 2688 KB
(96.7% full), `storage` littlefs 1280 KB. **No OTA partitions.**

## Lua app platform

Apps live at `/littlefs/apps/<slug>/` with `main.lua` (max 64 KiB) and
`manifest.cfg`:

```
name = Bump
slug = bump
```

Install over the USB console: `put <path> <size>` then send raw bytes, then
`reload` (no reboot needed). Apps can also be shared badge-to-badge via the
built-in **Share** app (48 KiB max, receiver presses A to accept).

### API (verified by execution)

```
badge.me        badge_id() name() color() role() role_name() provisioned()
badge.contacts  count()  get(i)   -- 1-BASED; {badge_id,name,received_unix,role}
badge.radio     enable() disable() send(s) on_recv(fn) mac() dropped()
badge.sensor    accel() shake() tap() orientation()
badge.led       set() set_all() show() clear() count()   -- count()==6
badge.nfc       enable() disable() card() read_text() clear()
badge.fs        read() write() append() exists() list() mkdir() remove()
badge.store     get/set, get_int/set_int(key,default), get_str/set_str
badge.input     is_down(badge.button.X) held()
badge.sys       ms() heap() log() uptime() version() random() gc_step() wake_lock()
badge.ui        arc bar box button checkbox image label line roller slider
                switch textarea | theme (11 colors) | screen_width/height
badge.button    A=0 B=1 HOME=2 DOWN=3 LEFT=4 RIGHT=5 UP=6 AUX1=7 START=8
```

**There is no `share`/`install`/`pair`/`connect` API** — an app cannot push
itself to another badge or drive the stock bump handshake.

### Constraints that shape everything

- **No `pcall`.** Any error kills the app. Sandbox globals: `assert
  collectgarbage error getmetatable ipairs math next pairs print rawequal
  rawget rawlen rawset require select string table tonumber tostring type
  utf8 warn`.
- **No loops.** ~450 iterations raises `Lua stack safety limit reached`.
  No `sleep`, no `coroutine`. Do bounded work and return; callbacks fire later.
- **No canvas.** No per-pixel drawing is reachable from Lua. Tiles must be
  composed from primitives. `badge.ui.box{x=,y=,w=,h=,color=}` accepts arbitrary
  RGB ints. ~3.75 ms per object created.
- **fs paths are app-relative.** Absolute paths raise
  `path escapes the app sandbox`.
- **~18-24 KB Lua heap.** Source size itself costs heap.
- **Radio payload: hard cap 44 bytes**, and sends are **rate-limited** —
  consecutive sends return `false`. Spacing of ~200 ms works.

## Known firmware bugs (report to organizers)

- Bare `radio` console command panics: `Guru Meditation ... Load access fault`.
- `badge.radio.send()` with a 5000-byte payload crashes the badge hard enough
  to drop USB.
- BLE init fails under low heap (`nimble_port_init: ESP_FAIL` when largest free
  block is ~29 KB; it needs ~43 KB). `enable()` then reports the radio is not
  enabled.

## Running Bump

1. Open **Connect** on both badges and bump (the other person needs nothing
   installed).
2. Open **Apps -> Bump**. It sweeps the contact store and emits one edge per
   new pairing.

Output: `edges.jsonl` in the app sandbox, one JSON object per line.

```json
{"v":2,"a":"<id>","b":"<id>","observer":"<id>","peer_name":"...",
 "t_contact":502,"t_ms":27383,"rssi":null,"via":"contacts"}
```

`a` and `b` are sorted, so a pair has one canonical form regardless of which
badge observed it. Re-running never duplicates (seen-set in `seen.txt`).

**Badges have no RTC** — `t_ms` is uptime. Reconstruct wall-clock server-side.

### Radio path

`USE_RADIO` in `bump-app/main.lua` is **`false`** by default. Setting it `true`
enables direct badge-to-badge pairing (both badges need Bump) and gives you
RSSI. It has crashed the board twice under low heap — launch right after a
reboot, when the largest free block is ~69 KB.

**`badge.radio.on_recv`'s callback signature is UNVERIFIED** — it needs two
badges to observe. `on_packet` introspects whatever it receives and logs
`RX n=... raw=... rssi=...`.

## Recovering a badge

Backup restore (dump is gitignored — get it from Hassan):

```bash
esptool -p /dev/cu.usbmodem* write-flash 0x0 htn-badge-flash-full-4MB.bin
```

Download mode without buttons, over JTAG:

```bash
openocd -f board/esp32c3-builtin.cfg \
  -c "init; halt; mww 0x6000812C 0x00000001; reset run; shutdown"
```

Sets `RTC_CNTL_OPTION1.FORCE_DOWNLOAD_BOOT`; write `0` to the same register to
clear it. Or hold **START** while plugging in USB.
