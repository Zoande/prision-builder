// People: box-doll agents (prisoner / guard / cook), one draw per kind,
// fully instanced. Each vertex carries a part id (0..7 prisoner palette,
// +8 guard, +16 cook):
//   0 skin, 1 hair/cap/chef hat, 2 torso, 3 arms, 4 legs, 5 shoes, 6 baton.
// Instances are live agents: continuous position, radian heading, pose and a
// walk cycle (phase/amp) driven by the sim. Poses: 0 stand, 2 sit (legs
// forward, body dropped to bench height), 3 lie on bed, 4 lie on the floor.
// The baton part collapses to a point unless the instance's flag is set.
// (Globals/helpers come from the shared prelude.)

const HIP_Y : f32 = 0.85;
const SHOULDER_Y : f32 = 1.38;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) world : vec3<f32>,
  @location(1) part : f32,
};

fn rotZ(p : vec3<f32>, pivotX : f32, pivotY : f32, a : f32) -> vec3<f32> {
  let dx = p.x - pivotX;
  let dy = p.y - pivotY;
  let c = cos(a);
  let s = sin(a);
  return vec3<f32>(pivotX + dx * c - dy * s, pivotY + dx * s + dy * c, p.z);
}

@vertex
fn vs(
  @location(0) pos : vec3<f32>,
  @location(1) part : f32,
  @location(2) posxz : vec2<f32>,  // continuous world position (person centre)
  @location(3) heading : f32,      // radians, 0 = +X
  @location(4) baton : f32,
  @location(5) pose : f32,
  @location(6) phase : f32,        // walk-cycle phase
  @location(7) amp : f32,          // walk amplitude 0..1
  @location(8) flags : f32,        // 1 = cuffed, 2 = carrying a tray (bitwise)
  @location(9) handA : f32,        // item kind in each hand (0 = empty)
  @location(10) handB : f32,
  @location(11) elev : f32,      // height off the ground (a sniper is on a tower)
) -> VSOut {
  let pid = part - floor(part / 16.0) * 16.0;
  let cuffed = (flags - floor(flags / 2.0) * 2.0) > 0.5;
  let carrying = flags > 1.5;
  var p = pos;
  let HIDE = vec3<f32>(0.5, 0.7, 0.5); // collapse a part to a point = invisible

  // Baton hides unless carried; the tray (part 7) hides unless carrying.
  if (pid > 5.5 && pid < 6.5 && baton < 0.5) { p = HIDE; }
  if (pid > 6.5 && pid < 7.5 && !carrying) { p = HIDE; }

  // Held props. Each part belongs to one hand and one item, and only exists if
  // that hand is actually holding that item. Kinds match items.ts:
  // 1 = spoon, 2 = cutters, 3 = book.
  //   8/9   book cover   (hand A / hand B)
  //   10/11 spoon
  //   12/13 cutters
  //   14/15 book pages
  if (pid > 7.5) {
    var hand = handA;
    var want = 3.0;
    if      (pid < 8.5)  { hand = handA; want = 3.0; }
    else if (pid < 9.5)  { hand = handB; want = 3.0; }
    else if (pid < 10.5) { hand = handA; want = 1.0; }
    else if (pid < 11.5) { hand = handB; want = 1.0; }
    else if (pid < 12.5) { hand = handA; want = 2.0; }
    else if (pid < 13.5) { hand = handB; want = 2.0; }
    else if (pid < 14.5) { hand = handA; want = 3.0; }
    else                 { hand = handB; want = 3.0; }
    if (abs(hand - want) > 0.5) { p = HIDE; }
  }

  let isLeg = pid > 3.5 && pid < 5.5; // legs + shoes
  // Held props swing with the arm they're in, so a book tracks the hand.
  let isArm = (pid > 2.5 && pid < 3.5) || pid > 7.5;
  let side = select(1.0, -1.0, pos.z < 0.5);

  if (pose > 4.5) {
    // Climbing: hanging on the fence, rising with phase (= height), arms
    // overhead, legs scrambling.
    if (isArm) { p = rotZ(p, 0.5, SHOULDER_Y, 2.8 * side); }
    if (isLeg) { p = rotZ(p, 0.5, HIP_Y, sin(U.time * 6.0) * 0.3 * side); }
    p.y += phase;
  } else if (pose > 2.5) {
    // Lying (3 = on a bed, 4 = on the floor): height becomes length along +X.
    let restY = select(0.13, 0.48, pose < 3.5);
    p = vec3<f32>(0.12 + pos.y * 0.95, restY + (pos.x - 0.5) * 0.9, pos.z);
  } else if (pose > 1.5) {
    // Sitting: legs swing forward/down, whole body drops to seat height.
    if (isLeg) {
      let r = HIP_Y - p.y;
      p.x = p.x + r * 0.75;
      p.y = HIP_Y - r * 0.55;
    }
    p.y -= 0.35;
  } else {
    // Standing / walking: swing legs and arms, plus a subtle idle sway.
    if (isLeg) {
      p = rotZ(p, 0.5, HIP_Y, sin(phase) * 0.55 * amp * side);
    } else if (isArm) {
      if (cuffed) {
        // Hands pinned together behind the back.
        p = rotZ(p, 0.5, SHOULDER_Y, -0.55);
        p.z = 0.5 + (p.z - 0.5) * 0.55;
      } else if (carrying) {
        // Both arms out front, holding the tray.
        p = rotZ(p, 0.5, SHOULDER_Y, 1.25);
      } else {
        let idle = sin(U.time * 1.7 + phase) * 0.06 * (1.0 - amp);
        p = rotZ(p, 0.5, SHOULDER_Y, -sin(phase) * 0.35 * amp * side + idle * side);
      }
    }
    if (pid < 3.5) {
      p.y += sin(U.time * 2.0 + phase) * 0.012 * (1.0 - amp); // breathing
    }
    p.y += abs(sin(phase)) * 0.035 * amp; // walk bob
  }

  // Face the heading (rotate about the body centre axis).
  let c = cos(heading);
  let s = sin(heading);
  let dx = p.x - 0.5;
  let dz = p.z - 0.5;
  let q = vec3<f32>(dx * c - dz * s, p.y, dx * s + dz * c);

  var out : VSOut;
  out.world = vec3<f32>(posxz.x + q.x, q.y + elev, posxz.y + q.z);
  out.clip = U.viewProj * vec4<f32>(out.world, 1.0);
  out.part = part;
  return out;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  var N = normalize(cross(dpdx(in.world), dpdy(in.world)));
  if (dot(N, U.eye - in.world) < 0.0) { N = -N; }

  var palette = array<vec3<f32>, 80>(
    // prisoner
    vec3<f32>(0.80, 0.58, 0.44), // skin
    vec3<f32>(0.16, 0.12, 0.09), // hair
    vec3<f32>(0.92, 0.36, 0.07), // jumpsuit torso
    vec3<f32>(0.85, 0.33, 0.07), // sleeves
    vec3<f32>(0.80, 0.31, 0.08), // trousers
    vec3<f32>(0.12, 0.11, 0.10), // shoes
    vec3<f32>(0.08, 0.08, 0.10), // baton
    vec3<f32>(0.30, 0.31, 0.34), // tray
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand A)
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand B)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand A)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand B)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand A)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand B)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand A)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand B)
    // guard
    vec3<f32>(0.80, 0.58, 0.44), // skin
    vec3<f32>(0.13, 0.17, 0.30), // cap
    vec3<f32>(0.18, 0.23, 0.40), // shirt
    vec3<f32>(0.16, 0.20, 0.35), // sleeves
    vec3<f32>(0.10, 0.12, 0.18), // trousers
    vec3<f32>(0.06, 0.06, 0.07), // boots
    vec3<f32>(0.08, 0.08, 0.10), // baton
    vec3<f32>(0.30, 0.31, 0.34), // tray
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand A)
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand B)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand A)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand B)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand A)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand B)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand A)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand B)
    // cook
    vec3<f32>(0.80, 0.58, 0.44), // skin
    vec3<f32>(0.90, 0.90, 0.88), // chef hat
    vec3<f32>(0.86, 0.86, 0.84), // tunic
    vec3<f32>(0.80, 0.80, 0.78), // sleeves
    vec3<f32>(0.34, 0.36, 0.40), // trousers
    vec3<f32>(0.14, 0.14, 0.15), // shoes
    vec3<f32>(0.08, 0.08, 0.10), // baton
    vec3<f32>(0.30, 0.31, 0.34), // tray
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand A)
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand B)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand A)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand B)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand A)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand B)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand A)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand B)
    // workman
    vec3<f32>(0.80, 0.58, 0.44), // skin
    vec3<f32>(0.95, 0.75, 0.10), // hard hat
    vec3<f32>(0.42, 0.45, 0.50), // overalls
    vec3<f32>(0.38, 0.41, 0.46), // sleeves
    vec3<f32>(0.26, 0.28, 0.32), // trousers
    vec3<f32>(0.10, 0.10, 0.11), // boots
    vec3<f32>(0.08, 0.08, 0.10), // baton
    vec3<f32>(0.30, 0.31, 0.34), // tray
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand A)
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand B)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand A)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand B)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand A)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand B)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand A)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand B)
    // sniper
    vec3<f32>(0.80, 0.58, 0.44), // skin
    vec3<f32>(0.20, 0.26, 0.16), // olive cap
    vec3<f32>(0.26, 0.32, 0.20), // fatigues
    vec3<f32>(0.23, 0.29, 0.18), // sleeves
    vec3<f32>(0.19, 0.24, 0.15), // trousers
    vec3<f32>(0.10, 0.10, 0.09), // boots
    vec3<f32>(0.06, 0.06, 0.07), // rifle (the "baton" slot)
    vec3<f32>(0.30, 0.31, 0.34), // tray
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand A)
    vec3<f32>(0.42, 0.16, 0.14), // book cover (hand B)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand A)
    vec3<f32>(0.72, 0.75, 0.80), // spoon (hand B)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand A)
    vec3<f32>(0.24, 0.26, 0.30), // cutters (hand B)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand A)
    vec3<f32>(0.88, 0.86, 0.78), // book pages (hand B)
  );
  let albedo = palette[u32(in.part + 0.5)];

  let color = atmosphere(shadeLit(albedo, N, in.world), in.world);
  return vec4<f32>(toSRGB(color), 1.0);
}
