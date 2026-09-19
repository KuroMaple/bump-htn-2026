#!/usr/bin/env python3
"""
Bump forwarder: badge A profile captures -> durable queue -> POST /api/bumps.

This is the laptop ingestion gateway described in the repo README:

    BLE badges -> USB -> laptop gateway -> POST /api/bumps -> PostgreSQL -> SSE

It accepts durable `BUMP/1 RECORD` lines from Badge A's USB sync protocol. A
record contains the complete BMP2/BPA1 Connect advertisement that Badge A
saved before the laptop was connected. The gateway first upserts the profile,
then sends the edge to the web service. Legacy scanner log lines remain
supported for diagnostic use.

Server contract (verified from server/src on origin/main):
  POST /api/bumps   Authorization: Bearer <GATEWAY_API_KEY>
    { badge_id_a, badge_id_b, timestamp(ISO8601+offset), signal_strength?,
      event_id(>=8 chars, dedup key), source, observer_id? }
  badge_id_* map to badges.hardware_id. processBump returns "unknown_badge"
  (no edge) unless BOTH badges are already registered via
  POST /api/admin/badges (Authorization: Bearer <ADMIN_API_KEY>).

DURABILITY / RETRY SAFETY: every extracted bump is appended to a JSONL queue and
fsync'd BEFORE the network call. event_id is deterministic (observer|peer|time-
bucket), so a retry of the same encounter collapses server-side instead of
double-counting. On startup, any queued bump not marked confirmed is re-sent.

PRIVACY: the Connect profile is sent only to the authenticated admin endpoint
and is rendered on the attendee's private page. The public projector keeps the
server's alias/opt-in policy; it never receives email, phone, claim ID, or raw
advertisement bytes.
"""
import argparse, hashlib, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

ADV_RE = re.compile(
    r'ADV (?P<kind>EXT|LEG) (?P<mac>[0-9a-f:]{17})/(?P<atype>\S+) '
    r'rssi=(?P<rssi>-?\d+) .*?props=(?P<props>\S+).*? len=(?P<len>\d+) '
    r'data=(?P<data>[0-9a-f]*)')

PROFILE_MARKS = ('424d5032', '42504131')          # BMP2, BPA1
BUMP_RECORD_RE = re.compile(r'^BUMP/1 RECORD (?P<body>\{.*\})\s*$')
SLUG_RE = re.compile(r'^[a-z]+(?:-[a-z0-9]+){2,}$')  # word-word-word[-...]
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
PHONE_RE = re.compile(r'^\+?[0-9][0-9 ()-]{6,}$')
FIELD_RE = re.compile(r'(?i)\b(?P<key>name|role|company|bio|email|phone|linkedin|discord|'
                      r'claim(?:_id)?|attendee(?:_id)?|profile(?:_version)?|'
                      r'provisioned(?:_unix)?)\s*[:=]\s*(?P<value>[^|;,]+)')
