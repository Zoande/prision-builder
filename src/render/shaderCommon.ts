// WGSL prelude shared by every pass: the per-frame Globals uniform, common
// lighting / atmosphere / color helpers, and the shared world dimensions.
// Prepended to each pass's shader so there is a single source of truth for the
// uniform layout, the look, and the building proportions.
//
// Globals uniform layout (std140-ish, 272 bytes). Mirrored by writeGlobals():
//   offset   0  viewProj    mat4x4<f32>
//   offset  64  invViewProj mat4x4<f32>
//   offset 128  lightDir    vec3<f32>   worldSize  f32
//   offset 144  eye         vec3<f32>   tileScale  f32
//   offset 160  sunDir      vec3<f32>   fadeWidth  f32
//   offset 176  sunColor    vec3<f32>   roofAlpha  f32
//   offset 192  ambDown     vec3<f32>   time       f32
//   offset 208  ambUp       vec3<f32>   fogDensity f32
//   offset 224  fogColor    vec3<f32>   border     f32
//   offset 240  skyHorizon  vec3<f32>   (pad)
//   offset 256  skyZenith   vec3<f32>   (pad)

// --- Shared building dimensions (world tiles = 1 unit) --------------------
export const WALL_H = 3.0; // wall height
export const WALL_BEVEL = 0.16; // top-edge chamfer inset on exposed sides
export const WALL_CAP = 0.45; // height of the chamfered cap region
export const ROOF_Y = WALL_H + 0.03; // roof sits just above the wall tops
export const DOOR_H = WALL_H; // door fills the full opening height
export const DOOR_W = 0.98; // door leaf width (nearly the whole tile)
export const DOOR_T = 0.14; // door leaf thickness
export const FENCE_H = 3.0; // fence fabric height (wall-sized; barbed wire sits above)

// WGSL consts mirroring the above, so shaders and JS never drift apart.
const SHADER_CONSTS = /* wgsl */ `
const WALL_H : f32 = ${WALL_H};
const WALL_BEVEL : f32 = ${WALL_BEVEL};
const ROOF_Y : f32 = ${ROOF_Y};
const DOOR_H : f32 = ${DOOR_H};
const DOOR_W : f32 = ${DOOR_W};
const DOOR_T : f32 = ${DOOR_T};
`;

