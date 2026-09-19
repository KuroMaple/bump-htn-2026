/*
 * Bump controller for Badge A.
 *
 * It advertises a small Bump controller beacon while passively receiving stock
 * Connect profile advertisements. A valid profile is copied off the NimBLE
 * callback, durably journaled, then made available over USB for the laptop
 * gateway. It never sends a packet to, connects to, or modifies Badge B.
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/ble_hs_id.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"

#include "badge_display.h"
#include "bump_store.h"
#include "wireless_sync.h"

#define BUMP_RSSI_DBM       (-78)
#define RECENT_PROFILE_MS   12 * 1000
#define RECENT_PROFILE_N    32

static const char *TAG = "bump-controller";
static uint8_t self_id[6];
static uint8_t own_addr_type;
static QueueHandle_t profile_queue;

typedef struct {
    uint8_t length;
    int8_t rssi;
    uint64_t uptime_ms;
    uint8_t data[BUMP_STORE_MAX_PROFILE_BYTES];
} profile_candidate_t;

static struct {
    uint32_t hash;
    int64_t seen_ms;
} recent_profiles[RECENT_PROFILE_N];

static uint32_t fnv1a(const uint8_t *data, size_t length)
{
    uint32_t hash = 2166136261u;
    for (size_t i = 0; i < length; ++i) {
        hash ^= data[i];
        hash *= 16777619u;
    }
    return hash;
}

/* Only the observed Connect profile signatures qualify. Hub/game beacons and
 * arbitrary BLE ads are deliberately ignored. */
static bool has_connect_profile_marker(const uint8_t *data, uint8_t length)
{
    for (uint8_t i = 0; i + 4 <= length; ++i) {
        if ((memcmp(data + i, "BMP2", 4) == 0) || (memcmp(data + i, "BPA1", 4) == 0)) {
            return true;
        }
    }
    return false;
}

static bool is_recent_duplicate(const uint8_t *data, uint8_t length, int64_t now_ms)
{
    const uint32_t hash = fnv1a(data, length);
    size_t oldest = 0;
    for (size_t i = 0; i < RECENT_PROFILE_N; ++i) {
        if (recent_profiles[i].hash == hash && recent_profiles[i].seen_ms != 0) {
            if (now_ms - recent_profiles[i].seen_ms < RECENT_PROFILE_MS) return true;
            recent_profiles[i].seen_ms = now_ms;
            return false;
        }
        if (recent_profiles[i].seen_ms < recent_profiles[oldest].seen_ms) oldest = i;
    }
    recent_profiles[oldest] = (typeof(recent_profiles[0])){ .hash = hash, .seen_ms = now_ms };
    return false;
}

static void queue_profile(const uint8_t *data, uint8_t length, int8_t rssi)
{
    const int64_t now_ms = esp_timer_get_time() / 1000;
    if (length == 0 || rssi < BUMP_RSSI_DBM ||
        !has_connect_profile_marker(data, length) || is_recent_duplicate(data, length, now_ms)) {
        return;
    }
    profile_candidate_t candidate = {
        .length = length,
        .rssi = rssi,
        .uptime_ms = (uint64_t)now_ms,
    };
    memcpy(candidate.data, data, length);
    if (xQueueSend(profile_queue, &candidate, 0) != pdTRUE) {
        ESP_LOGW(TAG, "profile queue full; encounter left unsaved");
    }
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;
#if MYNEWT_VAL(BLE_EXT_ADV)
    if (event->type == BLE_GAP_EVENT_EXT_DISC) {
        const struct ble_gap_ext_disc_desc *desc = &event->ext_disc;
        /* A partial chained extended advertising report is not a complete
         * profile. Wait for a complete report instead of recording fragments. */
        if (desc->data_status == 0) queue_profile(desc->data, desc->length_data, desc->rssi);
        return 0;
    }
#endif
    if (event->type == BLE_GAP_EVENT_DISC) {
        queue_profile(event->disc.data, event->disc.length_data, event->disc.rssi);
    }
    return 0;
}

static void start_scanning(void)
{
#if MYNEWT_VAL(BLE_EXT_ADV)
    const struct ble_gap_ext_disc_params params = {
        .passive = 1,
        .itvl = 0x0060,
        .window = 0x0060,
    };
    const int rc = ble_gap_ext_disc(own_addr_type, 0, 0, 0,
                                    BLE_HCI_SCAN_FILT_NO_WL, 0,
                                    &params, NULL, gap_event, NULL);
#else
    const struct ble_gap_disc_params params = {
        .passive = 1, .filter_duplicates = 0, .itvl = 0x0060, .window = 0x0060,
    };
    const int rc = ble_gap_disc(own_addr_type, BLE_HS_FOREVER, &params, gap_event, NULL);
#endif
    if (rc != 0) ESP_LOGE(TAG, "passive scan did not start: %d", rc);
}

