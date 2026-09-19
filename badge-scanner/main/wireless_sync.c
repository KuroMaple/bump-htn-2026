#include "wireless_sync.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs.h"

#include "bump_store.h"

#define CONFIG_NAMESPACE "bump-wifi"
#define CONFIG_KEY       "gateway"
#define WIFI_CONNECTED   BIT0
#define WIFI_FAILED      BIT1
#define WIFI_RETRIES     3
#define CONNECT_TIMEOUT_MS 15000
#define RETRY_PERIOD_MS    60000

typedef struct {
    char ssid[33];
    char password[65];
    char gateway_url[160];
    char token[96];
} wireless_config_t;

static const char *TAG = "wireless-sync";
static wireless_config_t config;
static bool configured;
static bool wifi_started;
static EventGroupHandle_t event_group;
static TaskHandle_t sync_task;
static uint8_t retries;

static void hex_encode(const uint8_t *input, size_t length, char *output)
{
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < length; ++i) {
        output[i * 2] = hex[input[i] >> 4];
        output[i * 2 + 1] = hex[input[i] & 0x0f];
    }
    output[length * 2] = '\0';
}

static esp_err_t load_config(void)
{
    nvs_handle_t nvs;
    esp_err_t result = nvs_open(CONFIG_NAMESPACE, NVS_READONLY, &nvs);
    if (result == ESP_ERR_NVS_NOT_FOUND) return ESP_OK;
    if (result != ESP_OK) return result;
    size_t size = sizeof(config);
    result = nvs_get_blob(nvs, CONFIG_KEY, &config, &size);
    nvs_close(nvs);
    if (result == ESP_OK && size == sizeof(config) && config.ssid[0] && config.gateway_url[0] && config.token[0]) {
        configured = true;
    } else if (result == ESP_OK) {
        memset(&config, 0, sizeof(config));
        configured = false;
        result = ESP_ERR_INVALID_STATE;
    }
    return result;
}

static void wifi_event(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_data;
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        if (retries++ < WIFI_RETRIES) esp_wifi_connect();
        else xEventGroupSetBits(event_group, WIFI_FAILED);
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(event_group, WIFI_CONNECTED);
    }
}

static esp_err_t connect_to_laptop(void)
{
    xEventGroupClearBits(event_group, WIFI_CONNECTED | WIFI_FAILED);
    retries = 0;
    wifi_config_t wifi = {0};
    strlcpy((char *)wifi.sta.ssid, config.ssid, sizeof(wifi.sta.ssid));
    strlcpy((char *)wifi.sta.password, config.password, sizeof(wifi.sta.password));
    wifi.sta.threshold.authmode = config.password[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    wifi.sta.pmf_cfg.capable = true;
    wifi.sta.pmf_cfg.required = false;
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi), TAG, "set Wi-Fi config failed");
    if (!wifi_started) {
        ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "start Wi-Fi failed");
        wifi_started = true;
    } else {
        ESP_RETURN_ON_ERROR(esp_wifi_connect(), TAG, "connect Wi-Fi failed");
    }
    const EventBits_t bits = xEventGroupWaitBits(event_group, WIFI_CONNECTED | WIFI_FAILED,
                                                 pdFALSE, pdFALSE, pdMS_TO_TICKS(CONNECT_TIMEOUT_MS));
    if (bits & WIFI_CONNECTED) return ESP_OK;
    return ESP_ERR_TIMEOUT;
}

static bool upload_record(const bump_store_record_t *record, void *context)
{
    size_t *uploaded = context;
    char profile_hex[BUMP_STORE_MAX_PROFILE_BYTES * 2 + 1];
    char body[700];
    hex_encode(record->profile, record->profile_len, profile_hex);
    const int written = snprintf(body, sizeof(body),
                                 "{\"event_id\":\"%s\",\"rssi\":%d,\"uptime_ms\":%" PRIu64
                                 ",\"profile_hex\":\"%s\"}",
                                 record->event_id, record->rssi, record->uptime_ms, profile_hex);
    if (written < 0 || written >= (int)sizeof(body)) return false;

    esp_http_client_config_t http_config = {
        .url = config.gateway_url,
        .timeout_ms = 8000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&http_config);
    if (!client) return false;
    esp_http_client_set_method(client, HTTP_METHOD_POST);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Bump-Token", config.token);
    esp_http_client_set_post_field(client, body, written);
    const esp_err_t result = esp_http_client_perform(client);
    const int status = result == ESP_OK ? esp_http_client_get_status_code(client) : 0;
    esp_http_client_cleanup(client);
    if (result != ESP_OK || status < 200 || status >= 300) {
        ESP_LOGW(TAG, "laptop upload deferred: %s HTTP %d", esp_err_to_name(result), status);
        return false;
    }
    if (bump_store_mark_synced(record->event_id) != ESP_OK) return false;
    (*uploaded)++;
    return true;
}

