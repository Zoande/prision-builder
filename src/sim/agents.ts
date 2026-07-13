// Living agents.
//
// Prisoners: needs (food/sleep/outdoors/comfort), personal memory (they only
// know what they've seen through a facing vision cone + awareness ring; walls
// block sight, fences and bars don't), A* over remembered tiles, frontier
// exploration — plus ESCAPE. Escape desire is a slow average of how miserable
// their needs have been; feasibility is whether a plan can be assembled from
// their memory: a route to a "believed exit" (a frontier just past the
// outermost fence THEY know about), crossing known fences by climbing (slow,
// exposed), cutting (1 cutter per fence, 3 meals each) or digging (1 spoon =
// 1 meal = 1 tile; tunnels drift so the surfacing hole may not be where they
// think). Capture teaches — memory only ever grows.
//
// Prisoners break rules differently per need: starving men raid stocked
// serving tables openly (no server needed off-schedule); low hygiene/outdoors
// leads to QUIET trespassing — sneaked showers, slipping out through a
// finished tunnel for air — gated by a learned `risk` memory that grows with
// every close call, bust, and capture, and fades slowly.
//
// Guards: patrol (biased along fences), spot climbers/cutters with the same
// vision rules, escort them to their bed confiscating tools, flag breaches
// for repair, and stake out occupied tunnel holes. Visible misbehavior and
// jail-door tasks interrupt patrol; noisy escape acts trump everything.
//
// Cooks: claim a cooker, cook, stock tables. Workmen: repair flagged breaches
// (cut fences, tunnels, surface holes). Staff know the whole layout.

import { Access, RoomType, World, type Room } from "./world.ts";
import {
  Item, type Inventory, type Stack,
  canHold, canPocket, clearInventory, countItem, hasItem, heldSlots, itemDef,
POCKET_SLOTS,
  newInventory, pocket, removeFromHands, removeItem, seizeContraband, stashAdd,
  stashCount, stashTake, stow, takeInHands,
} from "./items.ts";
import {
  DIRS, NEEDS, Obj, SHELF_KINDS, defOf, kindsServing,
  POSE_STAND, POSE_SIT, POSE_LIE_FLOOR, POSE_CLIMB,
  type NeedName,
} from "./objects.ts";

export { POSE_STAND, POSE_SIT, POSE_LIE_BED, POSE_LIE_FLOOR, POSE_CLIMB } from "./objects.ts";
export type { NeedName } from "./objects.ts";

export const FOOD_KIND = 1000; // pseudo-kinds for the furniture pass
export const HOLE_ENTRY_KIND = 1001;
export const HOLE_SURF_KIND = 1002;
export const TRAY_STACK_KIND = 1003; // stocked serving tables

// Regime activities, one per hour of the 24h clock.
export const REG = { Lockup: 0, Free: 1, Eating: 2, Yard: 3, Shower: 4, Sleep: 5 } as const;
export const REG_NAMES = ["Lockup", "Free time", "Eating", "Yard", "Shower", "Sleep"];

export function defaultRegime(): number[] {
  const r = new Array(24).fill(REG.Free);
  for (let h = 0; h < 6; h++) r[h] = REG.Sleep;
  r[6] = REG.Shower;
  r[7] = REG.Eating; r[8] = REG.Eating;
  r[12] = REG.Yard; r[13] = REG.Yard;
  r[17] = REG.Eating; r[18] = REG.Eating;
  r[21] = REG.Lockup;
  r[22] = REG.Sleep; r[23] = REG.Sleep;
  return r;
}

const SERVING_CAP = 6; // meals a serving table can hold
const SHOWER_TIME = 10; // seconds under the head

const VISION_RANGE = 26;
const VISION_HALF = 0.90;
const VISION_RAYS = 44;
const AWARE_R = 2.5;

const PRISONER_SPEED = 2.1;
const STAFF_SPEED = 2.5;
const COOK_TIME = 20;
const CLIMB_TIME = 8; // seconds per fence line
const CUT_TIME = 6;
const DIG_TILE_TIME = 3;
const CRAWL_SPEED = 3; // tiles/s inside a tunnel
const REPAIR_TIME = 8;
const STAKEOUT_TIME = 45;
const SNIPER_RANGE = 60;   // a tower sees a long way
const SNIPER_AIM = 1.6;    // seconds to line up the shot
const SNIPER_RELOAD = 3;
const KO_TIME = 30;        // seconds face-down before he comes round
const TOWER_HEIGHT = 3.4;  // where the sniper actually stands
const MEALS_PER_CUTTER = 3;
const BOOK_READ_RATE = 1 / 35; // recreation per second, while holding a book
const READ_TIME = 45;
const SPOONS_TO_DIG = 4;
const TUNNEL_DRIFT = 0.16; // radians of accumulated error per dug tile
const ESCAPE_MARGIN = 26; // this close to the playable edge = swallowed by fog

// Decay is sized against the regime: meals are ~13 game hours (390s) apart
// overnight, so food must last comfortably longer than that.
const RATES = {
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

// The needs that decay on their own and are met by walking to an object with a
// matching use-slot. Outdoors is not here: it refills by *being* outside, not by
// using anything, so it keeps its bespoke handling below.
//
//   decay  — per second
//   weight — how loudly it argues in decide(); >1 means it usually wins
const NEED_TUNING: Record<NeedName, { decay: number; weight: number }> = {
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
};


function freshNeeds(): Record<NeedName, number> {
  const n = {} as Record<NeedName, number>;
  for (const k of NEEDS) n[k] = 0.6 + Math.random() * 0.4;
  n.food = 0.7 + Math.random() * 0.3;
  n.sleep = 0.7 + Math.random() * 0.3;
  return n;
}

// Memory tile states. K_DOOR: a jail door — might be open or locked right
// now, so path through it optimistically and let reality decide at the door.
const K_OPEN = 1, K_BLOCKED = 2, K_FENCE = 3, K_CUT = 4, K_DOOR = 5;

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
}

interface RepairJob { kind: "fence" | "tunnel" | "hole"; idx: number; claimedBy: number }

export interface IssueLabel {
  id: string;
  x: number;
  z: number;
  issue: string;
}

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
  known: Map<number, number> | null;
  /** Remembered objects, by kind. Replaces the old per-kind Sets, so a new
   *  object type is remembered without touching this file at all. */
  objMem: Map<number, Set<number>> | null;
  /** Anchor of the object currently being used (a claim on its capacity). */
  useIdx: number;
  /** The seat he means to take when he gets there (the bench by the table). */
  seatIdx: number;
  compliant: boolean; // following this hour's regime activity
  /** Hands (visible) + pockets. Replaces the old carrying/cutters/spoons ints. */
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
  plan: EscapePlan | null;
  tunnel: Tunnel | null;
  underground: boolean;
  planBias: Method | null; // debug/testing hook
  escortedBy: number; // guard id while being marched home
  /** How high above the ground he stands (a sniper is up his tower). */
  elev: number;
  // staff
  /** The tower this sniper mans (its piece anchor), or -1. */
  postIdx: number;
  cookerIdx: number;
  job: RepairJob | null;
  chaseId: number;
  stakeTunnel: Tunnel | null;
}

// --- Small helpers ----------------------------------------------------------

function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function passable(world: World, i: number, staff: boolean): boolean {
  const k = world.objKind[i];
  if (defOf(k)?.walkable) return true;
  // The two conditional cases the registry can't state as a flag.
  if (k === Obj.FenceJailDoor) return staff;
  // Open jail doors let prisoners through; closed ones are staff-only.
  if (k === Obj.JailDoor) return staff || !world.jailClosed[i];
  return false;
}

/** May a prisoner BE here under the access rules? (Escapes ignore this.)
 *  Doors and gates are connectors between rooms — always crossable; whether
 *  they're physically passable is a separate check. */
function prisonerAllowed(world: World, i: number): boolean {
  const k = world.objKind[i];
  if (k === Obj.Door || k === Obj.JailDoor || k === Obj.FenceDoor || k === Obj.CutFence) return true;
  return world.accessAt(i) === Access.Prisoners;
}

function sightBlocks(world: World, i: number): boolean {
  return defOf(world.objKind[i])?.blocksSight ?? false;
}

function isFenceKind(k: number): boolean {
  return k === Obj.Fence || k === Obj.FenceJailDoor;
}

function astar(
  size: number, start: number, goal: number,
  open: (i: number) => boolean, maxNodes = 30000,
): number[] | null {
  if (start === goal) return [start];
  const gx = goal % size, gz = (goal / size) | 0;
  const h = (i: number) => Math.abs((i % size) - gx) + Math.abs(((i / size) | 0) - gz);
  const g = new Map<number, number>([[start, 0]]);
  const from = new Map<number, number>();
  const heap: number[] = [h(start), start];
  const push = (f: number, i: number) => {
    heap.push(f, i);
    let c = heap.length / 2 - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p * 2] <= heap[c * 2]) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[p * 2 + k]; heap[p * 2 + k] = heap[c * 2 + k]; heap[c * 2 + k] = t;
      }
      c = p;
    }
  };
  const pop = (): number => {
    const i = heap[1];
    const n = heap.length / 2 - 1;
    heap[0] = heap[n * 2]; heap[1] = heap[n * 2 + 1];
    heap.length = n * 2;
    let c = 0;
    for (;;) {
      const l = c * 2 + 1, r = l + 1;
      let m = c;
      if (l < heap.length / 2 && heap[l * 2] < heap[m * 2]) m = l;
      if (r < heap.length / 2 && heap[r * 2] < heap[m * 2]) m = r;
      if (m === c) break;
      for (let k = 0; k < 2; k++) {
        const t = heap[m * 2 + k]; heap[m * 2 + k] = heap[c * 2 + k]; heap[c * 2 + k] = t;
      }
      c = m;
    }
    return i;
  };
  let pops = 0;
  while (heap.length > 0 && pops++ < maxNodes) {
    const cur = pop();
    if (cur === goal) {
      const path = [cur];
      let p = cur;
      while (from.has(p)) { p = from.get(p)!; path.push(p); }
      return path.reverse();
    }
    const cx = cur % size, cz = (cur / size) | 0;
    const gc = g.get(cur)!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const ni = nz * size + nx;
      if (!open(ni)) continue;
      const ng = gc + 1;
      if (ng >= (g.get(ni) ?? Infinity)) continue;
      g.set(ni, ng); from.set(ni, cur);
      push(ng + h(ni), ni);
    }
  }
  return null;
}

function bfsFind(
  size: number, start: number,
  open: (i: number) => boolean, want: (i: number) => boolean,
  limit = 20000,
): number {
  if (want(start)) return start;
  const seen = new Set<number>([start]);
  const q = [start];
  for (let qi = 0; qi < q.length && qi < limit; qi++) {
    const cur = q[qi];
    const cx = cur % size, cz = (cur / size) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const ni = nz * size + nx;
      if (seen.has(ni)) continue;
      seen.add(ni);
      if (want(ni)) return ni;
      if (open(ni)) q.push(ni);
    }
  }
  return -1;
}

// --- The simulation ---------------------------------------------------------

export class Agents {
  readonly agents: Agent[] = [];
  private nextId = 1;
  private claimedBeds = new Map<number, number>();
  private claimedCookers = new Map<number, number>();
  /** Use-slot occupancy: object anchor -> the agents using it right now. */
  private useClaims = new Map<number, Set<number>>();
  /** What each prisoner has hidden under his bunk, keyed by bed anchor. A guard
   *  who catches him only takes what's on him — the stash is why hiding pays. */
  readonly stashes = new Map<number, Stack[]>();
  readonly mealTables = new Set<number>();
  readonly tunnels: Tunnel[] = [];
  readonly cutFences = new Set<number>(); // cut fence tiles (world holds truth)
  private flaggedCuts = new Set<number>();
  private flaggedHoles = new Set<number>(); // surface hole tiles flagged
  readonly repairJobs: RepairJob[] = [];
  readonly doorTasks: { idx: number; close: boolean; claimedBy: number }[] = [];
  readonly regime: number[] = defaultRegime();
  readonly servingStock = new Map<number, number>(); // serving table -> meals
  private servers = new Map<number, number>(); // serving table -> manning cook id
  private curHour = -1;
  private curActivity: number = REG.Free;
  private evictT = 0;
  escapedCount = 0;
  caughtCount = 0;
  private mealsDirty = false; // any tray/hole render change
  private worldDirty = false; // sim mutated world tiles (cut/repair)

  takeMealsDirty(): boolean { const d = this.mealsDirty; this.mealsDirty = false; return d; }
  takeWorldDirty(): boolean { const d = this.worldDirty; this.worldDirty = false; return d; }

  /** A fresh agent of a kind, at the origin. sync() and manTowers() both use it. */
  private blankAgent(kind: number): Agent {
    const prisoner = kind === Obj.Prisoner;
    return {
      id: 0,
      kind,
      x: 0.5, z: 0.5,
      heading: 0,
      baton: kind === Obj.Guard,
      pose: POSE_STAND, phase: Math.random() * 6.28, amp: 0,
      path: null, pathI: 0,
      state: "idle", timer: 0, interact: -1, aux: 0,
      needs: freshNeeds(),
      known: prisoner ? new Map() : null,
      objMem: prisoner ? new Map() : null,
      useIdx: -1,
      seatIdx: -1,
      compliant: true,
      inv: newInventory(),
      bedIdx: -1,
      lastTX: -1, lastTZ: -1,
      decideT: Math.random(),
      escapeDesire: 0, escapeFeasibility: 0,
      desire: 0, fear: 0, timesCaught: 0,
      risk: 0, sneaking: false,
      cutterMeals: 0,
      cuffed: prisoner,
      cellRoom: -1,
      speedMul: 1,
      plan: null, tunnel: null, underground: false,
      planBias: null,
      escortedBy: -1,
      elev: 0,
      postIdx: -1,
      cookerIdx: -1,
      job: null,
      chaseId: -1,
      stakeTunnel: null,
    };
  }

  sync(world: World) {
    for (const kind of [Obj.Prisoner, Obj.Guard, Obj.Cook, Obj.Workman]) {
      for (const i of world.tilesOfKind(kind)) {
        const x = i % world.size, z = (i / world.size) | 0;
        const orient = world.objOrient[i];
        const baton = world.objMat[i] === 1;
        world.objKind[i] = Obj.None;
        world.objMat[i] = 0;
        this.agents.push({
          ...this.blankAgent(kind),
          id: this.nextId++,
          x: x + 0.5, z: z + 0.5,
          heading: [0, Math.PI / 2, Math.PI, -Math.PI / 2][orient & 3],
          baton,
        });
      }
    }
  }

  eraseAt(x: number, z: number) {
    for (let n = this.agents.length - 1; n >= 0; n--) {
      const ag = this.agents[n];
      if (!ag.underground && Math.floor(ag.x) === x && Math.floor(ag.z) === z) {
        this.removeAgent(ag);
      }
    }
  }

  private removeAgent(ag: Agent) {
    if (ag.bedIdx >= 0) this.claimedBeds.delete(ag.bedIdx);
    if (ag.cookerIdx >= 0) this.claimedCookers.delete(ag.cookerIdx);
    this.releaseUse(ag);
    if (ag.tunnel) ag.tunnel.occupied = false;
    if (ag.job) ag.job.claimedBy = -1;
    for (const [s, id] of this.servers) if (id === ag.id) this.servers.delete(s);
    const n = this.agents.indexOf(ag);
    if (n >= 0) this.agents.splice(n, 1);
  }

  giveBatonAt(x: number, z: number) {
    for (const ag of this.agents) {
      if (Math.floor(ag.x) === x && Math.floor(ag.z) === z) ag.baton = true;
    }
  }

  agentNear(x: number, z: number, r: number): Agent | null {
    let best: Agent | null = null, bd = r * r;
    for (const ag of this.agents) {
      if (ag.underground) continue;
      const d = (ag.x - x) ** 2 + (ag.z - z) ** 2;
      if (d < bd) { bd = d; best = ag; }
    }
    return best;
  }

  currentActivity(): number { return this.curActivity; }

  prisonerCount(): number {
    return this.agents.filter((a) => a.kind === Obj.Prisoner).length;
  }

  /** Does this prisoner's cell contain a shower (in-cell shower = lockup)? */
  cellHasShower(world: World, ag: Agent): boolean {
    const r = world.rooms.get(ag.cellRoom);
    if (!r) return false;
    for (const t of r.tiles) if (world.objKind[t] === Obj.Shower) return true;
    return false;
  }

