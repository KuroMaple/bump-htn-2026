/*
 * badge-scanner - throwaway diagnostic firmware for the HTN badge (ESP32-C3).
 *
 * ONE JOB: bring BLE up at boot (clean heap, like the hub firmware - this is
 * what avoids the crash we hit doing it from a Lua app), scan passively, and
 * log every advertisement: MAC, RSSI, raw payload, and any printable text.
 *
 * It answers the make-or-break question before you commit to a real flash:
 *   Does a STOCK badge broadcast an identifiable badge_id over BLE, or only
 *   an anonymous MAC? Only your own badges will be flashed, so the whole
 *   "walk up to people and build a mosaic" flow depends on this being YES.
 *
 * Observer role only: it never advertises, never connects, never transmits
 * anything. It reads what is already being broadcast in the open. It writes
 * nothing to flash. Restore your 4MB backup afterward to return to stock.
 *
 * WHAT TO LOOK FOR in the log (idf.py monitor):
 *   - Lines tagged  <<< BADGE-ID? >>>  contain hyphenated lowercase text that
 *     looks like "brave-moth-badger-vivid". If you see stock badges' own IDs
 *     here, passive collection works -> green light.
 *   - If badges only ever show as raw MACs with no such text, identity travels
 *     only through the Connect handshake -> passive collection will NOT work,
 *     do not flash the real app, stay on the Lua+contacts path.
 */

#include <stdio.h>
#include <string.h>
#include <ctype.h>

#include "esp_log.h"
#include "nvs_flash.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "esp_timer.h"

#include "badge_display.h"

/* ---- Tunables -------------------------------------------------------------
 * A hackathon floor produces ~300 adverts/sec, which drowns the badge and
 * overruns USB serial. SUPPRESS_MS re-prints an identical (address, payload)
 * pair at most once per window, so every DISTINCT payload is still shown --
 * which is what protocol characterisation actually needs -- without flooding.
 * Set to 0 for an unfiltered firehose.
 *
 * FOCUS_OUI: print ONLY addresses starting with these bytes (and always mark
 * them). The ESP32-C3 derives its BLE address from the base MAC, so a badge
 * with USB MAC 68:ee:8f:01:07:dc is expected to advertise very close to it.
 * Empty string = show everything. */
#define SUPPRESS_MS   3000
#define FOCUS_OUI     ""      /* e.g. "68:ee:8f" to isolate one badge */

static const char *TAG = "scanner";

/* Heuristic: does this printable text look like a badge_id
 * (>=2 hyphens, mostly lowercase letters, reasonably long)? */
static bool looks_like_badge_id(const char *s, int n)
{
    int hyphens = 0, lower = 0, other = 0;
    for (int i = 0; i < n; i++) {
        char c = s[i];
        if (c == '-') hyphens++;
        else if (c >= 'a' && c <= 'z') lower++;
        else if (c != 0) other++;
    }
    return (n >= 10 && hyphens >= 2 && lower >= 6 && other <= 2);
}

/* BLE address types decide whether passive identity collection is even possible:
 * a resolvable-private address rotates and cannot be used as a stable node id. */
static const char *addr_type_str(uint8_t t)
{
    switch (t) {
    case 0:  return "public";
    case 1:  return "random";
    case 2:  return "rpa-pub";   /* resolvable private, public identity */
    case 3:  return "rpa-rnd";   /* resolvable private, random identity */
    default: return "?";
    }
}

static const char *phy_str(uint8_t p)
{
    switch (p) {
    case 1:  return "1M";
    case 2:  return "2M";
    case 3:  return "coded";
    default: return "-";
    }
}

/* Duplicate suppression: small ring of recently-seen (addr,payload) hashes. */
#if SUPPRESS_MS > 0
#define SEEN_N 128
static struct { uint32_t h; int64_t ms; uint16_t hits; } seen[SEEN_N];
static uint32_t suppressed_total;

static uint32_t fnv1a(const uint8_t *a, const uint8_t *d, uint8_t n)
{
    uint32_t h = 2166136261u;
    for (int i = 0; i < 6; i++) { h ^= a[i]; h *= 16777619u; }
    for (int i = 0; i < n; i++) { h ^= d[i]; h *= 16777619u; }
    return h;
}

