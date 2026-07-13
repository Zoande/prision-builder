// Room borders: thin colored strips just inside each room's edge, colored by
// access — staff yellow, prisoners orange, forbidden red. Instances are
// (tile, edgeDir 0..3 = +X,-X,+Z,-Z, access). (Globals from the prelude.)

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) acc : f32,
};

@vertex
fn vs(
  @builtin(vertex_index) vi : u32,
  @location(0) tile : vec2<f32>,
  @location(1) dir : f32,
  @location(2) acc : f32,
) -> VSOut {
  // Strip 0.08 wide along the tile edge given by dir.
  var lo = vec2<f32>(0.0, 0.0);
  var hi = vec2<f32>(1.0, 1.0);
  if (dir < 0.5) { lo.x = 0.92; }        // +X edge
  else if (dir < 1.5) { hi.x = 0.08; }   // -X edge
  else if (dir < 2.5) { lo.y = 0.92; }   // +Z edge
  else { hi.y = 0.08; }                  // -Z edge
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(lo.x, lo.y), vec2<f32>(hi.x, lo.y), vec2<f32>(hi.x, hi.y),
    vec2<f32>(lo.x, lo.y), vec2<f32>(hi.x, hi.y), vec2<f32>(lo.x, hi.y),
  );
  let p = tile + corners[vi];
  var out : VSOut;
  out.clip = U.viewProj * vec4<f32>(p.x, 0.05, p.y, 1.0);
  out.acc = acc;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var col = vec3<f32>(0.85, 0.72, 0.10); // staff: yellow
  if (in.acc > 1.5) { col = vec3<f32>(0.85, 0.10, 0.08); }      // forbidden: red
  else if (in.acc > 0.5) { col = vec3<f32>(0.95, 0.45, 0.06); } // prisoners: orange
  let a = 0.85;
  return vec4<f32>(toSRGB(col) * a, a); // premultiplied
}
