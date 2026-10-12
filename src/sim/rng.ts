// The simulation's random number generator.
//
// It is seeded and deterministic on purpose: a fixed prison, driven for a fixed
// number of ticks, must land in exactly the same state every time. That is what
// makes `npm run sim-check` able to prove a refactor changed nothing, and what
// lets a bug that only shows up after ten game-hours be reproduced at all.
//
// Nothing in sim/ may call Math.random(). Use rnd().

let state = 0x2f6e2b1 >>> 0;

/** Reset the stream. The same seed always replays the same prison. */
export function seedRng(seed = 0x2f6e2b1) {
  state = (seed >>> 0) || 1;
}

/** Capture the current stream position for deterministic save files. */
export function getRngState(): number {
  return state >>> 0;
}

/** Restore a captured stream position. Zero is invalid for xorshift32. */
export function setRngState(next: number): void {
  if (!Number.isInteger(next) || next < 1 || next > 0xffffffff)
    throw new RangeError("RNG state must be a nonzero unsigned 32-bit integer");
  state = next >>> 0;
}

/** Uniform in [0, 1). xorshift32 — small, fast, and good enough for a game. */
export function rnd(): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state / 4294967296;
}

/** Uniform integer in [0, n). */
export function rndInt(n: number): number {
  return (rnd() * n) | 0;
}

/** A random element, or undefined if the list is empty. */
export function pick<T>(list: readonly T[]): T | undefined {
  return list.length === 0 ? undefined : list[rndInt(list.length)];
}
