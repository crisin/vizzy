// Seeded RNG (mulberry32) — same seed, same garden. The seed is a normal
// editor parameter, so a plant you like is reproducible and shareable.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** value ± spread*value, uniform */
export function jitter(rng: Rng, value: number, spread: number): number {
  return value * (1 + (rng() * 2 - 1) * spread);
}

/** uniform in [min, max) */
export function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** integer in [min, max] inclusive */
export function irange(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Golden angle in radians — phyllotaxis: leaves, petals and cactus areoles
 *  placed at multiples of this never stack on top of each other. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈ 2.39996
