export type TilePalette = readonly [
  background: string,
  motif: string,
];

export interface TilePattern {
  cells: number[][];
  palette: TilePalette;
}

const darks = [
  "#123F3C", // deep teal
  "#0F5D63", // teal
  "#092D6E", // ink blue
  "#86133F", // wine
  "#9B2F78", // plum
  "#37551E", // green
  "#6B6F1C", // olive
  "#475F86", // blue
  "#647B48", // moss
  "#7B1E4A", // berry
  "#A1264A", // rose
  "#6E2C74", // purple
] as const;

const brights = [
  "#55E2F2", // aqua
  "#20C8E6", // cyan
  "#1494A8",
  "#2AAFC4",
  "#65D4C8",

  "#B9D9FF",
  "#8B96DD",

  "#FF7A6E", // coral
  "#FF9B8F", // light coral
  "#F06E59",

  "#F45B8D", // pink
  "#FF8FC7", // bright pink
  "#D94B78",

  "#F2A44F",
  "#D9682E",
  "#E0C47C",
  "#C8B73B",
  "#FFD52E",

  "#1B2A4A", // ink blue
  "#243C73",

  "#6F45A8", // purple
  "#9A68D8",
  "#B55AC4",

  "#090B0D", // jet black
] as const;

function hashNumber(value: string): number {
  let hash = 2166136261 >>> 0;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function randomFactory(seed: string) {
  let state = hashNumber(seed);

  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;

    return (state >>> 0) / 4294967296;
  };
}

function rgb(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);

  return [
    (value >> 16) & 255,
    (value >> 8) & 255,
    value & 255,
  ] as const;
}

function luminance(hex: string): number {
  const [red, green, blue] = rgb(hex);

  return (
    red * 0.299 +
    green * 0.587 +
    blue * 0.114
  );
}

function hue(hex: string): number {
  const rgbValues = rgb(hex);

  const red = rgbValues[0] / 255;
  const green = rgbValues[1] / 255;
  const blue = rgbValues[2] / 255;

  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const difference = maximum - minimum;

  if (difference === 0) {
    return 0;
  }

  let result: number;

  if (maximum === red) {
    result = ((green - blue) / difference) % 6;
  } else if (maximum === green) {
    result = (blue - red) / difference + 2;
  } else {
    result = (red - green) / difference + 4;
  }

  result *= 60;

  return result < 0
    ? result + 360
    : result;
}

function hueDistance(
  left: string,
  right: string,
): number {
  const difference = Math.abs(
    hue(left) - hue(right),
  );

  return Math.min(
    difference,
    360 - difference,
  );
}

function contrastScore(
  left: string,
  right: string,
): number {
  return (
    Math.abs(
      luminance(left) - luminance(right),
    ) *
      1.55 +
    hueDistance(left, right) * 0.62
  );
}

function choosePalette(
  seed: string,
  neighborPalettes: readonly TilePalette[],
): TilePalette {
  const candidates: Array<{
    palette: TilePalette;
    score: number;
  }> = [];

  for (const dark of darks) {
    for (const bright of brights) {
      /*
       * Background does not always need
       * to be the darker colour.
       *
       * About 42% of candidate combinations
       * invert the usual dark-background rule.
       */
      const invert =
        hashNumber(
          `${seed}:${dark}:${bright}:invert`,
        ) %
          1000 <
        420;

      const background = invert
        ? bright
        : dark;

      const motif = invert
        ? dark
        : bright;

      let score = contrastScore(
        background,
        motif,
      );

      /*
       * Prefer palettes that look different
       * from nearby quilt squares.
       */
      for (const neighborPalette of neighborPalettes) {
        const [
          neighborBackground,
          neighborMotif,
        ] = neighborPalette;

        score +=
          hueDistance(
            background,
            neighborBackground,
          ) * 0.8;

        score +=
          hueDistance(
            motif,
            neighborMotif,
          ) * 0.35;

        score +=
          Math.abs(
            luminance(background) -
              luminance(neighborBackground),
          ) * 0.55;
      }

      /*
       * Small deterministic amount of noise
       * so the generator does not always pick
       * the mathematically perfect combination.
       */
      score +=
        (hashNumber(
          `${seed}:${background}:${motif}:jitter`,
        ) %
          1000) /
        40;

      candidates.push({
        palette: [
          background,
          motif,
        ] as const,
        score,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score,
  );

  /*
   * Choose deterministically from the
   * strongest few candidates.
   *
   * This gives variety while still avoiding
   * muddy / low-contrast combinations.
   */
  const top = candidates.slice(0, 8);

  const selectedIndex =
    hashNumber(`${seed}:palette`) %
    top.length;

  const selected = top[selectedIndex];

  /*
   * This technically should never happen
   * because our colour arrays aren't empty,
   * but the fallback keeps TypeScript happy.
   */
  if (!selected) {
    return [
      "#092D6E",
      "#FFD52E",
    ];
  }

  return selected.palette;
}

export function createTilePattern(
  seed: string,
  neighborPalettes: readonly TilePalette[] = [],
): TilePattern {
  const random = randomFactory(seed);

  const cells = Array.from(
    { length: 8 },
    () => Array<number>(8).fill(0),
  );

  /*
   * Generate one eighth of an 8x8 pattern,
   * then mirror it across all axes.
   *
   * This creates the mandala symmetry.
   */
  for (let y = 0; y < 4; y += 1) {
    for (let x = y; x < 4; x += 1) {
      const active =
        random() > 0.46
          ? 1
          : 0;

      /*
       * Explicit tuple typing is important.
       * Without this, strict TypeScript can infer
       * mirrorX / mirrorY as possibly undefined.
       */
      const mirrors: Array<
        [number, number]
      > = [
        [x, y],
        [y, x],

        [7 - x, y],
        [7 - y, x],

        [x, 7 - y],
        [y, 7 - x],

        [7 - x, 7 - y],
        [7 - y, 7 - x],
      ];

      for (
        const [mirrorX, mirrorY]
        of mirrors
      ) {
        cells[mirrorY]![mirrorX] =
          active;
      }
    }
  }

  return {
    cells,
    palette: choosePalette(
      seed,
      neighborPalettes,
    ),
  };
}