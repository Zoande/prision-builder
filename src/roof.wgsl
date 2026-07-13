// Roof: one instanced quad per building-footprint tile, sitting just above the
// wall tops. Textured per wall material so the roof matches the walls beneath.
// Alpha-blended so the bottom-right toggle can fade it out and reveal the
// rooms inside (U.roofAlpha).
// (Globals/helpers/consts come from the shared prelude.)

const TEX_SCALE : f32 = 4.0;

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var roofCol : texture_2d<f32>;
@group(0) @binding(3) var roofNrm : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @location(0) tile : vec2<f32>,
  @location(1) expose : vec4<f32>, // building-edge flags N,S,E,W
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  var p = corners[vi];
  // Inset exposed edges by the wall bevel so the roof rim sits on the wall top.
  if (p.x < 0.5) { p.x += WALL_BEVEL * expose.w; } else { p.x -= WALL_BEVEL * expose.z; }
  if (p.y < 0.5) { p.y += WALL_BEVEL * expose.x; } else { p.y -= WALL_BEVEL * expose.y; }

  let c = tile + p;
  var out : VSOut;
  out.world = vec3<f32>(c.x, ROOF_Y, c.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let xz = in.world.xz;
  let uv = xz / TEX_SCALE;
  let albedo = textureSample(roofCol, sampRepeat, uv).rgb;
  let N = unpackNormal(textureSample(roofNrm, sampRepeat, uv).rgb);
  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), U.roofAlpha);
}
