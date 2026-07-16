// Texture resolver. Maps a logical material name to either a GPU-compressed KTX
// (BC7) at the selected quality, or the original PNG/JPG as a fallback when BC
// isn't supported or a KTX is missing. The raw 1K textures are kept as both the
// "low" path and the ultimate fallback.

import { loadTexture } from "../textures";
import { loadKtxTexture } from "./ktx";

export type Quality = "4k" | "1k";

let quality: Quality = "4k";
let bcSupported = false;
const textureCache = new Map<string, Promise<GPUTexture>>();

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
  black_col: "black_col.jpg", black_nrm: "black_nrm.png",
  galv_col: "galv_col.png", galv_nrm: "galv_nrm.png",
  corroded_col: "corroded_col.png", corroded_nrm: "corroded_nrm.png",
  fabric_col: "fabric_col.png",
};

// Names that have a compressed KTX twin (others go straight to raw).
const COMPRESSED = new Set([
  "grass_col", "grass_nrm", "dirt_col", "dirt_nrm", "floor2_col", "floor2_nrm",
  "concrete_col", "concrete_nrm", "wall_col", "wood_col", "black_col",
  "galv_col", "galv_nrm", "corroded_col", "corroded_nrm", "fabric_col",
]);

const RAW_MAX = 2048; // cap raw textures so 4K sources don't blow up VRAM

/** Load a material texture by logical name; `srgb` for color, false for normals. */
export async function loadTex(device: GPUDevice, name: string, srgb: boolean): Promise<GPUTexture> {
  const cacheKey = `${name}:${srgb ? "srgb" : "linear"}:${quality}:${bcSupported ? "bc" : "raw"}`;
  const cached = textureCache.get(cacheKey);
  if (cached) return cached;

  const load = loadTexUncached(device, name, srgb);
  textureCache.set(cacheKey, load);
  try {
    return await load;
  } catch (error) {
    textureCache.delete(cacheKey);
    throw error;
  }
}

async function loadTexUncached(device: GPUDevice, name: string, srgb: boolean): Promise<GPUTexture> {
  if (name === "white_col") {
    const texture = device.createTexture({
      size: [1, 1, 1], format: srgb ? "rgba8unorm-srgb" : "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, new Uint8Array([245, 245, 240, 255]), { bytesPerRow: 4 }, [1, 1, 1]);
    return texture;
  }
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
