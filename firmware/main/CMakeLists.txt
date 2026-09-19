idf_component_register(
    SRCS
        "app_main.c"
        "bump_protocol.c"
    INCLUDE_DIRS "."
    REQUIRES
        bt
        nvs_flash
)
