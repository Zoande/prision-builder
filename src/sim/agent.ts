// What an agent IS: the record, the tuning numbers, and the regime clock.
//
// No behaviour lives here — this is the vocabulary every other sim module
// speaks. If you are looking for what agents DO, see prisoner.ts, guard.ts,
// sniper.ts, staff.ts and the engines they call (needs, useSlots, escape).

import { NEEDS, type NeedName } from "./objects.ts";
import { newInventory, type Inventory } from "./items.ts";
import { rnd } from "./rng.ts";
import { Obj } from "./objects.ts";
import type { PrisonerMind, PrisonerProfile } from "./profiles.ts";

// Pseudo-kinds for the furniture pass: things the sim draws that aren't
// placeable objects.
export const FOOD_KIND = 1000;
export const HOLE_ENTRY_KIND = 1001;
export const HOLE_SURF_KIND = 1002;
export const TRAY_STACK_KIND = 1003; // stocked serving tables
export const TRUCK_KIND = 1004;
export const INTAKE_TRUCK_KIND = 1005;
export const CARGO_KIND = 1006;
export const DRIVER_KIND = 1007;
export const VISITOR_VEHICLE_KIND = 1008;
export const MEDICAL_VEHICLE_KIND = 1009;
export const OUTSIDE_VEHICLE_KIND = 1010;

// --- The regime -------------------------------------------------------------

/** Regime activities, one per hour of the 24h clock. */
export const REG = { Lockup: 0, Free: 1, Eating: 2, Yard: 3, Shower: 4, Sleep: 5, Work: 6, RollCall: 7 } as const;
export const REG_NAMES = ["Lockup", "Free time", "Eating", "Yard", "Shower", "Sleep", "Work", "Roll call"];

export function defaultRegime(): number[] {
  const r = new Array(24).fill(REG.Free);
  for (let h = 0; h < 6; h++) r[h] = REG.Sleep;
  r[6] = REG.Shower;
  r[7] = REG.Eating; r[8] = REG.Eating;
  r[12] = REG.Yard; r[13] = REG.Yard;
  r[9] = REG.Work; r[10] = REG.Work; r[11] = REG.Work;
  r[14] = REG.Work; r[15] = REG.Work; r[16] = REG.Work;
  r[17] = REG.Eating; r[18] = REG.Eating;
  r[21] = REG.Lockup;
  r[20] = REG.RollCall;
  r[22] = REG.Sleep; r[23] = REG.Sleep;
  return r;
}

// --- Tuning -----------------------------------------------------------------

export const SERVING_CAP = 6; // meals a serving table can hold
export const SHOWER_TIME = 10; // seconds under the head

export const VISION_RANGE = 26;
export const VISION_HALF = 0.90;
export const VISION_RAYS = 44;
export const AWARE_R = 2.5;

export const PRISONER_SPEED = 2.1;
export const STAFF_SPEED = 2.5;
export const COOK_TIME = 20;
export const CLIMB_TIME = 8; // seconds per fence line
export const CUT_TIME = 6;
export const DIG_TILE_TIME = 3;
export const CRAWL_SPEED = 3; // tiles/s inside a tunnel
export const REPAIR_TIME = 8;
export const STAKEOUT_TIME = 45;
export const SNIPER_RANGE = 60;   // a tower sees a long way
export const SNIPER_AIM = 1.6;    // seconds to line up the shot
export const SNIPER_RELOAD = 3;
export const KO_TIME = 30;        // seconds face-down before he comes round
export const TOWER_HEIGHT = 3.4;  // where the sniper actually stands
export const MEALS_PER_CUTTER = 3;
export const BOOK_READ_RATE = 1 / 35; // recreation per second, holding a book
export const READ_TIME = 45;
export const SPOONS_TO_DIG = 4;
export const TUNNEL_DRIFT = 0.16; // radians of accumulated error per dug tile
export const ESCAPE_MARGIN = 1;  // entering a map-edge tile completes escape

// Decay is sized against the regime: meals are ~13 game hours (390s) apart
// overnight, so food must last comfortably longer than that.
export const RATES = {
  foodDecay: 1 / 900,
  sleepDecay: 1 / 700,
  outdoorsDecay: 1 / 540,
  comfortDecay: 1 / 350,
  hygieneDecay: 1 / 1080,
  sleepRefill: 1 / 90,
  sleepRefillFloor: 1 / 220,
  outdoorsRefill: 1 / 25,
  comfortRefill: 1 / 30,
  hygieneRefill: 1 / SHOWER_TIME,
};

