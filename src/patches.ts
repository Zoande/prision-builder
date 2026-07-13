// Generates a coherent grass-vs-dirt splat map using fractal value noise (FBM).
// Output: single-channel (R8) texture data where 0 = full dirt, 255 = full grass.
// Patches are organic blobs (not per-tile random) thanks to low-frequency noise
// thresholded with a soft edge; linear filtering at sample time blends boundaries.

function hash2(ix: number, iy: number, seed: number): number {
  // Deterministic pseudo-random in [0,1) from integer lattice coords.
  let h = ix * 374761393 + iy * 668265263 + seed * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Smoothly interpolated value noise sampled at a continuous position.
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  const ux = smootherstep(fx), uy = smootherstep(fy);
  const top = a + (b - a) * ux;
  const bot = c + (d - c) * ux;
  return top + (bot - top) * uy;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 131);
    norm += amp;
    amp *= 0.5;
    freq *= 2.04;
  }
  return sum / norm; // ~[0,1]
}

export interface PatchMap {
  data: Uint8Array; // length res*res, R8
  res: number;
}

/**
 * @param res        splat texture resolution (texels per side)
 * @param worldSize  world extent in tiles the map covers
 * @param seed       RNG seed
 */
export function generatePatchMap(res: number, worldSize: number, seed = 1337): PatchMap {
  const data = new Uint8Array(res * res);
  // Absolute patch size (in tiles) so terrain looks the same on any map size,
  // just with more patches on a bigger map rather than larger blobs.
  const patchScale = 55;
  // Threshold controls grass/dirt ratio; soft controls boundary blend width.
  // A wide soft band makes small dirt islands fade in gradually instead of
  // appearing as hard-edged blobs.
  const threshold = 0.5;
  const soft = 0.17;

  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) {
      // Position in world tiles.
      const wx = (x / res) * worldSize;
      const wy = (y / res) * worldSize;
      // Domain-warp the lookup a touch so blobs feel less round / more natural.
      const wox = fbm(wx / patchScale + 11.3, wy / patchScale + 4.7, seed + 900, 3) - 0.5;
      const woy = fbm(wx / patchScale + 2.1, wy / patchScale + 19.4, seed + 1700, 3) - 0.5;
      // Fewer octaves + gentler warp => larger, calmer patches with fewer tiny
      // speckles that would otherwise pop in without a smooth transition.
      const n = fbm(
        wx / patchScale + wox * 0.4,
        wy / patchScale + woy * 0.4,
        seed,
        4,
      );
      // Single smooth ramp across a wide band -> grass weight in [0,1]. No extra
      // sharpening so boundaries (and small islands) fade gradually.
      const t = (n - (threshold - soft)) / (2 * soft);
      const g = smootherstep(t < 0 ? 0 : t > 1 ? 1 : t);
      data[y * res + x] = Math.round(g * 255);
    }
  }
  return { data, res };
}
