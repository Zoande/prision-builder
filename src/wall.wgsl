// Walls: one instanced extruded block per wall tile, with a chamfered top.
// Each vertex carries inset selectors; per-instance exposure flags decide how
// far the top edges pull inward. Exposed edges get a 45° bevel; edges shared
// with a neighbouring wall stay flush (no grooves), and convex corners cut.
// Normals are derived per-face from screen-space derivatives, so the faceted
// chamfer lights correctly without any per-vertex normal bookkeeping.
// (Globals/helpers come from the shared prelude.)

// WALL_H, WALL_BEVEL come from the shared prelude.
const TEX_SCALE : f32 = 3.0;

@group(0) @binding(1) var sampRepeat : sampler;
@group(0) @binding(2) var wallCol : texture_2d<f32>;
@group(0) @binding(3) var wallNrm : texture_2d<f32>;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
};

@vertex
fn vs(
  @location(0) pos    : vec3<f32>,  // base corner (insets not yet applied)
  @location(1) inset  : vec4<f32>,  // does this vertex ride the N,S,E,W top edge?
  @location(2) tile   : vec2<f32>,  // instance tile coords
  @location(3) expose : vec4<f32>,  // per-side exposure (N,S,E,W) 1=open
) -> VSOut {
  // Apply the bevel only where the vertex is a top-edge vertex AND that side is
  // exposed. N pushes +z, S pushes -z, E pushes -x, W pushes +x.
  var p = pos;
  p.z += inset.x * expose.x * WALL_BEVEL;
  p.z -= inset.y * expose.y * WALL_BEVEL;
  p.x -= inset.z * expose.z * WALL_BEVEL;
  p.x += inset.w * expose.w * WALL_BEVEL;

  var out : VSOut;
  out.world = p + vec3<f32>(tile.x, 0.0, tile.y);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  // Flat per-face normal from derivatives, oriented toward the camera.
  var Ng = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(Ng, U.eye - in.world) < 0.0) { Ng = -Ng; }

  // Triplanar uv plus the matching tangent frame (T along u, B along v),
  // so the normal map can perturb the flat face normal.
  let an = abs(Ng);
  var uv : vec2<f32>;
  var T : vec3<f32>;
  var B : vec3<f32>;
  if (an.y > 0.5) {
    uv = in.world.xz / TEX_SCALE;                        // top / bevel-ish
    T = vec3<f32>(1.0, 0.0, 0.0); B = vec3<f32>(0.0, 0.0, 1.0);
  } else if (an.x > an.z) {
    uv = vec2<f32>(in.world.z, in.world.y) / TEX_SCALE;  // east/west faces
    T = vec3<f32>(0.0, 0.0, 1.0); B = vec3<f32>(0.0, 1.0, 0.0);
  } else {
    uv = vec2<f32>(in.world.x, in.world.y) / TEX_SCALE;  // north/south faces
    T = vec3<f32>(1.0, 0.0, 0.0); B = vec3<f32>(0.0, 1.0, 0.0);
  }

  let tn = textureSample(wallNrm, sampRepeat, uv).rgb * 2.0 - 1.0;
  let N = normalize(T * tn.x * 0.9 + B * tn.y * 0.9 + Ng * max(tn.z, 0.35));

  let albedo = textureSample(wallCol, sampRepeat, uv).rgb;

  // Subtle contact shadow toward the base of the side faces.
  var ao = 1.0;
  if (an.y < 0.5) {
    ao = mix(0.55, 1.0, clamp(in.world.y / WALL_H, 0.0, 1.0));
  }

  let color = atmosphere(shadeLit(albedo, N, in.world) * ao, in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
