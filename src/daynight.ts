// Day/night cycle: maps elapsed time to the sun's position and a full set of
// atmosphere colors (light, ambient, sky gradient, fog). Everything the look
// depends on is a keyframe constant here, blended smoothly by sun elevation —
// so day, dusk, night and dawn morph into each other with no popping.

import { vnorm, vscale, type Vec3 } from "./math";

// --- Game clock -------------------------------------------------------------
// One game hour = 30 real seconds at 1x speed; a full day is 12 minutes.
// The sun rises at 6:00 and sets at 18:00.
export const HOUR_SECONDS = 30;
export const DAY_SECONDS_TOTAL = HOUR_SECONDS * 24;
export const SUNRISE = 6;
export const SUNSET = 18;

/** Fractional 24h clock for a world time in seconds. */
export function hourOf(timeSec: number): number {
  return (timeSec / HOUR_SECONDS) % 24;
}

export function dayOf(timeSec: number): number {
  return Math.floor(timeSec / DAY_SECONDS_TOTAL) + 1;
}

export function isNightAt(timeSec: number): boolean {
  const h = hourOf(timeSec);
  return h < SUNRISE || h >= SUNSET;
}

export function clockLabel(timeSec: number): string {
  const h = hourOf(timeSec);
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `Day ${dayOf(timeSec)} — ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// --- Look keyframes (linear color, pre-gamma) ------------------------------
const DAY_SUN: Vec3 = [1.10, 1.02, 0.90];
const DUSK_SUN: Vec3 = [1.15, 0.48, 0.20];
const MOON_LIGHT: Vec3 = [0.10, 0.13, 0.24];

const DAY_AMB_UP: Vec3 = [0.30, 0.34, 0.43];
const DAY_AMB_DN: Vec3 = [0.22, 0.21, 0.185];
const DUSK_AMB_UP: Vec3 = [0.26, 0.19, 0.20];
const NIGHT_AMB_UP: Vec3 = [0.050, 0.065, 0.115];
const NIGHT_AMB_DN: Vec3 = [0.020, 0.024, 0.040];

const DAY_ZENITH: Vec3 = [0.10, 0.26, 0.55];
const DAY_HORIZON: Vec3 = [0.36, 0.50, 0.66];
const DUSK_ZENITH: Vec3 = [0.08, 0.10, 0.22];
const DUSK_HORIZON: Vec3 = [0.78, 0.33, 0.13];
const NIGHT_ZENITH: Vec3 = [0.010, 0.016, 0.042];
const NIGHT_HORIZON: Vec3 = [0.035, 0.050, 0.095];

export interface AtmosphereState {
  sunDir: Vec3; // true sun direction (below the horizon at night)
  lightDir: Vec3; // active light: sun by day, moon by night
  sunColor: Vec3;
  ambDown: Vec3;
  ambUp: Vec3;
  fogColor: Vec3;
  skyHorizon: Vec3;
  skyZenith: Vec3;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Evaluate the atmosphere for a wall-clock time in seconds. */
export function evalAtmosphere(timeSec: number): AtmosphereState {
  // Sun sweeps 0..pi from sunrise (6:00) to sunset (18:00), pi..2pi below
  // the horizon overnight.
  const hr = hourOf(timeSec);
  const ang = hr >= SUNRISE && hr < SUNSET
    ? Math.PI * ((hr - SUNRISE) / (SUNSET - SUNRISE))
    : Math.PI * (1 + ((hr < SUNRISE ? hr + 24 - SUNSET : hr - SUNSET) / (24 - SUNSET + SUNRISE)));
  const sunDir = vnorm([Math.cos(ang), Math.sin(ang) * 0.95, 0.35]);
  const moonDir = vscale(sunDir, -1);
  const h = sunDir[1]; // sun elevation, -1..1

  const dayF = smooth(-0.02, 0.25, h); // how much "full day" we are
  const duskF = Math.exp(-((h / 0.15) ** 2)); // sunrise/sunset glow bump

  const skyZenith = mix3(mix3(NIGHT_ZENITH, DAY_ZENITH, dayF), DUSK_ZENITH, duskF * 0.55);
  const skyHorizon = mix3(mix3(NIGHT_HORIZON, DAY_HORIZON, dayF), DUSK_HORIZON, duskF * 0.80);
  const ambUp = mix3(mix3(NIGHT_AMB_UP, DAY_AMB_UP, dayF), DUSK_AMB_UP, duskF * 0.5);
  const ambDown = mix3(NIGHT_AMB_DN, DAY_AMB_DN, dayF);
  // Fog is exactly the sky's horizon color: hazed-out ground and the skybox
  // meet at the horizon as one continuous surface.
  const fogColor: Vec3 = [skyHorizon[0], skyHorizon[1], skyHorizon[2]];

  // Active light: the sun while it is up, the moon at night. Each fades to
  // zero at the horizon so the handover is invisible.
  let lightDir: Vec3;
  let sunColor: Vec3;
  if (h >= 0) {
    lightDir = sunDir;
    const warm = mix3(DUSK_SUN, DAY_SUN, smooth(0.02, 0.35, h));
    sunColor = vscale(warm, smooth(-0.01, 0.07, h));
  } else {
    lightDir = moonDir;
    sunColor = vscale(MOON_LIGHT, smooth(0.03, 0.16, -h));
  }

  return { sunDir, lightDir, sunColor, ambDown, ambUp, fogColor, skyHorizon, skyZenith };
}
