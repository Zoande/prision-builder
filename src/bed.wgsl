// Bed: instanced two-tile furniture, drawn in tinted parts (steel frame,
// mattress + pillow, blanket) so one fabric texture serves several cloths.
// One mesh is authored for the X orientation; instances with orient=1 are
// rotated 90° by swapping local X/Z so the bed aligns with a Z run.
// (Globals/helpers/consts come from the shared prelude.)

const TEX_SCALE : f32 = 1.6;

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;
@group(0) @binding(3) var<uniform> tint : vec4<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(
  @location(0) pos : vec3<f32>,
  @location(2) tile : vec2<f32>,
  @location(3) orient : f32,
) -> VSOut {
  var p = pos;
  let o = i32(orient + 0.5) & 3;
  if (o == 1) {
    p = vec3<f32>(p.z, p.y, p.x);
  } else if (o == 2) {
    p = vec3<f32>(1.0 - p.x, p.y, p.z);
  } else if (o == 3) {
    p = vec3<f32>(p.z, p.y, 1.0 - p.x);
  }
  var out : VSOut;
  out.world = p + vec3<f32>(tile.x, 0.0, tile.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var N = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(N, U.eye - in.world) < 0.0) { N = -N; }

  let an = abs(N);
  var uv : vec2<f32>;
  if (an.y > 0.5) {
    uv = in.world.xz / TEX_SCALE;
  } else if (an.x > an.z) {
    uv = vec2<f32>(in.world.z, in.world.y) / TEX_SCALE;
  } else {
    uv = vec2<f32>(in.world.x, in.world.y) / TEX_SCALE;
  }

  let albedo = textureSample(tex, sampRepeat, uv).rgb * tint.rgb;
  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
