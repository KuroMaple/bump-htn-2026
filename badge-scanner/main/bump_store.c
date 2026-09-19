#include "bump_store.h"

#include <ctype.h>
#include <errno.h>
#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_littlefs.h"
#include "esp_log.h"
#include "nvs.h"

#define STORE_BASE      "/bump"
#define JOURNAL_PATH    STORE_BASE "/encounters.v1"
#define ACK_PATH        STORE_BASE "/synced.v1"
#define RECORD_LINE_MAX (BUMP_STORE_EVENT_ID_BYTES + 32 + BUMP_STORE_MAX_PROFILE_BYTES * 2 + 8)

static const char *TAG = "bump-store";
static bool ready;
static uint8_t self_id[6];

static uint32_t fnv1a(const uint8_t *data, size_t length)
{
    uint32_t hash = 2166136261u;
    for (size_t i = 0; i < length; ++i) {
        hash ^= data[i];
        hash *= 16777619u;
    }
    return hash;
}

static void hex_encode(const uint8_t *in, size_t length, char *out)
{
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < length; ++i) {
        out[i * 2] = hex[in[i] >> 4];
        out[i * 2 + 1] = hex[in[i] & 0x0f];
    }
    out[length * 2] = '\0';
}

static bool hex_decode(const char *in, uint8_t *out, size_t max_length, size_t *out_length)
{
    const size_t length = strlen(in);
    if ((length & 1u) != 0 || length / 2 > max_length) return false;
    for (size_t i = 0; i < length; i += 2) {
        const int high = isdigit((unsigned char)in[i]) ? in[i] - '0' :
            (in[i] >= 'a' && in[i] <= 'f' ? in[i] - 'a' + 10 : -1);
        const int low = isdigit((unsigned char)in[i + 1]) ? in[i + 1] - '0' :
            (in[i + 1] >= 'a' && in[i + 1] <= 'f' ? in[i + 1] - 'a' + 10 : -1);
        if (high < 0 || low < 0) return false;
        out[i / 2] = (uint8_t)((high << 4) | low);
    }
    *out_length = length / 2;
    return true;
}

static bool parse_record_line(char *line, bump_store_record_t *record)
{
    char *save = NULL;
    char *event_id = strtok_r(line, "|", &save);
    char *rssi = strtok_r(NULL, "|", &save);
    char *uptime = strtok_r(NULL, "|", &save);
    char *profile = strtok_r(NULL, "\r\n", &save);
    if (!event_id || !rssi || !uptime || !profile || strlen(event_id) >= sizeof(record->event_id)) {
        return false;
    }
    strcpy(record->event_id, event_id);
    record->rssi = (int8_t)strtol(rssi, NULL, 10);
    record->uptime_ms = strtoull(uptime, NULL, 10);
    size_t profile_length = 0;
    if (!hex_decode(profile, record->profile, sizeof(record->profile), &profile_length)) return false;
    record->profile_len = (uint8_t)profile_length;
    return true;
}

static bool acknowledged(const char *event_id)
{
    FILE *file = fopen(ACK_PATH, "r");
    if (!file) return false;
    char line[BUMP_STORE_EVENT_ID_BYTES + 4];
    bool found = false;
    while (fgets(line, sizeof(line), file)) {
        line[strcspn(line, "\r\n")] = '\0';
        if (strcmp(line, event_id) == 0) {
            found = true;
            break;
        }
    }
    fclose(file);
    return found;
}

static bool event_exists(const char *event_id)
{
    FILE *file = fopen(JOURNAL_PATH, "r");
    if (!file) return false;
    char line[RECORD_LINE_MAX];
    bool found = false;
    while (fgets(line, sizeof(line), file)) {
        bump_store_record_t record;
        if (parse_record_line(line, &record) && strcmp(record.event_id, event_id) == 0) {
            found = true;
            break;
        }
    }
    fclose(file);
    return found;
}

esp_err_t bump_store_init(const uint8_t id[6])
{
    memcpy(self_id, id, sizeof(self_id));
    const esp_vfs_littlefs_conf_t config = {
        .base_path = STORE_BASE,
        .partition_label = "storage",
        .format_if_mount_failed = false,
        .dont_mount = false,
    };
    const esp_err_t result = esp_vfs_littlefs_register(&config);
    if (result != ESP_OK) {
        ESP_LOGE(TAG, "storage mount refused: %s (not formatting)", esp_err_to_name(result));
        return result;
    }
    ready = true;
    ESP_LOGI(TAG, "offline journal mounted at %s", STORE_BASE);
    return ESP_OK;
}

esp_err_t bump_store_append(const uint8_t *profile, uint8_t profile_len, int8_t rssi,
                            uint64_t uptime_ms, char out_event_id[BUMP_STORE_EVENT_ID_BYTES])
{
    if (!ready || !profile || profile_len == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t nvs;
    esp_err_t result = nvs_open("bump", NVS_READWRITE, &nvs);
    if (result != ESP_OK) return result;
    uint32_t sequence = 0;
    nvs_get_u32(nvs, "sequence", &sequence);
    sequence++;
    result = nvs_set_u32(nvs, "sequence", sequence);
    if (result == ESP_OK) result = nvs_commit(nvs);
    nvs_close(nvs);
    if (result != ESP_OK) return result;

    const uint32_t fingerprint = fnv1a(profile, profile_len);
    snprintf(out_event_id, BUMP_STORE_EVENT_ID_BYTES,
             "bump-%02x%02x%02x%02x%02x%02x-%" PRIu32 "-%08" PRIx32,
             self_id[0], self_id[1], self_id[2], self_id[3], self_id[4], self_id[5],
             sequence, fingerprint);

    char encoded[BUMP_STORE_MAX_PROFILE_BYTES * 2 + 1];
    hex_encode(profile, profile_len, encoded);
    FILE *file = fopen(JOURNAL_PATH, "a");
    if (!file) return ESP_FAIL;
    const int written = fprintf(file, "%s|%d|%" PRIu64 "|%s\n", out_event_id, rssi, uptime_ms, encoded);
    if (written < 0 || fflush(file) != 0 || fsync(fileno(file)) != 0) {
        fclose(file);
        return ESP_FAIL;
    }
    fclose(file);
    return ESP_OK;
}

size_t bump_store_export_pending(bump_store_export_cb_t callback, void *context)
{
    if (!ready || !callback) return 0;
    FILE *file = fopen(JOURNAL_PATH, "r");
    if (!file) return 0;
    size_t count = 0;
    char line[RECORD_LINE_MAX];
    while (fgets(line, sizeof(line), file)) {
        bump_store_record_t record;
        if (parse_record_line(line, &record) && !acknowledged(record.event_id)) {
            count++;
            if (!callback(&record, context)) break;
        }
    }
    fclose(file);
    return count;
}

esp_err_t bump_store_mark_synced(const char *event_id)
{
    if (!ready || !event_id || strlen(event_id) == 0 || strlen(event_id) >= BUMP_STORE_EVENT_ID_BYTES) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!event_exists(event_id)) return ESP_ERR_NOT_FOUND;
    if (acknowledged(event_id)) return ESP_OK;
    FILE *file = fopen(ACK_PATH, "a");
    if (!file) return ESP_FAIL;
    const int written = fprintf(file, "%s\n", event_id);
    if (written < 0 || fflush(file) != 0 || fsync(fileno(file)) != 0) {
        fclose(file);
        return ESP_FAIL;
    }
    fclose(file);
    return ESP_OK;
}

bool bump_store_is_ready(void)
{
    return ready;
}
