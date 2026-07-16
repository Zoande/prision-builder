// Translucent per-tile quads. Two jobs, never on screen at once:
//   a selected agent's memory — 0 known walkable (cyan), 1 blocked (red),
//     2 remembered object (yellow)
//   the staff layer — 3 blue beat, 4 purple beat, 5 room with guards posted
// (Globals from the shared prelude.)

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
  if      (in.c > 8.5) { col = vec4<f32>(0.10, 0.86, 0.82, 0.68); } // tunnel entry
  else if (in.c > 7.5) { col = vec4<f32>(0.72, 0.24, 0.95, 0.70); } // conspiracy member
  else if (in.c > 6.5) { col = vec4<f32>(0.95, 0.16, 0.12, 0.68); } // rival/grievance
  else if (in.c > 5.5) { col = vec4<f32>(0.34, 0.88, 0.38, 0.62); } // positive social tie
  else if (in.c > 4.5) { col = vec4<f32>(0.95, 0.75, 0.15, 0.30); } // posted room
  else if (in.c > 3.5) { col = vec4<f32>(0.62, 0.28, 0.92, 0.62); } // purple beat
  else if (in.c > 2.5) { col = vec4<f32>(0.20, 0.45, 0.95, 0.62); } // blue beat
  else if (in.c > 1.5) { col = vec4<f32>(0.95, 0.8, 0.1, 0.5); }   // remembered object
  else if (in.c > 0.5) { col = vec4<f32>(0.9, 0.15, 0.1, 0.3); }  // blocked
  return vec4<f32>(toSRGB(col.rgb) * col.a, col.a); // premultiplied
}