static void sync_once(void)
{
    if (!configured || !bump_store_is_ready()) return;
    const esp_err_t connected = connect_to_laptop();
    if (connected != ESP_OK) {
        ESP_LOGI(TAG, "laptop Wi-Fi unavailable; keeping journal for later (%s)", esp_err_to_name(connected));
        return;
    }
    size_t uploaded = 0;
    bump_store_export_pending(upload_record, &uploaded);
    ESP_LOGI(TAG, "wireless sync uploaded %u record(s)", (unsigned)uploaded);
    esp_wifi_disconnect();
}

static void sync_worker(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(RETRY_PERIOD_MS));
        sync_once();
    }
}

esp_err_t wireless_sync_init(void)
{
    event_group = xEventGroupCreate();
    if (!event_group) return ESP_ERR_NO_MEM;
    esp_err_t result = esp_netif_init();
    if (result != ESP_OK && result != ESP_ERR_INVALID_STATE) return result;
    result = esp_event_loop_create_default();
    if (result != ESP_OK && result != ESP_ERR_INVALID_STATE) return result;
    esp_netif_create_default_wifi_sta();
    const wifi_init_config_t wifi_init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&wifi_init), TAG, "Wi-Fi init failed");
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "Wi-Fi mode failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                             &wifi_event, NULL, NULL), TAG,
                        "Wi-Fi event registration failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                             &wifi_event, NULL, NULL), TAG,
                        "IP event registration failed");
    result = load_config();
    if (result != ESP_OK && result != ESP_ERR_NVS_NOT_FOUND) return result;
    if (xTaskCreate(sync_worker, "bump-wifi", 6144, NULL, 4, &sync_task) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "wireless sync %s", configured ? "configured" : "awaiting configuration");
    return ESP_OK;
}

void wireless_sync_notify_pending(void)
{
    if (sync_task && configured) xTaskNotifyGive(sync_task);
}

static bool copy_required(cJSON *root, const char *name, char *output, size_t capacity)
{
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, name);
    if (!cJSON_IsString(item) || !item->valuestring || item->valuestring[0] == '\0' ||
        strlen(item->valuestring) >= capacity) return false;
    strlcpy(output, item->valuestring, capacity);
    return true;
}

esp_err_t wireless_sync_configure_json(const char *json)
{
    cJSON *root = cJSON_Parse(json);
    if (!root) return ESP_ERR_INVALID_ARG;
    wireless_config_t next = {0};
    const bool valid = copy_required(root, "ssid", next.ssid, sizeof(next.ssid)) &&
                       copy_required(root, "gateway_url", next.gateway_url, sizeof(next.gateway_url)) &&
                       copy_required(root, "token", next.token, sizeof(next.token));
    cJSON *password = cJSON_GetObjectItemCaseSensitive(root, "password");
    if (password && (!cJSON_IsString(password) || strlen(password->valuestring) >= sizeof(next.password))) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }
    if (password) strlcpy(next.password, password->valuestring, sizeof(next.password));
    cJSON_Delete(root);
    if (!valid || strncmp(next.gateway_url, "http://", 7) != 0) return ESP_ERR_INVALID_ARG;

    nvs_handle_t nvs;
    ESP_RETURN_ON_ERROR(nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &nvs), TAG, "open config failed");
    esp_err_t result = nvs_set_blob(nvs, CONFIG_KEY, &next, sizeof(next));
    if (result == ESP_OK) result = nvs_commit(nvs);
    nvs_close(nvs);
    if (result != ESP_OK) return result;
    config = next;
    configured = true;
    wireless_sync_notify_pending();
    return ESP_OK;
}

esp_err_t wireless_sync_clear_config(void)
{
    nvs_handle_t nvs;
    ESP_RETURN_ON_ERROR(nvs_open(CONFIG_NAMESPACE, NVS_READWRITE, &nvs), TAG, "open config failed");
    esp_err_t result = nvs_erase_key(nvs, CONFIG_KEY);
    if (result == ESP_OK || result == ESP_ERR_NVS_NOT_FOUND) result = nvs_commit(nvs);
    nvs_close(nvs);
    memset(&config, 0, sizeof(config));
    configured = false;
    return result;
}

bool wireless_sync_is_configured(void)
{
    return configured;
}
