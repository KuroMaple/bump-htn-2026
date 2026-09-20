/**
 * Server-side PNG renderer for the mandela tile.
 * Faithfully ports web/src/lib/tile.ts — must stay in sync with it.
 * No external dependencies; uses only Node's built-in zlib.
 */
import { deflateSync } from "node:zlib";

// ── Colour palettes (must match web/src/lib/tile.ts) ────────────────────────

const DARKS = [
  "#123F3C", "#0F5D63", "#092D6E", "#86133F", "#9B2F78", "#37551E",
  "#6B6F1C", "#475F86", "#647B48", "#7B1E4A", "#A1264A", "#6E2C74",
] as const;

const BRIGHTS = [
  "#55E2F2", "#20C8E6", "#1494A8", "#2AAFC4", "#65D4C8",
  "#B9D9FF", "#8B96DD",
  "#FF7A6E", "#FF9B8F", "#F06E59",
  "#F45B8D", "#FF8FC7", "#D94B78",
  "#F2A44F", "#D9682E", "#E0C47C", "#C8B73B", "#FFD52E",
  "#1B2A4A", "#243C73",
  "#6F45A8", "#9A68D8", "#B55AC4",
  "#090B0D",
] as const;

// ── Deterministic helpers ────────────────────────────────────────────────────

function hashNumber(v: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < v.length; i++) {
    h ^= v.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: string) {
  let s = hashNumber(seed);
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return r * 0.299 + g * 0.587 + b * 0.114;
}

function hue(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDist(a: string, b: string): number {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

function choosePalette(seed: string): [string, string] {
  const candidates: { bg: string; fg: string; score: number }[] = [];
  for (const dark of DARKS) {
    for (const bright of BRIGHTS) {
      const invert = hashNumber(`${seed}:${dark}:${bright}:invert`) % 1000 < 420;
      const bg = invert ? bright : dark;
      const fg = invert ? dark : bright;
      const score =
        Math.abs(luminance(bg) - luminance(fg)) * 1.55 +
        hueDist(bg, fg) * 0.62 +
        (hashNumber(`${seed}:${bg}:${fg}:jitter`) % 1000) / 40;
      candidates.push({ bg, fg, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 8);
  const sel = top[hashNumber(`${seed}:palette`) % top.length] ?? top[0]!;
  return [sel.bg, sel.fg];
}

function buildCells(seed: string): number[][] {
  const next = rng(seed);
  const cells = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  for (let y = 0; y < 4; y++) {
    for (let x = y; x < 4; x++) {
      const on = next() > 0.46 ? 1 : 0;
      for (const [mx, my] of [
        [x, y], [y, x], [7 - x, y], [7 - y, x],
        [x, 7 - y], [y, 7 - x], [7 - x, 7 - y], [7 - y, 7 - x],
      ] as [number, number][]) {
        cells[my]![mx] = on;
      }
    }
  }
  return cells;
}

// ── Minimal PNG encoder (no external deps) ───────────────────────────────────

let _crcTable: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    _crcTable[n] = c;
  }
  return _crcTable;
}

function crc32(buf: Buffer): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (const b of buf) c = (c >>> 8) ^ t[(c ^ b) & 0xff]!;
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const out = Buffer.allocUnsafe(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = 1 + w * 3;
  const raw = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3, d = y * stride + 1 + x * 3;
      raw[d] = rgb[s]!; raw[d + 1] = rgb[s + 1]!; raw[d + 2] = rgb[s + 2]!;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a mandela tile as PNG. px = pixels per 8×8 logical cell (default 30
 * → 240×240 output, which fills the badge screen height exactly).
 */
export function renderTilePng(seed: string, px = 30): Buffer {
  const [bg, fg] = choosePalette(seed);
  const cells = buildCells(seed);
  const size = 8 * px;
  const pixels = new Uint8Array(size * size * 3);
  const [bgR, bgG, bgB] = hexToRgb(bg);
  const [fgR, fgG, fgB] = hexToRgb(fg);

  for (let cy = 0; cy < 8; cy++) {
    for (let cx = 0; cx < 8; cx++) {
      const [r, g, b] = cells[cy]![cx] ? [fgR, fgG, fgB] : [bgR, bgG, bgB];
      for (let py = 0; py < px; py++) {
        for (let px_ = 0; px_ < px; px_++) {
          const i = ((cy * px + py) * size + cx * px + px_) * 3;
          pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b;
        }
      }
    }
  }
  return encodePng(size, size, pixels);
}

/** Base64-encode the PNG for the HTN OS image JSON API. */
export function renderTileB64(seed: string, px = 30): string {
  return renderTilePng(seed, px).toString("base64");
}