  update(dt: number, world: World, isNight: boolean, hour: number) {
    // Top of the hour: compliance rolls + door choreography.
    const h = Math.floor(hour) % 24;
    if (h !== this.curHour) {
      this.curHour = h;
      this.curActivity = this.regime[h];
      for (const ag of this.agents) {
        if (ag.kind !== Obj.Prisoner) continue;
        // Misery breeds defiance.
        ag.compliant = Math.random() < Math.max(0.25, 1 - 0.6 * ag.escapeDesire);
      }
      const act = this.curActivity;
      if (act === REG.Free || act === REG.Eating || act === REG.Yard || act === REG.Shower) {
        // Unlock the cells — except cells with in-cell showers at shower time.
        for (const i of world.tilesOfKind(Obj.JailDoor)) {
          if (!world.jailClosed[i] || this.doorTasks.some((t) => t.idx === i)) continue;
          if (act === REG.Shower && this.doorServesShowerCell(world, i)) continue;
          this.doorTasks.push({ idx: i, close: false, claimedBy: -1 });
        }
      }
      // Manning assignments reset each hour.
      this.servers.clear();
      for (const ag of this.agents) {
        if (ag.kind === Obj.Cook && ag.state === "manning") ag.state = "idle";
      }
    }

    // Cell claims must stay valid (room deleted / requirements broken).
    this.evictT -= dt;
    if (this.evictT <= 0) {
      this.evictT = 2;
      for (const ag of this.agents) {
        if (ag.cellRoom < 0) continue;
        const r = world.rooms.get(ag.cellRoom);
        if (!r || !r.valid || (r.type !== RoomType.Cell && r.type !== RoomType.Dorm)) {
          ag.cellRoom = -1;
          if (ag.bedIdx >= 0) { this.claimedBeds.delete(ag.bedIdx); ag.bedIdx = -1; }
        }
      }
    }

    this.manTowers(world);

    for (let n = this.agents.length - 1; n >= 0; n--) {
      const ag = this.agents[n];
      if (ag.kind === Obj.Prisoner) this.updatePrisoner(ag, dt, world, isNight);
      else if (ag.kind === Obj.Cook) this.updateCook(ag, dt, world);
      else if (ag.kind === Obj.Guard) this.updateGuard(ag, dt, world);
      else if (ag.kind === Obj.Sniper) this.updateSniper(ag, dt, world);
      else this.updateWorkman(ag, dt, world);
    }
  }