// How fast each need drains, and how loudly it argues in decide(). Outdoors is
// the odd one out: it refills by BEING outside rather than by using anything,
// so it keeps a bespoke path in needs.ts.
//
//   decay  — per second
//   weight — >1 means it usually wins the argument
export const NEED_TUNING: Record<NeedName, { decay: number; weight: number }> = {
  food: { decay: RATES.foodDecay, weight: 1.3 },
  sleep: { decay: RATES.sleepDecay, weight: 0.55 },
  outdoors: { decay: RATES.outdoorsDecay, weight: 0.7 },
  comfort: { decay: RATES.comfortDecay, weight: 0.6 },
  hygiene: { decay: RATES.hygieneDecay, weight: 0.5 },
  recreation: { decay: 1 / 620, weight: 0.55 },
  exercise: { decay: 1 / 800, weight: 0.5 },
  // Fast and insistent: a full bladder outranks nearly everything.
  bladder: { decay: 1 / 260, weight: 1.5 },
  spirituality: { decay: 1 / 1400, weight: 0.4 },
  social: { decay: 1 / 720, weight: 0.58 },
  family: { decay: 1 / 2200, weight: 0.48 },
  safety: { decay: 1 / 960, weight: 0.8 },
  privacy: { decay: 1 / 1200, weight: 0.48 },
  tobacco: { decay: 1 / 620, weight: 0.65 },
  alcohol: { decay: 1 / 880, weight: 0.65 },
  drugs: { decay: 1 / 760, weight: 0.8 },
};

export function freshNeeds(): Record<NeedName, number> {
  const n = {} as Record<NeedName, number>;
  for (const k of NEEDS) n[k] = 0.6 + rnd() * 0.4;
  n.food = 0.7 + rnd() * 0.3;
  n.sleep = 0.7 + rnd() * 0.3;
  return n;
}

// Remembered tile states. K_DOOR: a jail door — it might be open or locked
// right now, so path through it optimistically and let reality decide there.
export const K_OPEN = 1, K_BLOCKED = 2, K_FENCE = 3, K_CUT = 4, K_DOOR = 5;

// --- Escape -----------------------------------------------------------------

export type Method = "climb" | "cut" | "dig";

export interface EscapePlan {
  method: Method;
  breaches: number[]; // fence tiles to defeat, in route order (climb/cut)
  exitTile: number; // believed exit (frontier past the last known fence)
  needed: number; // fences to breach (sizes the resource budget)
  stage: "prepare" | "execute" | "flee" | "retreat";
  legI: number;
  toiletIdx: number; // dig entry
  watchdog: number;
}

export interface Tunnel {
  owner: number; // agent id (kept even after escape, for repair)
  entry: number; // toilet tile idx
  heading: number; // intended digging direction
  believed: number; // tiles the digger THINKS he has dug
  goal: number; // believed tiles needed to pass the exit
  actualX: number; actualZ: number; // real tunnel head (world coords)
  drift: number; // accumulated heading error
  surfHole: number; // surface hole tile idx, -1 while unsurfaced
  occupied: boolean;
  flagged: boolean; // a guard has seen it
  /** Shared-operation tunnel network, -1 for a legacy/solo tunnel. */
  networkId: number;
}

export interface RepairJob {
  kind: "fence" | "tunnel" | "hole";
  idx: number;
  claimedBy: number;
}

export interface DoorTask {
  idx: number;
  close: boolean;
  claimedBy: number;
}

export interface IssueLabel {
  id: string;
  x: number;
  z: number;
  issue: string;
}

// --- The agent --------------------------------------------------------------

