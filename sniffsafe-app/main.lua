--------------------------------------------------------------------------------
-- Sniff Safe - passive radio callback probe for stock-badge characterization.
--
-- This intentionally does not transmit. The previous Sniff experiment combined
-- radio enable, immediate send, and a heap value concatenation at startup; any
-- one of those can abort a Lua app before it produces a usable trace.
--------------------------------------------------------------------------------

local MAX_LOGGED = 30
local received = 0

local function record(line)
  print(line)
  if received <= MAX_LOGGED then
    badge.fs.append("sniff.log", line .. "\n")
  end
end

local function describe(value)
  local kind = type(value)
  if kind == "string" then
    return "string=" .. value
  elseif kind == "number" or kind == "boolean" or kind == "nil" then
    return kind .. "=" .. tostring(value)
  elseif kind == "table" then
    local fields = {}
    for key, item in pairs(value) do
      fields[#fields + 1] = tostring(key) .. "=" .. tostring(item)
    end
    table.sort(fields)
    return "table={" .. table.concat(fields, ",") .. "}"
  end
  return kind
end

local enabled = badge.radio.enable()
record("sniffsafe start radio_enabled=" .. tostring(enabled) ..
       " ms=" .. tostring(badge.sys.ms()))

if enabled then
  badge.radio.on_recv(function(...)
    received = received + 1
    local args = {}
    local count = select("#", ...)
    for i = 1, count do
      args[i] = describe(select(i, ...))
    end
    record("RX#" .. received .. " nargs=" .. count .. " " .. table.concat(args, " | "))
  end)
end

local T = badge.ui.theme
badge.ui.label{x=10, y=10, text="Sniff Safe", color=T.accent}
badge.ui.label{x=10, y=44,
  text=enabled and "Radio: listening" or "Radio: unavailable",
  color=enabled and T.text or T.text_muted}
badge.ui.label{x=10, y=78, text="Passive: sends nothing", color=T.text_dim}
badge.ui.label{x=10, y=108, text="Use near Connect badge", color=T.text_dim}
badge.ui.label{x=10, y=210, text="HOME: exit", color=T.text_muted}