  /** Is this jail door on the boundary of a shower-equipped cell/dorm? */
  private doorServesShowerCell(world: World, door: number): boolean {
    const size = world.size;
    const x = door % size, z = (door / size) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!world.inBounds(x + dx, z + dz)) continue;
      const r = world.rooms.get(world.roomId[world.idx(x + dx, z + dz)]);
      if (!r || !r.valid || (r.type !== RoomType.Cell && r.type !== RoomType.Dorm)) continue;
      for (const t of r.tiles) if (world.objKind[t] === Obj.Shower) return true;
    }
    return false;
  }

  // --- Vision / memory ------------------------------------------------------

  private record(ag: Agent, world: World, i: number) {
    const k = world.objKind[i];
    let v = K_BLOCKED;
    if (isFenceKind(k)) v = K_FENCE;
    else if (k === Obj.CutFence) v = K_CUT;
    else if (k === Obj.JailDoor) v = K_DOOR;
    else if (passable(world, i, false)) v = K_OPEN;
    ag.known!.set(i, v);

    // Objects are remembered straight off the registry. Beds and use-slot
    // objects are remembered by anchor (a bed claim and a use claim are both
    // keyed by it); benches and tables by tile, because a diner sits on the
    // tile he reached, not on the anchor.
    const def = defOf(k);
    if (!def || !def.remember) return;
    const at = def.remember === "anchor" ? world.anchorOf(i) : i;
    this.mem(ag, k).add(at);
  }

  /** An agent's remembered tiles for one object kind. */
  private mem(ag: Agent, kind: number): Set<number> {
    let s = ag.objMem!.get(kind);
    if (!s) ag.objMem!.set(kind, s = new Set());
    return s;
  }

  private look(ag: Agent, world: World) {
    const size = world.size;
    const ax = Math.floor(ag.x), az = Math.floor(ag.z);
    const R = Math.ceil(AWARE_R);
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > AWARE_R * AWARE_R) continue;
        const nx = ax + dx, nz = az + dz;
        if (!world.inBounds(nx, nz)) continue;
        this.record(ag, world, nz * size + nx);
      }
    }
    for (let r = 0; r < VISION_RAYS; r++) {
      const a = ag.heading - VISION_HALF + (2 * VISION_HALF * r) / (VISION_RAYS - 1);
      const dx = Math.cos(a), dz = Math.sin(a);
      let last = -1;
      for (let t = 0.5; t < VISION_RANGE; t += 0.45) {
        const nx = Math.floor(ag.x + dx * t), nz = Math.floor(ag.z + dz * t);
        if (!world.inBounds(nx, nz)) break;
        const i = nz * size + nx;
        if (i === last) continue;
        last = i;
        this.record(ag, world, i);
        if (sightBlocks(world, i)) break;
      }
    }
  }

  /** Line-of-sight visibility check (guards spotting, prisoners sneaking).
   *  `nearR` is the omnidirectional radius — noisy acts (climbing, cutting)
   *  are noticed all around, not just in the facing cone. */
  private canSee(
    ag: Agent, world: World, tx: number, tz: number,
    nearR = AWARE_R, range = ag.kind === Obj.Sniper ? SNIPER_RANGE : VISION_RANGE,
  ): boolean {
    const dx = tx - ag.x, dz = tz - ag.z;
    const d = Math.hypot(dx, dz);
    if (d > range) return false;
    if (d > nearR) {
      let da = Math.atan2(dz, dx) - ag.heading;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > VISION_HALF) return false;
    }
    const size = world.size;
    for (let t = 0.5; t < d - 0.5; t += 0.45) {
      const nx = Math.floor(ag.x + (dx / d) * t), nz = Math.floor(ag.z + (dz / d) * t);
      if (!world.inBounds(nx, nz)) return false;
      if (sightBlocks(world, nz * size + nx)) return false;
    }
    return true;
  }

  // --- Movement ---------------------------------------------------------------

  private followPath(ag: Agent, dt: number, world: World, staff: boolean): boolean {
    if (!ag.path || ag.pathI >= ag.path.length) return true;
    const size = world.size;
    let ti = ag.path[ag.pathI];
    // Tolerate starting from inside furniture (e.g. seated on a bench).
    const cur = Math.floor(ag.z) * size + Math.floor(ag.x);
    if (ti === cur && !passable(world, ti, staff) && ag.pathI + 1 < ag.path.length) {
      ag.pathI++;
      ti = ag.path[ag.pathI];
    }
    if (!passable(world, ti, staff)) {
      if (ag.known) this.record(ag, world, ti);
      ag.path = null;
      return false;
    }
    const tx = (ti % size) + 0.5, tz = ((ti / size) | 0) + 0.5;
    const dx = tx - ag.x, dz = tz - ag.z;
    const d = Math.hypot(dx, dz);
    const speed = (ag.kind === Obj.Prisoner ? PRISONER_SPEED : STAFF_SPEED) * ag.speedMul;
    const step = speed * dt;
    ag.heading = angleLerp(ag.heading, Math.atan2(dz, dx), Math.min(1, dt * 10));
    ag.amp = Math.min(1, ag.amp + dt * 6);
    ag.phase += dt * speed * 4.4;
    if (d <= step) {
      ag.x = tx; ag.z = tz;
      ag.pathI++;
      if (ag.pathI >= ag.path.length) { ag.path = null; return true; }
    } else {
      ag.x += (dx / d) * step;
      ag.z += (dz / d) * step;
    }
    const nx = Math.floor(ag.x), nz = Math.floor(ag.z);
    if (ag.known && (nx !== ag.lastTX || nz !== ag.lastTZ)) {
      ag.lastTX = nx; ag.lastTZ = nz;
      this.look(ag, world);
    }
    return false;
  }

  private knownOpen(ag: Agent) {
    return (i: number) => {
      const v = ag.known!.get(i);
      return v === K_OPEN || v === K_CUT || v === K_DOOR;
    };
  }

  /** Normal-life predicate: remembered walkable AND access allows prisoners.
   *  `trespass` (critical hunger) ignores the access rules, not the walls. */
  private lawfulOpen(ag: Agent, world: World, trespass = false) {
    const open = this.knownOpen(ag);
    if (trespass) return open;
    return (i: number) => open(i) && prisonerAllowed(world, i);
  }

  /** Optimistic pathing for fleeing: unknown tiles are assumed walkable. */
  private fleeOpen(ag: Agent) {
    return (i: number) => {
      const v = ag.known!.get(i);
      return v === undefined || v === K_OPEN || v === K_CUT || v === K_DOOR;
    };
  }

  private pathAdjacent(
    ag: Agent, world: World, target: number,
    open: (i: number) => boolean,
  ): boolean {
    const size = world.size;
    const start = Math.floor(ag.z) * size + Math.floor(ag.x);
    const tx = target % size, tz = (target / size) | 0;
    let best: number[] | null = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = tx + dx, nz = tz + dz;
      if (!world.inBounds(nx, nz)) continue;
      const ni = nz * size + nx;
      if (!open(ni) && ni !== start) continue;
      const p = astar(size, start, ni, open);
      if (p && (!best || p.length < best.length)) best = p;
    }
    if (!best) return false;
    ag.path = best; ag.pathI = 0;
    return true;
  }

  // --- Prisoner --------------------------------------------------------------

  private updatePrisoner(ag: Agent, dt: number, world: World, isNight: boolean) {
    const n = ag.needs;
    // A use claim only lives as long as the using: a guard escort, a lock-up or
    // an erased object all pull him off it, and none of them route through
    // finishUse.
    if (ag.useIdx >= 0 && ag.state !== "using") {
      this.releaseUse(ag);
      ag.pose = POSE_STAND;
    }
    if (ag.seatIdx >= 0 && ag.state !== "toUse") ag.seatIdx = -1;
    for (const need of NEEDS) {
      if (need === "outdoors") continue; // refills by being outside, below
      n[need] = Math.max(0, n[need] - NEED_TUNING[need].decay * dt);
    }
    if (!ag.underground) {
      const here = world.idx(Math.floor(ag.x), Math.floor(ag.z));
      const outside = world.roofed[here] === 0;
      // Yards refill the outdoors need noticeably faster.
      const yard = world.roomTypeAt(here) === RoomType.Yard ? 1.6 : 1.0;
      n.outdoors = outside
        ? Math.min(1, n.outdoors + RATES.outdoorsRefill * yard * dt)
        : Math.max(0, n.outdoors - RATES.outdoorsDecay * dt);
    }

    // Escape desire: slow average of misery; fear (post-capture) suppresses it.
    //
    // Weighted by how much each need matters, so a prison with no chapel isn't
    // punished as hard as one with no food — and bladder is excluded outright,
    // because needing the toilet is not a reason to tunnel out of a prison.
    let sum = 0, total = 0;
    for (const need of NEEDS) {
      if (need === "bladder") continue;
      const w = NEED_TUNING[need].weight;
      sum += n[need] * w; total += w;
    }
    const misery = 1 - sum / total;
    ag.desire += (Math.min(1, misery * 1.6) - ag.desire) * Math.min(1, dt / 45);
    ag.fear = Math.max(0, ag.fear - dt / 150);
    ag.risk = Math.max(0, ag.risk - dt / 900); // wariness fades slowly
    ag.escapeDesire = ag.desire * (1 - ag.fear);

    if (ag.lastTX < 0) { ag.lastTX = Math.floor(ag.x); ag.lastTZ = Math.floor(ag.z); this.look(ag, world); }

    // Being marched home.
    if (ag.state === "escorted") {
      const guard = this.agents.find((a) => a.id === ag.escortedBy);
      if (!guard) { ag.state = ag.cuffed ? "cuffed" : "idle"; ag.escortedBy = -1; return; }
      const dx = guard.x - ag.x, dz = guard.z - ag.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.9) {
        const step = Math.min(d - 0.9, (ag.cuffed ? 1.6 : STAFF_SPEED) * dt);
        ag.x += (dx / d) * step; ag.z += (dz / d) * step;
        ag.heading = angleLerp(ag.heading, Math.atan2(dz, dx), Math.min(1, dt * 10));
        ag.amp = Math.min(1, ag.amp + dt * 6);
        ag.phase += dt * STAFF_SPEED * 4.4;
        // Keep looking while marched — he must know the way back out.
        const nx = Math.floor(ag.x), nz = Math.floor(ag.z);
        if (ag.known && (nx !== ag.lastTX || nz !== ag.lastTZ)) {
          ag.lastTX = nx; ag.lastTZ = nz;
          this.look(ag, world);
        }
      } else ag.amp = Math.max(0, ag.amp - dt * 8);
      return;
    }

    if (ag.underground) { this.updateUnderground(ag, dt, world); return; }

    // Handcuffed newcomers just stand and wait for a guard.
    if (ag.cuffed) {
      ag.amp = Math.max(0, ag.amp - dt * 8);
      ag.state = "cuffed";
      return;
    }

    // Shot with a beanbag round: nothing to decide until he comes round.
    if (ag.state === "knockedOut") {
      ag.amp = 0;
      ag.pose = POSE_LIE_FLOOR;
      ag.timer -= dt;
      if (ag.timer <= 0) {
        ag.pose = POSE_STAND;
        ag.state = "idle";
      }
      return;
    }

    // Timed interaction states.
    switch (ag.state) {
      case "using": {
        this.updateUsing(ag, dt, world, isNight);
        return;
      }
      case "sleepFloor": {
        ag.amp = 0;
        n.sleep = Math.min(1, n.sleep + RATES.sleepRefillFloor * dt);
        if (n.sleep >= 1 || (!isNight && n.sleep > 0.75)) {
          ag.pose = POSE_STAND;
          ag.state = "idle";
        }
        return;
      }
      case "reading": {
        // Nowhere to sit, so he reads on his feet.
        ag.amp = Math.max(0, ag.amp - dt * 8);
        if (!hasItem(ag.inv, Item.Book)) { ag.state = "idle"; return; }
        const mul = world.ambienceMul(world.idx(Math.floor(ag.x), Math.floor(ag.z)));
        n.recreation = Math.min(1, n.recreation + BOOK_READ_RATE * mul * dt);
        ag.timer -= dt;
        if (n.recreation >= 1 || ag.timer <= 0) ag.state = "idle";
        return;
      }
      case "outside": {
        ag.amp = Math.max(0, ag.amp - dt * 8);
        ag.timer -= dt;
        // Sneaked out: keep watch and bail early if a guard shows.
        if (ag.sneaking) {
          ag.decideT -= dt;
          if (ag.decideT <= 0) {
            ag.decideT = 0.5;
            if (this.guardInSight(ag, world)) {
              ag.risk = Math.min(1, ag.risk + 0.15); // close call — remembered
              this.finishOutside(ag, world);
              return;
            }
          }
        }
        if (n.outdoors >= 0.95 || ag.timer <= 0) this.finishOutside(ag, world);
        return;
      }
      case "climbing": {
        ag.amp = 0;
        ag.pose = POSE_CLIMB;
        ag.timer -= dt;
        ag.phase = 3.2 * (1 - Math.max(0, ag.timer) / CLIMB_TIME); // height
        if (ag.timer <= 0) this.finishClimb(ag, world);
        return;
      }
      case "cutting": {
        ag.amp = 0;
        ag.timer -= dt;
        if (ag.timer <= 0) this.finishCut(ag, world);
        return;
      }
      case "sneakWait": {
        ag.amp = Math.max(0, ag.amp - dt * 8);
        ag.timer -= dt;
        if (ag.timer <= 0) this.approachBreach(ag, world); // try again
        return;
      }
      case "queueing": {
        ag.amp = Math.max(0, ag.amp - dt * 8);
        ag.timer -= dt;
        if (ag.timer <= 0) {
          ag.timer = 2;
          // The counter may have been stocked or manned since he sat down here.
          if (this.useable(ag, world, ag.interact, Obj.ServingTable) &&
              this.isNextTo(ag, world, ag.interact)) {
            this.startUse(ag, world);
          } else if (ag.needs.food > 0.6) ag.state = "idle";
        }
        return;
      }
      case "yardTime": {
        if (this.curActivity !== REG.Yard) { ag.state = "idle"; return; }
        ag.amp = Math.max(0, ag.amp - dt * 8);
        ag.timer -= dt;
        if (ag.timer <= 0) {
          // Mill about the yard.
          ag.timer = 3 + Math.random() * 5;
          const size = world.size;
          const x = Math.floor(ag.x), z = Math.floor(ag.z);
          const nx = x + ((Math.random() * 5) | 0) - 2, nz = z + ((Math.random() * 5) | 0) - 2;
          if (world.inBounds(nx, nz)) {
            const ni = world.idx(nx, nz);
            if (world.roomTypeAt(ni) === RoomType.Yard && this.lawfulOpen(ag, world)(ni)) {
              const p = astar(size, world.idx(x, z), ni, this.lawfulOpen(ag, world), 2000);
              if (p) { ag.path = p; ag.pathI = 0; }
            }
          }
        }
        return;
      }
      case "inCell": {
        ag.amp = Math.max(0, ag.amp - dt * 8);
        const act = this.curActivity;
        const showerCell = act === REG.Shower && this.cellHasShower(world, ag);
        if (showerCell) ag.needs.hygiene = Math.min(1, ag.needs.hygiene + RATES.hygieneRefill * dt);
        if (act !== REG.Lockup && !showerCell) ag.state = "idle";
        return;
      }
    }

    // Traveling.
    if (ag.path) {
      const before = ag.path;
      const arrived = this.followPath(ag, dt, world, false);
      if (arrived) this.onArrive(ag, world);
      else if (!ag.path && before) this.onBlocked(ag, world);
      return;
    }

    ag.amp = Math.max(0, ag.amp - dt * 8);

    ag.decideT -= dt;
    if (ag.decideT > 0) return;
    ag.decideT = 0.6 + Math.random() * 0.6;

    // A standing prisoner still has eyes: keep the world model fresh (this
    // is how they notice a jail door opening without walking anywhere).
    this.look(ag, world);

    // Plan lifecycle beats needs unless something is critical.
    if (this.planTick(ag, world, isNight)) return;
    if (this.regimeTick(ag, world)) return;
    this.decide(ag, world, isNight);
  }

  // --- Regime ---------------------------------------------------------------

  private insideOwnCell(ag: Agent, world: World): boolean {
    if (ag.cellRoom < 0) return false;
    return world.roomId[world.idx(Math.floor(ag.x), Math.floor(ag.z))] === ag.cellRoom;
  }

  /** Queue lock-up tasks for the agent's cell doors. */
  private lockCell(ag: Agent, world: World) {
    const room = world.rooms.get(ag.cellRoom);
    if (!room) return;
    for (const d of world.roomJailDoors(room)) {
      if (!world.jailClosed[d] && !this.doorTasks.some((t) => t.idx === d)) {
        this.doorTasks.push({ idx: d, close: true, claimedBy: -1 });
      }
    }
  }

  /** Follow this hour's regime. Returns true if it consumed the decision. */
  private regimeTick(ag: Agent, world: World): boolean {
    const act = this.curActivity;
    if (!ag.compliant || act === REG.Free) return false;
    // Defiance with a purpose: urgent needs break the schedule — but never
    // away from the very activity that would fix them.
    if (act !== REG.Eating && ag.needs.food < 0.15) return false;
    if (act !== REG.Sleep && ag.needs.sleep < 0.12) return false;
    if (act !== REG.Shower && ag.needs.hygiene < 0.05) return false;

    const showerCell = act === REG.Shower && ag.cellRoom >= 0 && this.cellHasShower(world, ag);
    switch (act) {
      case REG.Sleep:
      case REG.Lockup: {
        if (ag.cellRoom < 0 || ag.bedIdx < 0) return false;
        if (this.insideOwnCell(ag, world)) {
          this.lockCell(ag, world);
          if (act === REG.Sleep && this.trySatisfy(ag, world, "sleep")) return true;
          ag.state = "inCell";
          return true;
        }
        if (act === REG.Sleep && this.trySatisfy(ag, world, "sleep")) return true;
        if (this.pathAdjacent(ag, world, ag.bedIdx, this.lawfulOpen(ag, world))) {
          ag.state = "regimeToCell";
          return true;
        }
        return false;
      }
      case REG.Eating: {
        // Mid-meal already (tray in hand, or sat at a table).
        if (hasItem(ag.inv, Item.Tray) || ag.state === "using" || ag.state === "queueing") return true;
        if (ag.needs.food > 0.95) return false; // fed; do as you please
        return this.trySatisfy(ag, world, "food");
      }
      case REG.Yard: {
        const size = world.size;
        const here = world.idx(Math.floor(ag.x), Math.floor(ag.z));
        if (world.roomTypeAt(here) === RoomType.Yard) {
          ag.state = "yardTime";
          ag.timer = 0;
          return true;
        }
        const open = this.lawfulOpen(ag, world);
        const spot = bfsFind(size, here, open, (i) =>
          open(i) && world.roomTypeAt(i) === RoomType.Yard);
        if (spot < 0) return false;
        const path = astar(size, here, spot, open);
        if (!path) return false;
        ag.path = path; ag.pathI = 0;
        ag.state = "toYard";
        return true;
      }
      case REG.Shower: {
        if (ag.needs.hygiene >= 0.98) return false;
        if (showerCell) {
          if (this.insideOwnCell(ag, world)) {
            this.lockCell(ag, world);
            ag.state = "inCell";
            return true;
          }
          if (ag.bedIdx >= 0 && this.pathAdjacent(ag, world, ag.bedIdx, this.lawfulOpen(ag, world))) {
            ag.state = "regimeToCell";
            return true;
          }
          return false;
        }
        return this.trySatisfy(ag, world, "hygiene");
      }
    }
    return false;
  }

  private stepOff(ag: Agent, world: World) {
    const size = world.size;
    const x = Math.floor(ag.x), z = Math.floor(ag.z);
    for (const [dx, dz] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      const nx = x + dx, nz = z + dz;
      if (!world.inBounds(nx, nz)) continue;
      if (passable(world, nz * size + nx, false)) {
        ag.x = nx + 0.5; ag.z = nz + 0.5;
        return;
      }
    }
  }

  private onArrive(ag: Agent, world: World) {
    switch (ag.state) {
      case "toQueue": {
        // Reached the counter: use it if he can, otherwise wait his turn.
        if (this.useable(ag, world, ag.interact, Obj.ServingTable)) this.startUse(ag, world);
        else { ag.state = "queueing"; ag.timer = 2; }
        return;
      }
      case "toShelf": {
        // Put the book back where it came from.
        removeItem(ag.inv, Item.Book);
        ag.state = "idle";
        return;
      }
      case "toStash": {
        this.doStash(ag);
        ag.state = "idle";
        return;
      }
      case "toRetrieve": {
        this.doRetrieve(ag, ag.aux);
        ag.state = "idle";
        return;
      }
      case "toOutside": {
        ag.state = "outside";
        ag.timer = 30;
        return;
      }
      case "toUse": {
        this.startUse(ag, world);
        return;
      }
      case "toBreach": {
        this.startBreach(ag, world);
        return;
      }
      case "toYard": {
        ag.state = "yardTime";
        ag.timer = 0;
        return;
      }
      case "regimeToCell": {
        ag.state = this.insideOwnCell(ag, world) ? "inCell" : "idle";
        if (ag.state === "inCell") this.lockCell(ag, world);
        return;
      }
      case "toTunnel": {
        this.enterTunnel(ag, world);
        return;
      }
      case "toTrip": {
        // Down the toilet hole for an unauthorized breather.
        const t = ag.tunnel;
        if (!t || !this.tunnels.includes(t) || t.occupied || t.surfHole < 0 ||
            world.objKind[t.entry] !== Obj.Toilet || !this.isNextTo(ag, world, t.entry)) {
          if (t && !this.tunnels.includes(t)) ag.tunnel = null;
          ag.sneaking = false;
          ag.state = "idle";
          return;
        }
        t.occupied = true;
        ag.underground = true;
        ag.state = "crawlingOut";
        ag.timer = t.believed / CRAWL_SPEED;
        return;
      }
      case "fleeing": {
        this.fleeStep(ag, world); // reached the leg target: keep going
        return;
      }
      case "retreating": {
        if (ag.plan) { ag.plan = null; }
        ag.fear = Math.min(1, ag.fear + 0.35);
        ag.state = "idle";
        return;
      }
      default:
        ag.state = "idle";
    }
  }

  /** A path step turned out blocked (world changed / optimistic flee guess). */
  private onBlocked(ag: Agent, world: World) {
    if (ag.state === "fleeing" && ag.plan) {
      // Something new in the way — maybe a fence we didn't know. Replan.
      this.look(ag, world);
      this.replanOrRetreat(ag, world);
      return;
    }
    // Walked into a shut jail door mid-errand: if he's desperate for air and
    // owns a finished tunnel, there is a secret way out of the cell.
    ag.sneaking = false;
    if (ag.kind === Obj.Prisoner && this.tryTunnelTrip(ag, world)) return;
    ag.state = "idle";
  }

  private isNextTo(ag: Agent, world: World, tile: number): boolean {
    const size = world.size;
    const x = Math.floor(ag.x), z = Math.floor(ag.z);
    const tx = tile % size, tz = (tile / size) | 0;
    return Math.abs(x - tx) + Math.abs(z - tz) <= 1;
  }

  // --- Needs ----------------------------------------------------------------

  private decide(ag: Agent, world: World, isNight: boolean) {
    const n = ag.needs;
    const gathering = ag.plan?.stage === "prepare" &&
      (ag.plan.method === "cut" || ag.plan.method === "dig");

    // Housekeeping first. A finished book goes back on the shelf, and anything
    // incriminating in his hands goes under the bunk before a guard sees it.
    if (hasItem(ag.inv, Item.Book) && n.recreation > 0.95 &&
        this.returnBook(ag, world)) return;
    if (this.tryStashTrip(ag, world)) return;

    // Each need argues for itself with (how empty it is) x (how loud it is).
    // The handful of needs whose urgency isn't linear get a nudge on top.
    const cands: [NeedName, number][] = NEEDS.map((need) => {
      let w = (1 - n[need]) * NEED_TUNING[need].weight;
      // Gathering contraband makes meals instrumental: eat well before hungry.
      if (need === "food" && gathering) w += 0.5;
      // At night, sleep stops being optional.
      if (need === "sleep" && isNight) w = (1 - n.sleep) * 1.7;
      // Filth escalates: past a point the shower outranks comfort and air.
      if (need === "hygiene" && n.hygiene < 0.1) w = (1 - n.hygiene) * 0.9;
      return [need, w];
    });

    cands.sort((a, b) => b[1] - a[1]);
    for (const [need, w] of cands) {
      if (w < 0.28) break;
      if (this.trySatisfy(ag, world, need)) return;
    }
    this.explore(ag, world);
  }

  private trySatisfy(ag: Agent, world: World, need: NeedName): boolean {
    const size = world.size;
    const ax = Math.floor(ag.x), az = Math.floor(ag.z);
    switch (need) {
      case "food": {
        // Holding a tray already? Then all that is left is to find a table.
        if (hasItem(ag.inv, Item.Tray)) return this.tryUse(ag, world, "food", [Obj.Table]);
        // A table with a tray already on it is a free meal — take it.
        if (this.tryUse(ag, world, "food", [Obj.Table])) return true;

        // Otherwise queue at a serving counter. Hunger is shameless: past a
        // point he will cut through staff territory to reach one.
        const trespass = ag.needs.food < 0.2;
        const counter = this.nearestUsable(ag, world, [Obj.ServingTable]);
        if (counter >= 0 && this.walkToUse(ag, world, counter, trespass)) {
          ag.state = "toUse";
          ag.interact = counter;
          return true;
        }
        // A counter he knows of, but it is empty or unmanned: wait beside it.
        let known = -1, kd = Infinity;
        for (const t of this.mem(ag, Obj.ServingTable)) {
          if (world.objKind[t] !== Obj.ServingTable) continue;
          const d = Math.abs((t % size) - ax) + Math.abs(((t / size) | 0) - az);
          if (d < kd) { kd = d; known = t; }
        }
        if (known >= 0 && ag.needs.food < 0.6) {
          if (this.isNextTo(ag, world, known)) {
            ag.state = "queueing";
            ag.interact = known;
            ag.timer = 2;
            return true;
          }
          if (this.pathAdjacent(ag, world, known, this.lawfulOpen(ag, world, trespass))) {
            ag.state = "toQueue";
            ag.interact = known;
            return true;
          }
        }
        // Starving and knows of no food anywhere: go and look, rules be damned.
        if (ag.needs.food < 0.15) { this.explore(ag, world, true); return true; }
        return false;
      }

      case "sleep": {
        // His own bunk, through the generic machinery — which lies him down at
        // the middle of the bed instead of snapping him to the pillow end.
        if (ag.bedIdx >= 0 && this.useable(ag, world, ag.bedIdx, Obj.Bed) &&
            this.walkToUse(ag, world, ag.bedIdx)) {
          ag.state = "toUse";
          ag.interact = ag.bedIdx;
          return true;
        }
        // Dead on his feet with nowhere to lie: the floor will do.
        if (ag.needs.sleep < 0.12) {
          ag.pose = POSE_LIE_FLOOR;
          ag.state = "sleepFloor";
          return true;
        }
        return false;
      }

      case "outdoors": {
        const start = az * size + ax;
        const open = this.lawfulOpen(ag, world);
        const spot = bfsFind(size, start, open, (i) => open(i) && world.roofed[i] === 0);
        if (spot >= 0) {
          const path = astar(size, start, spot, open);
          if (path) {
            ag.path = path; ag.pathI = 0;
            ag.state = "toOutside";
            return true;
          }
        }
        // No lawful way to fresh air: consider breaking the rules quietly.
        return this.trySneak(ag, world, "outdoors");
      }

      case "hygiene": {
        const shower = this.nearestUsableIn(ag, world, [Obj.Shower], RoomType.ShowerRoom);
        if (shower >= 0 && this.walkToUse(ag, world, shower)) {
          ag.state = "toUse";
          ag.interact = shower;
          return true;
        }
        // No lawful route to a shower: consider a quiet unauthorized one.
        return this.trySneak(ag, world, "hygiene");
      }

      case "recreation": {
        // With a book in hand, the job is to find somewhere to read it.
        if (hasItem(ag.inv, Item.Book)) return this.startReading(ag, world);
        // A television or a pool table needs no props.
        if (this.tryUse(ag, world, "recreation")) return true;
        // Otherwise borrow a book — that is what the shelves are for.
        return this.tryUse(ag, world, "recreation", SHELF_KINDS);
      }

      // Comfort, exercise, bladder, spirituality: nothing bespoke about any of
      // them — find a remembered object whose registry row fills it, and go.
      default:
        return this.tryUse(ag, world, need);
    }
  }

  /** Nearest usable object of these kinds that also sits in the right room. */
  private nearestUsableIn(
    ag: Agent, world: World, kinds: number[], roomType: number,
  ): number {
    const size = world.size;
    const ax = Math.floor(ag.x), az = Math.floor(ag.z);
    let best = -1, bd = Infinity;
    for (const kind of kinds) {
      for (const anchor of this.mem(ag, kind)) {
        if (!this.useable(ag, world, anchor, kind)) continue;
        if (world.roomTypeAt(anchor) !== roomType) continue;
        const d = Math.abs((anchor % size) - ax) + Math.abs(((anchor / size) | 0) - az);
        if (d < bd) { bd = d; best = anchor; }
      }
    }
    return best;
  }

  // --- Books ------------------------------------------------------------------

  /** He has a book. Settle somewhere to read it — a chair if he knows of one,
   *  his bunk if not, and failing both, right where he stands. */
  private startReading(ag: Agent, world: World): boolean {
    if (this.tryUse(ag, world, "comfort")) return true; // read it in the armchair
    if (ag.bedIdx >= 0 && this.useable(ag, world, ag.bedIdx, Obj.Bed) &&
        this.walkToUse(ag, world, ag.bedIdx)) {
      ag.state = "toUse";
      ag.interact = ag.bedIdx;
      return true;
    }
    ag.pose = POSE_STAND;
    ag.timer = READ_TIME;
    ag.state = "reading";
    return true;
  }

  /** Done with it: put it back on a shelf, or slide it under the bunk. */
  private returnBook(ag: Agent, world: World): boolean {
    const shelf = this.nearestUsable(ag, world, SHELF_KINDS);
    if (shelf >= 0 && this.pathAdjacent(ag, world, shelf, this.lawfulOpen(ag, world))) {
      ag.state = "toShelf";
      ag.interact = shelf;
      return true;
    }
    if (ag.bedIdx >= 0 && this.pathAdjacent(ag, world, ag.bedIdx, this.lawfulOpen(ag, world))) {
      ag.state = "toStash";
      ag.interact = ag.bedIdx;
      return true;
    }
    return false;
  }

  // --- Stashing ---------------------------------------------------------------

  /** Contraband in your HANDS is contraband a guard can see. Once the pockets
   *  are full, the only place left to put it is under the bunk. */
  private needsToStash(ag: Agent): boolean {
    return ag.inv.hands.some((s) => itemDef(s.kind)?.contraband);
  }

  private tryStashTrip(ag: Agent, world: World): boolean {
    if (ag.bedIdx < 0 || !this.needsToStash(ag)) return false;
    if (!this.pathAdjacent(ag, world, ag.bedIdx, this.lawfulOpen(ag, world))) return false;
    ag.state = "toStash";
    ag.interact = ag.bedIdx;
    return true;
  }

  /** At the bunk: push whatever is showing in his hands out of sight. */
  private doStash(ag: Agent) {
    if (ag.bedIdx < 0) return;
    const items = this.stashOf(ag.bedIdx);
    for (const held of [...ag.inv.hands]) {
      const d = itemDef(held.kind);
      if (!d) continue;
      if (!d.contraband && held.kind !== Item.Book) continue;
      for (let n = held.count; n > 0; n--) {
        // A pocket is better than the floorboards; the bunk is the fallback.
        if (d.contraband && canPocket(ag.inv, held.kind)) {
          removeFromHands(ag.inv, held.kind);
          pocket(ag.inv, held.kind);
        } else if (stashAdd(items, held.kind)) {
          removeFromHands(ag.inv, held.kind);
        } else break;
      }
    }
  }

  /** Fetch the tools he hid, because a plan needs them on his person. */
  private tryRetrieveTools(ag: Agent, world: World, kind: number): boolean {
    if (ag.bedIdx < 0) return false;
    if (stashCount(this.stashOf(ag.bedIdx), kind) <= 0) return false;
    if (!this.pathAdjacent(ag, world, ag.bedIdx, this.lawfulOpen(ag, world))) return false;
    ag.state = "toRetrieve";
    ag.interact = ag.bedIdx;
    ag.aux = kind;
    return true;
  }

  private doRetrieve(ag: Agent, kind: number) {
    if (ag.bedIdx < 0) return;
    const items = this.stashOf(ag.bedIdx);
    while (stashCount(items, kind) > 0) {
      if (pocket(ag.inv, kind) || takeInHands(ag.inv, kind)) { stashTake(items, kind); continue; }
      break; // he cannot carry any more
    }
  }

  // --- Use-slots --------------------------------------------------------------
  //
  // Any object whose registry row carries a `use` block can be walked to, stood
  // (or sat) at, and drained for the needs it lists. One state pair — "toUse"
  // then "using" — serves every such object, so a new usable thing is a data
  // row, not a new branch in this machine.

  private useCount(anchor: number): number {
    return this.useClaims.get(anchor)?.size ?? 0;
  }

  private releaseUse(ag: Agent) {
    if (ag.useIdx < 0) return;
    const set = this.useClaims.get(ag.useIdx);
    if (set) {
      set.delete(ag.id);
      if (set.size === 0) this.useClaims.delete(ag.useIdx);
    }
    ag.useIdx = -1;
  }

  /** Is this remembered anchor still a usable object with room for one more —
   *  and does this particular agent qualify to use it right now? */
  private useable(ag: Agent, world: World, anchor: number, kind: number): boolean {
    if (world.objKind[anchor] !== kind) return false;
    const use = defOf(kind)?.use;
    if (!use) return false;
    if (this.useCount(anchor) >= use.capacity) return false;
    // Your bunk is yours.
    if (use.owned && ag.bedIdx !== anchor) return false;
    // You can't eat at a table without a tray — unless someone left one there.
    if (use.requires !== undefined && !hasItem(ag.inv, use.requires)) {
      if (!(kind === Obj.Table && this.mealTables.has(anchor))) return false;
    }
    // You can't take what it hands out if you've no hand free for it.
    if (use.gives !== undefined) {
      const d = itemDef(use.gives)!;
      const room = d.perSlot > 0 ? canPocket(ag.inv, use.gives) || canHold(ag.inv, use.gives)
        : canHold(ag.inv, use.gives);
      if (!room) return false;
    }
    // A serving counter with nothing on it serves nobody; and at meal times a
    // cook has to be manning it (off-schedule, a starving man just helps himself).
    if (kind === Obj.ServingTable) {
      if ((this.servingStock.get(anchor) ?? 0) <= 0) return false;
      const mustBeServed = this.curActivity === REG.Eating && ag.needs.food >= 0.15;
      if (mustBeServed && !this.servers.has(anchor)) return false;
    }
    return true;
  }

  /** A tile a sitter can actually sit on (a bench beside the dining table). */
  private isSeatTile(world: World, i: number): boolean {
    const use = defOf(world.objKind[i])?.use;
    return !!use && use.from === "on" && use.pose === POSE_SIT;
  }

  /** Where an agent stands to use an object: on it, or on a tile beside it —
   *  preferring a seat, which is how diners end up on the bench by the table. */
  private walkToUse(ag: Agent, world: World, anchor: number, trespass = false): boolean {
    const size = world.size;
    const use = defOf(world.objKind[anchor])!.use!;
    const open = this.lawfulOpen(ag, world, trespass);

    if (use.from === "on") {
      // A bed, an armchair and a bench are all things you stand next to and
      // then get onto — they are not walkable, so pathing *through* them fails.
      // Walk to a tile beside it; startUse settles him onto the object itself.
      return this.pathAdjacent(ag, world, anchor, open);
    }
    // Adjacent. A bench beside the table is the obvious place to eat, but a
    // bench is furniture, not floor — he walks to a tile beside the BENCH and
    // then sits down on it (startUse does the sitting).
    ag.seatIdx = -1;
    for (const [dx, dz] of DIRS) {
      const nx = (anchor % size) + dx, nz = ((anchor / size) | 0) + dz;
      if (!world.inBounds(nx, nz)) continue;
      const seat = nz * size + nx;
      if (!this.isSeatTile(world, seat)) continue;
      if (this.pathAdjacent(ag, world, seat, open)) {
        ag.seatIdx = seat;
        return true;
      }
    }
    // No seat: stand at it.
    return this.pathAdjacent(ag, world, anchor, open);
  }

  /** The tile at the middle of a piece's footprint (a 2-tile bed's middle is
   *  between its tiles, so the far tile is the honest choice for lying on). */
  private useCenterTile(world: World, anchor: number): number {
    const p = world.pieceAtTile(anchor);
    if (!p) return anchor;
    const tiles = world.pieceTiles(p);
    return tiles[Math.floor(tiles.length / 2)] ?? anchor;
  }

  /** Walk to the nearest remembered object that fills `need`. */
  private tryUse(ag: Agent, world: World, need: NeedName, kinds = kindsServing(need)): boolean {
    const anchor = this.nearestUsable(ag, world, kinds);
    if (anchor < 0) return false;
    if (!this.walkToUse(ag, world, anchor)) return false;
    ag.state = "toUse";
    ag.interact = anchor;
    return true;
  }

  /** The closest remembered object of any of these kinds that he could use. */
  private nearestUsable(ag: Agent, world: World, kinds: number[]): number {
    const size = world.size;
    const ax = Math.floor(ag.x), az = Math.floor(ag.z);
    let best = -1, bd = Infinity;
    for (const kind of kinds) {
      for (const anchor of this.mem(ag, kind)) {
        if (!this.useable(ag, world, anchor, kind)) continue;
        const d = Math.abs((anchor % size) - ax) + Math.abs(((anchor / size) | 0) - az);
        if (d < bd) { bd = d; best = anchor; }
      }
    }
    return best;
  }

  /** Arrived at a use-slot object: claim it, take/consume items, settle in. */
  private startUse(ag: Agent, world: World) {
    const anchor = ag.interact;
    const kind = world.objKind[anchor];
    const use = defOf(kind)?.use;
    if (!use || !this.useable(ag, world, anchor, kind)) { ag.state = "idle"; return; }

    let set = this.useClaims.get(anchor);
    if (!set) this.useClaims.set(anchor, set = new Set());
    set.add(ag.id);
    ag.useIdx = anchor;

    const size = world.size;
    if (use.from === "on") {
      const tile = use.center ? this.useCenterTile(world, anchor) : anchor;
      ag.x = (tile % size) + 0.5;
      ag.z = ((tile / size) | 0) + 0.5;
      // Lie along the bed, not across it.
      const p = world.pieceAtTile(anchor);
      ag.heading = use.center && p
        ? [0, Math.PI / 2, Math.PI, -Math.PI / 2][p.orient & 3]
        : ag.heading;
    } else {
      // Sit down on the bench he walked over to, if he lined one up.
      if (ag.seatIdx >= 0 && this.isSeatTile(world, ag.seatIdx) &&
          this.isNextTo(ag, world, ag.seatIdx)) {
        ag.x = (ag.seatIdx % size) + 0.5;
        ag.z = ((ag.seatIdx / size) | 0) + 0.5;
      }
      ag.heading = Math.atan2(
        (((anchor / size) | 0) + 0.5) - ag.z,
        ((anchor % size) + 0.5) - ag.x,
      );
    }
    ag.seatIdx = -1;

    // Sitting only works if there's something under you. A man eating at a
    // table with no bench eats standing, tray in hand.
    const here = world.idx(Math.floor(ag.x), Math.floor(ag.z));
    ag.pose = (use.pose === POSE_SIT && use.from === "adjacent" && !this.isSeatTile(world, here))
      ? POSE_STAND : use.pose;

    // Set the tray down on the table before eating it (a leftover if he's
    // interrupted — which is exactly how leftovers happen today).
    if (use.requires !== undefined && hasItem(ag.inv, use.requires)) {
      if (use.consumes !== undefined) {
        removeItem(ag.inv, use.consumes);
        if (kind === Obj.Table) { this.mealTables.add(anchor); this.mealsDirty = true; }
      }
    }
    // Take what it hands out.
    if (use.gives !== undefined) {
      stow(ag.inv, use.gives);
      if (kind === Obj.ServingTable) {
        this.servingStock.set(anchor, (this.servingStock.get(anchor) ?? 1) - 1);
        this.mealsDirty = true;
      }
    }

    // Bedding down during lock-up hours calls for the doors to be shut.
    if (kind === Obj.Bed && (this.curActivity === REG.Sleep || this.curActivity === REG.Lockup) &&
        ag.cellRoom >= 0 && this.insideOwnCell(ag, world)) {
      this.lockCell(ag, world);
    }

    // A man with a book stays in the chair long enough to actually read it.
    const base = use.seconds > 0 ? use.seconds : Infinity;
    ag.timer = hasItem(ag.inv, Item.Book) ? Math.max(base, READ_TIME) : base;
    ag.state = "using";
  }

  /** Drain the object's needs into the agent; stop when full, bored, or the
   *  object is gone (a player can erase a bookshelf out from under a reader). */
  private updateUsing(ag: Agent, dt: number, world: World, isNight: boolean) {
    ag.amp = Math.max(0, ag.amp - dt * 8);
    const kind = ag.useIdx >= 0 ? world.objKind[ag.useIdx] : Obj.None;
    const use = defOf(kind)?.use;
    if (!use) { this.finishUse(ag, world); return; }

    // Doing this without permission? Bail the moment a uniform appears.
    if (ag.sneaking) {
      ag.decideT -= dt;
      if (ag.decideT <= 0) {
        ag.decideT = 0.5;
        if (this.guardInSight(ag, world)) {
          ag.risk = Math.min(1, ag.risk + 0.15); // a close call, remembered
          ag.sneaking = false;
          this.finishUse(ag, world);
          return;
        }
      }
    }

    // A well-furnished room restores people faster — this is the whole payoff
    // of the cosmetic objects, and the reason ambience is a number.
    const mul = world.ambienceMul(world.idx(Math.floor(ag.x), Math.floor(ag.z)));
    let full = true;
    for (const [need, rate] of Object.entries(use.needs) as [NeedName, number][]) {
      ag.needs[need] = Math.min(1, ag.needs[need] + rate * mul * dt);
      if (ag.needs[need] < 1) full = false;
    }
    // A book read in a comfortable chair fills the time on top of whatever the
    // chair itself was doing for him — and he stays in the chair until he has
    // finished it, not merely until he is comfortable.
    if (hasItem(ag.inv, Item.Book)) {
      ag.needs.recreation = Math.min(1, ag.needs.recreation + BOOK_READ_RATE * mul * dt);
      if (ag.needs.recreation < 1) full = false;
    }

    ag.timer -= dt;
    // A man wakes when he's slept enough — earlier if it's daylight.
    if (kind === Obj.Bed && !isNight && ag.needs.sleep > 0.75) { this.finishUse(ag, world); return; }
    if (full || ag.timer <= 0) this.finishUse(ag, world);
  }

  private finishUse(ag: Agent, world: World) {
    const kind = ag.useIdx >= 0 ? world.objKind[ag.useIdx] : Obj.None;
    const use = defOf(kind)?.use;
    // The meal is finished, so the tray goes.
    if (kind === Obj.Table && this.mealTables.delete(ag.useIdx)) this.mealsDirty = true;
    // Eating is also how a man squirrels away a spoon or works a cutter loose.
    if (kind === Obj.Table) this.mealContraband(ag);

    const on = use?.from === "on";
    this.releaseUse(ag);
    ag.pose = POSE_STAND;
    ag.sneaking = false;
    ag.state = "idle";
    if (on) this.stepOff(ag, world);
  }

  /** Meals feed the escape kit: a tucked-away spoon, or progress on a cutter. */
  private mealContraband(ag: Agent) {
    if (ag.plan?.method === "cut") {
      ag.cutterMeals++;
      if (ag.cutterMeals >= MEALS_PER_CUTTER) {
        ag.cutterMeals = 0;
        this.acquire(ag, Item.Cutter);
      }
    } else if (ag.plan?.method === "dig") {
      this.acquire(ag, Item.Spoon);
    }
  }

  /** Take an item: into a pocket if it fits, else into a hand. If neither, it
   *  goes straight under the bunk (he can't very well stand there holding it). */
  private acquire(ag: Agent, kind: number): boolean {
    if (stow(ag.inv, kind)) return true;
    return this.stashUnderBed(ag, kind);
  }

  /** What a prisoner has hidden under a given bunk (read-only, for the HUD). */
  stashOfBed(bed: number): Stack[] {
    return (bed >= 0 && this.stashes.get(bed)) || [];
  }

  private stashOf(bed: number): Stack[] {
    let s = this.stashes.get(bed);
    if (!s) this.stashes.set(bed, s = []);
    return s;
  }

  private stashUnderBed(ag: Agent, kind: number): boolean {
    if (ag.bedIdx < 0) return false;
    return stashAdd(this.stashOf(ag.bedIdx), kind);
  }

  /** Everything he owns of a kind — on him and hidden under his bunk. */
  private toolCount(ag: Agent, kind: number): number {
    const hidden = ag.bedIdx >= 0 ? stashCount(this.stashOf(ag.bedIdx), kind) : 0;
    return countItem(ag.inv, kind) + hidden;
  }

  // --- Rule-breaking need trips ----------------------------------------------

  /** Any guard this agent can currently see nearby (his own eyes)? */
  private guardInSight(ag: Agent, world: World, r = 14): boolean {
    for (const g of this.agents) {
      if (g.kind !== Obj.Guard) continue;
      if (Math.hypot(g.x - ag.x, g.z - ag.z) > r) continue;
      if (this.canSee(ag, world, g.x, g.z)) return true;
    }
    return false;
  }

  /** Quiet trespass to fix hygiene/outdoors. Unlike food runs (starving men
   *  are shameless), these trips are risk-gated: the more often he has been
   *  busted, the more desperate he must be before trying again. */
  private trySneak(ag: Agent, world: World, need: "outdoors" | "hygiene"): boolean {
    const urgency = 1 - ag.needs[need];
    if (urgency < 0.55 + 0.4 * ag.risk) return false;
    if (this.guardInSight(ag, world)) return false; // wait for a clear moment
    const size = world.size;
    const start = Math.floor(ag.z) * size + Math.floor(ag.x);
    const open = this.lawfulOpen(ag, world, true); // break the rules, not walls
    if (need === "outdoors") {
      const spot = bfsFind(size, start, open, (i) => open(i) && world.roofed[i] === 0);
      if (spot >= 0) {
        const path = astar(size, start, spot, open);
        if (path) {
          ag.path = path; ag.pathI = 0;
          ag.state = "toOutside";
          ag.sneaking = true;
          return true;
        }
      }
      return this.tryTunnelTrip(ag, world);
    }
    // Hygiene: nearest remembered shower head, access rules be damned
    // (someone else's in-cell shower counts).
    let best = -1, bd = Infinity;
    for (const s of this.mem(ag, Obj.Shower)) {
      if (world.objKind[s] !== Obj.Shower) continue;
      const d = Math.abs((s % size) - ag.x) + Math.abs(((s / size) | 0) - ag.z);
      if (d < bd) { bd = d; best = s; }
    }
    if (best < 0) return false;
    const path = astar(size, start, best, (i) => open(i) || i === best);
    if (!path) return false;
    ag.path = path; ag.pathI = 0;
    ag.state = "toShower";
    ag.sneaking = true;
    return true;
  }

  /** Pop out of his own surfaced tunnel just to breathe for a while. */
  private tryTunnelTrip(ag: Agent, world: World): boolean {
    if (ag.needs.outdoors > 0.35) return false;
    if (Math.random() < ag.risk) return false; // still spooked from last time
    const t = this.tunnels.find((tn) => tn.owner === ag.id && tn.surfHole >= 0 && !tn.occupied);
    if (!t || world.objKind[t.entry] !== Obj.Toilet) return false;
    if (this.isNextTo(ag, world, t.entry)) {
      ag.tunnel = t;
      t.occupied = true;
      ag.underground = true;
      ag.state = "crawlingOut";
      ag.timer = t.believed / CRAWL_SPEED;
      ag.sneaking = true;
      return true;
    }
    if (!this.pathAdjacent(ag, world, t.entry, this.knownOpen(ag))) return false;
    ag.tunnel = t;
    ag.state = "toTrip";
    ag.sneaking = true;
    return true;
  }

  /** End an outdoors break; sneaks that came up a tunnel crawl back down. */
  private finishOutside(ag: Agent, world: World) {
    const t = ag.tunnel;
    if (ag.sneaking && t && t.surfHole >= 0 && this.tunnels.includes(t) &&
        !t.occupied && this.isNextTo(ag, world, t.surfHole)) {
      t.occupied = true;
      ag.underground = true;
      ag.state = "crawlingBack";
      ag.timer = t.believed / CRAWL_SPEED;
      return;
    }
    ag.sneaking = false;
    ag.state = "idle";
  }

  /** Frontier exploration. `trespass` (desperate hunger with no known food
   *  source) searches past the access rules. */
  private explore(ag: Agent, world: World, trespass = false) {
    const size = world.size;
    const ax = Math.floor(ag.x), az = Math.floor(ag.z);
    const start = az * size + ax;
    const open = this.lawfulOpen(ag, world, trespass); // wandering respects access

    let best = -1, bestScore = -Infinity;
    for (const [i, v] of ag.known!) {
      if (v !== K_OPEN && v !== K_CUT && v !== K_DOOR) continue;
      if (!trespass && !prisonerAllowed(world, i)) continue;
      const x = i % size, z = (i / size) | 0;
      let frontier = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (world.inBounds(nx, nz) && !ag.known!.has(nz * size + nx)) { frontier = true; break; }
      }
      if (!frontier) continue;
      const d = Math.hypot(x - ax, z - az);
      if (d < 0.5) continue;
      const dirBonus = Math.cos(Math.atan2(z + 0.5 - ag.z, x + 0.5 - ag.x) - ag.heading);
      const s = dirBonus * 2 - d * 0.15 + Math.random() * 0.8;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0) {
      const path = astar(size, start, best, open);
      if (path) {
        ag.path = path; ag.pathI = 0;
        ag.state = "exploring";
        return;
      }
    }
    const keys = [...ag.known!.keys()].filter(open);
    if (keys.length > 0) {
      const t = keys[(Math.random() * keys.length) | 0];
      const path = astar(size, start, t, open);
      if (path) {
        ag.path = path; ag.pathI = 0;
        ag.state = "wandering";
        return;
      }
    }
    ag.state = "idle";
  }

  // --- Escape planning ---------------------------------------------------------

  /** Dijkstra over the prisoner's memory where fences are crossable at a
   *  price. Returns the chosen believed exit + breach route, or null. */
  private findRoute(ag: Agent, world: World): { exit: number; breaches: number[]; cost: number } | null {
    const size = world.size;
    const start = Math.floor(ag.z) * size + Math.floor(ag.x);
    const cost = new Map<number, number>([[start, 0]]);
    const fences = new Map<number, number>([[start, 0]]);
    const prev = new Map<number, number>();
    const heap: number[] = [0, start];
    const push = (f: number, i: number) => {
      heap.push(f, i);
      let c = heap.length / 2 - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heap[p * 2] <= heap[c * 2]) break;
        for (let k = 0; k < 2; k++) {
          const t = heap[p * 2 + k]; heap[p * 2 + k] = heap[c * 2 + k]; heap[c * 2 + k] = t;
        }
        c = p;
      }
    };
    const pop = (): number => {
      const i = heap[1];
      const nn = heap.length / 2 - 1;
      heap[0] = heap[nn * 2]; heap[1] = heap[nn * 2 + 1];
      heap.length = nn * 2;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < heap.length / 2 && heap[l * 2] < heap[m * 2]) m = l;
        if (r < heap.length / 2 && heap[r * 2] < heap[m * 2]) m = r;
        if (m === c) break;
        for (let k = 0; k < 2; k++) {
          const t = heap[m * 2 + k]; heap[m * 2 + k] = heap[c * 2 + k]; heap[c * 2 + k] = t;
        }
        c = m;
      }
      return i;
    };
    const done = new Set<number>();
    while (heap.length > 0) {
      const cur = pop();
      if (done.has(cur)) continue;
      done.add(cur);
      const cx = cur % size, cz = (cur / size) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const ni = nz * size + nx;
        const v = ag.known!.get(ni);
        if (v === undefined || v === K_BLOCKED) continue;
        const step = v === K_FENCE ? 16 : v === K_CUT ? 2 : v === K_DOOR ? 3 : 1;
        const nc = cost.get(cur)! + step;
        if (nc >= (cost.get(ni) ?? Infinity)) continue;
        cost.set(ni, nc);
        fences.set(ni, fences.get(cur)! + (v === K_FENCE || v === K_CUT ? 1 : 0));
        prev.set(ni, cur);
        push(nc, ni);
      }
    }

    // Believed exits: frontier tiles whose route crossed >=1 barrier and that
    // sit just past the LAST crossing (heading into the unknown = freedom).
    let best = -1, bestCost = Infinity;
    for (const [i, v] of ag.known!) {
      if ((v !== K_OPEN && v !== K_CUT) || !cost.has(i)) continue;
      if ((fences.get(i) ?? 0) < 1) continue;
      const x = i % size, z = (i / size) | 0;
      let frontier = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (world.inBounds(nx, nz) && !ag.known!.has(nz * size + nx)) { frontier = true; break; }
      }
      if (!frontier) continue;
      // Walk back: distance since the last barrier crossing must be short.
      let steps = 0, p = i, pastFence = false;
      while (prev.has(p) && steps < 12) {
        const q = prev.get(p)!;
        const vq = ag.known!.get(p);
        if (vq === K_FENCE || vq === K_CUT) { pastFence = true; break; }
        p = q; steps++;
      }
      if (!pastFence) continue;
      const c = cost.get(i)!;
      if (c < bestCost) { bestCost = c; best = i; }
    }
    if (best < 0) return null;

    // Collect the real fence tiles (not cut ones) along the winning route.
    const breaches: number[] = [];
    let p = best;
    while (prev.has(p)) {
      if (ag.known!.get(p) === K_FENCE) breaches.push(p);
      p = prev.get(p)!;
    }
    breaches.reverse();
    return { exit: best, breaches, cost: bestCost };
  }

  private makePlan(ag: Agent, world: World) {
    const route = this.findRoute(ag, world);
    if (!route) { ag.escapeFeasibility = 0; return; }
    ag.escapeFeasibility = 1 / (1 + route.cost / 120);

    // Method: climbers who keep getting caught switch to tools.
    let method: Method;
    if (ag.planBias) {
      method = ag.planBias;
      // Biased to dig but no toilet known yet: hold out for one.
      if (method === "dig" && this.mem(ag, Obj.Toilet).size === 0) return;
    } else {
      const wClimb = 1 / (1 + ag.timesCaught);
      const wCut = 0.8;
      const wDig = this.mem(ag, Obj.Toilet).size > 0 ? 0.7 : 0;
      const r = Math.random() * (wClimb + wCut + wDig);
      method = r < wClimb ? "climb" : r < wClimb + wCut ? "cut" : "dig";
    }

    const size = world.size;
    let toiletIdx = -1;
    if (method === "dig") {
      let bd = Infinity;
      for (const t of this.mem(ag, Obj.Toilet)) {
        if (world.objKind[t] !== Obj.Toilet) continue;
        const d = Math.abs((t % size) - ag.x) + Math.abs(((t / size) | 0) - ag.z);
        if (d < bd) { bd = d; toiletIdx = t; }
      }
      if (toiletIdx < 0) method = "climb";
    }

    ag.plan = {
      method,
      breaches: route.breaches,
      exitTile: route.exit,
      needed: route.breaches.length,
      stage: "prepare",
      legI: 0,
      toiletIdx,
      watchdog: 90,
    };
  }

  /** Returns true when plan work consumed this decision slot. */
  private planTick(ag: Agent, world: World, isNight: boolean): boolean {
    // Critical needs always win.
    if (ag.needs.food < 0.08 || ag.needs.sleep < 0.08) return false;

    const threshold = isNight ? 0.40 : 0.55;
    if (!ag.plan) {
      if (ag.escapeDesire > threshold) this.makePlan(ag, world);
      if (!ag.plan) return false;
    }
    const plan = ag.plan;

    if (plan.stage === "prepare") {
      const ready =
        plan.method === "climb" ||
        (plan.method === "cut" && this.toolCount(ag, Item.Cutter) >= plan.needed) ||
        (plan.method === "dig" && this.toolCount(ag, Item.Spoon) >= SPOONS_TO_DIG);
      if (!ready || ag.escapeDesire < threshold * 0.7) return false; // keep living (and eating)
      // The kit is his, but half of it may be under the bunk. Go and get it.
      const tool = plan.method === "cut" ? Item.Cutter : Item.Spoon;
      if (plan.method !== "climb" && countItem(ag.inv, tool) <= 0 &&
          this.tryRetrieveTools(ag, world, tool)) {
        return true;
      }
      plan.stage = "execute";
      plan.watchdog = 120;
    }

    if (plan.stage === "execute") {
      if (plan.method === "dig") {
        if (world.objKind[plan.toiletIdx] !== Obj.Toilet) { ag.plan = null; return false; }
        if (this.pathAdjacent(ag, world, plan.toiletIdx, this.knownOpen(ag))) {
          ag.state = "toTunnel";
          return true;
        }
        ag.plan = null;
        return false;
      }
      return this.approachBreach(ag, world);
    }

    if (plan.stage === "flee") { this.fleeStep(ag, world); return true; }
    if (plan.stage === "retreat") { this.retreat(ag, world); return true; }
    return false;
  }

  private approachBreach(ag: Agent, world: World): boolean {
    const plan = ag.plan!;
    if (plan.legI >= plan.breaches.length) {
      plan.stage = "flee";
      this.fleeStep(ag, world);
      return true;
    }
    const b = plan.breaches[plan.legI];
    // Breach already gone (cut by someone / erased)? Skip the leg.
    if (!isFenceKind(world.objKind[b])) {
      plan.legI++;
      return this.approachBreach(ag, world);
    }
    if (this.isNextTo(ag, world, b)) { this.startBreach(ag, world); return true; }
    if (this.pathAdjacent(ag, world, b, this.knownOpen(ag))) {
      ag.state = "toBreach";
      return true;
    }
    ag.plan = null;
    return false;
  }

  private startBreach(ag: Agent, world: World) {
    const plan = ag.plan!;
    const size = world.size;
    const b = plan.breaches[plan.legI];
    // Sneak: hold off while a guard is visibly nearby.
    if (this.guardInSight(ag, world, 15)) {
      ag.state = "sneakWait";
      ag.timer = 2.5;
      return;
    }
    ag.heading = Math.atan2((((b / size) | 0) + 0.5) - ag.z, ((b % size) + 0.5) - ag.x);
    if (plan.method === "climb") {
      // Hang on the fence itself.
      ag.aux = Math.floor(ag.z) * size + Math.floor(ag.x); // approach tile (to compute the far side)
      ag.x = (b % size) + 0.5; ag.z = ((b / size) | 0) + 0.5;
      ag.state = "climbing";
      ag.timer = CLIMB_TIME;
    } else {
      if (countItem(ag.inv, Item.Cutter) <= 0) {
        // He left them under the bunk. Go back for them.
        if (!this.tryRetrieveTools(ag, world, Item.Cutter)) {
          plan.stage = "prepare";
          ag.state = "idle";
        }
        return;
      }
      ag.state = "cutting";
      ag.timer = CUT_TIME;
      ag.interact = b;
    }
  }

  private finishClimb(ag: Agent, world: World) {
    const plan = ag.plan;
    const size = world.size;
    const b = Math.floor(ag.z) * size + Math.floor(ag.x);
    // Land on the far side (opposite the approach tile).
    const far = 2 * b - ag.aux;
    const fx = far % size, fz = (far / size) | 0;
    if (world.inBounds(fx, fz) && passable(world, far, false)) {
      ag.x = fx + 0.5; ag.z = fz + 0.5;
    } else this.stepOff(ag, world);
    ag.pose = POSE_STAND;
    ag.phase = 0;
    this.look(ag, world);
    if (!plan) { ag.state = "idle"; return; }
    plan.legI++;
    plan.watchdog = 120;
    ag.state = "idle";
    ag.decideT = 0; // continue the plan next tick
  }

  private finishCut(ag: Agent, world: World) {
    const plan = ag.plan;
    const b = ag.interact;
    if (isFenceKind(world.objKind[b])) {
      world.cutFenceAt(b);
      this.cutFences.add(b);
      this.worldDirty = true;
      removeItem(ag.inv, Item.Cutter); // a set of cutters is spent on a fence
      if (ag.known) this.record(ag, world, b);
    }
    ag.state = "idle";
    if (plan) { plan.legI++; plan.watchdog = 120; ag.decideT = 0; }
  }

  /** Head for the map border, optimistically pathing through the unknown. */
  private fleeStep(ag: Agent, world: World) {
    const size = world.size;
    // Swallowed by the border fog?
    if (ag.x < ESCAPE_MARGIN || ag.z < ESCAPE_MARGIN ||
        ag.x > size - ESCAPE_MARGIN || ag.z > size - ESCAPE_MARGIN) {
      this.escapedCount++;
      this.removeAgent(ag);
      return;
    }
    // Aim at the nearest edge, one 40-tile leg at a time.
    const dists = [ag.x, ag.z, size - ag.x, size - ag.z];
    const dirs = [[-1, 0], [0, -1], [1, 0], [0, 1]];
    const dir = dirs[dists.indexOf(Math.min(...dists))];
    const tx = Math.max(2, Math.min(size - 3, Math.floor(ag.x + dir[0] * 40)));
    const tz = Math.max(2, Math.min(size - 3, Math.floor(ag.z + dir[1] * 40)));
    const start = Math.floor(ag.z) * size + Math.floor(ag.x);
    const path = astar(size, start, tz * size + tx, this.fleeOpen(ag), 12000);
    if (path) {
      ag.path = path; ag.pathI = 0;
      ag.state = "fleeing";
    } else {
      this.replanOrRetreat(ag, world);
    }
  }

  /** New barrier discovered mid-escape: replan with what we know and have. */
  private replanOrRetreat(ag: Agent, world: World) {
    const old = ag.plan!;
    this.makePlan(ag, world);
    if (ag.plan && ag.plan !== old) {
      ag.plan.method = old.method; // committed to the method (and its tools)
      const ready =
        old.method === "climb" ||
        (old.method === "cut" && this.toolCount(ag, Item.Cutter) >= ag.plan.needed) ||
        (old.method === "dig" && this.toolCount(ag, Item.Spoon) >= SPOONS_TO_DIG);
      if (ready && old.method !== "dig") {
        ag.plan.stage = "execute";
        ag.decideT = 0;
        return;
      }
    }
    // Not ready (or no route): retreat home and regroup.
    if (ag.plan) ag.plan.stage = "retreat";
    this.retreat(ag, world);
  }

  private retreat(ag: Agent, world: World) {
    // Walk back to the claimed bed (or just inward) over anything we can
    // pass in truth — breaches we made are open; fences must be re-climbed
    // (abstracted: retreat paths only through passable tiles; if boxed in,
    // climb back over the nearest known fence).
    const size = world.size;
    const home = ag.bedIdx >= 0 ? ag.bedIdx : this.mem(ag, Obj.Table).values().next().value ?? -1;
    if (home < 0) { ag.plan = null; ag.state = "idle"; return; }
    if (this.pathAdjacent(ag, world, home, this.fleeOpen(ag))) {
      ag.state = "retreating";
      return;
    }
    // Boxed in behind a fence: climb the nearest known one back.
    let best = -1, bd = Infinity;
    for (const [i, v] of ag.known!) {
      if (v !== K_FENCE) continue;
      const d = Math.abs((i % size) - ag.x) + Math.abs(((i / size) | 0) - ag.z);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && ag.plan) {
      ag.plan.method = "climb";
      ag.plan.breaches = [best];
      ag.plan.legI = 0;
      ag.plan.stage = "execute";
      ag.decideT = 0;
      return;
    }
    ag.plan = null;
    ag.state = "idle";
  }

  // --- Digging -----------------------------------------------------------------

  private enterTunnel(ag: Agent, world: World) {
    const plan = ag.plan!;
    const size = world.size;
    let t = this.tunnels.find((tn) => tn.entry === plan.toiletIdx && tn.owner === ag.id);
    if (!t) {
      const ex = (plan.exitTile % size) + 0.5, ez = ((plan.exitTile / size) | 0) + 0.5;
      const sx = (plan.toiletIdx % size) + 0.5, sz = ((plan.toiletIdx / size) | 0) + 0.5;
      t = {
        owner: ag.id,
        entry: plan.toiletIdx,
        heading: Math.atan2(ez - sz, ex - sx),
        believed: 0,
        goal: Math.hypot(ex - sx, ez - sz) + 3,
        actualX: sx, actualZ: sz,
        drift: 0,
        surfHole: -1,
        occupied: true,
        flagged: false,
      };
      this.tunnels.push(t);
      this.mealsDirty = true; // entry hole appears
    } else t.occupied = true;
    ag.tunnel = t;
    ag.underground = true;
    ag.state = "crawling";
    ag.timer = t.believed / CRAWL_SPEED; // crawl to the tunnel head
    ag.pose = POSE_STAND;
  }

  private updateUnderground(ag: Agent, dt: number, world: World) {
    const t = ag.tunnel;
    if (!t) { ag.underground = false; ag.state = "idle"; return; }
    const size = world.size;
    switch (ag.state) {
      case "crawling": {
        ag.timer -= dt;
        if (ag.timer <= 0) ag.state = "digging";
        return;
      }
      case "crawlingBack": {
        ag.timer -= dt;
        if (ag.timer > 0) return;
        // Emerge at the entry hole — right into a stakeout, if one is set.
        ag.underground = false;
        t.occupied = false;
        ag.sneaking = false;
        ag.x = (t.entry % size) + 0.5; ag.z = ((t.entry / size) | 0) + 0.5;
        this.stepOff(ag, world);
        ag.state = "idle";
        if (ag.plan) ag.plan.stage = "prepare"; // gather more spoons
        for (const g of this.agents) {
          if (g.kind === Obj.Guard && g.stakeTunnel === t) {
            this.capture(g, ag, world);
            break;
          }
        }
        return;
      }
      case "crawlingOut": {
        // Not digging — just slipping topside through the surface hole.
        ag.timer -= dt;
        if (ag.timer > 0) return;
        t.occupied = false;
        ag.underground = false;
        const hole = t.surfHole >= 0 ? t.surfHole : t.entry;
        ag.x = (hole % size) + 0.5; ag.z = ((hole / size) | 0) + 0.5;
        ag.pose = POSE_STAND;
        this.look(ag, world);
        ag.state = "outside";
        ag.timer = 12 + Math.random() * 8;
        return;
      }
      case "digging": {
        if (countItem(ag.inv, Item.Spoon) <= 0) {
          ag.state = "crawlingBack";
          ag.timer = t.believed / CRAWL_SPEED;
          return;
        }
        ag.timer -= dt;
        if (ag.timer > 0) return;
        ag.timer = DIG_TILE_TIME;
        removeItem(ag.inv, Item.Spoon); // a spoon wears out per tile of tunnel
        t.believed += 1;
        // Actual digging drifts: heading error accumulates as a random walk.
        t.drift += (Math.random() - 0.5) * 2 * TUNNEL_DRIFT;
        const a = t.heading + t.drift;
        t.actualX += Math.cos(a);
        t.actualZ += Math.sin(a);
        if (t.believed >= t.goal) this.surface(ag, world);
        return;
      }
      default:
        ag.state = "digging";
    }
  }

  private surface(ag: Agent, world: World) {
    const t = ag.tunnel!;
    const size = world.size;
    // Pop out at the ACTUAL tunnel head, nudged to the nearest free tile.
    let hx = Math.max(1, Math.min(size - 2, Math.floor(t.actualX)));
    let hz = Math.max(1, Math.min(size - 2, Math.floor(t.actualZ)));
    outer: for (let r = 0; r < 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = hx + dx, nz = hz + dz;
          if (!world.inBounds(nx, nz)) continue;
          if (world.objKind[nz * size + nx] === Obj.None) { hx = nx; hz = nz; break outer; }
        }
      }
    }
    t.surfHole = hz * size + hx;
    t.occupied = false;
    this.mealsDirty = true;
    ag.underground = false;
    ag.x = hx + 0.5; ag.z = hz + 0.5;
    this.look(ag, world);
    if (ag.plan) {
      ag.plan.stage = "flee";
      ag.decideT = 0;
    }
    ag.state = "idle";
  }

  // --- Capture -------------------------------------------------------------------

  private capture(guard: Agent, prisoner: Agent, world: World) {
    // He is searched on the spot: everything in his hands and pockets is taken.
    // The stash under his bunk is not — nobody has looked there.
    seizeContraband(prisoner.inv);
    clearInventory(prisoner.inv); // the tray and the book go too
    prisoner.cutterMeals = 0;
    prisoner.plan = null;
    prisoner.fear = 1;
    prisoner.risk = Math.min(1, prisoner.risk + 0.5); // caught red-handed
    prisoner.sneaking = false;
    prisoner.timesCaught++;
    prisoner.pose = POSE_STAND;
    prisoner.phase = 0;
    prisoner.path = null;
    prisoner.state = "escorted";
    prisoner.escortedBy = guard.id;
    this.caughtCount++;
    // Guard marches him home.
    guard.chaseId = -1;
    guard.stakeTunnel = null;
    guard.state = "escorting";
    guard.interact = prisoner.id;
    const home = prisoner.bedIdx >= 0 ? prisoner.bedIdx
      : Math.floor(prisoner.z) * world.size + Math.floor(prisoner.x);
    if (!this.pathAdjacent(guard, world, home, (i) => passable(world, i, true))) {
      guard.path = null;
      guard.state = "patrol"; // nowhere to take him; release on the spot
      prisoner.state = "idle";
      prisoner.escortedBy = -1;
    }
  }

  // --- Guard ------------------------------------------------------------------

  private updateGuard(ag: Agent, dt: number, world: World) {
    const size = world.size;

    if (ag.state === "escorting") {
      const done = ag.path ? this.followPath(ag, dt, world, true) : true;
      if (done) {
        const p = this.agents.find((a) => a.id === ag.interact);
        if (p) { p.state = "idle"; p.escortedBy = -1; }
        ag.state = "patrol";
      }
      return;
    }

    // Intake: walk to the handcuffed newcomer, then march him to his cell.
    if (ag.state === "intakeGo") {
      const p = this.agents.find((a) => a.id === ag.interact);
      const room = world.rooms.get(ag.aux);
      if (!p || !p.cuffed || !room || !room.valid) {
        if (p && p.escortedBy === ag.id) p.escortedBy = -1;
        ag.state = "patrol"; ag.path = null;
        return;
      }
      const done = ag.path ? this.followPath(ag, dt, world, true) : true;
      if (!done) return;
      // Attached: head for a free bed in the assigned cell/dorm.
      const bed = this.freeBedInRoom(world, room);
      if (bed < 0 || !this.pathAdjacent(ag, world, bed, (i) => passable(world, i, true))) {
        p.escortedBy = -1;
        ag.state = "patrol";
        return;
      }
      p.state = "escorted";
      ag.state = "intakeEscort";
      ag.speedMul = 0.62; // cuffed men shuffle
      ag.chaseId = bed; // remember the bed for the handover
      return;
    }
    if (ag.state === "intakeEscort") {
      const p = this.agents.find((a) => a.id === ag.interact);
      if (!p) { ag.state = "patrol"; ag.speedMul = 1; ag.path = null; return; }
      const done = ag.path ? this.followPath(ag, dt, world, true) : true;
      if (!done) return;
      ag.speedMul = 1;
      const room = world.rooms.get(ag.aux);
      const bed = ag.chaseId;
      ag.chaseId = -1;
      if (room && room.valid && bed >= 0 && world.objKind[bed] === Obj.Bed && !this.claimedBeds.has(bed)) {
        p.cuffed = false;
        p.cellRoom = room.id;
        p.bedIdx = bed;
        this.claimedBeds.set(bed, p.id);
        p.x = ag.x; p.z = ag.z;
      }
      p.state = p.cuffed ? "cuffed" : "idle";
      p.escortedBy = -1;
      ag.state = "patrol";
      return;
    }

    // Regime enforcement: fetch the defier, then march him to the right room.
    if (ag.state === "regimeGo") {
      const p = this.agents.find((a) => a.id === ag.interact);
      if (!p || p.cuffed || p.underground || p.escortedBy !== ag.id) {
        if (p && p.escortedBy === ag.id) p.escortedBy = -1;
        ag.state = "patrol"; ag.path = null;
        return;
      }
      const done = ag.path ? this.followPath(ag, dt, world, true) : true;
      if (!done) return;
      if (!this.pathAdjacent(ag, world, ag.aux, (i) => passable(world, i, true))) {
        p.escortedBy = -1;
        ag.state = "patrol";
        return;
      }
      p.state = "escorted";
      p.path = null;
      ag.state = "regimeEscort";
      return;
    }
    if (ag.state === "regimeEscort") {
      const p = this.agents.find((a) => a.id === ag.interact);
      if (!p) { ag.state = "patrol"; ag.path = null; return; }
      const done = ag.path ? this.followPath(ag, dt, world, true) : true;
      if (!done) return;
      // Delivered: he complies for the rest of the hour (no punishment).
      p.compliant = true;
      p.state = "idle";
      p.escortedBy = -1;
      p.decideT = 0;
      ag.state = "patrol";
      return;
    }

    // Door tasks: walk to the jail door, work it, flip the state.
    if (ag.state === "toDoor") {
      const done = ag.path ? this.followPath(ag, dt, world, true) : true;
      if (!done) return;
      ag.state = "doorWork";
      ag.timer = 1.2;
      ag.heading = Math.atan2(
        (((ag.interact / size) | 0) + 0.5) - ag.z,
        ((ag.interact % size) + 0.5) - ag.x,
      );
      return;
    }
    if (ag.state === "doorWork") {
      ag.amp = Math.max(0, ag.amp - dt * 8);
      ag.timer -= dt;
      if (ag.timer > 0) return;
      if (world.objKind[ag.interact] === Obj.JailDoor) {
        world.jailClosed[ag.interact] = ag.aux ? 1 : 0;
        this.worldDirty = true;
      }
      const ti = this.doorTasks.findIndex((t) => t.idx === ag.interact);
      if (ti >= 0) this.doorTasks.splice(ti, 1);
      ag.state = "patrol";
      return;
    }

    if (ag.state === "chasing") {
      const target = this.agents.find((a) => a.id === ag.chaseId);
      // Worth chasing: caught in the act, or lying where a sniper put him.
      const bad = target && !target.underground &&
        (this.isEscaping(target) || target.state === "knockedOut");
      if (!target || !bad) { ag.chaseId = -1; ag.state = "patrol"; ag.path = null; }
      else {
        if (Math.hypot(target.x - ag.x, target.z - ag.z) < 1.4) {
          this.capture(ag, target, world);
          return;
        }
        // Re-path toward the runner occasionally.
        ag.aux -= dt;
        if (!ag.path || ag.aux <= 0) {
          ag.aux = 0.8;
          const ti = Math.floor(target.z) * size + Math.floor(target.x);
          if (!this.pathAdjacent(ag, world, ti, (i) => passable(world, i, true))) {
            ag.chaseId = -1; ag.state = "patrol"; ag.path = null; // unreachable (other side)
          }
        }
        if (ag.path) this.followPath(ag, dt, world, true);
        return;
      }
    }

    if (ag.state === "stakeout") {
      if (ag.path) { this.followPath(ag, dt, world, true); return; } // walk to the hole first
      ag.amp = Math.max(0, ag.amp - dt * 8);
      ag.timer -= dt;
      const t = ag.stakeTunnel;
      if (!t || !t.occupied || ag.timer <= 0 || !this.tunnels.includes(t)) {
        ag.stakeTunnel = null;
        ag.state = "patrol";
      }
      return;
    }

    // Work pickup & detection sweep (throttled). Priority: prisoners in the
    // act > visible misbehavior > jail doors > intake. Misbehavior and door
    // tasks interrupt a patrol leg — walking a beat never delays them.
    ag.decideT -= dt;
    if (ag.decideT <= 0) {
      ag.decideT = 0.4;

      // A man face-down in the yard is the most urgent thing in the prison:
      // he is a confirmed escaper, and he will get up again shortly.
      for (const p of this.agents) {
        if (p.kind !== Obj.Prisoner || p.state !== "knockedOut") continue;
        if (p.escortedBy >= 0) continue;
        if (this.agents.some((g) => g.kind === Obj.Guard && g.chaseId === p.id && g.id !== ag.id)) {
          continue; // someone else is already on their way
        }
        const ti = Math.floor(p.z) * size + Math.floor(p.x);
        if (!this.pathAdjacent(ag, world, ti, (i) => passable(world, i, true))) continue;
        ag.chaseId = p.id;
        ag.state = "chasing";
        ag.aux = 0;
        return;
      }

      // Prisoners in the act. Climbing/cutting is noisy: heard all around.
      for (const p of this.agents) {
        if (p.kind !== Obj.Prisoner || p.underground) continue;
        const noisy = p.state === "climbing" || p.state === "cutting";
        if (!noisy && p.state !== "fleeing") continue;
        if (!this.canSee(ag, world, p.x, p.z, noisy ? 10 : AWARE_R)) continue;
        ag.chaseId = p.id;
        ag.state = "chasing";
        ag.path = null;
        ag.aux = 0;
        return;
      }

      // Misbehavior: a prisoner visibly out of line — sneaking around,
      // somewhere prisoners aren't allowed, or defying the regime — gets
      // marched back where he belongs.
      for (const p of this.agents) {
        if (p.kind !== Obj.Prisoner || p.cuffed || p.underground) continue;
        if (p.escortedBy >= 0 || p.state === "escorted") continue;
        if (p.plan && (p.plan.stage === "execute" || p.plan.stage === "flee")) continue;
        const pi = Math.floor(p.z) * size + Math.floor(p.x);
        const outOfLine = p.sneaking || !prisonerAllowed(world, pi);
        // "Defiant" on paper but already doing the right thing? Leave him be.
        // Ditto a visibly filthy man off to a shower he's allowed to reach —
        // purposeful defiance is tolerated (trespassing still isn't).
        const excused = p.needs.hygiene < 0.1 &&
          this.usingKind(world, p) === Obj.Shower;
        const defying = this.curActivity !== REG.Free && !p.compliant &&
          !this.actingInRegime(this.curActivity, p, world) && !excused;
        if (!outOfLine && !defying) continue;
        if (!this.canSee(ag, world, p.x, p.z)) continue;
        // A starving man gets marched to the canteen, not back to his cell —
        // dumping him home just restarts the food run (and teaches nothing).
        const hungry = p.needs.food < 0.25;
        let dest = -1;
        if (hungry) {
          let bd2 = Infinity;
          for (const s of world.tilesOfKind(Obj.ServingTable)) {
            if (world.roomTypeAt(s) !== RoomType.Canteen) continue;
            if ((this.servingStock.get(s) ?? 0) <= 0) continue;
            const dd = Math.abs((s % size) - p.x) + Math.abs(((s / size) | 0) - p.z);
            if (dd < bd2) { bd2 = dd; dest = s; }
          }
        }
        if (dest < 0) dest = outOfLine && p.bedIdx >= 0 ? p.bedIdx : this.regimeDestination(world, p);
        if (dest < 0) continue;
        if (outOfLine) {
          // Hunger runs are desperation, not scheming: they don't teach
          // the wariness that gates hygiene/outdoors sneaks.
          if (!hungry) p.risk = Math.min(1, p.risk + 0.3); // busted
          p.sneaking = false;
        }
        p.escortedBy = ag.id;
        ag.interact = p.id;
        ag.aux = dest;
        ag.state = "regimeGo";
        if (!this.pathAdjacent(ag, world, pi, (i) => passable(world, i, true))) {
          p.escortedBy = -1;
          ag.state = "patrol";
          ag.decideT = 1.6; // unreachable: don't hammer the pathfinder
          continue;
        }
        return;
      }

      // Jail door tasks trump the rest of the routine.
      let task = null, bd = Infinity;
      for (const t of this.doorTasks) {
        if (t.claimedBy >= 0) continue;
        const d = Math.abs((t.idx % size) - ag.x) + Math.abs(((t.idx / size) | 0) - ag.z);
        if (d < bd) { bd = d; task = t; }
      }
      if (task) {
        if (this.pathAdjacent(ag, world, task.idx, (i) => passable(world, i, true))) {
          task.claimedBy = ag.id;
          ag.interact = task.idx;
          ag.aux = task.close ? 1 : 0;
          ag.state = "toDoor";
          return;
        }
        ag.decideT = 1.6; // unreachable door: back off before retrying
      }

      // A cuffed newcomer waiting, and a free cell for him?
      if (!ag.path) {
        for (const p of this.agents) {
          if (p.kind !== Obj.Prisoner || !p.cuffed || p.escortedBy >= 0) continue;
          const room = this.findFreeCell(world, p);
          if (!room) break; // no capacity anywhere
          const pi = Math.floor(p.z) * size + Math.floor(p.x);
          if (!this.pathAdjacent(ag, world, pi, (i) => passable(world, i, true))) continue;
          p.escortedBy = ag.id;
          ag.interact = p.id;
          ag.aux = room.id;
          ag.state = "intakeGo";
          return;
        }
      }

      // Unflagged breaches.
      for (const b of this.cutFences) {
        if (this.flaggedCuts.has(b)) continue;
        if (!this.canSee(ag, world, (b % size) + 0.5, ((b / size) | 0) + 0.5)) continue;
        this.flaggedCuts.add(b);
        this.repairJobs.push({ kind: "fence", idx: b, claimedBy: -1 });
      }
      for (const t of this.tunnels) {
        if (!t.flagged) {
          const ex = (t.entry % size) + 0.5, ez = ((t.entry / size) | 0) + 0.5;
          if (this.canSee(ag, world, ex, ez)) {
            t.flagged = true;
            this.repairJobs.push({ kind: "tunnel", idx: t.entry, claimedBy: -1 });
            if (t.occupied) {
              // Someone's down there: stake out the hole.
              ag.stakeTunnel = t;
              ag.timer = STAKEOUT_TIME;
              if (this.pathAdjacent(ag, world, t.entry, (i) => passable(world, i, true))) {
                ag.state = "stakeout"; // walks there, then waits (path runs first)
              }
              return;
            }
          }
        }
        if (t.surfHole >= 0 && !this.flaggedHoles.has(t.surfHole)) {
          if (this.canSee(ag, world, (t.surfHole % size) + 0.5, ((t.surfHole / size) | 0) + 0.5)) {
            this.flaggedHoles.add(t.surfHole);
            this.repairJobs.push({ kind: "hole", idx: t.surfHole, claimedBy: -1 });
          }
        }
      }
    }

    // Patrolling.
    if (ag.path) { this.followPath(ag, dt, world, true); }
    else {
      ag.amp = Math.max(0, ag.amp - dt * 8);
      ag.timer -= dt;
      if (ag.timer <= 0) {
        ag.timer = 1.5 + Math.random() * 2.5;
        this.pickPatrolTarget(ag, world);
      }
    }
  }

  /** Is this prisoner's current state already serving the given activity?
   *
   *  Since needs run through one generic "toUse"/"using" pair, a state name no
   *  longer says WHAT he is doing — so ask what he is walking to or using. */
  private usingKind(world: World, p: Agent): number {
    if (p.state === "using" && p.useIdx >= 0) return world.objKind[p.useIdx];
    if ((p.state === "toUse" || p.state === "toQueue") && p.interact >= 0) {
      return world.objKind[p.interact];
    }
    return Obj.None;
  }

  private actingInRegime(act: number, p: Agent, world: World): boolean {
    const s = p.state;
    const k = this.usingKind(world, p);
    switch (act) {
      case REG.Sleep:
      case REG.Lockup:
        return k === Obj.Bed || s === "sleepFloor" || s === "inCell" || s === "regimeToCell";
      case REG.Eating:
        // Eating, queueing for a tray, or already walking one to a table.
        return k === Obj.Table || k === Obj.ServingTable || s === "queueing" ||
          hasItem(p.inv, Item.Tray);
      case REG.Yard:
        return s === "toYard" || s === "yardTime";
      case REG.Shower:
        return k === Obj.Shower || s === "inCell" || s === "regimeToCell";
    }
    return false;
  }

  /** Where should a prisoner be under the current regime activity? */
  private regimeDestination(world: World, p: Agent): number {
    const act = this.curActivity;
    switch (act) {
      case REG.Sleep:
      case REG.Lockup:
        return p.bedIdx >= 0 && world.objKind[p.bedIdx] === Obj.Bed ? p.bedIdx : -1;
      case REG.Eating: {
        for (const s of world.tilesOfKind(Obj.ServingTable)) {
          if (world.roomTypeAt(s) === RoomType.Canteen) return s;
        }
        return -1;
      }
      case REG.Yard: {
        for (const r of world.rooms.values()) {
          if (r.valid && r.type === RoomType.Yard) return r.tiles.values().next().value!;
        }
        return -1;
      }
      case REG.Shower: {
        if (p.cellRoom >= 0 && this.cellHasShower(world, p)) return p.bedIdx;
        for (const s of world.tilesOfKind(Obj.Shower)) {
          if (world.roomTypeAt(s) === RoomType.ShowerRoom) return s;
        }
        return -1;
      }
    }
    return -1;
  }

  /** An unclaimed bed anchor inside a room, or -1. */
  private freeBedInRoom(world: World, room: Room): number {
    for (const b of world.piecesOfKind(Obj.Bed)) {
      const anchor = world.idx(b.x, b.z);
      if (!room.tiles.has(anchor) || this.claimedBeds.has(anchor)) continue;
      return anchor;
    }
    return -1;
  }

  /** Nearest valid cell/dorm with capacity for one more prisoner. */
  private findFreeCell(world: World, p: Agent): Room | null {
    let best: Room | null = null, bd = Infinity;
    for (const r of world.rooms.values()) {
      if (!r.valid || (r.type !== RoomType.Cell && r.type !== RoomType.Dorm)) continue;
      if (r.type === RoomType.Cell && this.agents.some((a) => a.cellRoom === r.id)) continue;
      if (this.freeBedInRoom(world, r) < 0) continue;
      const t: number = r.tiles.values().next().value!;
      const d = Math.abs((t % world.size) - p.x) + Math.abs(((t / world.size) | 0) - p.z);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  /** Where a free guard wanders when he has nothing better to do.
   *
   *  Guards used to patrol the perimeter almost exclusively, which left the
   *  prison itself unwatched — all the walls and fences are on the OUTSIDE, so
   *  a wall-biased patrol is a patrol of the empty edges. So: mostly go where
   *  the prisoners are, and let the sniper towers watch the fence line. */
  private pickPatrolTarget(ag: Agent, world: World) {
    const open = (i: number) =>
      passable(world, i, true) && world.accessAt(i) !== Access.Forbidden;

    // Head for a crowd. Each prisoner is a vote for his own patch of floor, so
    // the busiest rooms draw the most guards without any density map.
    //
    // The bias has to be strong. A perimeter leg is enormously longer than an
    // interior one, so even a modest chance of picking the fence would eat most
    // of a guard's day walking to and from it — which is exactly the problem the
    // sniper towers exist to solve.
    const crowd = this.agents.filter((a) => a.kind === Obj.Prisoner && !a.underground);
    if (crowd.length > 0) {
      // Weight by how unwatched each man is: the further from any guard, the
      // more he needs one. This spreads guards out instead of clumping them.
      let best: Agent | null = null, bestScore = -Infinity;
      for (let n = 0; n < Math.min(8, crowd.length); n++) {
        const p = crowd[(Math.random() * crowd.length) | 0];
        let nearest = Infinity;
        for (const g of this.agents) {
          if (g.kind !== Obj.Guard || g.id === ag.id) continue;
          nearest = Math.min(nearest, Math.abs(g.x - p.x) + Math.abs(g.z - p.z));
        }
        const mine = Math.abs(ag.x - p.x) + Math.abs(ag.z - p.z);
        const score = Math.min(nearest, 60) - mine * 0.35 + Math.random() * 6;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (best) {
        const ti = world.idx(Math.floor(best.x), Math.floor(best.z));
        if (this.pathAdjacent(ag, world, ti, open)) return;
      }
    }

    // Nobody to watch (or nobody he can reach): fall back to walking the line.
    // This is now the exception, not the rule — the towers watch the wire.
    //
    // Even then, pick a stretch of fence NEAR him: a random tile of a 200-tile
    // perimeter would send him on a march right across the map.
    const fences = world.tilesOfKind(Obj.Fence);
    const walls = world.tilesOfKind(Obj.Wall);
    const pool = fences.length > 0 ? fences : walls;
    if (pool.length === 0) return;
    let best = -1, bd = Infinity;
    for (let n = 0; n < Math.min(24, pool.length); n++) {
      const t = pool[(Math.random() * pool.length) | 0];
      const d = Math.abs((t % world.size) - ag.x) + Math.abs(((t / world.size) | 0) - ag.z) +
        Math.random() * 10;
      if (d < bd) { bd = d; best = t; }
    }
    if (best >= 0) this.pathAdjacent(ag, world, best, open);
  }

  // --- Sniper ------------------------------------------------------------------
  //
  // A tower is a post that hires itself: build one and a sniper turns up. He
  // never leaves it. He sees a long way and he shoots escapers — with a
  // non-lethal round, so a hit is a man face-down in the dirt, not a corpse.
  //
  // The point of him is to free the foot guards from the fence line, which is
  // where they used to spend nearly all their time.

  /** Post a sniper to every tower that hasn't got one, and retire the rest. */
  private manTowers(world: World) {
    const towers = world.piecesOfKind(Obj.SniperTower);
    const manned = new Set<number>();
    for (let n = this.agents.length - 1; n >= 0; n--) {
      const ag = this.agents[n];
      if (ag.kind !== Obj.Sniper) continue;
      // His tower was demolished under him.
      if (!towers.some((t) => world.idx(t.x, t.z) === ag.postIdx)) {
        this.removeAgent(ag);
        continue;
      }
      manned.add(ag.postIdx);
    }
    for (const t of towers) {
      const anchor = world.idx(t.x, t.z);
      if (manned.has(anchor)) continue;
      // Stand him at the middle of the platform, up top.
      const tiles = world.pieceTiles(t);
      let sx = 0, sz = 0;
      for (const i of tiles) { sx += i % world.size; sz += (i / world.size) | 0; }
      this.agents.push({
        ...this.blankAgent(Obj.Sniper),
        id: this.nextId++,
        x: sx / tiles.length + 0.5, z: sz / tiles.length + 0.5,
        elev: TOWER_HEIGHT,
        postIdx: anchor,
        state: "scanning",
      });
    }
  }

  /** Is this man visibly in the middle of getting out? */
  private isEscaping(p: Agent): boolean {
    if (p.kind !== Obj.Prisoner || p.underground) return false;
    if (p.state === "climbing" || p.state === "cutting" || p.state === "fleeing") return true;
    return p.plan?.stage === "flee";
  }

  private updateSniper(ag: Agent, dt: number, world: World) {
    ag.amp = 0;
    ag.pose = POSE_STAND;
    ag.timer -= dt;

    // Lining one up already?
    if (ag.state === "aiming") {
      const target = this.agents.find((a) => a.id === ag.chaseId);
      if (!target || !this.isEscaping(target) || !this.canSee(ag, world, target.x, target.z)) {
        ag.chaseId = -1;
        ag.state = "scanning";
        return;
      }
      ag.heading = Math.atan2(target.z - ag.z, target.x - ag.x);
      if (ag.timer <= 0) {
        this.knockOut(target, world);
        ag.chaseId = -1;
        ag.state = "scanning";
        ag.timer = SNIPER_RELOAD;
      }
      return;
    }

    // Sweep the field of fire.
    ag.heading += dt * 0.35;
    if (ag.timer > 0) return; // reloading

    ag.decideT -= dt;
    if (ag.decideT > 0) return;
    ag.decideT = 0.25;

    let best: Agent | null = null, bd = Infinity;
    for (const p of this.agents) {
      if (!this.isEscaping(p)) continue;
      // A tower has line of sight over the whole yard, so no facing cone —
      // he is looking for exactly this and nothing else.
      if (!this.canSee(ag, world, p.x, p.z, SNIPER_RANGE)) continue;
      const d = Math.hypot(p.x - ag.x, p.z - ag.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    ag.chaseId = best.id;
    ag.state = "aiming";
    ag.timer = SNIPER_AIM;
    // Every guard who can be spared converges on the shot.
    this.raiseAlarm(best, world);
  }

  /** A non-lethal round: he goes down, his kit is scattered, the escape is off.
   *  He comes round in KO_TIME — sooner if a guard collects him first. */
  private knockOut(p: Agent, world: World) {
    if (p.state === "knockedOut") return;
    seizeContraband(p.inv);
    clearInventory(p.inv);
    this.releaseUse(p);
    if (p.tunnel) p.tunnel.occupied = false;
    p.plan = null;
    p.path = null;
    p.underground = false;
    p.sneaking = false;
    p.fear = 1;
    p.risk = Math.min(1, p.risk + 0.6);
    p.timesCaught++;
    p.pose = POSE_LIE_FLOOR;
    p.amp = 0;
    p.state = "knockedOut";
    p.timer = KO_TIME;
    p.escortedBy = -1;
    this.caughtCount++;
    this.worldDirty = true;
    void world;
  }

  /** An escape in progress outranks every patrol and every posting: the nearest
   *  few guards drop what they are doing and run at it. */
  private raiseAlarm(runner: Agent, world: World) {
    const RESPONDERS = 3;
    const free = this.agents
      .filter((a) => a.kind === Obj.Guard && a.state !== "escorting" &&
        a.state !== "intakeEscort" && a.state !== "regimeEscort" && a.chaseId !== runner.id)
      .sort((a, b) =>
        (Math.hypot(a.x - runner.x, a.z - runner.z)) -
        (Math.hypot(b.x - runner.x, b.z - runner.z)));
    let sent = 0;
    for (const g of free) {
      if (sent >= RESPONDERS) break;
      const ti = world.idx(Math.floor(runner.x), Math.floor(runner.z));
      if (!this.pathAdjacent(g, world, ti, (i) => passable(world, i, true))) continue;
      g.chaseId = runner.id;
      g.state = "chasing";
      g.aux = 0;
      sent++;
    }
  }

  // --- Workman -----------------------------------------------------------------

  private updateWorkman(ag: Agent, dt: number, world: World) {
    const size = world.size;
    if (ag.path) {
      const done = this.followPath(ag, dt, world, true);
      if (done && ag.job) { ag.state = "repairing"; ag.timer = REPAIR_TIME; }
      return;
    }
    if (ag.state === "repairing" && ag.job) {
      ag.amp = Math.max(0, ag.amp - dt * 8);
      ag.timer -= dt;
      if (ag.timer > 0) return;
      const job = ag.job;
      if (job.kind === "fence") {
        world.repairFenceAt(job.idx);
        this.cutFences.delete(job.idx);
        this.flaggedCuts.delete(job.idx);
        this.worldDirty = true;
      } else if (job.kind === "tunnel") {
        const t = this.tunnels.find((tn) => tn.entry === job.idx);
        if (t && t.occupied) {
          // Someone's inside — come back later.
          job.claimedBy = -1;
          ag.job = null;
          ag.state = "idle";
          return;
        }
        if (t) {
          if (t.surfHole >= 0) this.flaggedHoles.delete(t.surfHole);
          this.tunnels.splice(this.tunnels.indexOf(t), 1);
          this.mealsDirty = true;
        }
      } else {
        const t = this.tunnels.find((tn) => tn.surfHole === job.idx);
        if (t) { t.surfHole = -1; this.mealsDirty = true; }
        this.flaggedHoles.delete(job.idx);
      }
      const ji = this.repairJobs.indexOf(job);
      if (ji >= 0) this.repairJobs.splice(ji, 1);
      ag.job = null;
      ag.state = "idle";
      return;
    }

    ag.amp = Math.max(0, ag.amp - dt * 8);
    ag.decideT -= dt;
    if (ag.decideT > 0) return;
    ag.decideT = 1.0;

    // Claim the nearest open job.
    let best: RepairJob | null = null, bd = Infinity;
    for (const job of this.repairJobs) {
      if (job.claimedBy >= 0) continue;
      const d = Math.abs((job.idx % size) - ag.x) + Math.abs(((job.idx / size) | 0) - ag.z);
      if (d < bd) { bd = d; best = job; }
    }
    if (best && this.pathAdjacent(ag, world, best.idx, (i) => passable(world, i, true))) {
      best.claimedBy = ag.id;
      ag.job = best;
      ag.state = "toJob";
    }
  }

  // --- Cook --------------------------------------------------------------------

  private updateCook(ag: Agent, dt: number, world: World) {
    const size = world.size;
    if (ag.cookerIdx >= 0 && world.objKind[ag.cookerIdx] !== Obj.Cooker) {
      this.claimedCookers.delete(ag.cookerIdx);
      ag.cookerIdx = -1;
      ag.state = "idle";
    }

    if (ag.path) {
      const arrived = this.followPath(ag, dt, world, true);
      if (!arrived) return;
      if (ag.state === "toCooker") {
        ag.state = "cooking";
        ag.timer = COOK_TIME;
        ag.heading = Math.atan2(
          (((ag.cookerIdx / size) | 0) + 0.5) - ag.z,
          ((ag.cookerIdx % size) + 0.5) - ag.x,
        );
      } else if (ag.state === "delivering") {
        // Stock the serving table.
        if (world.objKind[ag.interact] === Obj.ServingTable) {
          const cur = this.servingStock.get(ag.interact) ?? 0;
          if (cur < SERVING_CAP) {
            this.servingStock.set(ag.interact, cur + 1);
            this.mealsDirty = true;
          }
        }
        removeItem(ag.inv, Item.Tray);
        ag.state = "idle";
      } else if (ag.state === "toServeDuty") {
        ag.state = "manning";
        ag.heading = Math.atan2(
          (((ag.interact / size) | 0) + 0.5) - ag.z,
          ((ag.interact % size) + 0.5) - ag.x,
        );
      }
      return;
    }

    ag.amp = Math.max(0, ag.amp - dt * 8);

    // Manning the serving table during eating hours.
    if (ag.state === "manning") {
      if (this.curActivity !== REG.Eating || this.servers.get(ag.interact) !== ag.id) {
        this.servers.delete(ag.interact);
        ag.state = "idle";
      }
      return;
    }

    /** Serving tables in valid canteens. */
    const servingTables = () => world.tilesOfKind(Obj.ServingTable)
      .filter((i) => world.roomTypeAt(i) === RoomType.Canteen);

    switch (ag.state) {
      case "cooking": {
        // Serving duty trumps the stove during eating hours.
        if (this.curActivity === REG.Eating) {
          for (const s of servingTables()) {
            if (this.servers.has(s) || (this.servingStock.get(s) ?? 0) <= 0) continue;
            if (this.pathAdjacent(ag, world, s, (i) => passable(world, i, true))) {
              this.servers.set(s, ag.id);
              ag.interact = s;
              ag.state = "toServeDuty";
              removeItem(ag.inv, Item.Tray);
              return;
            }
          }
        }
        ag.timer -= dt;
        if (ag.timer > 0) return;
        // Meal's up: carry it to the least-stocked serving table.
        let best = -1, bs = Infinity;
        for (const s of servingTables()) {
          const stock = this.servingStock.get(s) ?? 0;
          if (stock >= SERVING_CAP) continue;
          if (stock < bs) { bs = stock; best = s; }
        }
        if (best >= 0 && this.pathAdjacent(ag, world, best, (i) => passable(world, i, true))) {
          ag.state = "delivering";
          ag.interact = best;
          takeInHands(ag.inv, Item.Tray); // both hands, all the way to the counter
        } else {
          ag.timer = 3; // everything full (or no serving table): hold the meal
        }
        return;
      }
      default: {
        // Eating hour: someone has to hand the trays out.
        if (this.curActivity === REG.Eating) {
          for (const s of servingTables()) {
            if (this.servers.has(s)) continue;
            if ((this.servingStock.get(s) ?? 0) <= 0) continue;
            if (this.pathAdjacent(ag, world, s, (i) => passable(world, i, true))) {
              this.servers.set(s, ag.id);
              ag.interact = s;
              ag.state = "toServeDuty";
              return;
            }
          }
        }
        // Strict chain: no serving table in a canteen -> nothing to cook for.
        if (servingTables().length === 0) return;
        if (ag.cookerIdx < 0) {
          let best = -1, bd = Infinity;
          for (const i of world.tilesOfKind(Obj.Cooker)) {
            if (this.claimedCookers.has(i)) continue;
            // Strict chain: only cookers inside a valid Kitchen are used.
            if (world.roomTypeAt(i) !== RoomType.Kitchen) continue;
            const d = Math.abs((i % size) - ag.x) + Math.abs(((i / size) | 0) - ag.z);
            if (d < bd) { bd = d; best = i; }
          }
          if (best < 0) return;
          this.claimedCookers.set(best, ag.id);
          ag.cookerIdx = best;
        }
        if (this.pathAdjacent(ag, world, ag.cookerIdx, (i) => passable(world, i, true))) {
          ag.state = "toCooker";
        }
        return;
      }
    }
  }

  // --- Render data ---------------------------------------------------------------

  personInstances(): {
    prisoners: Float32Array; guards: Float32Array; cooks: Float32Array;
    workmen: Float32Array; snipers: Float32Array;
  } {
    const out: Record<number, number[]> = {
      [Obj.Prisoner]: [], [Obj.Guard]: [], [Obj.Cook]: [], [Obj.Workman]: [],
      [Obj.Sniper]: [],
    };
    for (const ag of this.agents) {
      if (ag.underground) continue;
      const [h0, h1] = heldSlots(ag.inv);
      out[ag.kind].push(
        ag.x, ag.z, ag.heading, ag.baton || ag.kind === Obj.Sniper ? 1 : 0,
        ag.pose, ag.phase, ag.amp,
        (ag.cuffed ? 1 : 0) + (h0 === Item.Tray || h1 === Item.Tray ? 2 : 0), // flags
        h0, h1,
        ag.elev,
      );
    }
    return {
      prisoners: new Float32Array(out[Obj.Prisoner]),
      guards: new Float32Array(out[Obj.Guard]),
      cooks: new Float32Array(out[Obj.Cook]),
      workmen: new Float32Array(out[Obj.Workman]),
      snipers: new Float32Array(out[Obj.Sniper]),
    };
  }

  foodInstances(world: World): Float32Array {
    const out: number[] = [];
    for (const i of this.mealTables) {
      if (world.objKind[i] !== Obj.Table) { this.mealTables.delete(i); this.mealsDirty = true; continue; }
      out.push(i % world.size, (i / world.size) | 0, world.objOrient[i]);
    }
    return new Float32Array(out);
  }

  /** Tray stacks on stocked serving tables. */
  trayStackInstances(world: World): Float32Array {
    const out: number[] = [];
    for (const [i, stock] of this.servingStock) {
      if (world.objKind[i] !== Obj.ServingTable) { this.servingStock.delete(i); continue; }
      if (stock <= 0) continue;
      out.push(i % world.size, (i / world.size) | 0, world.objOrient[i]);
    }
    return new Float32Array(out);
  }

  /** Tunnel entry holes (beside displaced toilets) and surfacing holes. */
  holeInstances(world: World): { entries: Float32Array; surfs: Float32Array } {
    const entries: number[] = [], surfs: number[] = [];
    for (const t of this.tunnels) {
      entries.push(t.entry % world.size, (t.entry / world.size) | 0, world.objOrient[t.entry]);
      if (t.surfHole >= 0) surfs.push(t.surfHole % world.size, (t.surfHole / world.size) | 0, 0);
    }
    return { entries: new Float32Array(entries), surfs: new Float32Array(surfs) };
  }

  knownOverlay(ag: Agent, world: World): Float32Array {
    if (!ag.known) return new Float32Array(0);
    const out: number[] = [];
    for (const [i, v] of ag.known) {
      out.push(i % world.size, (i / world.size) | 0, v === K_OPEN || v === K_CUT ? 0 : 1);
    }
    for (const s of ag.objMem!.values()) {
      for (const i of s) out.push(i % world.size, (i / world.size) | 0, 2);
    }
    // Active tunnel: believed line vs actual head.
    if (ag.tunnel) {
      const t = ag.tunnel;
      const sx = (t.entry % world.size) + 0.5, sz = ((t.entry / world.size) | 0) + 0.5;
      for (let d = 1; d <= t.believed; d++) {
        out.push(Math.floor(sx + Math.cos(t.heading) * d), Math.floor(sz + Math.sin(t.heading) * d), 2);
      }
      out.push(Math.floor(t.actualX), Math.floor(t.actualZ), 1);
    }
    return new Float32Array(out);
  }

  issueLabels(world: World): IssueLabel[] {
    const out: IssueLabel[] = [];
    for (const t of this.doorTasks) {
      const claimed = t.claimedBy >= 0;
      out.push({
        id: `door-${t.idx}`,
        x: (t.idx % world.size) + 0.5,
        z: ((t.idx / world.size) | 0) + 0.5,
        issue: `${t.close ? "Close" : "Open"} jail door task${claimed ? " in progress" : " waiting for a reachable guard"}.`,
      });
    }
    for (const j of this.repairJobs) {
      const claimed = j.claimedBy >= 0;
      const what = j.kind === "fence" ? "cut fence" : j.kind === "tunnel" ? "tunnel entry" : "surface hole";
      out.push({
        id: `repair-${j.kind}-${j.idx}`,
        x: (j.idx % world.size) + 0.5,
        z: ((j.idx / world.size) | 0) + 0.5,
        issue: `Repair ${what}${claimed ? " in progress" : " waiting for a reachable workman"}.`,
      });
    }
    if (this.curActivity === REG.Eating) {
      for (const s of world.tilesOfKind(Obj.ServingTable)) {
        if (world.objKind[s] !== Obj.ServingTable || world.roomTypeAt(s) !== RoomType.Canteen) continue;
        const stock = this.servingStock.get(s) ?? 0;
        if (stock > 0 && this.servers.has(s)) continue;
        out.push({
          id: `serve-${s}`,
          x: (s % world.size) + 0.5,
          z: ((s / world.size) | 0) + 0.5,
          issue: stock <= 0 ? "Serving table is out of meals." : "Serving table has meals but no cook is manning it.",
        });
      }
    }
    return out;
  }

  diagnostics(world: World) {
    const states: Record<string, number> = {};
    const kinds = { prisoners: 0, guards: 0, cooks: 0, workmen: 0 };
    let noCell = 0, cuffed = 0, nonCompliant = 0, withPlan = 0, underground = 0;
    let lowFood = 0, lowSleep = 0, lowOutdoors = 0, lowComfort = 0, lowHygiene = 0;
    let avgFood = 0, avgSleep = 0, avgOutdoors = 0, avgComfort = 0, avgHygiene = 0;
    let sneaking = 0, avgRisk = 0;
    const prisoners = this.agents.filter((a) => a.kind === Obj.Prisoner);
    for (const ag of this.agents) {
      states[ag.state] = (states[ag.state] ?? 0) + 1;
      if (ag.kind === Obj.Prisoner) kinds.prisoners++;
      else if (ag.kind === Obj.Guard) kinds.guards++;
      else if (ag.kind === Obj.Cook) kinds.cooks++;
      else if (ag.kind === Obj.Workman) kinds.workmen++;
    }
    for (const p of prisoners) {
      if (p.cellRoom < 0) noCell++;
      if (p.cuffed) cuffed++;
      if (!p.compliant) nonCompliant++;
      if (p.plan) withPlan++;
      if (p.underground) underground++;
      if (p.sneaking) sneaking++;
      avgRisk += p.risk;
      const n = p.needs;
      avgFood += n.food; avgSleep += n.sleep; avgOutdoors += n.outdoors;
      avgComfort += n.comfort; avgHygiene += n.hygiene;
      if (n.food < 0.25) lowFood++;
      if (n.sleep < 0.25) lowSleep++;
      if (n.outdoors < 0.25) lowOutdoors++;
      if (n.comfort < 0.25) lowComfort++;
      if (n.hygiene < 0.25) lowHygiene++;
    }
    const denom = Math.max(1, prisoners.length);
    let servingTables = 0, stockedServingTables = 0, mannedServingTables = 0;
    for (const s of world.tilesOfKind(Obj.ServingTable)) {
      if (world.roomTypeAt(s) !== RoomType.Canteen) continue;
      servingTables++;
      if ((this.servingStock.get(s) ?? 0) > 0) stockedServingTables++;
      if (this.servers.has(s)) mannedServingTables++;
    }
    return {
      kinds,
      states,
      prisoners: {
        noCell,
        cuffed,
        nonCompliant,
        withPlan,
        underground,
        sneaking,
        avgRisk: avgRisk / denom,
        lowNeeds: { food: lowFood, sleep: lowSleep, outdoors: lowOutdoors, comfort: lowComfort, hygiene: lowHygiene },
        avgNeeds: {
          food: avgFood / denom,
          sleep: avgSleep / denom,
          outdoors: avgOutdoors / denom,
          comfort: avgComfort / denom,
          hygiene: avgHygiene / denom,
        },
      },
      tasks: {
        door: this.doorTasks.length,
        unclaimedDoor: this.doorTasks.filter((t) => t.claimedBy < 0).length,
        repair: this.repairJobs.length,
        unclaimedRepair: this.repairJobs.filter((j) => j.claimedBy < 0).length,
      },
      food: {
        mealTables: this.mealTables.size,
        servingTables,
        stockedServingTables,
        mannedServingTables,
        totalServingStock: [...this.servingStock.values()].reduce((a, b) => a + b, 0),
      },
      security: {
        tunnels: this.tunnels.length,
        occupiedTunnels: this.tunnels.filter((t) => t.occupied).length,
        cutFences: this.cutFences.size,
        escaped: this.escapedCount,
        caught: this.caughtCount,
      },
    };
  }

  saveData() {
    const serMap = (m: Map<number, number> | null) => m ? [...m.entries()] : null;
    const serMem = (m: Map<number, Set<number>> | null): [number, number[]][] | null =>
      m ? [...m].map(([kind, tiles]) => [kind, [...tiles]]) : null;
    return {
      nextId: this.nextId,
      regime: [...this.regime],
      curHour: this.curHour,
      curActivity: this.curActivity,
      escapedCount: this.escapedCount,
      caughtCount: this.caughtCount,
      stashes: [...this.stashes].map(([bed, items]) => ({
        bed, items: items.map((i) => ({ ...i })),
      })),
      mealTables: [...this.mealTables],
      servingStock: [...this.servingStock.entries()],
      tunnels: this.tunnels.map((t) => ({ ...t })),
      cutFences: [...this.cutFences],
      repairJobs: this.repairJobs.map((j) => ({ ...j })),
      doorTasks: this.doorTasks.map((t) => ({ ...t, claimedBy: -1 })),
      agents: this.agents.map((a) => ({
        ...a,
        path: a.path ? [...a.path] : null,
        needs: { ...a.needs },
        known: serMap(a.known),
        objMem: serMem(a.objMem),
        inv: { hands: a.inv.hands.map((x) => ({ ...x })), pockets: a.inv.pockets.map((x) => x && { ...x }) },
        plan: a.plan ? { ...a.plan, breaches: [...a.plan.breaches] } : null,
        tunnel: a.tunnel ? { ...a.tunnel } : null,
        job: a.job ? { ...a.job, claimedBy: -1 } : null,
        stakeTunnel: null,
        escortedBy: -1,
      })),
    };
  }

  loadData(data: ReturnType<Agents["saveData"]> & LegacyAgentSave) {
    this.agents.length = 0;
    this.claimedBeds.clear();
    this.claimedCookers.clear();
    this.useClaims.clear();
    this.stashes.clear();
    this.mealTables.clear();
    this.tunnels.length = 0;
    this.cutFences.clear();
    this.repairJobs.length = 0;
    this.doorTasks.length = 0;
    this.servingStock.clear();
    this.servers.clear();

    this.nextId = data.nextId ?? 1;
    this.regime.splice(0, this.regime.length, ...(data.regime ?? defaultRegime()));
    this.curHour = data.curHour ?? -1;
    this.curActivity = data.curActivity ?? REG.Free;
    this.escapedCount = data.escapedCount ?? 0;
    this.caughtCount = data.caughtCount ?? 0;
    for (const { bed, items } of data.stashes ?? []) {
      this.stashes.set(bed, items.map((i) => ({ ...i })));
    }
    for (const i of data.mealTables ?? []) this.mealTables.add(i);
    for (const [i, n] of data.servingStock ?? []) this.servingStock.set(i, n);
    for (const t of data.tunnels ?? []) this.tunnels.push({ ...t });
    for (const i of data.cutFences ?? []) this.cutFences.add(i);
    for (const j of data.repairJobs ?? []) this.repairJobs.push({ ...j, claimedBy: -1 });
    for (const t of data.doorTasks ?? []) this.doorTasks.push({ ...t, claimedBy: -1 });

    const deMap = (v: [number, number][] | null) => v ? new Map(v) : null;
    // Saves written before the registry kept one Set per object type.
    const deMem = (raw: LegacyAgentMem): Map<number, Set<number>> | null => {
      if (raw.objMem) return new Map(raw.objMem.map(([k, t]) => [k, new Set(t)]));
      const legacy: [number, number[] | null | undefined][] = [
        [Obj.Bed, raw.beds], [Obj.Table, raw.tables], [Obj.Toilet, raw.toilets],
        [Obj.Shower, raw.showers], [Obj.ServingTable, raw.servings],
      ];
      const any = raw.beds ?? raw.tables ?? raw.benches ?? raw.toilets ??
        raw.showers ?? raw.servings;
      if (!any) return null; // staff: no memory at all
      const m = new Map<number, Set<number>>();
      for (const [kind, tiles] of legacy) if (tiles) m.set(kind, new Set(tiles));
      // Bench tiles were one pooled set; they can't be split back per kind, so
      // file them under the kind actually on each tile at load.
      for (const t of raw.benches ?? []) {
        const k = Obj.Bench2; // refined on first sight; both are benches
        let s = m.get(k);
        if (!s) m.set(k, s = new Set());
        s.add(t);
      }
      return m;
    };

    for (const raw of data.agents ?? []) {
      const ag = {
        ...raw,
        path: raw.path ? [...raw.path] : null,
        needs: { ...raw.needs, recreation: raw.needs.recreation ?? 0.8 },
        known: deMap(raw.known),
        objMem: deMem(raw as LegacyAgentMem),
        // Pre-inventory saves have no `inv`; those prisoners start empty-handed.
        inv: raw.inv
          ? { hands: (raw.inv.hands ?? []).map((x) => ({ ...x })),
              pockets: padPockets(raw.inv.pockets) }
          : newInventory(),
        cutterMeals: raw.cutterMeals ?? 0,
        useIdx: -1, // claims are re-taken on the next decision
        seatIdx: -1,
        elev: raw.elev ?? 0,
        postIdx: raw.postIdx ?? -1,
        plan: raw.plan ? { ...raw.plan, breaches: [...raw.plan.breaches] } : null,
        tunnel: raw.tunnel ? this.tunnels.find((t) => t.owner === raw.tunnel!.owner && t.entry === raw.tunnel!.entry) ?? { ...raw.tunnel } : null,
        job: null,
        stakeTunnel: null,
        escortedBy: -1,
        risk: raw.risk ?? 0, // older saves predate risk memory
        sneaking: raw.sneaking ?? false,
      } as Agent;
      if (ag.state === "using" || ag.state === "toUse") ag.state = "idle";
      this.agents.push(ag);
      if (ag.bedIdx >= 0) this.claimedBeds.set(ag.bedIdx, ag.id);
      if (ag.cookerIdx >= 0) this.claimedCookers.set(ag.cookerIdx, ag.id);
    }
    this.mealsDirty = true;
    this.worldDirty = true;
  }
}

/** Pockets must always be exactly POCKET_SLOTS long, however a save left them. */
function padPockets(p: (Stack | null)[] | undefined): (Stack | null)[] {
  const out: (Stack | null)[] = new Array(POCKET_SLOTS).fill(null);
  for (let i = 0; i < Math.min(POCKET_SLOTS, p?.length ?? 0); i++) {
    const s = p![i];
    out[i] = s ? { ...s } : null;
  }
  return out;
}

/** Per-agent memory as older saves stored it: one array per object type. */
interface LegacyAgentMem {
  objMem?: [number, number[]][] | null;
  beds?: number[] | null;
  tables?: number[] | null;
  benches?: number[] | null;
  toilets?: number[] | null;
  showers?: number[] | null;
  servings?: number[] | null;
}
interface LegacyAgentSave {
  agents?: (Agent & LegacyAgentMem)[];
}
