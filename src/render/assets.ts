// Texture resolver. Maps a logical material name to either a GPU-compressed KTX
// (BC7) at the selected quality, or the original PNG/JPG as a fallback when BC
// isn't supported or a KTX is missing. The raw 1K textures are kept as both the
// "low" path and the ultimate fallback.

import { loadTexture } from "../textures";
import { loadKtxTexture } from "./ktx";

export type Quality = "4k" | "1k";

let quality: Quality = "4k";
let bcSupported = false;

export function configureAssets(opts: { quality: Quality; bcSupported: boolean }) {
  quality = opts.quality;
  bcSupported = opts.bcSupported;
}

export function getQuality(): Quality {
  return quality;
}

// Logical name -> raw file (under /public/textures). Includes both the
// fallbacks for compressed materials and the raw-only newer materials.
const RAW: Record<string, string> = {
  grass_col: "grass_col.jpg", grass_nrm: "grass_nrm.png",
  dirt_col: "dirt_col.jpg", dirt_nrm: "dirt_nrm.jpg",
  floor2_col: "floor2_col.jpg", floor2_nrm: "floor2_nrm.png",
  concrete_col: "concrete_col.jpg", concrete_nrm: "concrete_nrm.png",
  wall_col: "wall_col.png", wall_nrm: "wall_nrm.png",
  wood_col: "wood_col.jpg", wood_nrm: "wood_nrm.png",
  black_col: "black_col.jpg",
  // raw-only (added later, not yet GPU-compressed)
  galv_col: "galv_col.jpg", galv_nrm: "galv_nrm.jpg",
  corroded_col: "corroded_col.jpg", corroded_nrm: "corroded_nrm.jpg",
  fabric_col: "fabric_col.jpg",
};

// Names that have a compressed KTX twin (others go straight to raw).
const COMPRESSED = new Set([
  "grass_col", "grass_nrm", "dirt_col", "dirt_nrm", "floor2_col", "floor2_nrm",
  "concrete_col", "concrete_nrm", "wall_col", "wood_col", "black_col",
]);

const RAW_MAX = 2048; // cap raw textures so 4K sources don't blow up VRAM

/** Load a material texture by logical name; `srgb` for color, false for normals. */
export async function loadTex(device: GPUDevice, name: string, srgb: boolean): Promise<GPUTexture> {
  if (bcSupported && COMPRESSED.has(name)) {
    try {
      return await loadKtxTexture(device, `/textures/compressed/${name}.${quality}.ktx`, srgb);
    } catch (e) {
      console.warn(`[assets] compressed load failed for ${name}.${quality}, using raw`, e);
    }
  }
  const file = RAW[name];
  if (!file) throw new Error(`[assets] unknown texture: ${name}`);
  return loadTexture(device, `/textures/${file}`, srgb ? "rgba8unorm-srgb" : "rgba8unorm", RAW_MAX);
}
