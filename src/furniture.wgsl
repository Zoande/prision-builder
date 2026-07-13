// Furniture: instanced flat-colored box assemblies (toilet, shower, drain,
// fence gates, table, benches, cooker). Each vertex carries a palette index;
// index 10 is chain-link mesh (fence gates) cut out with the same diamond
// discard pattern as the fence. Instance orient = 0..3 quarter turns.
// (Globals/helpers come from the shared prelude.)

const LINK_FREQ : f32 = 7.0;
const CHAINLINK_PART : f32 = 10.0;

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
  // Chain-link cutout (derivatives taken in uniform control flow).
  let cq = vec2<f32>(in.world.x + in.world.z, in.world.y) * LINK_FREQ;
  let r = vec2<f32>(cq.x + cq.y, cq.x - cq.y);
  let fw = max(fwidth(r.x), fwidth(r.y));
  let w = clamp(0.08 + 0.3 * fw, 0.08, 0.22);
  let dxl = 0.5 - abs(fract(r.x) - 0.5);
  let dyl = 0.5 - abs(fract(r.y) - 0.5);
  let isLink = abs(in.part - CHAINLINK_PART) < 0.5;
  if (isLink && min(dxl, dyl) > w) { discard; }

  var N = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(N, U.eye - in.world) < 0.0) { N = -N; }

  var palette = array<vec3<f32>, 24>(
    vec3<f32>(0.82, 0.84, 0.88), // 0 ceramic white
    vec3<f32>(0.68, 0.70, 0.74), // 1 ceramic shade
    vec3<f32>(0.50, 0.52, 0.57), // 2 steel
    vec3<f32>(0.28, 0.29, 0.32), // 3 dark metal
    vec3<f32>(0.10, 0.10, 0.11), // 4 near-black
    vec3<f32>(0.95, 0.45, 0.08), // 5 orange accent (open gate)
    vec3<f32>(0.80, 0.12, 0.10), // 6 red accent (guard-only gate)
    vec3<f32>(0.84, 0.84, 0.80), // 7 table white
    vec3<f32>(0.88, 0.88, 0.84), // 8 seat white
    vec3<f32>(0.70, 0.73, 0.78), // 9 chrome
    vec3<f32>(0.38, 0.40, 0.44), // 10 chain-link wire
    vec3<f32>(0.14, 0.14, 0.15), // 11 stove top
    vec3<f32>(0.52, 0.33, 0.14), // 12 food (mash)
    vec3<f32>(0.30, 0.45, 0.16), // 13 food (greens)
    vec3<f32>(0.42, 0.28, 0.16), // 14 wood (shelves, warm furniture)
    vec3<f32>(0.60, 0.36, 0.30), // 15 book spines
    vec3<f32>(0.30, 0.36, 0.44), // 16 upholstery (sofa, armchair)
    vec3<f32>(0.26, 0.17, 0.12), // 17 dark wood
    vec3<f32>(0.22, 0.45, 0.18), // 18 foliage
    vec3<f32>(0.16, 0.17, 0.18), // 19 rubber (mats, bags, treadmill belt)
    vec3<f32>(0.06, 0.08, 0.11), // 20 screen glass
    vec3<f32>(0.09, 0.38, 0.22), // 21 baize (pool table)
    vec3<f32>(0.55, 0.30, 0.22), // 22 terracotta (pots, rugs)
    vec3<f32>(0.72, 0.58, 0.26), // 23 brass (altar)
  );
  let albedo = palette[u32(in.part + 0.5)];

  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