export interface Agent {
  id: number;
  kind: number;
  x: number; z: number;
  heading: number;
  baton: boolean;
  pose: number; phase: number; amp: number;
  path: number[] | null; pathI: number;
  state: string;
  timer: number;
  interact: number;
  aux: number;
  needs: Record<NeedName, number>;
  /** Deterministic identity/traits. Null for staff. */
  profile: PrisonerProfile | null;
  /** Dynamic psychology. Null for staff. */
  mind: PrisonerMind | null;
  known: Map<number, number> | null;
  /** Remembered objects, by kind. A new object type is remembered for free. */
  objMem: Map<number, Set<number>> | null;
  /** Anchor of the object currently being used (a claim on its capacity). */
  useIdx: number;
  /** The seat he means to take when he gets there (the bench by the table). */
  seatIdx: number;
  compliant: boolean; // following this hour's regime activity
  /** Hands (visible) + pockets. */
  inv: Inventory;
  bedIdx: number;
  lastTX: number; lastTZ: number;
  decideT: number;
  // escape
  escapeDesire: number; escapeFeasibility: number;
  desire: number; fear: number; timesCaught: number;
  // rule-breaking
  risk: number; // learned wariness: how risky breaking the rules has proven
  sneaking: boolean; // on a quiet unauthorized need trip (hygiene/outdoors)
  cutterMeals: number; // meals eaten toward fashioning the next cutter
  cuffed: boolean; // newcomers wait handcuffed for a cell assignment
  cellRoom: number; // claimed cell/dorm room id, -1 = none
  speedMul: number;
  /** Physical stolen-key access: 0 none, 1 staff, 2 guard. */
  accessKeys: number;
  /** 0..1 suspicion reduction from a physically carried disguise. */
  disguise: number;
  protectiveCustody: boolean;
  plan: EscapePlan | null;
  tunnel: Tunnel | null;
  tunnelEntry: number;
  tunnelFace: "" | "branch" | "main";
  underground: boolean;
  /** Authoritative shared operation; solo plans are one-member operations. */
  escapeOperationId: number;
  escapeRole: string;
  socialAction: "none" | "talking" | "arguing";
  socialGroup: number;
  planBias: Method | null; // debug/testing hook
  escortedBy: number; // guard id while being marched home
  /** How high above the ground he stands (a sniper is up his tower). */
  elev: number;
  // staff
  /** The tower this sniper mans (its piece anchor), or -1. */
  postIdx: number;
  /** The patrol beat he walks, or -1. */
  routeId: number;
  /** How far along that beat he is, and which way he's going. */
  routeI: number;
  routeDir: number;
  /** The room he is posted to, or -1. */
  postRoom: number;
  cookerIdx: number;
  job: RepairJob | null;
  /** Physical construction claim, separate from urgent security repairs. */
  buildGroup: number;
  buildTarget: number;
  chaseId: number;
  stakeTunnel: Tunnel | null;
}

/** A fresh agent of a kind, at the origin. sync() and manTowers() both use it. */
export function blankAgent(kind: number): Agent {
  const prisoner = kind === Obj.Prisoner;
  return {
    id: 0,
    kind,
    x: 0.5, z: 0.5,
    heading: 0,
    baton: kind === Obj.Guard,
    pose: POSE_STAND, phase: rnd() * 6.28, amp: 0,
    path: null, pathI: 0,
    state: "idle", timer: 0, interact: -1, aux: 0,
    needs: freshNeeds(),
    profile: null,
    mind: null,
    known: prisoner ? new Map() : null,
    objMem: prisoner ? new Map() : null,
    useIdx: -1,
    seatIdx: -1,
    compliant: true,
    inv: newInventory(),
    bedIdx: -1,
    lastTX: -1, lastTZ: -1,
    decideT: rnd(),
    escapeDesire: 0, escapeFeasibility: 0,
    desire: 0, fear: 0, timesCaught: 0,
    risk: 0, sneaking: false,
    cutterMeals: 0,
    cuffed: prisoner,
    cellRoom: -1,
    speedMul: 1,
    accessKeys: 0,
    disguise: 0,
    protectiveCustody: false,
    plan: null, tunnel: null, tunnelEntry: -1, tunnelFace: "", underground: false,
    escapeOperationId: -1, escapeRole: "", socialAction: "none", socialGroup: -1,
    planBias: null,
    escortedBy: -1,
    elev: 0,
    postIdx: -1,
    routeId: -1,
    routeI: 0,
    routeDir: 1,
    postRoom: -1,
    cookerIdx: -1,
    buildGroup: -1,
    buildTarget: -1,
    job: null,
    chaseId: -1,
    stakeTunnel: null,
  };
}

// Poses live in objects.ts (the shaders mirror them); re-exported here so the
// behaviour modules have one place to import agent vocabulary from.
export {
  POSE_STAND, POSE_SIT, POSE_LIE_BED, POSE_LIE_FLOOR, POSE_CLIMB,
} from "./objects.ts";
import { POSE_STAND } from "./objects.ts";
export type { NeedName } from "./objects.ts";