FIELD_NAMES = {
    'name': 'name', 'role': 'role', 'company': 'company', 'bio': 'bio',
    'email': 'email', 'phone': 'phone', 'linkedin': 'linkedin', 'discord': 'discord',
    'claim': 'claimId', 'claim_id': 'claimId', 'attendee': 'attendeeId',
    'attendee_id': 'attendeeId', 'profile': 'profileVersion',
    'profile_version': 'profileVersion', 'provisioned': 'provisionedUnix',
    'provisioned_unix': 'provisionedUnix',
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def text_runs(hex_str, minlen=3):
    b = bytes.fromhex(hex_str)
    out, cur = [], b""
    for c in b:
        if 0x20 <= c < 0x7f:
            cur += bytes([c])
        else:
            if len(cur) >= minlen:
                out.append(cur.decode())
            cur = b""
    if len(cur) >= minlen:
        out.append(cur.decode())
    return out


def parse_profile(hex_str):
    """Decode every currently-known Connect profile field.

    `raw_profile_hex` stays in the laptop's retry journal, never in a public
    graph request. The advertised version is intentionally kept alongside the
    parsed values so newer Connect fields are retained for future decoders.
    """
    if not any(m in hex_str for m in PROFILE_MARKS):
        return None
    runs = [r for r in text_runs(hex_str) if r not in ("BMP2", "BPA1")]
    prof = {'raw_profile_hex': hex_str}
    for r in runs:
        rs = r.strip()
        for match in FIELD_RE.finditer(rs):
            key = FIELD_NAMES[match.group('key').lower()]
            value = match.group('value').strip()
            if key in ('attendeeId', 'profileVersion', 'provisionedUnix'):
                try:
                    prof[key] = int(value)
                except ValueError:
                    pass
            elif value:
                prof[key] = value
        if not prof.get("badge_id") and SLUG_RE.match(rs):
            prof["badge_id"] = rs
        elif not prof.get("email") and EMAIL_RE.match(rs):
            prof["email"] = rs
        elif not prof.get("phone") and PHONE_RE.match(rs):
            prof["phone"] = rs
        elif "linkedin" not in prof and re.match(r'^[a-z]+-[a-z]+-\d{6,}$', rs):
            prof["linkedin"] = rs
        elif "name" not in prof and " " in rs and any(c.isalpha() for c in rs):
            prof["name"] = rs
    # Current Connect payloads carry unlabelled text runs. These conservative
    # fallbacks preserve the existing observed format while labelled fields
    # above cover future/extended profile records.
    return prof if prof.get("badge_id") else None


class Queue:
    """Append-only, fsync'd bump log with a confirmation side-record."""

    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        self.confirmed = set()
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    if rec.get("kind") == "confirm":
                        self.confirmed.add(rec["event_id"])

    def append(self, rec):
        with open(self.path, "a") as f:
            f.write(json.dumps(rec) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def pending(self):
        """Records written but never confirmed (offline replay on startup)."""
        out, seen = [], set()
        if not os.path.exists(self.path):
            return out
        with open(self.path) as f:
            for line in f:
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                if rec.get("kind") == "bump":
                    eid = rec["bump"]["event_id"]
                    if eid not in self.confirmed and eid not in seen:
                        seen.add(eid)
                        out.append(rec)
        return out


class Client:
    def __init__(self, base, gateway_key, admin_key):
        self.base = base.rstrip("/")
        self.gateway_key = gateway_key
        self.admin_key = admin_key
        self._registered = set()

    def _post(self, path, body, key):
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path, data=data, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, json.loads(r.read().decode() or "{}")

    def forget(self, hardware_id):
        """Drop the cached registration so the next bump re-registers.

        Needed after the board is cleared server-side: this process would
        otherwise keep skipping registration for badges the server no longer
        knows about."""
        self._registered.discard(hardware_id)

    def register(self, hardware_id, profile):
        if hardware_id in self._registered:
            return True
        if not self.admin_key:
            return False
        body = {"hardwareId": hardware_id, "projectorIdentity": "alias",
                "name": hardware_id}
        if profile:
            if profile.get("name"):
                body["name"] = profile["name"]
            for key in ("role", "company", "bio", "email", "phone", "linkedin", "discord",
                        "claimId", "attendeeId", "profileVersion", "provisionedUnix"):
                if profile.get(key) is not None:
                    body[key] = profile[key]
        try:
            self._post("/api/admin/badges", body, self.admin_key)
            self._registered.add(hardware_id)
            return True
        except urllib.error.HTTPError as e:
            # 201 on create/update; anything else we log and continue
            if e.code in (200, 201):
                self._registered.add(hardware_id)
                return True
            else:
                print(f"[register] {hardware_id}: HTTP {e.code}", file=sys.stderr)
        except Exception as e:
            print(f"[register] {hardware_id}: {e}", file=sys.stderr)
        return False

    def bump(self, body):
        return self._post("/api/bumps", body, self.gateway_key)


def make_event_id(observer, peer, bucket_s):
    bucket = int(time.time()) // bucket_s
    raw = f"{observer}|{peer}|{bucket}"
    return "bmp-" + hashlib.sha1(raw.encode()).hexdigest()[:24]


def send(client, queue, bump, profile, auto_register, acknowledge=None):
    if auto_register:
        if not client.register(bump["badge_id_b"], profile):
            print(f"[register] {bump['badge_id_b']}: retaining local record for retry", file=sys.stderr)
            return False
    try:
        status, resp = client.bump(bump)
        outcome = resp.get("status", f"http{status}")
        print(f"[bump] {bump['badge_id_b']} rssi={bump.get('signal_strength')} "
              f"-> {outcome}", file=sys.stderr)
        if outcome in ("accepted", "duplicate_event", "duplicate_window"):
            queue.append({"kind": "confirm", "event_id": bump["event_id"],
                          "outcome": outcome, "ts": now_iso()})
            if acknowledge:
                acknowledge(bump["event_id"])
        elif outcome == "unknown_badge":
            if not auto_register:
                print("        (peer not registered; run with --auto-register)", file=sys.stderr)
            else:
                # The board was cleared server-side while this process kept a
                # cached "already registered" entry, so registration was
                # skipped and the edge was dropped. Forget the badge, register
                # it again and retry once. Without this, every bump after a
                # Clear silently fails until the gateway is restarted.
                print(f"        (badge unknown server-side — re-registering "
                      f"{bump['badge_id_b']} and retrying)", file=sys.stderr)
                client.forget(bump["badge_id_b"])
                if client.register(bump["badge_id_b"], profile):
                    status, resp = client.bump(bump)
                    outcome = resp.get("status", f"http{status}")
                    print(f"[bump] {bump['badge_id_b']} retry -> {outcome}", file=sys.stderr)
                    if outcome in ("accepted", "duplicate_event", "duplicate_window"):
                        queue.append({"kind": "confirm", "event_id": bump["event_id"],
                                      "outcome": outcome, "ts": now_iso()})
                        if acknowledge:
                            acknowledge(bump["event_id"])
        return True
    except urllib.error.HTTPError as e:
        print(f"[bump] {bump['badge_id_b']}: HTTP {e.code} {e.reason}", file=sys.stderr)
    except Exception as e:
        print(f"[bump] {bump['badge_id_b']}: {e} (queued, will retry)", file=sys.stderr)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/cu.usbmodem3101", help="badge serial port")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--server", default=os.environ.get("BUMP_SERVER", "http://localhost:8787"))
    ap.add_argument("--gateway-key", default=os.environ.get("GATEWAY_API_KEY", "local-gateway-key-change-me"))
    ap.add_argument("--admin-key", default=os.environ.get("ADMIN_API_KEY", ""))
    ap.add_argument("--observer", default=os.environ.get("BUMP_OBSERVER", "brave-moth-badger-vivid"),
                    help="MY badge_id (badge A storage = brave-moth-badger-vivid)")
    ap.add_argument("--rssi", type=int, default=-80, help="ignore peers weaker than this dBm")
    ap.add_argument("--bucket", type=int, default=60, help="event_id time bucket (retry-collapse) seconds")
    ap.add_argument("--auto-register", action="store_true",
                    help="upsert full Connect profiles via admin key before creating edges")
    ap.add_argument("--anonymous", action="store_true",
                    help="do not upsert contact fields; keeps only badge IDs (not recommended)")
    ap.add_argument("--queue", default=os.path.join(HERE, "data", "bumps.jsonl"))
    a = ap.parse_args()

    if a.auto_register and not a.admin_key:
        print("error: --auto-register needs --admin-key or ADMIN_API_KEY", file=sys.stderr)
        sys.exit(2)

    queue = Queue(a.queue)
    client = Client(a.server, a.gateway_key, a.admin_key)

    # health check + offline replay
    try:
        with urllib.request.urlopen(a.server + "/api/health", timeout=5) as r:
            print(f"[gateway] server {a.server}: {json.loads(r.read())['status']}", file=sys.stderr)
    except Exception as e:
        print(f"[gateway] WARNING server unreachable ({e}); bumps will queue", file=sys.stderr)

    pend = queue.pending()
    if pend:
        print(f"[gateway] replaying {len(pend)} queued bump(s)", file=sys.stderr)
        for record in pend:
            send(client, queue, record["bump"], record.get("profile"),
                 a.auto_register and not a.anonymous)

    print(f"[gateway] observer={a.observer} port={a.port} rssi>={a.rssi} "
          f"profile_upsert={a.auto_register and not a.anonymous}", file=sys.stderr)

    import serial
    while True:
        try:
            s = serial.Serial(a.port, a.baud, timeout=1)
            s.setDTR(False); s.setRTS(False)
            s.write(b"BUMP_SYNC\n")
            last_sync = time.monotonic()
            print(f"[gateway] reading {a.port}", file=sys.stderr)
            while True:
                # A badge may create a record after the laptop was already
                # connected. Polling is idempotent: Badge A repeats pending
                # records until it receives BUMP_ACK for each event ID.
                if time.monotonic() - last_sync >= 5:
                    s.write(b"BUMP_SYNC\n")
                    last_sync = time.monotonic()
                line = s.readline()
                if not line:
                    continue
                text = line.decode("utf8", "replace").strip()
                record_match = BUMP_RECORD_RE.match(text)
                if record_match:
                    try:
                        saved = json.loads(record_match.group("body"))
                        event_id = saved["event_id"]
                        profile_hex = saved["profile_hex"]
                        rssi = int(saved["rssi"])
                    except (KeyError, ValueError, json.JSONDecodeError) as e:
                        print(f"[gateway] invalid badge record: {e}", file=sys.stderr)
                        continue
                    prof = parse_profile(profile_hex)
                    if not prof:
                        print(f"[gateway] {event_id}: profile decoder found no badge ID; left on badge", file=sys.stderr)
                        continue
                    peer = prof["badge_id"]
                    if peer == a.observer:
                        continue
                    bump = {
                        "badge_id_a": a.observer,
                        "badge_id_b": peer,
                        "timestamp": now_iso(),
                        "signal_strength": rssi,
                        "event_id": event_id,
                        "source": "badge-a-usb-sync",
                        "observer_id": a.observer,
                    }
                    queue.append({"kind": "bump", "bump": bump, "profile": prof,
                                  "badge_uptime_ms": saved.get("uptime_ms"), "captured": now_iso()})
                    send(client, queue, bump, prof, a.auto_register and not a.anonymous,
                         acknowledge=lambda eid: s.write(f"BUMP_ACK {eid}\n".encode()))
                    continue

                m = ADV_RE.search(text)
                if not m:
                    continue
                g = m.groupdict()
                if "ext" not in g["props"] or "legacy" in g["props"]:
                    continue
                prof = parse_profile(g["data"])
                if not prof:
                    continue
                rssi = int(g["rssi"])
                if rssi < a.rssi:
                    continue
                peer = prof["badge_id"]
                if peer == a.observer:
                    continue
                bump = {
                    "badge_id_a": a.observer,
                    "badge_id_b": peer,
                    "timestamp": now_iso(),
                    "signal_strength": rssi,
                    "event_id": make_event_id(a.observer, peer, a.bucket),
                    "source": "laptop-gateway",
                    "observer_id": a.observer,
                }
                queue.append({"kind": "bump", "bump": bump, "profile": prof,
                              "peer_mac": g["mac"], "captured": now_iso()})
                send(client, queue, bump, prof, a.auto_register and not a.anonymous)
        except serial.SerialException as e:
            print(f"[gateway] serial error: {e}; retry in 2s", file=sys.stderr)
            time.sleep(2)
        except KeyboardInterrupt:
            print("\n[gateway] stopped", file=sys.stderr)
            break


if __name__ == "__main__":
    main()
