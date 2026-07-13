// Debug overlay: translucent per-tile quads visualizing a selected agent's
// memory. color id: 0 = known walkable (cyan), 1 = known blocked (red),
// 2 = remembered spot (yellow). (Globals from the shared prelude.)

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) c : f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @location(0) tile : vec2<f32>,
  @location(1) c : f32,
) -> VSOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.06, 0.06), vec2<f32>(0.94, 0.06), vec2<f32>(0.94, 0.94),
    vec2<f32>(0.06, 0.06), vec2<f32>(0.94, 0.94), vec2<f32>(0.06, 0.94),
  );
  let p = tile + corners[vi];
  var out : VSOut;
  out.clip = U.viewProj * vec4<f32>(p.x, 0.045, p.y, 1.0);
  out.c = c;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var col = vec4<f32>(0.0, 0.55, 0.9, 0.22);
  if (in.c > 1.5) { col = vec4<f32>(0.95, 0.8, 0.1, 0.5); }
  else if (in.c > 0.5) { col = vec4<f32>(0.9, 0.15, 0.1, 0.3); }
  return vec4<f32>(toSRGB(col.rgb) * col.a, col.a); // premultiplied
}
