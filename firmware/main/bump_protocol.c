#include "bump_protocol.h"

#include <string.h>

#include "esp_random.h"
#include "esp_mac.h"
#include "esp_system.h"

void bump_protocol_init(bump_identity_t *identity) {
    esp_read_mac(identity->node_id, ESP_MAC_BT);
    identity->nonce = (uint16_t)esp_random();
}

void bump_protocol_build_discovery(
    const bump_identity_t *identity,
    uint8_t out[BUMP_DISCOVERY_BYTES]) {
    bump_discovery_packet_t packet = {
        .company_id_le = { BUMP_COMPANY_ID & 0xff, BUMP_COMPANY_ID >> 8 },
        .version = BUMP_PROTOCOL_VERSION,
        .type = BUMP_PACKET_DISCOVER,
        .nonce = { identity->nonce & 0xff, identity->nonce >> 8 },
    };
    memcpy(packet.node_id, identity->node_id, sizeof(packet.node_id));
    memcpy(out, &packet, sizeof(packet));
}

bool bump_protocol_parse_discovery(
    const uint8_t *data,
    size_t data_len,
    bump_identity_t *peer) {
    if (data_len != sizeof(bump_discovery_packet_t)) {
        return false;
    }

    const bump_discovery_packet_t *packet = (const bump_discovery_packet_t *)data;
    const uint16_t company_id = packet->company_id_le[0] | ((uint16_t)packet->company_id_le[1] << 8);
    if (company_id != BUMP_COMPANY_ID ||
        packet->version != BUMP_PROTOCOL_VERSION ||
        packet->type != BUMP_PACKET_DISCOVER) {
        return false;
    }

    memcpy(peer->node_id, packet->node_id, sizeof(peer->node_id));
    peer->nonce = packet->nonce[0] | ((uint16_t)packet->nonce[1] << 8);
    return true;
}
