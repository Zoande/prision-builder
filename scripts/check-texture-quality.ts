import assert from "node:assert/strict";
import { COMPRESSED_TEXTURE_NAMES, resolveTextureQuality } from "../src/render/textureQuality.ts";

const filesFor = (...qualities: Array<"4k" | "1k">) => new Set(
  COMPRESSED_TEXTURE_NAMES.flatMap((name) => qualities.map((quality) => `${name}.${quality}.ktx`)),
);

assert.deepEqual(resolveTextureQuality("4k", true, new Set()), {
  quality: "1k", mode: "raw", canToggle: false, bcSupported: true,
}, "when generated KTX files are absent, use raw textures and disable the ineffective toggle");
assert.deepEqual(resolveTextureQuality("4k", false, filesFor("4k", "1k")), {
  quality: "1k", mode: "raw", canToggle: false, bcSupported: false,
}, "GPU support is required before selecting compressed textures");
assert.deepEqual(resolveTextureQuality("4k", true, filesFor("1k")), {
  quality: "1k", mode: "compressed", canToggle: false, bcSupported: true,
}, "a single complete compressed set is selected honestly without offering a false toggle");
assert.deepEqual(resolveTextureQuality("1k", true, filesFor("4k", "1k")), {
  quality: "1k", mode: "compressed", canToggle: true, bcSupported: true,
}, "a complete pair of generated sets honors the saved preference and allows switching");

const partial = new Set([`${COMPRESSED_TEXTURE_NAMES[0]}.4k.ktx`]);
assert.deepEqual(resolveTextureQuality("4k", true, partial), {
  quality: "4k", mode: "mixed", canToggle: false, bcSupported: true,
}, "partial generated output uses available files plus raw fallback, with no false quality claim");

console.log("Texture quality resolution matches generated-file and GPU support.");
