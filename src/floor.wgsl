// Concrete floor: one instanced unit quad per concrete tile, laid just above
// the terrain so it cleanly overrides the natural ground inside rooms.
// (Globals/helpers come from the shared prelude.)

const FLOOR_Y : f32 = 0.02;
const TEX_SCALE : f32 = 4.0; // world tiles per concrete texture repeat

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var floorCol : texture_2d<f32>;
@group(0) @binding(3) var floorNrm : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32, @location(0) tile : vec2<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let c = tile + corners[vi];
  var out : VSOut;
  out.world = vec3<f32>(c.x, FLOOR_Y, c.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let xz = in.world.xz;
  let uv = xz / TEX_SCALE;
  let albedo = textureSample(floorCol, sampRepeat, uv).rgb;
  let N = unpackNormal(textureSample(floorNrm, sampRepeat, uv).rgb);
  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
