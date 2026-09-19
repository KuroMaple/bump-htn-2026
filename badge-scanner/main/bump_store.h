#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#define BUMP_STORE_MAX_PROFILE_BYTES 255
#define BUMP_STORE_EVENT_ID_BYTES     40

typedef struct {
    char event_id[BUMP_STORE_EVENT_ID_BYTES];
    int8_t rssi;
    uint64_t uptime_ms;
    uint8_t profile_len;
    uint8_t profile[BUMP_STORE_MAX_PROFILE_BYTES];
} bump_store_record_t;

typedef bool (*bump_store_export_cb_t)(const bump_store_record_t *record, void *context);

/* Mount the existing `storage` LittleFS volume. This never formats the volume. */
esp_err_t bump_store_init(const uint8_t self_id[6]);

/* Atomically append an unsynchronised Connect profile observation. */
esp_err_t bump_store_append(const uint8_t *profile, uint8_t profile_len, int8_t rssi,
                            uint64_t uptime_ms, char out_event_id[BUMP_STORE_EVENT_ID_BYTES]);

/* Call the callback once per record not acknowledged by the laptop yet. */
size_t bump_store_export_pending(bump_store_export_cb_t callback, void *context);

/* Make a laptop acknowledgement durable. Unknown IDs are rejected. */
esp_err_t bump_store_mark_synced(const char *event_id);

bool bump_store_is_ready(void);