const GLOBALS_WGSL = /* wgsl */ `
struct Globals {
  viewProj    : mat4x4<f32>,
  invViewProj : mat4x4<f32>,
  lightDir    : vec3<f32>, worldSize  : f32, // active light (sun by day, moon by night)
  eye         : vec3<f32>, tileScale  : f32,
  sunDir      : vec3<f32>, fadeWidth  : f32, // true sun position (may be below horizon)
  sunColor    : vec3<f32>, roofAlpha  : f32,
  ambDown     : vec3<f32>, time       : f32,
  ambUp       : vec3<f32>, fogDensity : f32,
  fogColor    : vec3<f32>, border     : f32, // non-buildable haze margin (tiles)
  skyHorizon  : vec3<f32>, _pad1      : f32,
  skyZenith   : vec3<f32>, _pad2      : f32,
};
@group(0) @binding(0) var<uniform> U : Globals;

fn unpackNormal(t : vec3<f32>) -> vec3<f32> {
  let n = t * 2.0 - 1.0;
  // Tangent space (u->+X, v->+Z, up->+Y) to world for a flat ground/floor.
  return normalize(vec3<f32>(n.x, n.z, n.y));
}

fn shade(albedo : vec3<f32>, N : vec3<f32>) -> vec3<f32> {
  let L = normalize(U.lightDir);
  let ndl = max(dot(N, L), 0.0);
  // Hemisphere ambient: sky color from above, bounce color from below.
  let hemi = mix(U.ambDown, U.ambUp, N.y * 0.5 + 0.5);
  return albedo * (hemi + U.sunColor * ndl);
}

// World light grid (one texel per tile, RGB = fixture light reaching that
// tile, walls already occluded on the CPU). Shared by every lit pass.
@group(0) @binding(10) var lightSamp : sampler;
@group(0) @binding(11) var lightTex : texture_2d<f32>;

fn shadeLit(albedo : vec3<f32>, N : vec3<f32>, world : vec3<f32>) -> vec3<f32> {
  let uv = world.xz / U.worldSize;
  let lm = textureSample(lightTex, lightSamp, uv).rgb * 2.0;
  // Fixture light lives low: full strength at the floor, fading with height.
  let hf = clamp(1.0 - world.y / 5.0, 0.2, 1.0);
  // No fixture light outside the playable area (the clamp sampler would
  // otherwise smear edge texels across the whole border margin).
  let inside = step(abs(uv.x - 0.5), 0.5) * step(abs(uv.y - 0.5), 0.5);
  return shade(albedo, N) + albedo * lm * hf * inside;
}

// Distance to the playable-area edge; negative out in the border margin.
// The haze builds slowly from fadeWidth tiles inside the playable area and is
// fully opaque 10 tiles before the ground geometry ends, so the plane's edge
// (and anything beneath it) can never be seen.
fn borderFade(xz : vec2<f32>) -> f32 {
  let d = min(min(xz.x, xz.y), min(U.worldSize - xz.x, U.worldSize - xz.y));
  return smoothstep(-(U.border - 10.0), U.fadeWidth, d);
}

// Height fog toward the sky's horizon color: the haze sits in a low layer
// over the ground (density falls off exponentially with altitude), so a high
// zoomed-out camera looking down stays clear while horizon-grazing views sink
// into it. The world border dissolves into the same haze so the map edge
// reads as atmosphere, not a cliff.
const FOG_FALLOFF : f32 = 0.03; // 1/units: haze layer is ~35 units thick

fn atmosphere(color : vec3<f32>, world : vec3<f32>) -> vec3<f32> {
  let rel = world - U.eye;
  let d = length(rel);
  // Average fog density along the ray (analytic integral of exp(-k*y)).
  var avg = exp(-FOG_FALLOFF * U.eye.y);
  if (abs(rel.y) > 0.01) {
    avg = (exp(-FOG_FALLOFF * world.y) - exp(-FOG_FALLOFF * U.eye.y))
        / (FOG_FALLOFF * (U.eye.y - world.y));
  }
  let fog = 1.0 - exp(-pow(d * avg * U.fogDensity, 1.5));
  // Union with the border haze (probabilistic, so the two blend smoothly
  // instead of one snapping over the other).
  let edge = 1.0 - borderFade(world.xz);
  let f = clamp(fog + edge - fog * edge, 0.0, 1.0);
  // In-scattering: haze looking toward the sun/moon catches its light, so
  // fog glows warm around a low sun instead of being one flat color.
  let sunAmt = pow(max(dot(rel / max(d, 0.001), normalize(U.sunDir)), 0.0), 6.0);
  let fogCol = U.fogColor + U.sunColor * sunAmt * 0.35;
  return mix(color, fogCol, f);
}

fn toSRGB(c : vec3<f32>) -> vec3<f32> {
  return pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
}
`;

/** Prelude prepended to every pass shader (uniforms + helpers + shared consts). */
export const PRELUDE = GLOBALS_WGSL + SHADER_CONSTS;

/** The shared world light grid, bound by every pass whose shader calls shadeLit. */
export interface SceneLight { view: GPUTextureView; samp: GPUSampler }
export const sceneLightEntries = (l: SceneLight): GPUBindGroupEntry[] => [
  { binding: 10, resource: l.samp },
  { binding: 11, resource: l.view },
];

export const GLOBALS_SIZE = 272; // bytes

export interface GlobalsParams {
  viewProj: Float32Array;
  invViewProj: Float32Array;
  lightDir: [number, number, number];
  worldSize: number;
  eye: [number, number, number];
  tileScale: number;
  sunDir: [number, number, number];
  fadeWidth: number;
  sunColor: [number, number, number];
  roofAlpha: number;
  ambDown: [number, number, number];
  time: number;
  ambUp: [number, number, number];
  fogDensity: number;
  fogColor: [number, number, number];
  border: number;
  skyHorizon: [number, number, number];
  skyZenith: [number, number, number];
}

/** Pack per-frame globals into the shared uniform Float32Array (68 floats). */
export function writeGlobals(uni: Float32Array, p: GlobalsParams) {
  uni.set(p.viewProj, 0);
  uni.set(p.invViewProj, 16);
  const v3 = (off: number, v: [number, number, number], w: number) => {
    uni[off] = v[0]; uni[off + 1] = v[1]; uni[off + 2] = v[2]; uni[off + 3] = w;
  };
  v3(32, p.lightDir, p.worldSize);
  v3(36, p.eye, p.tileScale);
  v3(40, p.sunDir, p.fadeWidth);
  v3(44, p.sunColor, p.roofAlpha);
  v3(48, p.ambDown, p.time);
  v3(52, p.ambUp, p.fogDensity);
  v3(56, p.fogColor, p.border);
  v3(60, p.skyHorizon, 0);
  v3(64, p.skyZenith, 0);
}
