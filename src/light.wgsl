// Light fixtures: floor lamp, wall light and ceiling light. Flat-colored
// metal bodies plus emissive parts that glow regardless of the sun. Instances
// carry an orient (0..3 = quarter turns) so wall lights face their open side.
// part: 0 = metal, 1 = warm emissive, 2 = cool emissive.
// (Globals/helpers come from the shared prelude.)

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) part : f32,
};

@vertex
fn vs(
  @location(0) pos : vec3<f32>,
  @location(1) part : f32,
  @location(2) tile : vec2<f32>,
  @location(3) orient : f32,
) -> VSOut {
  // Rotate around the tile centre in quarter turns.
  let dx = pos.x - 0.5;
  let dz = pos.z - 0.5;
  var q = pos;
  if (orient > 2.5) { q.x = 0.5 + dz; q.z = 0.5 - dx; }
  else if (orient > 1.5) { q.x = 0.5 - dx; q.z = 0.5 - dz; }
  else if (orient > 0.5) { q.x = 0.5 - dz; q.z = 0.5 + dx; }

  var out : VSOut;
  out.world = q + vec3<f32>(tile.x, 0.0, tile.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  out.part = part;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var N = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(N, U.eye - in.world) < 0.0) { N = -N; }

  // Sampled unconditionally (uniform control flow), selected per part.
  var color = shadeLit(vec3<f32>(0.30, 0.31, 0.34), N, in.world); // metal body
  if (in.part > 1.5) {
    color = vec3<f32>(1.10, 1.16, 1.28); // cool fluorescent panel
  } else if (in.part > 0.5) {
    color = vec3<f32>(1.35, 1.02, 0.58); // warm bulb glow
  }
  return vec4<f32>(toSRGB(atmosphere(color, in.world)), 1.0);
}
