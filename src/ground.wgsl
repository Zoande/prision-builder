// Ground plane: a single quad on the XZ plane covering the playable area plus
// the non-buildable border margin, so the terrain runs on under the haze and
// never shows its edge. Tiles the grass & dirt textures, blends them with the
// splat map, applies normal-mapped lighting, then dissolves into atmosphere.
// (Globals/helpers come from the shared prelude prepended at build time.)

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var sampClamp  : sampler;
@group(0) @binding(3) var grassCol : texture_2d<f32>;
@group(0) @binding(4) var grassNrm : texture_2d<f32>;
@group(0) @binding(5) var dirtCol  : texture_2d<f32>;
@group(0) @binding(6) var dirtNrm  : texture_2d<f32>;
@group(0) @binding(7) var splat    : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0),
  );
  let c = corners[vi] * (U.worldSize + 2.0 * U.border) - vec2<f32>(U.border, U.border);
  var out : VSOut;
  out.world = vec3<f32>(c.x, 0.0, c.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let xz = in.world.xz;
  let uv = xz / U.tileScale;
  let splatUV = xz / U.worldSize;

  let g = textureSample(splat, sampClamp, splatUV).r;

  let gC = textureSample(grassCol, sampRepeat, uv).rgb;
  let dC = textureSample(dirtCol,  sampRepeat, uv).rgb;
  let gN = unpackNormal(textureSample(grassNrm, sampRepeat, uv).rgb);
  let dN = unpackNormal(textureSample(dirtNrm,  sampRepeat, uv).rgb);

  let albedo = mix(dC, gC, g);
  let N = normalize(mix(dN, gN, g));

  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
