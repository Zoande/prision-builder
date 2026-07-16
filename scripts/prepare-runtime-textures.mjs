// Build small, committed runtime derivatives for materials whose licensed 4K
// sources live under assets/textures-src. Browsers never need the source files.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASISU = resolve(ROOT, "node_modules/basis_universal/bin/basisu.exe");
const TMP = resolve(ROOT, "build/runtime-textures");
const OUT = resolve(ROOT, "public/textures");

const JOBS = [
  ["galv_col", "assets/textures-src/lightgreymetaltexture/MetalGalvanizedSteelWorn001_COL_4K_METALNESS.jpg", false],
  ["galv_nrm", "assets/textures-src/lightgreymetaltexture/MetalGalvanizedSteelWorn001_NRM_4K_METALNESS.jpg", true],
  ["corroded_col", "assets/textures-src/corrodedmetal/MetalCorrodedHeavy001_COL_4K_METALNESS.jpg", false],
  ["corroded_nrm", "assets/textures-src/corrodedmetal/MetalCorrodedHeavy001_NRM_4K_METALNESS.jpg", true],
  ["fabric_col", "assets/textures-src/fabricplain/FabricPlainNaturalSheer009_COL_4K.jpg", false],
];

function run(args, cwd = ROOT) {
  execFileSync(BASISU, args, { cwd, stdio: "pipe" });
}

function build(name, relativeSource, normal) {
  const source = resolve(ROOT, relativeSource);
  if (!existsSync(source)) throw new Error(`missing licensed source: ${relativeSource}`);

  const basis = resolve(TMP, `${name}.basis`);
  const encode = [source, "-resample", "1024", "1024", "-uastc", "-uastc_level", "0", "-output_file", basis];
  if (normal) encode.push("-normal_map", "-renorm");
  run(encode);
  run(["-unpack", "-file", basis, "-format_only", "13"], TMP);

  const unpacked = resolve(TMP, `${name}_unpacked_rgb_UASTC_4x4_0000.png`);
  const dest = resolve(OUT, `${name}.png`);
  rmSync(dest, { force: true });
  renameSync(unpacked, dest);
  rmSync(resolve(TMP, `${name}_unpacked_a_UASTC_4x4_0000.png`), { force: true });
  rmSync(basis, { force: true });
  console.log(`built  public/textures/${name}.png (1024x1024)`);
}

if (!existsSync(BASISU)) throw new Error(`basisu not found at ${BASISU}; run npm install first`);
mkdirSync(TMP, { recursive: true });
mkdirSync(OUT, { recursive: true });
for (const [name, source, normal] of JOBS) build(name, source, normal);
rmSync(TMP, { recursive: true, force: true });
