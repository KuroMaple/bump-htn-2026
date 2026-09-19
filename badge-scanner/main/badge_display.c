/*
 * Minimal, native ESP-LCD display proof for the HTN badge.
 *
 * The GPIOs and panel settings are recovered from badge A's stock firmware
 * backup; see ../DISPLAY_FINDINGS.md.  Keep this intentionally small: it
 * proves the physical display path without adding an unverified LVGL download
 * or changing the scanner's observer-only BLE role.
 */

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_check.h"
#include "esp_lcd_io_spi.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_st7789.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "badge_display.h"

#define LCD_HOST       SPI2_HOST
#define LCD_MOSI_GPIO  10
#define LCD_MISO_GPIO  -1
#define LCD_SCLK_GPIO  1
#define LCD_CS_GPIO    2
#define LCD_DC_GPIO    0
#define LCD_RST_GPIO   4
#define LCD_WIDTH      320
#define LCD_HEIGHT     240
#define STRIPE_ROWS    30

/* RGB565 colors. The panel is configured for the stock image's big-endian
 * wire order; ESP-LCD configures the ST7789 controller accordingly. */
#define RGB565(r, g, b) ((uint16_t)((((r) & 0x1f) << 11) | (((g) & 0x3f) << 5) | ((b) & 0x1f)))
#define C_BG       RGB565(2, 4, 8)
#define C_CARD     RGB565(4, 12, 20)
#define C_BORDER   RGB565(0, 42, 31)
#define C_ACCENT   RGB565(0, 58, 41)
#define C_TEXT     RGB565(31, 63, 31)
#define C_MUTED    RGB565(15, 34, 26)

static const char *TAG = "display";
static TaskHandle_t display_task;
static esp_lcd_panel_handle_t panel;

typedef enum {
    SCREEN_READY,
    SCREEN_CONNECTION_FOUND,
    SCREEN_DATA_SAVED,
} screen_state_t;

/* esp_lcd submits pixel buffers by DMA. The official badge spec calls for two
 * roughly-30-row DMA stripes, avoiding a full 153.6 KiB frame on the no-PSRAM
 * ESP32-C3. Each stripe is reused only after its transfer completes. */
static bool on_color_done(esp_lcd_panel_io_handle_t io,
                          esp_lcd_panel_io_event_data_t *event,
                          void *user_ctx)
{
    (void)io;
    (void)event;
    (void)user_ctx;
    BaseType_t task_woken = pdFALSE;
    vTaskNotifyGiveFromISR(display_task, &task_woken);
    return task_woken == pdTRUE;
}

/* 5x7 glyphs. Each row uses the low five bits, left to right (bit 4 = leftmost).
 * Full A-Z / 0-9 plus the punctuation that appears in badge identifiers, so
 * arbitrary captured text (names, badge_ids like "flower-peach-jay-panda")
 * renders instead of silently dropping unsupported characters. */
#define GLYPH_W 5
#define GLYPH_H 7
#define CELL_W  6 /* 5 glyph columns + 1 column of inter-character spacing */

static const uint8_t FONT_ALPHA[26][GLYPH_H] = {
    {0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11}, /* A */
    {0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e}, /* B */
    {0x0f, 0x10, 0x10, 0x10, 0x10, 0x10, 0x0f}, /* C */
    {0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e}, /* D */
    {0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f}, /* E */
    {0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10}, /* F */
    {0x0f, 0x10, 0x10, 0x13, 0x11, 0x11, 0x0f}, /* G */
    {0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11}, /* H */
    {0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1f}, /* I */
    {0x01, 0x01, 0x01, 0x01, 0x01, 0x11, 0x0e}, /* J */
    {0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11}, /* K */
    {0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f}, /* L */
    {0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11}, /* M */
    {0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11}, /* N */
    {0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e}, /* O */
    {0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10}, /* P */
    {0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d}, /* Q */
    {0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11}, /* R */
    {0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e}, /* S */
    {0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04}, /* T */
    {0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e}, /* U */
    {0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04}, /* V */
    {0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11}, /* W */
    {0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11}, /* X */
    {0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04}, /* Y */
    {0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f}, /* Z */
};

