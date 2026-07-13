// Sky: a fullscreen triangle at the far plane, filling every pixel the scene
// left empty. The gradient colors come from the day/night uniforms; the sun,
// moon, stars and clouds are drawn procedurally from the view ray. Clouds are
// value-noise fbm on a virtual plane, drifting with time and tinted by the
// same sun colors that light the world, so the whole sky moves through dawn,
// day, dusk and night in lockstep with the lighting.
// (Globals/helpers come from the shared prelude.)

const CLOUD_HEIGHT : f32 = 340.0;

struct VSOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) ndc : vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out : VSOut;
  out.clip = vec4<f32>(p[vi], 1.0, 1.0); // z = far plane: only empty pixels pass
  out.ndc = p[vi];
  return out;
}

fn hash21(p : vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(123.34, 456.21));
  q += dot(q, q + vec2<f32>(45.32, 45.32));
  return fract(q.x * q.y);
}

fn vnoise(p : vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p0 : vec2<f32>) -> f32 {
  var p = p0;
  var amp = 0.5;
  var sum = 0.0;
  for (var i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec2<f32>(17.3, 9.1);
    amp *= 0.5;
  }
  return sum;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4<f32> {
  let far = U.invViewProj * vec4<f32>(in.ndc, 1.0, 1.0);
  let dir = normalize(far.xyz / far.w - U.eye);

  let sunD = normalize(U.sunDir);
  let sunH = sunD.y;
  let dayF = smoothstep(-0.06, 0.15, sunH);
  let nightF = 1.0 - smoothstep(-0.16, -0.02, sunH);
  let duskF = exp(-pow(sunH / 0.15, 2.0));

  // Base gradient; below the horizon converge to the exact fog color, so the
  // fully-hazed ground border and the sky beyond it are indistinguishable and
  // the world reads as endless haze, never a floating plane.
  let up = clamp(dir.y, 0.0, 1.0);
  var sky = mix(U.skyHorizon, U.skyZenith, pow(up, 0.55));
  sky = mix(sky, U.fogColor, smoothstep(0.01, -0.10, dir.y));

  // Sun: hot disk, tight halo, and a wide warm glow that swells at dusk.
  let sd = max(dot(dir, sunD), 0.0);
  let sunVis = smoothstep(-0.10, 0.02, sunH);
  let sunTint = mix(vec3<f32>(1.30, 0.45, 0.15), vec3<f32>(1.25, 1.15, 0.95),
                    smoothstep(0.0, 0.30, sunH));
  sky += sunTint * sunVis * (
    pow(sd, 800.0) * 3.0 +
    pow(sd, 90.0) * 0.5 +
    pow(sd, 6.0) * 0.16 * (0.35 + duskF)
  );

  // Moon: opposite the sun, cool disk with a faint halo.
  let md = max(dot(dir, -sunD), 0.0);
  let moonVis = smoothstep(-0.02, 0.10, -sunH);
  let moonCol = vec3<f32>(0.72, 0.78, 0.92);
  sky += moonCol * moonVis * (
    smoothstep(0.99955, 0.99985, md) * 1.6 +
    pow(md, 350.0) * 0.55 +
    pow(md, 20.0) * 0.05
  );

  // Stars: stereographic grid over the upper hemisphere, fading in at night.
  if (dir.y > 0.0 && nightF > 0.001) {
    let su = dir.xz / (1.0 + dir.y) * 34.0;
    let cell = floor(su);
    let f = fract(su);
    let h1 = hash21(cell);
    if (h1 > 0.80) {
      let pos = vec2<f32>(hash21(cell + vec2<f32>(13.7, 91.1)),
                          hash21(cell + vec2<f32>(71.3, 23.9))) * 0.7 + vec2<f32>(0.15, 0.15);
      let d = length(f - pos);
      let bright = (h1 - 0.80) / 0.20;
      let tw = 0.55 + 0.45 * sin(U.time * (1.5 + 5.0 * bright) + h1 * 40.0);
      sky += vec3<f32>(0.75, 0.82, 1.0)
        * smoothstep(0.10, 0.0, d) * bright * tw
        * nightF * smoothstep(0.0, 0.15, dir.y) * 1.4;
    }
  }

  // Clouds: fbm on a plane above the world, drifting slowly, lit by the day
  // and flushed by the dusk tint. They thin out toward the horizon.
  if (dir.y > 0.015) {
    let dist = max(CLOUD_HEIGHT - U.eye.y, 60.0) / max(dir.y, 0.02);
    let cp = (U.eye.xz + dir.xz * dist) * 0.0016
           + vec2<f32>(U.time * 0.0060, U.time * 0.0023);
    let base = fbm(cp);
    let detail = fbm(cp * 3.1 + vec2<f32>(4.7, 8.9));
    let cov = smoothstep(0.52, 0.74, base + detail * 0.18);
    let horizFade = smoothstep(0.015, 0.14, dir.y);
    var cloudCol = mix(vec3<f32>(0.030, 0.038, 0.062), vec3<f32>(0.80, 0.79, 0.77), dayF);
    cloudCol += sunTint * duskF * 0.55 * sunVis; // dusk flush
    cloudCol += moonCol * 0.05 * moonVis;        // faint moonlit rim at night
    let thick = mix(0.72, 1.05, smoothstep(0.45, 0.95, base));
    sky = mix(sky, cloudCol * thick, cov * horizFade * 0.85);
  }

  // Soft-clip only what exceeds 1.0 (the sun's halo) so it rolls off instead
  // of banding, while the base gradient stays untouched and thus identical to
  // the fog color applied to distant geometry — no seam at the horizon.
  sky = sky / (1.0 + 0.15 * max(sky - vec3<f32>(1.0), vec3<f32>(0.0)));
  return vec4<f32>(toSRGB(sky), 1.0);
}
