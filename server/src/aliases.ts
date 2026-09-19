const adjectives = [
  "Amber",
  "Bright",
  "Copper",
  "Electric",
  "Gentle",
  "Indigo",
  "Kinetic",
  "Lunar",
  "Neon",
  "Quiet",
  "Solar",
  "Velvet",
];

const nouns = [
  "Arc",
  "Beacon",
  "Circuit",
  "Comet",
  "Current",
  "Glyph",
  "Loop",
  "Pixel",
  "Pulse",
  "Relay",
  "Signal",
  "Spark",
];

function hash(value: string) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function makeAlias(seed: string) {
  const value = hash(seed);
  return `${adjectives[value % adjectives.length]} ${nouns[Math.floor(value / adjectives.length) % nouns.length]}`;
}