static const uint8_t FONT_DIGIT[10][GLYPH_H] = {
    {0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e}, /* 0 */
    {0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e}, /* 1 */
    {0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f}, /* 2 */
    {0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e}, /* 3 */
    {0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02}, /* 4 */
    {0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e}, /* 5 */
    {0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e}, /* 6 */
    {0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08}, /* 7 */
    {0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e}, /* 8 */
    {0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c}, /* 9 */
};

static const uint8_t GLYPH_HYPHEN[GLYPH_H] = {0, 0, 0, 0x1f, 0, 0, 0};
static const uint8_t GLYPH_PERIOD[GLYPH_H] = {0, 0, 0, 0, 0, 0, 0x04};
static const uint8_t GLYPH_COLON[GLYPH_H]  = {0, 0x04, 0, 0, 0, 0x04, 0};
static const uint8_t GLYPH_AT[GLYPH_H]     = {0x0e, 0x11, 0x17, 0x15, 0x17, 0x10, 0x0e};
static const uint8_t GLYPH_PLUS[GLYPH_H]   = {0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0};

static const uint8_t *glyph_for(char c)
{
    if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
    if (c >= 'A' && c <= 'Z') return FONT_ALPHA[c - 'A'];
    if (c >= '0' && c <= '9') return FONT_DIGIT[c - '0'];
    switch (c) {
    case '-': return GLYPH_HYPHEN;
    case '.': return GLYPH_PERIOD;
    case ':': return GLYPH_COLON;
    case '@': return GLYPH_AT;
    case '+': return GLYPH_PLUS;
    default:  return NULL; /* space and anything unmapped render blank */
    }
}

static uint8_t glyph_row(char c, int row)
{
    const uint8_t *g = glyph_for(c);
    if (g == NULL || row < 0 || row >= GLYPH_H) return 0;
    return g[row];
}

/* Inked width in pixels, excluding the trailing inter-character column. */
static int text_width(const char *text, int scale)
{
    int len = (int)strlen(text);
    return len <= 0 ? 0 : (len * CELL_W - 1) * scale;
}

static bool text_pixel(const char *text, int x, int y, int origin_x, int origin_y, int scale)
{
    int tx = x - origin_x;
    int ty = y - origin_y;
    if (tx < 0 || ty < 0 || ty >= GLYPH_H * scale) return false;
    int char_index = tx / (CELL_W * scale);
    /* Bound against the actual length: indexing past the terminator would be
     * an out-of-bounds read that paints stray glyphs to the right of a string. */
    if (char_index >= (int)strlen(text)) return false;
    int col = (tx / scale) % CELL_W;
    if (col >= GLYPH_W) return false; /* inter-character gap */
    return (glyph_row(text[char_index], ty / scale) & (1u << (GLYPH_W - 1 - col))) != 0;
}

/* Horizontally centred on center_x, so changing a string keeps it centred
 * instead of needing a hand-tuned origin per caller. */
static bool text_pixel_centered(const char *text, int x, int y,
                                int center_x, int origin_y, int scale)
{
    return text_pixel(text, x, y, center_x - text_width(text, scale) / 2, origin_y, scale);
}

static bool in_card(int x, int y)
{
    return x >= 16 && x < 304 && y >= 34 && y < 206;
}

static bool on_border(int x, int y)
{
    return in_card(x, y) && (x < 20 || x >= 300 || y < 38 || y >= 202);
}

