#pragma once

#include <stdbool.h>

#include "esp_err.h"

/*
 * Optional Wi-Fi transport to the laptop gateway. The journal remains the
 * source of truth: records are acknowledged only after the laptop returns a
 * successful response, and USB BUMP_SYNC continues to work independently.
 */
esp_err_t wireless_sync_init(void);
void wireless_sync_notify_pending(void);
esp_err_t wireless_sync_configure_json(const char *json);
esp_err_t wireless_sync_clear_config(void);
bool wireless_sync_is_configured(void);
