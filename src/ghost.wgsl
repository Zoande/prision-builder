struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) tone : f32,
};

@vertex
fn vs(
  @location(0) pos : vec3<f32>,
  @location(1) _part : f32,
  @location(2) tile : vec2<f32>,
  @location(3) orient : f32,
  @location(4) tone : f32,
) -> VSOut {
  let dx = pos.x - 0.5;
  let dz = pos.z - 0.5;
  var q = pos;
  if (orient > 2.5) { q.x = 0.5 + dz; q.z = 0.5 - dx; }
  else if (orient > 1.5) { q.x = 0.5 - dx; q.z = 0.5 - dz; }
  else if (orient > 0.5) { q.x = 0.5 - dz; q.z = 0.5 + dx; }
  var out : VSOut;
  out.clip = U.viewProj * vec4<f32>(q + vec3<f32>(tile.x, 0.0, tile.y), 1.0);
  out.tone = tone;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var color = vec3<f32>(0.12, 0.55, 1.0);
  if (in.tone > 0.5) { color = vec3<f32>(1.0, 0.16, 0.12); }
  let alpha = 0.38;
  return vec4<f32>(toSRGB(color) * alpha, alpha);
}