/* returns repeat count to print, or 0 if this advert should be suppressed */
static uint16_t dedup(const uint8_t *addr, const uint8_t *data, uint8_t len)
{
    uint32_t h = fnv1a(addr, data, len);
    int64_t now = esp_timer_get_time() / 1000;
    int free_slot = -1, oldest = 0;
    for (int i = 0; i < SEEN_N; i++) {
        if (seen[i].h == h && seen[i].ms != 0) {
            seen[i].hits++;
            if (now - seen[i].ms < SUPPRESS_MS) { suppressed_total++; return 0; }
            uint16_t n = seen[i].hits;
            seen[i].ms = now; seen[i].hits = 0;
            return n;
        }
        if (seen[i].ms == 0 && free_slot < 0) free_slot = i;
        if (seen[i].ms < seen[oldest].ms) oldest = i;
    }
    int slot = (free_slot >= 0) ? free_slot : oldest;
    seen[slot].h = h; seen[slot].ms = now; seen[slot].hits = 0;
    return 1;
}
#endif

static void print_adv(const ble_addr_t *baddr, int8_t rssi,
                      const uint8_t *data, uint8_t len, bool ext, uint8_t sid,
                      uint8_t props, uint8_t data_status, int8_t tx_power,
                      uint8_t prim_phy, uint8_t sec_phy)
{
    const uint8_t *addr = baddr->val;

    if (FOCUS_OUI[0]) {
        char oui[18];
        snprintf(oui, sizeof(oui), "%02x:%02x:%02x", addr[5], addr[4], addr[3]);
        if (strncmp(oui, FOCUS_OUI, strlen(FOCUS_OUI)) != 0) return;
    }

#if SUPPRESS_MS > 0
    uint16_t repeats = dedup(addr, data, len);
    if (repeats == 0) return;
#else
    uint16_t repeats = 1;
#endif

    /* hex dump */
    static char hex[600];
    int n = 0;
    for (int i = 0; i < len && n < (int)sizeof(hex) - 3; i++)
        n += snprintf(hex + n, sizeof(hex) - n, "%02x", data[i]);
    hex[n] = 0;

    /* printable rendering + capture the longest printable run for the check */
    static char ascii[256];
    int an = 0;
    char run[256]; int run_n = 0, best_start = -1, best_len = 0, cur_start = -1, cur_len = 0;
    for (int i = 0; i < len && an < (int)sizeof(ascii) - 1; i++) {
        uint8_t c = data[i];
        char pc = (c >= 0x20 && c < 0x7f) ? (char)c : '.';
        ascii[an++] = pc;
        if (pc != '.') {
            if (cur_start < 0) { cur_start = an - 1; cur_len = 0; }
            cur_len++;
            if (cur_len > best_len) { best_len = cur_len; best_start = cur_start; }
        } else {
            cur_start = -1; cur_len = 0;
        }
    }
    ascii[an] = 0;

    run_n = 0;
    if (best_start >= 0)
        for (int i = best_start; i < best_start + best_len && run_n < (int)sizeof(run) - 1; i++)
            run[run_n++] = ascii[i];
    run[run_n] = 0;

    const char *flag = looks_like_badge_id(run, run_n) ? "  <<< BADGE-ID? >>>" : "";

    /* event properties: what KIND of advertising this is -- the single most
     * useful field for reverse-engineering a pairing protocol. */
    char pr[40];
    snprintf(pr, sizeof(pr), "%s%s%s%s%s",
        (props & 0x10) ? "legacy," : "ext,",
        (props & 0x01) ? "conn,"   : "",
        (props & 0x02) ? "scan,"   : "",
        (props & 0x04) ? "directed," : "",
        (props & 0x08) ? "scanrsp" : "");

    char txp[16];
    if (tx_power == 127) snprintf(txp, sizeof(txp), "-");
    else                 snprintf(txp, sizeof(txp), "%d", tx_power);

    ESP_LOGI(TAG,
        "ADV %s %02x:%02x:%02x:%02x:%02x:%02x/%s rssi=%d tx=%s sid=%u phy=%s/%s "
        "props=%s%s x%u len=%u data=%s ascii=\"%s\"%s",
        ext ? "EXT" : "LEG",
        addr[5], addr[4], addr[3], addr[2], addr[1], addr[0],
        addr_type_str(baddr->type),
        rssi, txp, sid, phy_str(prim_phy), phy_str(sec_phy),
        pr, (data_status == 1) ? "PARTIAL" : (data_status == 2) ? "TRUNC" : "",
        repeats, len, hex, ascii, flag);
}

/* Proximity gate: only adverts at least this strong count as a real encounter.
 * The measured successful capture sat at -72 dBm at roughly arm's length. */
