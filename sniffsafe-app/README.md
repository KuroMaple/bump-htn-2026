# Sniff Safe

Passive Lua-radio probe for capturing the callback shape seen by custom apps.
It does not transmit or change contacts. It prints and persists the first 30
callback invocations in app-relative `sniff.log`.

Use only after the stock Connect app is open on the other test badge. The
expected capture result may be empty: that would establish that the Lua radio
callback does not receive stock Connect advertisements, and we would move to a
lower-level BLE capture instead.