static void start_controller_advertising(void)
{
    const uint8_t controller_beacon[] = {
        0xff, 0xff, 'B', 'U', 'M', 'P', 1,
        self_id[0], self_id[1], self_id[2], self_id[3], self_id[4], self_id[5],
    };
    struct ble_hs_adv_fields fields = {
        .flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP,
        .mfg_data = controller_beacon,
        .mfg_data_len = sizeof(controller_beacon),
        .name = (const uint8_t *)"Bump",
        .name_len = 4,
        .name_is_complete = 1,
    };
    struct os_mbuf *data = os_msys_get_pkthdr(BLE_HCI_MAX_ADV_DATA_LEN, 0);
    if (!data) {
        ESP_LOGE(TAG, "controller beacon allocation failed");
        return;
    }
    int rc = ble_hs_adv_set_fields_mbuf(&fields, data);
    if (rc != 0) {
        os_mbuf_free_chain(data);
        ESP_LOGE(TAG, "controller beacon fields failed: %d", rc);
        return;
    }
#if MYNEWT_VAL(BLE_EXT_ADV)
    struct ble_gap_ext_adv_params params = {0};
    params.own_addr_type = own_addr_type;
    params.primary_phy = BLE_HCI_LE_PHY_1M;
    params.secondary_phy = BLE_HCI_LE_PHY_1M;
    params.sid = 0;
    rc = ble_gap_ext_adv_configure(0, &params, NULL, gap_event, NULL);
    if (rc == 0) rc = ble_gap_ext_adv_set_data(0, data);
    if (rc == 0) rc = ble_gap_ext_adv_start(0, 0, 0);
#else
    struct ble_gap_adv_params params = {0};
    rc = ble_gap_adv_set_data_mbuf(data);
    if (rc == 0) rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
#endif
    if (rc != 0) ESP_LOGE(TAG, "controller beacon failed: %d", rc);
    else ESP_LOGI(TAG, "controller beacon broadcasting; passive Connect scan active");
}

static void profile_store_task(void *arg)
{
    (void)arg;
    for (;;) {
        profile_candidate_t candidate;
        if (xQueueReceive(profile_queue, &candidate, portMAX_DELAY) != pdTRUE) continue;
        badge_display_signal_connection_found();
        char event_id[BUMP_STORE_EVENT_ID_BYTES];
        const esp_err_t result = bump_store_append(candidate.data, candidate.length, candidate.rssi,
                                                   candidate.uptime_ms, event_id);
        if (result == ESP_OK) {
            badge_display_signal_data_saved();
            wireless_sync_notify_pending();
            ESP_LOGI(TAG, "saved connection %s (%u bytes, rssi=%d)",
                     event_id, candidate.length, candidate.rssi);
        } else {
            ESP_LOGE(TAG, "connection was not saved: %s", esp_err_to_name(result));
        }
    }
}

static void hex_encode(const uint8_t *input, size_t length, char *output)
{
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < length; ++i) {
        output[i * 2] = hex[input[i] >> 4];
        output[i * 2 + 1] = hex[input[i] & 0x0f];
    }
    output[length * 2] = '\0';
}

static void usb_write(const char *text)
{
    usb_serial_jtag_write_bytes(text, strlen(text), pdMS_TO_TICKS(1000));
    usb_serial_jtag_wait_tx_done(pdMS_TO_TICKS(1000));
}

static bool export_record(const bump_store_record_t *record, void *context)
{
    (void)context;
    char profile_hex[BUMP_STORE_MAX_PROFILE_BYTES * 2 + 1];
    char line[700];
    hex_encode(record->profile, record->profile_len, profile_hex);
    snprintf(line, sizeof(line),
             "BUMP/1 RECORD {\"event_id\":\"%s\",\"rssi\":%d,\"uptime_ms\":%" PRIu64
             ",\"profile_hex\":\"%s\"}\n",
             record->event_id, record->rssi, record->uptime_ms, profile_hex);
    usb_write(line);
    return true;
}

