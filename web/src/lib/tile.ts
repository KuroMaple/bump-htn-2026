export interface TilePattern {
  cells: number[][];
  palette: readonly [string, string, string];
}

const palettes = [
  ["#f2a93b", "#ef5da8", "#6842ff"],
  ["#70e1c8", "#ffca5c", "#ee6c6c"],
  ["#a78bfa", "#67e8f9", "#f9a8d4"],
  ["#f8d66d", "#6ed4a8", "#5577ff"],
  ["#ff7a61", "#ffd166", "#45c6b0"],
  ["#93c5fd", "#f0abfc", "#fde68a"],
  ["#b8f36b", "#4dd4d4", "#ff7897"],
] as const;

function hashString(value: string) {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

function randomFactory(seed: string) {
  const nextSeed = hashString(seed);
  let state = nextSeed();
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createTilePattern(seed: string): TilePattern {
  const random = randomFactory(seed);
  const palette = palettes[Math.floor(random() * palettes.length)]!;
  const mode = Math.floor(random() * 3);
  const cells = Array.from({ length: 10 }, () => Array<number>(10).fill(0));

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      const distance = Math.hypot(x - 4.5, y - 4.5);
      const threshold = mode === 0 ? 0.44 : mode === 1 ? 0.58 - distance * 0.035 : 0.5;
      const active = mode === 2 ? ((x + y + Math.floor(random() * 2)) % 2 === 0) : random() < threshold;
      const value = active ? 1 + Math.floor(random() * palette.length) : 0;
      const mirrors = [
        [x, y],
        [9 - x, y],
        [x, 9 - y],
        [9 - x, 9 - y],
      ];
      for (const [mirrorX, mirrorY] of mirrors) cells[mirrorY!]![mirrorX!] = value;
    }
  }

  return { cells, palette };
}
