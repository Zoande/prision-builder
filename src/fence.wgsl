// Prison fence: tall steel posts + rails + a chain-link panel + barbed wire.
// Per-vertex `ext` flags which side's run a vertex belongs to; per-instance
// `conn` says whether that neighbour exists. Runs with no neighbour collapse
// back into the post (invisible), so fence lines connect cleanly.
// `part` = 1 marks the chain-link panel: the fragment shader cuts the diamond
// mesh out of it with discard, so one thin quad reads as woven wire.
// (Globals/helpers from the shared prelude.)

const TEX_SCALE : f32 = 2.0;
const LINK_FREQ : f32 = 7.0; // chain-link diamond rows per world unit

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) part : f32,
};

@vertex
fn vs(
  @location(0) pos  : vec3<f32>,
  @location(1) ext  : vec4<f32>, // side this vertex's run belongs to (N,S,E,W)
  @location(2) tile : vec2<f32>,
  @location(3) conn : vec4<f32>, // neighbour present (N,S,E,W)
  @location(4) part : f32,       // 0 = solid steel, 1 = chain-link panel
) -> VSOut {
  var p = pos;
  if (ext.z > 0.5) { p.x = 0.5 + (p.x - 0.5) * conn.z; } // E
  if (ext.w > 0.5) { p.x = 0.5 + (p.x - 0.5) * conn.w; } // W
  if (ext.x > 0.5) { p.z = 0.5 + (p.z - 0.5) * conn.x; } // N
  if (ext.y > 0.5) { p.z = 0.5 + (p.z - 0.5) * conn.y; } // S

  var out : VSOut;
  out.world = p + vec3<f32>(tile.x, 0.0, tile.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  out.part = part;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Chain-link cutout. The panel runs along X or Z with the other axis
  // constant, so x+z is the along-run coordinate either way. Rotate the
  // (run, height) grid 45° and keep only pixels near the diamond edges.
  // Derivatives are taken unconditionally (WGSL requires uniform control
  // flow); only the discard is gated on `part`.
  let q = vec2<f32>(in.world.x + in.world.z, in.world.y) * LINK_FREQ;
  let r = vec2<f32>(q.x + q.y, q.x - q.y);
  // Widen the wires as they shrink under a pixel so distant fence reads as
  // a translucent weave instead of sparkling.
  let fw = max(fwidth(r.x), fwidth(r.y));
  let w = clamp(0.08 + 0.3 * fw, 0.08, 0.22);
  let dx = 0.5 - abs(fract(r.x) - 0.5);
  let dy = 0.5 - abs(fract(r.y) - 0.5);
  if (in.part > 0.5 && min(dx, dy) > w) { discard; }

  var N = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(N, U.eye - in.world) < 0.0) { N = -N; }
  let an = abs(N);
  var uv : vec2<f32>;
  if (an.y > 0.5) { uv = in.world.xz / TEX_SCALE; }
  else if (an.x > an.z) { uv = vec2<f32>(in.world.z, in.world.y) / TEX_SCALE; }
  else { uv = vec2<f32>(in.world.x, in.world.y) / TEX_SCALE; }

  // Gunmetal tint: the raw galvanized texture reads near-white under the
  // day-cycle lighting; pull it down to a darker steel.
  var albedo = textureSample(tex, sampRepeat, uv).rgb * vec3<f32>(0.58, 0.60, 0.65);
  if (in.part > 0.5) { albedo *= 0.80; } // woven wire sits a touch darker than the posts
  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
