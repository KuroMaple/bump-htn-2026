#!/usr/bin/env python3
"""Live demo: show profiles badge A extracts from nearby Connect broadcasts.

    . ~/esp/esp-idf/export.sh
    python tools/bump-demo.py                 # runs until Ctrl-C

Prints each distinct badge frame the moment it is heard. Profile frames (BMP2)
are highlighted; game frames (MPG1/BPI1) and stations (BBX1) are labelled but
dimmed, so a live audience sees the profile land.
"""
import argparse, re, sys, time
import serial

ADV = re.compile(r'ADV (EXT|LEG) ([0-9a-f:]{17})/(\S+) rssi=(-?\d+).*?'
                 r'props=(\S+).*?len=(\d+) data=([0-9a-f]*)')
MARKS = {'424d5032': 'PROFILE (BMP2)', '42504131': 'PROFILE (BPA1)',
         '4d504731': 'game (MPG1)', '42504931': 'game (BPI1)',
         '42425831': 'station (BBX1)'}
B, D, G, Y, R = '\033[1m', '\033[2m', '\033[32m', '\033[33m', '\033[0m'


def text_runs(hexstr, minlen=4):
    b = bytes.fromhex(hexstr)
    out, cur = [], b''
    for c in b:
        if 32 <= c < 127:
            cur += bytes([c])
        else:
            if len(cur) >= minlen: out.append(cur.decode())
            cur = b''
    if len(cur) >= minlen: out.append(cur.decode())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', default='/dev/cu.usbmodem3101')
    ap.add_argument('--seconds', type=float, default=0, help='0 = forever')
    a = ap.parse_args()

    s = serial.Serial(a.port, 115200, timeout=1)
    s.setDTR(False); s.setRTS(False)
    print(f"{B}Badge A passive profile capture — ask someone to open Connect{R}\n")
    seen, t0, n = set(), time.time(), 0
    try:
        while a.seconds == 0 or time.time() - t0 < a.seconds:
            line = s.readline()
            if not line: continue
            m = ADV.search(line.decode('utf8', 'replace'))
            if not m: continue
            kind, mac, atype, rssi, props, ln, data = m.groups()
            label = next((v for k, v in MARKS.items() if k in data), None)
            if not label: continue
            runs = text_runs(data)
            key = (mac, tuple(runs), label)
            if key in seen: continue
            seen.add(key); n += 1
            prof = label.startswith('PROFILE')
            col = G if prof else D
            print(f"{col}[{time.time()-t0:6.1f}s] {B if prof else ''}{label}{R}"
                  f"{col}  {mac}  rssi={rssi}dBm{R}")
            for r in runs:
                if r in ('BMP2', 'BPA1', 'MPG1', 'BPI1', 'BBX1'): continue
                print(f"          {Y if prof else D}{r}{R}")
            if prof:
                print(f"          {D}raw={data}{R}")
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        s.close()
        print(f"\n{n} distinct badge frames captured")


if __name__ == '__main__':
    main()
