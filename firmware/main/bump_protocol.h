#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Wire format for the discovery layer. This is deliberately tiny enough for
 * a BLE advertisement; packages themselves must move over a reliable GATT
 * transfer after both sides opt in.
 */
#define BUMP_PROTOCOL_VERSION 1
#define BUMP_COMPANY_ID        0xFFFF /* Demo-only; request an assigned ID before release. */
#define BUMP_DISCOVERY_BYTES   12

typedef struct __attribute__((packed)) {
    uint8_t company_id_le[2];
    uint8_t version;
    uint8_t type;
    uint8_t node_id[6];
    uint8_t nonce[2];
} bump_discovery_packet_t;

enum bump_packet_type {
    BUMP_PACKET_DISCOVER = 1,
    BUMP_PACKET_ACK = 2,
};

typedef struct {
    uint8_t node_id[6];
    uint16_t nonce;
} bump_identity_t;

void bump_protocol_init(bump_identity_t *identity);
void bump_protocol_build_discovery(
    const bump_identity_t *identity,
    uint8_t out[BUMP_DISCOVERY_BYTES]);
bool bump_protocol_parse_discovery(
    const uint8_t *data,
    size_t data_len,
    bump_identity_t *peer);

