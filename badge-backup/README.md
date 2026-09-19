# Hack the North badge — original firmware backup

Full raw flash image, dumped before any modification. **This is the only known copy**
— HTN publishes no firmware repo. Do not delete.

| | |
|---|---|
| File | `htn-badge-flash-full-4MB.bin` |
| Size | 4,194,304 bytes (4 MiB, full flash) |
| SHA-256 | `1ec5147178a92cb1c60e711ece314d49547da1f2d8841d681dedf481faa3272e` |
| Verified | two independent dumps, identical hash |
| Dumped | 2026-09-18 |

## Second badge recovery image

| | |
|---|---|
| Badge USB MAC | `68:EE:8F:01:07:DC` |
| File | `htn-badge-flash-full-4MB-68EE8F0107DC.bin` |
| Size | 4,194,304 bytes (4 MiB, full flash) |
| SHA-256 | `10b64159cf2a97628bb92248e1818f9604c23d1824914ca43c5ea57fa0ac1680` |
| Acquired | 2026-09-19, via Espressif ROM loader `read-flash` only |

This is a distinct image, not a byte-for-byte replacement for the first badge.
Restore a badge only from the image recorded for its USB MAC.

## Board
- ESP32-C3-MINI-1 (QFN32), revision **v0.4**, RV32IMAC @160MHz
- 4MB embedded flash (XMC, mfr 0x46 / dev 0x4016), 40MHz crystal, no PSRAM
- MAC / JTAG serial: `E8:3D:C1:29:87:00`, JTAG IDCODE `0x00005C25`
- eFuses **completely unburned**: no secure boot, no flash encryption,
  JTAG enabled, download mode enabled, nothing read/write protected

## Firmware
- ESP-IDF **v5.5.3-dirty**, project name `hello_world`, version `v0.1.2-392-gd3089c4`
- Built Sep 17 2026 17:39:16 (one day before the event)

## Partition table
| Name | Type | Subtype | Offset | Size |
|---|---|---|---|---|
| nvs | data | nvs | 0x009000 | 16 KB |
| phy_init | data | phy | 0x00D000 | 4 KB |
| factory | app | factory | 0x010000 | 2688 KB |
| storage | data | littlefs | 0x2B0000 | 1280 KB |

No OTA partitions — single `factory` app slot.

## Restore
```bash
../tools/badge-restore.sh            # MAC-verified; refuses the wrong image
```

Verified 2026-09-19 on badge A: written and read back byte-for-byte matching
the recorded SHA-256. Recovery works.

## Entering download mode (no BOOT button on this board)
**Verified 2026-09-19: not needed.** esptool resets both badges into download
mode automatically over USB-Serial-JTAG. The JTAG route below is a fallback
only, kept in case automatic entry ever fails:
```bash
openocd -f board/esp32c3-builtin.cfg \
  -c "init; halt; mww 0x6000812C 0x00000001; reset run; shutdown"
```
That sets `RTC_CNTL_OPTION1.FORCE_DOWNLOAD_BOOT`; esptool then connects normally.
Clear it by writing `0x00000000` to the same register before the final reset.
