# Bump gateway

Laptop legs of the pipeline:

    Badge A local journal -> Wi-Fi HTTP -> bump_forwarder.py -> server
                         \-> USB BUMP_SYNC (fallback) ->/

Badge A keeps each full Connect advertisement until the laptop asks for
`BUMP_SYNC`. The gateway decodes its profile, upserts the attendee with
`POST /api/admin/badges`, posts the connection with `POST /api/bumps`, and only
then sends `BUMP_ACK` back to Badge A. The raw profile stays in the local retry
queue, never in the public graph request.

## What it sends

All recognised Connect fields are sent to the authenticated admin API: badge
ID, name, role, company, bio, attendee/profile/claim IDs, email, phone,
LinkedIn, Discord, and provisioned time. The public projector still follows its
own alias/real-name/hidden setting and does not expose private contact data.

Bumps are appended to `data/bumps.jsonl` and fsync'd *before* the network call,
with a deterministic `event_id` (retry-safe). Unconfirmed bumps replay on start,
so captures survive the server being down.

## Run

Server + DB (from repo root, needs the `web`/`server` platform on `main`):

```bash
docker compose up -d                 # postgres
cd server && npm install && npm run db:migrate && npm run dev   # :8787
```

Gateway (needs the IDF python env for pyserial):

```bash
. ~/esp/esp-idf/export.sh
python gateway/bump_forwarder.py \
  --port "$(tools/badge-port.sh e8:3d:c1:29:87:00)" \
  --auto-register --admin-key "$ADMIN_API_KEY"
```

`--auto-register` is required for a fresh DB: `processBump` returns
`unknown_badge` (no edge) unless both badges already exist. With it, an unseen
peer is registered (alias identity) the moment it's bumped, so the edge lands.

Watch it appear on the projector at the web app's `/projector` route.

### Wireless receiver

Start the same gateway with an event-specific token. It listens only when the
token is supplied; there is no open Wi-Fi ingestion endpoint.

```bash
export BUMP_WIRELESS_TOKEN='choose-a-long-demo-token'
. ~/esp/esp-idf/export.sh
python gateway/bump_forwarder.py \
  --port "$(tools/badge-port.sh e8:3d:c1:29:87:00)" \
  --auto-register --admin-key "$ADMIN_API_KEY"
```

Use the laptop's address on the hotspot/LAN (not `localhost`) in Badge A's
`gateway_url`, for example `http://192.168.2.1:8788/bump/1/record`. The
receiver accepts a record only after its `X-Bump-Token` matches; it writes the
retry record locally, upserts the profile, posts the mosaic edge, and responds
200 only after that succeeds. Any other response leaves the item on Badge A
for its 60-second Wi-Fi retry or later USB fallback.

## Key flags

| flag | default | meaning |
|---|---|---|
| `--observer` | `brave-moth-badger-vivid` | MY badge_id (badge A) |
| `--rssi` | `-80` | ignore peers weaker than this |
| `--bucket` | `60` | seconds; collapses repeat bumps of one peer |
| `--auto-register` | off | upsert full captured profiles (needs admin key) |
| `--anonymous` | off | do not upsert the profile; IDs only |
| `--server` | `http://localhost:8787` | API base (or `$BUMP_SERVER`) |
| `--wireless-token` | `$BUMP_WIRELESS_TOKEN` | required to enable local Wi-Fi receiver |
| `--wireless-bind` | `0.0.0.0` | address for the Wi-Fi receiver |
| `--wireless-port` | `8788` | Wi-Fi receiver port |
