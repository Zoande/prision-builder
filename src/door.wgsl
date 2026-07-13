// Door: an instanced wood leaf plus a black handle, set in a wall opening.
// One mesh is authored for the X orientation; instances with orient=1 are
// rotated 90° by swapping local X/Z so the leaf aligns with a Z-running wall.
// The same shader draws both the leaf (wood texture) and the handle (black).
// (Globals/helpers/consts come from the shared prelude.)

const TEX_SCALE : f32 = 2.6;

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(
  @location(0) pos : vec3<f32>,
  @location(2) tile : vec2<f32>,
  @location(3) orient : f32,
  @location(4) open : f32,
) -> VSOut {
  var p = pos;
  if (open > 0.5) {
    // Swing the leaf 90° on its hinge (jail doors when unlocked).
    let dx = p.x - 0.08;
    let dz = p.z - 0.5;
    p.x = 0.08 - dz;
    p.z = 0.5 + dx;
  }
  if (orient > 0.5) { p = vec3<f32>(p.z, p.y, p.x); } // rotate into a Z-running wall
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
    uv = vec2<f32>(in.world.z, in.world.y) / TEX_SCALE; // vertical grain
  } else {
    uv = vec2<f32>(in.world.x, in.world.y) / TEX_SCALE; // vertical grain
  }

  let albedo = textureSample(tex, sampRepeat, uv).rgb;
  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
