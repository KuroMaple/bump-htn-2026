# Display recovery: badge A stock image

This is a reproducible record of the display wiring for badge A
(`E8:3D:C1:29:87:00`). It comes from static inspection of that badge's saved
stock flash image, not from trial GPIO writes.

## Directly evidenced configuration

The stock image's `hal_display_init()` begins at IROM address `0x4200df1a`.
It constructs an ESP-LCD SPI bus configuration and an ST7789 panel
configuration. The relevant stores are:

| Stock code address | Config field | Value | Recovered setting |
| --- | --- | ---: | --- |
| `0x4200df40` | `mosi_io_num` | `10` | GPIO10 |
| `0x4200df44` | `miso_io_num` | `-1` | not connected |
| `0x4200df48` | `sclk_io_num` | `1` | GPIO1 |
| `0x4200df50` | `max_transfer_sz` | `0x4b00` | 19,200 bytes = 320 x 30 RGB565 stripe |
| `0x4200df52` | SPI host | `1` | `SPI2_HOST` in ESP-IDF |
| `0x4200df74` | `cs_gpio_num` | `2` | GPIO2 |
| zeroed config at `sp+104` | `dc_gpio_num` | `0` | GPIO0 |
| `0x4200df7e` | `pclk_hz` | `40,000,000` | 40 MHz, SPI mode 0 |
| `0x4200df80` | `trans_queue_depth` | `10` | 10 transfers |
| `0x4200df84`, `0x4200df86` | command / parameter widths | `8`, `8` | 8-bit commands and parameters |
| `0x4200dfa0` | `reset_gpio_num` | `4` | GPIO4 |
| `0x4200dfa4` | `bits_per_pixel` | `16` | RGB565 |

The otherwise-zeroed panel structure makes RGB element order and data endian
their ESP-IDF enum-zero defaults: RGB and big-endian wire order.

The official 2026 badge specification supersedes earlier reverse-engineering
for panel flags: configure inverted colors, reset and
initializes the panel, turns on landscape orientation (`swap_xy=true`), enables
the panel, and sets mirror-X only. `main/badge_display.c` reproduces that
sequence using the public ESP-IDF APIs.

## Not claimed

No independent backlight GPIO has yet been evidenced. The first visual test
does **not** drive any guessed backlight pin. If the initialized panel remains
dark, inspect that signal separately rather than trying arbitrary GPIOs.

## Scope of the proof screen

`main/badge_display.c` uses the built-in ESP-LCD ST7789 driver and two
19,200-byte DMA stripe buffers, matching the official 30-row buffering rule.
It draws
a neutral `TAP` card at boot. The `CONNECTION FOUND` card is only drawn when a
verified completion event invokes its explicit function. It does not change BLE
configuration: the scanner remains passive observer-only and sends no radio
packets.

LVGL 9 is not bundled in the locally installed ESP-IDF or this repository.
The native proof deliberately avoids downloading an unreviewed component before
the display path is visually confirmed. Once confirmed, the same recovered
panel handle can be used by an explicitly pinned LVGL 9 dependency.
