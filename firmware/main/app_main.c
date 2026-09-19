#include <inttypes.h>
#include <string.h>

#include "bump_protocol.h"
#include "esp_log.h"
#include "nvs_flash.h"

#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "host/ble_hs_id.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

static const char *TAG = "bump";
static bump_identity_t self;
static uint8_t own_addr_type;

static void start_discovery(void);

static int gap_event(struct ble_gap_event *event, void *arg) {
    (void)arg;
    if (event->type == BLE_GAP_EVENT_DISC) {
        struct ble_hs_adv_fields fields;
        if (ble_hs_adv_parse_fields(&fields, event->disc.data, event->disc.length_data) != 0 ||
            fields.mfg_data == NULL) {
            return 0;
        }

        bump_identity_t peer;
        if (bump_protocol_parse_discovery(fields.mfg_data, fields.mfg_data_len, &peer) &&
            memcmp(peer.node_id, self.node_id, sizeof(self.node_id)) != 0) {
            ESP_LOGI(TAG,
                "candidate %02x:%02x:%02x:%02x:%02x:%02x rssi=%d nonce=%u",
                peer.node_id[0], peer.node_id[1], peer.node_id[2],
                peer.node_id[3], peer.node_id[4], peer.node_id[5],
                event->disc.rssi, peer.nonce);
        }
    }
    return 0;
}

static void start_discovery(void) {
    struct ble_gap_disc_params params = {0};
    params.passive = 1;
    params.filter_duplicates = 1;
    params.itvl = 0x0010;
    params.window = 0x0010;

    const int rc = ble_gap_disc(own_addr_type, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "could not start scan: %d", rc);
    }
}

static void start_advertising(void) {
    uint8_t packet[BUMP_DISCOVERY_BYTES];
    bump_protocol_build_discovery(&self, packet);

    struct ble_hs_adv_fields fields = {0};
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.mfg_data = packet;
    fields.mfg_data_len = sizeof(packet);
    fields.name = (const uint8_t *)"Bump";
    fields.name_len = 4;
    fields.name_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        ESP_LOGE(TAG, "could not set advertisement: %d", rc);
        return;
    }

    struct ble_gap_adv_params params = {0};
    params.conn_mode = BLE_GAP_CONN_MODE_NON;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(own_addr_type, NULL, BLE_HS_FOREVER, &params, NULL, NULL);
    if (rc != 0) {
        ESP_LOGE(TAG, "could not advertise: %d", rc);
        return;
    }
    ESP_LOGI(TAG, "advertising Bump discovery packets");
}

static void on_sync(void) {
    int rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "could not infer BLE address: %d", rc);
        return;
    }
    start_advertising();
    start_discovery();
}

static void nimble_host_task(void *param) {
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void) {
    const esp_err_t nvs_result = nvs_flash_init();
    if (nvs_result != ESP_OK) {
        ESP_LOGE(TAG, "NVS initialization failed: %s", esp_err_to_name(nvs_result));
        return;
    }

    bump_protocol_init(&self);
    ESP_LOGI(TAG, "Bump base firmware booted: %02x:%02x:%02x:%02x:%02x:%02x",
        self.node_id[0], self.node_id[1], self.node_id[2],
        self.node_id[3], self.node_id[4], self.node_id[5]);

    nimble_port_init();
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(nimble_host_task);
}
