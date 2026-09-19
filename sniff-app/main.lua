-- Sniff - does on_recv deliver OTHER badges' advertisements, or only ours?
-- Logs its own startup state so a silent run is still diagnosable.
local ok = badge.radio.enable() and true or false
badge.fs.append("sniff.log",
  "== start ms="..badge.sys.ms().." radio_ok="..tostring(ok)..
  " mac="..tostring(ok and badge.radio.mac() or "n/a")..
  " heap="..badge.sys.heap().."\n")
local n = 0
if ok then
  badge.radio.on_recv(function(...)
    n = n + 1
    local c = select("#", ...)
    local p = {}
    for i = 1, c do
      local v = select(i, ...)
      local t = type(v)
      if t == "table" then
        local f = {}
        for k, vv in pairs(v) do f[#f+1] = tostring(k).."="..tostring(vv) end
        table.sort(f); p[i] = "{"..table.concat(f, ",").."}"
      else p[i] = t..":"..tostring(v) end
    end
    local line = "RX#"..n.." nargs="..c.." "..table.concat(p, " | ")
    print(line)
    badge.fs.append("sniff.log", line.."\n")
  end)
  badge.radio.send("SNIFF|"..badge.me.badge_id())
end
print("sniff: radio_ok="..tostring(ok))
local T = badge.ui.theme
badge.ui.label{x=10, y=10,  text="Sniff", color=T.accent}
badge.ui.label{x=10, y=44,  text=ok and "Radio: LISTENING" or "Radio: FAILED",
               color = ok and T.text or T.text_muted}
badge.ui.label{x=10, y=78,  text="Walk near other badges", color=T.text_dim}
badge.ui.label{x=10, y=108, text="Wait ~60s then HOME", color=T.text_dim}
badge.ui.label{x=10, y=210, text="HOME: exit", color=T.text_muted}
