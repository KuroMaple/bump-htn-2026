#pragma once

#include "esp_err.h"

/* Bring up the stock ST7789 panel in its neutral, ready-to-bump state. This
 * has no BLE side effects; the scanner remains observer-only. */
esp_err_t badge_display_init(void);

/* Only call after a verified, completed connection event. */
esp_err_t badge_display_show_connection_found(void);

/* These calls are safe from the BLE host task. The display worker shows the
 * states in order and only returns to READY after a durable save. */
void badge_display_signal_connection_found(void);
void badge_display_signal_data_saved(void);

/* Compatibility alias for the old diagnostic scanner. */
void badge_display_signal_connection(void);
