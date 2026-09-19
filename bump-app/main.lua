-- Bump - pairing. Docs in README.md (kept out of here: source size costs heap).
-- Radio MUST come up first; NimBLE needs a large contiguous block.

local ID   = badge.me.badge_id()
local BCN  = "BMP1|" .. ID
local EDGES, SEEN = "edges.jsonl", "seen.txt"

-- 1. RADIO FIRST, before anything else touches the heap.
-- Radio is OFF by default: badge.radio has hard-crashed this board twice
-- (BLE init under low heap). Contacts path is proven stable. Flip to true
-- only when you have a second badge and can afford a reboot.
local USE_RADIO = false
local radio_ok = USE_RADIO and (badge.radio.enable() and true or false) or false
local last_tx, rx_new = -10000, 0

local function esc(s)
  return (tostring(s):gsub('[%c"\\]', function(c)
    return string.format('\\u%04x', c:byte()) end))
end

local seen = badge.fs.exists(SEEN) and (badge.fs.read(SEEN) or "") or ""
local function is_seen(id) return seen:find("\n"..id.."\n", 1, true) ~= nil end
local function mark(id)
  seen = seen .. "\n" .. id .. "\n"
  badge.fs.append(SEEN, "\n"..id.."\n")
end

function on_edge(peer, via) end          -- render hook, see README

local function emit(peer, name, tc, rssi, via)
  local a, b = ID, peer
  if a > b then a, b = b, a end
  local line = string.format(
    '{"v":2,"a":"%s","b":"%s","observer":"%s","peer_name":"%s","t_contact":%s,"t_ms":%d,"rssi":%s,"via":"%s"}',
    esc(a), esc(b), esc(ID), esc(name or ""), tostring(tc or "null"),
    badge.sys.ms(), tostring(rssi or "null"), via)
  print(line)
  badge.fs.append(EDGES, line .. "\n")
  on_edge(peer, via)
end

local function send_spaced(msg)
  if not radio_ok then return false end
  local t = badge.sys.ms()
  if t - last_tx < 200 then return false end
  last_tx = t
  return badge.radio.send(msg)
end

-- on_recv signature is UNVERIFIED (needs two badges); introspect and log.
local function on_packet(...)
  local n = select("#", ...)
  local peer, rssi, raw
  for i = 1, n do
    local v = select(i, ...)
    local t = type(v)
    if t == "table" then
      peer = peer or v.id or v.badge_id or v.peer
      rssi = rssi or v.rssi
      raw  = raw  or v.data or v.payload or v.msg
    elseif t == "string" then raw = raw or v
    elseif t == "number" and v < 0 then rssi = rssi or v end
  end
  print("RX n="..n.." raw="..tostring(raw).." rssi="..tostring(rssi))
  if type(raw) == "string" then
    local m = raw:match("^BMP1|(.+)$"); if m then peer = m end
  end
  if not peer or peer == ID or is_seen(peer) then return end
  mark(peer); rx_new = rx_new + 1
  emit(peer, nil, nil, rssi, "radio")
  send_spaced(BCN)
end

if radio_ok then
  badge.radio.on_recv(on_packet)
  send_spaced(BCN)
end

-- 2. CONTACTS sweep (universal fallback - works with people who lack Bump).
local total = badge.contacts.count()
local cs_new = 0
local first = badge.store.get_int("bmp_cur", 0)
if first > total then first = 0 end
local last = total
if last - first > 20 then last = first + 20 end
for i = first + 1, last do
  local c = badge.contacts.get(i)
  if type(c) == "table" and c.badge_id and c.badge_id ~= ID and not is_seen(c.badge_id) then
    mark(c.badge_id)
    emit(c.badge_id, c.name, c.received_unix, nil, "contacts")
    cs_new = cs_new + 1
  end
end
badge.store.set_int("bmp_cur", last)

print(string.format("bump: contacts=+%d radio=+%d total=%d radio_ok=%s",
      cs_new, rx_new, total, tostring(radio_ok)))

local T = badge.ui.theme
badge.ui.label{x=10, y=10,  text="Bump", color=T.accent}
badge.ui.label{x=10, y=44,  text="New links: "..(cs_new + rx_new), color=T.text}
badge.ui.label{x=10, y=74,  text="Contacts: "..total, color=T.text_dim}
badge.ui.label{x=10, y=104, text=radio_ok and "Radio: listening" or "Radio: unavailable",
               color=radio_ok and T.text_dim or T.text_muted}
badge.ui.label{x=10, y=210, text="HOME: exit", color=T.text_muted}
