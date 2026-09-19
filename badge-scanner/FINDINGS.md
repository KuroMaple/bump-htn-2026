# Measured BLE findings

All results below were **captured**, not inferred. Source: `badge-scanner`
firmware (passive observer, extended scan) on badge A `E8:3D:C1:29:87:00`,
2026-09-19, indoors.

## 1. Station beacon: `BBX1`

Two extended advertisers broadcast a clear-text station beacon. This is the
"nearby station" the stock Sync UI looks for.

```
dc:07:01:8f:ee:68  rssi=-57  sid=0  phy=1M/1M  props=ext  len=34
  21 ff ffff 42425831 04 00*10 01 0000 "hardware-hub"

f0:59:e7:85:84:28  rssi=-92  sid=0  phy=1M/1M  props=ext  len=29
  1c ff ffff 42425831 15 00*10 01 0000 "sync-02"
```

Decoded layout (AD structure, type `0xFF` manufacturer-specific):

| Field | Bytes | Observed | Note |
|---|---|---|---|
| AD length | 1 | `0x21` / `0x1c` | covers everything after it |
| AD type | 1 | `0xFF` | manufacturer specific |
| Company ID | 2 | `FF FF` | `0xFFFF` = unassigned/test ID, not a real allocation |
| Magic | 4 | `42 42 58 31` = `BBX1` | station marker |
| Station ID | 1 | `0x04` / `0x15` | differs per station |
| Reserved | 10 | all `0x00` | |
| Version? | 1 | `0x01` | constant across both |
| Reserved | 2 | `00 00` | |
| Name | var | `hardware-hub`, `sync-02` | ASCII, fills the remainder |

Both used **random** (not public) addresses, so the address is not a stable
station identity — the station ID byte and name are.

**`BBX1` is a distinct marker from `HTNSYNC1` and `BPI1`.** It is the one
actually observed on air. Do not conflate the three.

## 2. Radio environment

- ~310 adverts/sec ambient. Dedup at 3 s cut this to ~97/sec with no loss of
  distinct payloads.
- Of ~2400 adverts per 25 s, only ~100 were true extended ads (`props=ext`),
  from **6** distinct advertisers. Extended advertising is rare and therefore a
  cheap, high-precision filter for badge/station traffic.
- 98% of ambient advertisers use random addresses; only ~2% public.

## 3. Not yet observed

No badge-to-badge Connect advertisement has been captured yet — the stock
Connect app must be open on badge B for it to transmit. The four-phase capture
(idle / no-peer / successful bump / repeated bump) is still outstanding.