static uint16_t pixel_for(screen_state_t state, int x, int y)
{
    uint16_t color = C_BG;
    if (in_card(x, y)) color = C_CARD;
    if (on_border(x, y)) color = C_BORDER;

    /* The green dot is deliberately neutral: it means the passive scanner is
     * running, not that an encounter has been recorded. */
    int dx = x - 160, dy = y - 66;
    if (dx * dx + dy * dy < 15 * 15) color = (state == SCREEN_READY) ? C_MUTED : C_ACCENT;
    if (y >= 92 && y < 95 && x >= 42 && x < 278) color = C_MUTED;

    /* Two centred lines per screen. Card interior is x 20..300, y 38..202, so
     * every string below is checked to sit inside the border at its scale. */
    if ((state == SCREEN_READY &&
         (text_pixel_centered("READY", x, y, 160, 112, 5) ||
          text_pixel_centered("TO TAP", x, y, 160, 155, 5))) ||
        (state == SCREEN_CONNECTION_FOUND &&
         (text_pixel_centered("CONNECTION", x, y, 160, 112, 4) ||
          text_pixel_centered("FOUND", x, y, 160, 153, 6))) ||
        (state == SCREEN_DATA_SAVED &&
         (text_pixel_centered("DATA", x, y, 160, 112, 6) ||
          text_pixel_centered("SAVED", x, y, 160, 153, 6)))) {
        color = C_TEXT;
    }
    return color;
}

static esp_err_t draw_screen(screen_state_t state)
{
    if (panel == NULL) return ESP_ERR_INVALID_STATE;

    uint16_t *stripes[2] = {
        heap_caps_malloc(LCD_WIDTH * STRIPE_ROWS * sizeof(uint16_t), MALLOC_CAP_DMA),
        heap_caps_malloc(LCD_WIDTH * STRIPE_ROWS * sizeof(uint16_t), MALLOC_CAP_DMA),
    };
    if (stripes[0] == NULL || stripes[1] == NULL) {
        heap_caps_free(stripes[0]);
        heap_caps_free(stripes[1]);
        return ESP_ERR_NO_MEM;
    }

    display_task = xTaskGetCurrentTaskHandle();
    for (int top = 0; top < LCD_HEIGHT; top += STRIPE_ROWS) {
        uint16_t *stripe = stripes[(top / STRIPE_ROWS) & 1];
        int rows = (LCD_HEIGHT - top < STRIPE_ROWS) ? LCD_HEIGHT - top : STRIPE_ROWS;
        for (int y = 0; y < rows; y++) {
            for (int x = 0; x < LCD_WIDTH; x++) {
                stripe[y * LCD_WIDTH + x] = pixel_for(state, x, top + y);
            }
        }
        esp_err_t result = esp_lcd_panel_draw_bitmap(panel, 0, top, LCD_WIDTH, top + rows, stripe);
        if (result != ESP_OK) {
            heap_caps_free(stripes[0]);
            heap_caps_free(stripes[1]);
            return result;
        }
        if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000)) == 0) {
            heap_caps_free(stripes[0]);
            heap_caps_free(stripes[1]);
            return ESP_ERR_TIMEOUT;
        }
    }

    heap_caps_free(stripes[0]);
    heap_caps_free(stripes[1]);
    return ESP_OK;
}

/* How long the connection card stays up after the last matching advert. */
#define CARD_HOLD_MS 4000

/* Signalled from the BLE host task. A dedicated worker owns all drawing so a
 * full-screen redraw never blocks NimBLE (which would drop adverts). A
 * length-1 overwrite queue is used rather than a task notification because
 * draw_screen() already uses this task's notification slot for DMA completion. */
static QueueHandle_t signal_queue;

enum {
    DISPLAY_CONNECTION_FOUND = 1,
    DISPLAY_DATA_SAVED = 2,
};

static void display_signal(uint8_t token)
{
    if (signal_queue != NULL) {
        /* Preserve FOUND followed by SAVED; overwriting a length-one queue can
         * skip the confirmation state when storage is fast. */
        xQueueSend(signal_queue, &token, 0);
    }
}

void badge_display_signal_connection_found(void)
{
    display_signal(DISPLAY_CONNECTION_FOUND);
}

void badge_display_signal_data_saved(void)
{
    display_signal(DISPLAY_DATA_SAVED);
}

void badge_display_signal_connection(void)
{
    badge_display_signal_connection_found();
}