#define BUMP_RSSI_DBM (-78)

/* Connect profile frames are manufacturer data (company 0xFFFF) whose payload
 * begins with a 4-byte marker. Both markers below were observed on air; the
 * station beacon (BBX1) and the multiplayer frames (MPG1/BPI1) are explicitly
 * NOT matched, so neither a hub nor a chess game lights up the screen. */
static bool has_profile_marker(const uint8_t *d, uint8_t len)
{
    for (int i = 0; i + 4 <= (int)len; i++) {
        if (d[i] == 'B' && d[i + 1] == 'M' && d[i + 2] == 'P' && d[i + 3] == '2') return true;
        if (d[i] == 'B' && d[i + 1] == 'P' && d[i + 2] == 'A' && d[i + 3] == '1') return true;
    }
    return false;
}

static int scan_cb(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
#if MYNEWT_VAL(BLE_EXT_ADV)
    case BLE_GAP_EVENT_EXT_DISC: {
        struct ble_gap_ext_disc_desc *d = &event->ext_disc;
        print_adv(&d->addr, d->rssi, d->data, d->length_data, true, d->sid,
                  d->props, d->data_status, d->tx_power, d->prim_phy, d->sec_phy);
        if (d->rssi >= BUMP_RSSI_DBM && has_profile_marker(d->data, d->length_data)) {
            badge_display_signal_connection();
        }
        return 0;
    }
#endif
    case BLE_GAP_EVENT_DISC: {
        struct ble_gap_disc_desc *d = &event->disc;
        print_adv(&d->addr, d->rssi, d->data, d->length_data, false, 255,
                  0x10 /* legacy */, 0, 127, 1, 0);
        return 0;
    }
    default:
        return 0;
    }
}

static void start_scan(void)
{
    uint8_t own_addr_type;
    int rc = ble_hs_id_infer_auto(0, &own_addr_type);
    if (rc != 0) { ESP_LOGE(TAG, "infer addr rc=%d", rc); return; }

#if MYNEWT_VAL(BLE_EXT_ADV)
    /* Passive extended scan, run forever, do NOT filter duplicates
     * (we want to see repeats and RSSI changes). itvl/window in 0.625ms units;
     * window == itvl => ~100%% duty cycle so we miss as little as possible. */
    struct ble_gap_ext_disc_params uncoded = {
        .itvl = 0x0060, .window = 0x0060, .passive = 1,
    };
    rc = ble_gap_ext_disc(own_addr_type,
                          0 /* duration: forever */,
                          0 /* period: none */,
                          0 /* filter_duplicates: no */,
                          BLE_HCI_SCAN_FILT_NO_WL,
                          0 /* limited: no */,
                          &uncoded,
                          NULL /* no coded-PHY scan */,
                          scan_cb, NULL);
    ESP_LOGI(TAG, "EXTENDED passive scan started rc=%d", rc);
#else
    struct ble_gap_disc_params dp = {0};
    dp.passive = 1; dp.itvl = 0x0060; dp.window = 0x0060; dp.filter_duplicates = 0;
    rc = ble_gap_disc(own_addr_type, BLE_HS_FOREVER, &dp, scan_cb, NULL);
    ESP_LOGI(TAG, "LEGACY passive scan started rc=%d "
                  "(EXT_ADV disabled - may miss extended-only badges)", rc);
#endif
}

static void on_sync(void)
{
    ble_hs_util_ensure_addr(0);
    ESP_LOGI(TAG, "BLE host synced, heap free=%u", (unsigned) esp_get_free_heap_size());
    start_scan();
}

static void on_reset(int reason)
{
    ESP_LOGW(TAG, "BLE host reset, reason=%d", reason);
}

static void host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void app_main(void)
{
    esp_err_t r = nvs_flash_init();
    if (r == ESP_ERR_NVS_NO_FREE_PAGES || r == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        r = nvs_flash_init();
    }
    ESP_ERROR_CHECK(r);

    /* Start in a neutral ready state. Do not show CONNECTION FOUND here: this
     * scanner has not yet observed a verified stock Connect completion frame. */
    r = badge_display_init();
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "display test unavailable: %s", esp_err_to_name(r));
    }

    ESP_ERROR_CHECK(nimble_port_init());
    ble_hs_cfg.sync_cb  = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    nimble_port_freertos_init(host_task);

    ESP_LOGI(TAG, "badge-scanner up; free heap=%u", (unsigned) esp_get_free_heap_size());
}
