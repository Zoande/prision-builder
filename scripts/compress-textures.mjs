// Offline texture compression: source PNG/JPG -> Basis UASTC (+mips) -> transcode
// to raw BC7 stored in a KTX (KTX1) container. The runtime uploads the BC7 blocks
// directly (no transcoder needed). Produces two qualities per texture:
//   <name>.4k.ktx  (high)   and   <name>.1k.ktx  (low)
//
// Usage:  node scripts/compress-textures.mjs [--force]
// Idempotent: existing outputs are skipped unless --force is passed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASISU = resolve(ROOT, "node_modules/basis_universal/bin/basisu.exe");
const OUT = resolve(ROOT, "public/textures/compressed");
const TMP = resolve(ROOT, "build/tmp");
const FORCE = process.argv.includes("--force");

const UASTC_LEVEL = "2"; // high quality (slow encode, near-lossless to BC7)
const BC7 = "6"; // basis transcoder_texture_format::cTFBC7_RGBA

// name, kind, and source per quality. `null` 4k source falls back to the 1k one.
// 4k sources are the untracked third-party downloads under assets/textures-src;
// 1k sources are the runtime textures in public/textures.
const r = (p) => resolve(ROOT, p);
const hi = (p) => `assets/textures-src/${p}`;
const MANIFEST = [
  // --- color (sRGB) ---
  ["grass_col", "color", hi("grass4k/4K/Poliigon_GrassPatchyGround_4585_BaseColor.jpg"), "public/textures/grass_col.jpg"],
  ["dirt_col", "color", hi("dirt4k/GroundDirtWeedsPatchy004_COL_4K.jpg"), "public/textures/dirt_col.jpg"],
  ["floor2_col", "color", hi("floor4k/4K/Poliigon_ConcreteFloorPoured_7656_BaseColor.jpg"), "public/textures/floor2_col.jpg"],
  ["wall_col", "color", hi("wall4k/RammedEarth018_COL_4K_METALNESS.png"), "public/textures/wall_col.png"],
  ["wood_col", "color", hi("wood4k/4K/Poliigon_WoodVeneerOak_7760_BaseColor.jpg"), "public/textures/wood_col.jpg"],
  ["black_col", "color", hi("black_texture_4k/4K/Poliigon_PlasticMoldDryBlast_7495_BaseColor.jpg"), "public/textures/black_col.jpg"],
  ["concrete_col", "color", null, "public/textures/concrete_col.jpg"], // roof; no 4k source
  // --- normal (linear) ---
  ["grass_nrm", "normal", hi("grass4k/4K/Poliigon_GrassPatchyGround_4585_Normal.png"), "public/textures/grass_nrm.png"],
  ["dirt_nrm", "normal", hi("dirt4k/GroundDirtWeedsPatchy004_NRM_4K.jpg"), "public/textures/dirt_nrm.jpg"],
  ["floor2_nrm", "normal", hi("floor4k/4K/Poliigon_ConcreteFloorPoured_7656_Normal.png"), "public/textures/floor2_nrm.png"],
  ["concrete_nrm", "normal", null, "public/textures/concrete_nrm.png"], // roof; no 4k source
];

function basisu(args) {
  execFileSync(BASISU, args, { cwd: TMP, stdio: "pipe" });
}

function buildOne(name, kind, src, quality) {
  const dest = resolve(OUT, `${name}.${quality}.ktx`);
  if (!FORCE && existsSync(dest)) {
    console.log(`skip   ${name}.${quality} (exists)`);
    return;
  }
  const basis = resolve(TMP, `${name}.${quality}.basis`);
  const encodeArgs = [src, "-uastc", "-uastc_level", UASTC_LEVEL, "-mipmap", "-output_file", basis];
  if (kind === "normal") encodeArgs.push("-normal_map", "-mip_linear", "-mip_renorm");

  const t0 = Date.now();
  basisu(encodeArgs);

  // Clear any stale transcode output, then unpack the single BC7 KTX.
  for (const f of readdirSync(TMP)) if (f.includes("_transcoded_")) rmSync(resolve(TMP, f));
  basisu([basis, "-unpack", "-ktx_only", "-format_only", BC7]);
  const produced = readdirSync(TMP).find((f) => f.includes("_transcoded_") && f.endsWith(".ktx"));
  if (!produced) throw new Error(`unpack produced no KTX for ${name}.${quality}`);
  renameSync(resolve(TMP, produced), dest);
  rmSync(basis, { force: true });

  console.log(`build  ${name}.${quality}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function main() {
  if (!existsSync(BASISU)) throw new Error(`basisu not found at ${BASISU}`);
  mkdirSync(OUT, { recursive: true });
  mkdirSync(TMP, { recursive: true });

  for (const [name, kind, src4k, src1k] of MANIFEST) {
    buildOne(name, kind, r(src4k ?? src1k), "4k");
    buildOne(name, kind, r(src1k), "1k");
  }
  console.log("done.");
}

main();