static void display_worker(void *arg)
{
    (void)arg;
    screen_state_t current = SCREEN_READY;
    TickType_t hold_until = 0;

    for (;;) {
        uint8_t token;
        if (xQueueReceive(signal_queue, &token, pdMS_TO_TICKS(250)) == pdTRUE) {
            if (token == DISPLAY_CONNECTION_FOUND && current != SCREEN_CONNECTION_FOUND) {
                if (draw_screen(SCREEN_CONNECTION_FOUND) == ESP_OK) {
                    current = SCREEN_CONNECTION_FOUND;
                    ESP_LOGI(TAG, "connection card shown");
                }
            } else if (token == DISPLAY_DATA_SAVED) {
                if (draw_screen(SCREEN_DATA_SAVED) == ESP_OK) {
                    current = SCREEN_DATA_SAVED;
                    hold_until = xTaskGetTickCount() + pdMS_TO_TICKS(CARD_HOLD_MS);
                    ESP_LOGI(TAG, "data saved card shown");
                }
            }
        } else if (current == SCREEN_DATA_SAVED && (int32_t)(xTaskGetTickCount() - hold_until) >= 0) {
            if (draw_screen(SCREEN_READY) == ESP_OK) {
                current = SCREEN_READY;
                ESP_LOGI(TAG, "back to ready screen");
            }
        }
    }
}

esp_err_t badge_display_init(void)
{
    spi_bus_config_t bus_config = {
        .mosi_io_num = LCD_MOSI_GPIO,
        .miso_io_num = LCD_MISO_GPIO,
        .sclk_io_num = LCD_SCLK_GPIO,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = LCD_WIDTH * STRIPE_ROWS * sizeof(uint16_t),
    };
    ESP_RETURN_ON_ERROR(spi_bus_initialize(LCD_HOST, &bus_config, SPI_DMA_CH_AUTO), TAG,
                        "stock SPI bus init failed");

    esp_lcd_panel_io_handle_t io = NULL;
    const esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = LCD_CS_GPIO,
        .dc_gpio_num = LCD_DC_GPIO,
        .spi_mode = 0,
        .pclk_hz = 40 * 1000 * 1000,
        .trans_queue_depth = 1,
        .on_color_trans_done = on_color_done,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi(LCD_HOST, &io_config, &io), TAG,
                        "stock panel IO init failed");

    const esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = LCD_RST_GPIO,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .data_endian = LCD_RGB_DATA_ENDIAN_BIG,
        .bits_per_pixel = 16,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_st7789(io, &panel_config, &panel), TAG,
                        "ST7789 init failed");

    /* This sequence and the rotation flags are recovered from the stock image. */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_invert_color(panel, true), TAG, "invert config failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(panel), TAG, "reset failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(panel), TAG, "panel init failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_swap_xy(panel, true), TAG, "swap XY failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_disp_on_off(panel, true), TAG, "display-on failed");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_mirror(panel, true, false), TAG, "mirror config failed");

    ESP_RETURN_ON_ERROR(draw_screen(SCREEN_READY), TAG, "ready screen failed");
    ESP_LOGI(TAG, "ST7789 ready screen: 320x240, stock GPIO mapping, no radio TX");

    signal_queue = xQueueCreate(4, sizeof(uint8_t));
    ESP_RETURN_ON_FALSE(signal_queue != NULL, ESP_ERR_NO_MEM, TAG, "signal queue alloc failed");
    ESP_RETURN_ON_FALSE(
        xTaskCreate(display_worker, "display", 4096, NULL, 4, NULL) == pdPASS,
        ESP_ERR_NO_MEM, TAG, "display worker create failed");

    return ESP_OK;
}

esp_err_t badge_display_show_connection_found(void)
{
    ESP_RETURN_ON_ERROR(draw_screen(SCREEN_CONNECTION_FOUND), TAG, "connection card failed");
    ESP_LOGI(TAG, "verified connection card shown");
    return ESP_OK;
}
