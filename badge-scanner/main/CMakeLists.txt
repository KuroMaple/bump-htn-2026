idf_component_register(SRCS "controller_main.c" "bump_store.c" "wireless_sync.c" "badge_display.c"
                       INCLUDE_DIRS "."
                       REQUIRES esp_lcd driver nvs_flash bt esp_timer littlefs esp_wifi esp_netif esp_event esp_http_client json)
