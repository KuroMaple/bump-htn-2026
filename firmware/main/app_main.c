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
#include "os/os_mbuf.h"

static const char *TAG = "bump";
static bump_identity_t self;
static uint8_t own_addr_type;

static void start_discovery(void);

static void process_discovery(const uint8_t *data, uint8_t data_len, int8_t rssi) {
    struct ble_hs_adv_fields fields;
    if (ble_hs_adv_parse_fields(&fields, data, data_len) != 0 ||
        fields.mfg_data == NULL) {
        return;
    }

    bump_identity_t peer;
    if (bump_protocol_parse_discovery(fields.mfg_data, fields.mfg_data_len, &peer) &&
        memcmp(peer.node_id, self.node_id, sizeof(self.node_id)) != 0) {
        ESP_LOGI(TAG,
            "candidate %02x:%02x:%02x:%02x:%02x:%02x rssi=%d nonce=%u",
            peer.node_id[0], peer.node_id[1], peer.node_id[2],
            peer.node_id[3], peer.node_id[4], peer.node_id[5], rssi, peer.nonce);
    }
}

static int gap_event(struct ble_gap_event *event, void *arg) {
    (void)arg;
#if MYNEWT_VAL(BLE_EXT_ADV)
    if (event->type == BLE_GAP_EVENT_EXT_DISC) {
        process_discovery(event->ext_disc.data, event->ext_disc.length_data,
                          event->ext_disc.rssi);
    }
#endif
    if (event->type == BLE_GAP_EVENT_DISC) {
        process_discovery(event->disc.data, event->disc.length_data, event->disc.rssi);
    }
    return 0;
}

static void start_discovery(void) {
#if MYNEWT_VAL(BLE_EXT_ADV)
    const struct ble_gap_ext_disc_params params = {
        .passive = 1,
        .itvl = 0x0060,
        .window = 0x0060,
    };
    const int rc = ble_gap_ext_disc(own_addr_type, 0, 0, 1,
                                    BLE_HCI_SCAN_FILT_NO_WL, 0,
                                    &params, NULL, gap_event, NULL);
#else
    struct ble_gap_disc_params params = { .passive = 1, .filter_duplicates = 1,
                                          .itvl = 0x0060, .window = 0x0060 };
    const int rc = ble_gap_disc(own_addr_type, BLE_HS_FOREVER, &params, gap_event, NULL);
#endif
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

    struct os_mbuf *data = os_msys_get_pkthdr(31, 0);
    if (data == NULL) {
        ESP_LOGE(TAG, "could not allocate advertisement buffer");
        return;
    }
    int rc = ble_hs_adv_set_fields_mbuf(&fields, data);
    if (rc != 0) {
        ESP_LOGE(TAG, "could not set advertisement: %d", rc);
        return;
    }

    struct ble_gap_ext_adv_params params = {0};
    params.own_addr_type = own_addr_type;
    params.primary_phy = BLE_HCI_LE_PHY_1M;
    params.secondary_phy = BLE_HCI_LE_PHY_1M;
    params.sid = 0;
    rc = ble_gap_ext_adv_configure(0, &params, NULL, gap_event, NULL);
    if (rc == 0) rc = ble_gap_ext_adv_set_data(0, data);
    if (rc == 0) rc = ble_gap_ext_adv_start(0, 0, 0);
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