static void handle_usb_command(char *command)
{
    command[strcspn(command, "\r\n")] = '\0';
    if (strcmp(command, "BUMP_SYNC") == 0) {
        const size_t count = bump_store_export_pending(export_record, NULL);
        char done[64];
        snprintf(done, sizeof(done), "BUMP/1 END {\"records\":%u}\n", (unsigned)count);
        usb_write(done);
    } else if (strncmp(command, "BUMP_ACK ", 9) == 0) {
        const esp_err_t result = bump_store_mark_synced(command + 9);
        ESP_LOGI(TAG, "sync acknowledgement %s: %s", command + 9, esp_err_to_name(result));
    } else if (strcmp(command, "BUMP_STATUS") == 0) {
        char status[112];
        snprintf(status, sizeof(status), "BUMP/1 STATUS {\"storage\":\"%s\",\"wireless\":\"%s\"}\n",
                 bump_store_is_ready() ? "ready" : "unavailable",
                 wireless_sync_is_configured() ? "configured" : "unconfigured");
        usb_write(status);
    } else if (strncmp(command, "BUMP_WIFI ", 10) == 0) {
        const esp_err_t result = wireless_sync_configure_json(command + 10);
        usb_write(result == ESP_OK ? "BUMP/1 WIFI {\"status\":\"configured\"}\n"
                                   : "BUMP/1 WIFI {\"status\":\"invalid\"}\n");
    } else if (strcmp(command, "BUMP_WIFI_CLEAR") == 0) {
        const esp_err_t result = wireless_sync_clear_config();
        usb_write(result == ESP_OK ? "BUMP/1 WIFI {\"status\":\"cleared\"}\n"
                                   : "BUMP/1 WIFI {\"status\":\"error\"}\n");
    }
}

static void usb_sync_task(void *arg)
{
    (void)arg;
    usb_serial_jtag_driver_config_t config = {
        .tx_buffer_size = 2048,
        /* Wi-Fi setup is sent as one JSON command, which can be longer than
         * a raw profile record. Keep enough headroom for a full SSID, URL and
         * local gateway token. */
        .rx_buffer_size = 1024,
    };
    const esp_err_t install = usb_serial_jtag_driver_install(&config);
    if (install != ESP_OK) {
        ESP_LOGE(TAG, "USB sync unavailable: %s", esp_err_to_name(install));
        vTaskDelete(NULL);
        return;
    }
    char command[512] = {0};
    size_t used = 0;
    for (;;) {
        char byte;
        const int got = usb_serial_jtag_read_bytes(&byte, 1, pdMS_TO_TICKS(500));
        if (got != 1) continue;
        if (byte == '\n' || byte == '\r') {
            if (used) {
                command[used] = '\0';
                handle_usb_command(command);
                used = 0;
            }
        } else if (used + 1 < sizeof(command)) {
            command[used++] = byte;
        } else {
            used = 0;
        }
    }
}

static void on_sync(void)
{
    if (ble_hs_id_infer_auto(0, &own_addr_type) != 0) {
        ESP_LOGE(TAG, "unable to select BLE address");
        return;
    }
    start_controller_advertising();
    start_scanning();
}

static void nimble_host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    esp_err_t result = nvs_flash_init();
    if (result == ESP_ERR_NVS_NO_FREE_PAGES || result == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* Do not erase automatically: that could destroy the sequence counter
         * used for retry-safe events. Recovery requires an explicit action. */
        ESP_LOGE(TAG, "NVS needs recovery; refusing to erase connection metadata");
        return;
    }
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "NVS unavailable: %s", esp_err_to_name(result));
        return;
    }
    ESP_ERROR_CHECK(esp_read_mac(self_id, ESP_MAC_BT));
    result = badge_display_init();
    if (result != ESP_OK) ESP_LOGE(TAG, "display unavailable: %s", esp_err_to_name(result));
    result = bump_store_init(self_id);
    if (result != ESP_OK) ESP_LOGE(TAG, "offline storage unavailable; encounters will not be accepted");
    result = wireless_sync_init();
    if (result != ESP_OK) ESP_LOGE(TAG, "wireless sync unavailable: %s", esp_err_to_name(result));

    profile_queue = xQueueCreate(8, sizeof(profile_candidate_t));
    if (!profile_queue || xTaskCreate(profile_store_task, "bump-store", 6144, NULL, 4, NULL) != pdPASS ||
        xTaskCreate(usb_sync_task, "bump-usb", 4096, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "could not start Bump tasks");
        return;
    }
    ESP_ERROR_CHECK(nimble_port_init());
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(nimble_host_task);
    ESP_LOGI(TAG, "Bump controller ready: %02x:%02x:%02x:%02x:%02x:%02x",
             self_id[0], self_id[1], self_id[2], self_id[3], self_id[4], self_id[5]);
}
