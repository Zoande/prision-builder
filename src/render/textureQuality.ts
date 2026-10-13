export type Quality = "4k" | "1k";
export type TextureQualityResolution = {
  quality: Quality;
  mode: "compressed" | "mixed" | "raw";
  canToggle: boolean;
  bcSupported: boolean;
};

export const COMPRESSED_TEXTURE_NAMES = [
  "grass_col", "grass_nrm", "dirt_col", "dirt_nrm", "floor2_col", "floor2_nrm",
  "concrete_col", "concrete_nrm", "wall_col", "wood_col", "black_col",
  "galv_col", "galv_nrm", "corroded_col", "corroded_nrm", "fabric_col",
] as const;

/** Resolve a saved preference against the compressed files present at startup. */
export function resolveTextureQuality(
  requested: Quality,
  supportsBc: boolean,
  available: ReadonlySet<string>,
): TextureQualityResolution {
  const complete = (candidate: Quality) => COMPRESSED_TEXTURE_NAMES.every((name) => available.has(`${name}.${candidate}.ktx`));
  const any = (candidate: Quality) => COMPRESSED_TEXTURE_NAMES.some((name) => available.has(`${name}.${candidate}.ktx`));
  if (!supportsBc) return { quality: "1k", mode: "raw", canToggle: false, bcSupported: false };

  const has4k = complete("4k"), has1k = complete("1k");
  if (has4k && has1k) return { quality: requested, mode: "compressed", canToggle: true, bcSupported: true };
  if (has4k) return { quality: "4k", mode: "compressed", canToggle: false, bcSupported: true };
  if (has1k) return { quality: "1k", mode: "compressed", canToggle: false, bcSupported: true };

  const hasRequested = any(requested);
  const hasOther = any(requested === "4k" ? "1k" : "4k");
  if (hasRequested || hasOther) {
    return {
      quality: hasRequested ? requested : requested === "4k" ? "1k" : "4k",
      mode: "mixed", canToggle: false, bcSupported: true,
    };
  }
  return { quality: "1k", mode: "raw", canToggle: false, bcSupported: true };
}
