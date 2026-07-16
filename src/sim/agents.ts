// The simulation's conductor.
//
// `Agents` owns the mutable stores every subsystem reads and writes — the agent
// list, the claims, the tunnels, the repair queue, the regime clock — and calls
// the per-kind brains once per tick. The brains themselves live next door:
//
//   prisoner.ts  needs, regime, rule-breaking, the state machine
//   guard.ts     patrol, chase, escort, the chores
//   sniper.ts    towers, the shot, the alarm
//   staff.ts     cook, workman
//   deploy.ts    beats and postings
//
// and the engines they share: needs.ts, useSlots.ts, escape.ts, tunnel.ts,
// move.ts, vision.ts, nav.ts.

import { Access, RoomType, World, type Room } from "./world.ts";
import { rnd } from "./rng.ts";
import {
  Item, POCKET_SLOTS, type Stack,
  countItem, hasItem, newInventory, removeItem, takeInHands,
} from "./items.ts";
import {
  NEEDS, Obj, POSE_STAND, POSE_LIE_FLOOR, POSE_CLIMB,
  } from "./objects.ts";
import {
  angleLerp, astar, isFenceKind, passable, prisonerAllowed,
} from "./nav.ts";
import { canSee, look, mem, record } from "./vision.ts";
import {
  followPath, fleeOpen, isNextTo, knownOpen, lawfulOpen, pathAdjacent, stepOff,
} from "./move.ts";
import { actingInRegime, cellHasShower, doorServesShowerCell, insideOwnCell, lockCell, regimeDestination, regimeTick, usingKind } from "./regime.ts";
import { doRetrieve, doStash, toolCount, tryRetrieveTools } from "./contraband.ts";
import { capture, guardInSight, isEscaping, knockOut, raiseAlarm } from "./enforcement.ts";
import {
  blankAgent, defaultRegime,
  AWARE_R, BOOK_READ_RATE, CLIMB_TIME, COOK_TIME, CRAWL_SPEED, CUT_TIME,
  DIG_TILE_TIME, ESCAPE_MARGIN, K_BLOCKED, K_CUT, K_DOOR, K_FENCE,
  K_OPEN, NEED_TUNING, RATES, REG, REPAIR_TIME,
  SERVING_CAP, SNIPER_AIM, SNIPER_RANGE, SNIPER_RELOAD, SPOONS_TO_DIG,
  STAFF_SPEED, STAKEOUT_TIME, TOWER_HEIGHT, TUNNEL_DRIFT,
  type Agent, type DoorTask, type IssueLabel, type Method,
  type RepairJob, type Tunnel,
} from "./agent.ts";
import { releaseUse, startUse, updateUsing, useable } from "./useSlots.ts";
import { decide, finishOutside, tryTunnelTrip } from "./needs.ts";

// The public face of the sim: everything main.ts and the render passes import.
export {
  FOOD_KIND, HOLE_ENTRY_KIND, HOLE_SURF_KIND, TRAY_STACK_KIND,
  REG, REG_NAMES, defaultRegime,
  POSE_STAND, POSE_SIT, POSE_LIE_BED, POSE_LIE_FLOOR, POSE_CLIMB,
} from "./agent.ts";
export type {
  Agent, EscapePlan, IssueLabel, Method, Tunnel, NeedName,
} from "./agent.ts";

// --- The simulation ---------------------------------------------------------

/** The simulation.
 *
 *  Its members are public because the sibling modules in sim/ — prisoner.ts,
 *  guard.ts, needs.ts and the rest — ARE this class's implementation; they were
 *  split out for readability, not encapsulation. Treat everything here as
 *  internal to sim/ and call it from nowhere else. */
export class Agents {
  readonly agents: Agent[] = [];
  nextId = 1;
  claimedBeds = new Map<number, number>();
  claimedCookers = new Map<number, number>();
  /** Use-slot occupancy: object anchor -> the agents using it right now. */
  useClaims = new Map<number, Set<number>>();
  /** What each prisoner has hidden under his bunk, keyed by bed anchor. A guard
   *  who catches him only takes what's on him — the stash is why hiding pays. */
  readonly stashes = new Map<number, Stack[]>();
  /** How many guards the player has assigned to each patrol beat. */
  readonly routeGuards = new Map<number, number>();
  readonly mealTables = new Set<number>();
  readonly tunnels: Tunnel[] = [];
  readonly cutFences = new Set<number>(); // cut fence tiles (world holds truth)
  flaggedCuts = new Set<number>();
  flaggedHoles = new Set<number>(); // surface hole tiles flagged
  readonly repairJobs: RepairJob[] = [];
  readonly doorTasks: DoorTask[] = [];
  readonly regime: number[] = defaultRegime();
  readonly servingStock = new Map<number, number>(); // serving table -> meals
  servers = new Map<number, number>(); // serving table -> manning cook id
  curHour = -1;
  curActivity: number = REG.Free;
  evictT = 0;
  escapedCount = 0;
  caughtCount = 0;
  mealsDirty = false; // any tray/hole render change
  worldDirty = false; // sim mutated world tiles (cut/repair)

  takeMealsDirty(): boolean { const d = this.mealsDirty; this.mealsDirty = false; return d; }
  takeWorldDirty(): boolean { const d = this.worldDirty; this.worldDirty = false; return d; }

  sync(world: World) {
    for (const kind of [Obj.Prisoner, Obj.Guard, Obj.Cook, Obj.Workman]) {
      for (const i of world.tilesOfKind(kind)) {
        const x = i % world.size, z = (i / world.size) | 0;
        const orient = world.objOrient[i];
        const baton = world.objMat[i] === 1;
        world.objKind[i] = Obj.None;
        world.objMat[i] = 0;
        this.agents.push({
          ...blankAgent(kind),
          id: this.nextId++,
          x: x + 0.5, z: z + 0.5,
          heading: [0, Math.PI / 2, Math.PI, -Math.PI / 2][orient & 3],
          baton,
        });
      }
    }
  }

  eraseAt(x: number, z: number): boolean {
    let changed = false;
    for (let n = this.agents.length - 1; n >= 0; n--) {
      const ag = this.agents[n];
      if (!ag.underground && Math.floor(ag.x) === x && Math.floor(ag.z) === z) {
        this.removeAgent(ag);
        changed = true;
      }
    }
    return changed;
  }

  removeAgent(ag: Agent) {
    if (ag.bedIdx >= 0) this.claimedBeds.delete(ag.bedIdx);
    if (ag.cookerIdx >= 0) this.claimedCookers.delete(ag.cookerIdx);
    releaseUse(this, ag);
    if (ag.tunnel) ag.tunnel.occupied = false;
    if (ag.job) ag.job.claimedBy = -1;
    for (const [s, id] of this.servers) if (id === ag.id) this.servers.delete(s);
    const n = this.agents.indexOf(ag);
    if (n >= 0) this.agents.splice(n, 1);
  }

  giveBatonAt(x: number, z: number): boolean {
    let changed = false;
    for (const ag of this.agents) {
      if (Math.floor(ag.x) === x && Math.floor(ag.z) === z && !ag.baton) {
        ag.baton = true;
        changed = true;
      }
    }
    return changed;
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

  update(dt: number, world: World, isNight: boolean, hour: number) {
    // Top of the hour: compliance rolls + door choreography.
    const h = Math.floor(hour) % 24;
    if (h !== this.curHour) {
      this.curHour = h;
      this.curActivity = this.regime[h];
      for (const ag of this.agents) {
        if (ag.kind !== Obj.Prisoner) continue;
        // Misery breeds defiance.
        ag.compliant = rnd() < Math.max(0.25, 1 - 0.6 * ag.escapeDesire);
      }
      const act = this.curActivity;
      if (act === REG.Free || act === REG.Eating || act === REG.Yard || act === REG.Shower) {
        // Unlock the cells — except cells with in-cell showers at shower time.
        for (const i of world.tilesOfKind(Obj.JailDoor)) {
          if (!world.jailClosed[i] || this.doorTasks.some((t) => t.idx === i)) continue;
          if (act === REG.Shower && doorServesShowerCell(world, i)) continue;
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
    this.assignGuards(world);

    for (let n = this.agents.length - 1; n >= 0; n--) {
      const ag = this.agents[n];
      if (ag.kind === Obj.Prisoner) this.updatePrisoner(ag, dt, world, isNight);
      else if (ag.kind === Obj.Cook) this.updateCook(ag, dt, world);
      else if (ag.kind === Obj.Guard) this.updateGuard(ag, dt, world);
      else if (ag.kind === Obj.Sniper) this.updateSniper(ag, dt, world);
      else this.updateWorkman(ag, dt, world);
    }
  }

  // --- Prisoner --------------------------------------------------------------

  updatePrisoner(ag: Agent, dt: number, world: World, isNight: boolean) {
    const n = ag.needs;
    // A use claim only lives as long as the using: a guard escort, a lock-up or
    // an erased object all pull him off it, and none of them route through
    // finishUse.
    if (ag.useIdx >= 0 && ag.state !== "using") {
      releaseUse(this, ag);
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

    if (ag.lastTX < 0) { ag.lastTX = Math.floor(ag.x); ag.lastTZ = Math.floor(ag.z); look(ag, world); }

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
          look(ag, world);
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
        updateUsing(this, ag, dt, world, isNight);
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
            if (guardInSight(this, ag, world)) {
              ag.risk = Math.min(1, ag.risk + 0.15); // close call — remembered
              finishOutside(this, ag, world);
              return;
            }
          }
        }
        if (n.outdoors >= 0.95 || ag.timer <= 0) finishOutside(this, ag, world);
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
          if (useable(this, ag, world, ag.interact, Obj.ServingTable) &&
              isNextTo(ag, world, ag.interact)) {
            startUse(this, ag, world);
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
          ag.timer = 3 + rnd() * 5;
          const size = world.size;
          const x = Math.floor(ag.x), z = Math.floor(ag.z);
          const nx = x + ((rnd() * 5) | 0) - 2, nz = z + ((rnd() * 5) | 0) - 2;
          if (world.inBounds(nx, nz)) {
            const ni = world.idx(nx, nz);
            if (world.roomTypeAt(ni) === RoomType.Yard && lawfulOpen(ag, world)(ni)) {
              const p = astar(size, world.idx(x, z), ni, lawfulOpen(ag, world), 2000);
              if (p) { ag.path = p; ag.pathI = 0; }
            }
          }
        }
        return;
      }
      case "inCell": {
        ag.amp = Math.max(0, ag.amp - dt * 8);
        const act = this.curActivity;
        const showerCell = act === REG.Shower && cellHasShower(world, ag);
        if (showerCell) ag.needs.hygiene = Math.min(1, ag.needs.hygiene + RATES.hygieneRefill * dt);
        if (act !== REG.Lockup && !showerCell) ag.state = "idle";
        return;
      }
    }

    // Traveling.
    if (ag.path) {
      const before = ag.path;
      const arrived = followPath(ag, dt, world, false);
      if (arrived) this.onArrive(ag, world);
      else if (!ag.path && before) this.onBlocked(ag, world);
      return;
    }

    ag.amp = Math.max(0, ag.amp - dt * 8);

    ag.decideT -= dt;
    if (ag.decideT > 0) return;
    ag.decideT = 0.6 + rnd() * 0.6;

    // A standing prisoner still has eyes: keep the world model fresh (this
    // is how they notice a jail door opening without walking anywhere).
    look(ag, world);

    // Plan lifecycle beats needs unless something is critical.
    if (this.planTick(ag, world, isNight)) return;
    if (regimeTick(this, ag, world)) return;
    decide(this, ag, world, isNight);
  }

  // --- Regime ---------------------------------------------------------------

  onArrive(ag: Agent, world: World) {
    switch (ag.state) {
      case "toQueue": {
        // Reached the counter: use it if he can, otherwise wait his turn.
        if (useable(this, ag, world, ag.interact, Obj.ServingTable)) startUse(this, ag, world);
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
        doStash(this, ag);
        ag.state = "idle";
        return;
      }
      case "toRetrieve": {
        doRetrieve(this, ag, ag.aux);
        ag.state = "idle";
        return;
      }
      case "toOutside": {
        ag.state = "outside";
        ag.timer = 30;
        return;
      }
      case "toUse": {
        startUse(this, ag, world);
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
        ag.state = insideOwnCell(ag, world) ? "inCell" : "idle";
        if (ag.state === "inCell") lockCell(this, ag, world);
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
            world.objKind[t.entry] !== Obj.Toilet || !isNextTo(ag, world, t.entry)) {
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
  onBlocked(ag: Agent, world: World) {
    if (ag.state === "fleeing" && ag.plan) {
      // Something new in the way — maybe a fence we didn't know. Replan.
      look(ag, world);
      this.replanOrRetreat(ag, world);
      return;
    }
    // Walked into a shut jail door mid-errand: if he's desperate for air and
    // owns a finished tunnel, there is a secret way out of the cell.
    ag.sneaking = false;
    if (ag.kind === Obj.Prisoner && tryTunnelTrip(this, ag, world)) return;
    ag.state = "idle";
  }

  // --- Needs ----------------------------------------------------------------

  // --- Books ------------------------------------------------------------------

  // --- Stashing ---------------------------------------------------------------

  // --- Use-slots --------------------------------------------------------------
  //
  // Any object whose registry row carries a `use` block can be walked to, stood
  // (or sat) at, and drained for the needs it lists. One state pair — "toUse"
  // then "using" — serves every such object, so a new usable thing is a data
  // row, not a new branch in this machine.

  /** What a prisoner has hidden under a given bunk (read-only, for the HUD). */
  stashOfBed(bed: number): Stack[] {
    return (bed >= 0 && this.stashes.get(bed)) || [];
  }

  // --- Rule-breaking need trips ----------------------------------------------

  // --- Escape planning ---------------------------------------------------------

  /** Dijkstra over the prisoner's memory where fences are crossable at a
   *  price. Returns the chosen believed exit + breach route, or null. */
  findRoute(ag: Agent, world: World): { exit: number; breaches: number[]; cost: number } | null {
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

  makePlan(ag: Agent, world: World) {
    const route = this.findRoute(ag, world);
    if (!route) { ag.escapeFeasibility = 0; return; }
    ag.escapeFeasibility = 1 / (1 + route.cost / 120);

    // Method: climbers who keep getting caught switch to tools.
    let method: Method;
    if (ag.planBias) {
      method = ag.planBias;
      // Biased to dig but no toilet known yet: hold out for one.
      if (method === "dig" && mem(ag, Obj.Toilet).size === 0) return;
    } else {
      const wClimb = 1 / (1 + ag.timesCaught);
      const wCut = 0.8;
      const wDig = mem(ag, Obj.Toilet).size > 0 ? 0.7 : 0;
      const r = rnd() * (wClimb + wCut + wDig);
      method = r < wClimb ? "climb" : r < wClimb + wCut ? "cut" : "dig";
    }

    const size = world.size;
    let toiletIdx = -1;
    if (method === "dig") {
      let bd = Infinity;
      for (const t of mem(ag, Obj.Toilet)) {
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
  planTick(ag: Agent, world: World, isNight: boolean): boolean {
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
        (plan.method === "cut" && toolCount(this, ag, Item.Cutter) >= plan.needed) ||
        (plan.method === "dig" && toolCount(this, ag, Item.Spoon) >= SPOONS_TO_DIG);
      if (!ready || ag.escapeDesire < threshold * 0.7) return false; // keep living (and eating)
      // The kit is his, but half of it may be under the bunk. Go and get it.
      const tool = plan.method === "cut" ? Item.Cutter : Item.Spoon;
      if (plan.method !== "climb" && countItem(ag.inv, tool) <= 0 &&
          tryRetrieveTools(this, ag, world, tool)) {
        return true;
      }
      plan.stage = "execute";
      plan.watchdog = 120;
    }

    if (plan.stage === "execute") {
      if (plan.method === "dig") {
        if (world.objKind[plan.toiletIdx] !== Obj.Toilet) { ag.plan = null; return false; }
        if (pathAdjacent(ag, world, plan.toiletIdx, knownOpen(ag))) {
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

  approachBreach(ag: Agent, world: World): boolean {
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
    if (isNextTo(ag, world, b)) { this.startBreach(ag, world); return true; }
    if (pathAdjacent(ag, world, b, knownOpen(ag))) {
      ag.state = "toBreach";
      return true;
    }
    ag.plan = null;
    return false;
  }

  startBreach(ag: Agent, world: World) {
    const plan = ag.plan!;
    const size = world.size;
    const b = plan.breaches[plan.legI];
    // Sneak: hold off while a guard is visibly nearby.
    if (guardInSight(this, ag, world, 15)) {
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
        if (!tryRetrieveTools(this, ag, world, Item.Cutter)) {
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

  finishClimb(ag: Agent, world: World) {
    const plan = ag.plan;
    const size = world.size;
    const b = Math.floor(ag.z) * size + Math.floor(ag.x);
    // Land on the far side (opposite the approach tile).
    const far = 2 * b - ag.aux;
    const fx = far % size, fz = (far / size) | 0;
    if (world.inBounds(fx, fz) && passable(world, far, false)) {
      ag.x = fx + 0.5; ag.z = fz + 0.5;
    } else stepOff(ag, world);
    ag.pose = POSE_STAND;
    ag.phase = 0;
    look(ag, world);
    if (!plan) { ag.state = "idle"; return; }
    plan.legI++;
    plan.watchdog = 120;
    ag.state = "idle";
    ag.decideT = 0; // continue the plan next tick
  }

  finishCut(ag: Agent, world: World) {
    const plan = ag.plan;
    const b = ag.interact;
    if (isFenceKind(world.objKind[b])) {
      world.cutFenceAt(b);
      this.cutFences.add(b);
      this.worldDirty = true;
      removeItem(ag.inv, Item.Cutter); // a set of cutters is spent on a fence
      if (ag.known) record(ag, world, b);
    }
    ag.state = "idle";
    if (plan) { plan.legI++; plan.watchdog = 120; ag.decideT = 0; }
  }

  /** Head for the map border, optimistically pathing through the unknown. */
  fleeStep(ag: Agent, world: World) {
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
    const path = astar(size, start, tz * size + tx, fleeOpen(ag), 12000);
    if (path) {
      ag.path = path; ag.pathI = 0;
      ag.state = "fleeing";
    } else {
      this.replanOrRetreat(ag, world);
    }
  }

  /** New barrier discovered mid-escape: replan with what we know and have. */
  replanOrRetreat(ag: Agent, world: World) {
    const old = ag.plan!;
    this.makePlan(ag, world);
    if (ag.plan && ag.plan !== old) {
      ag.plan.method = old.method; // committed to the method (and its tools)
      const ready =
        old.method === "climb" ||
        (old.method === "cut" && toolCount(this, ag, Item.Cutter) >= ag.plan.needed) ||
        (old.method === "dig" && toolCount(this, ag, Item.Spoon) >= SPOONS_TO_DIG);
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

  retreat(ag: Agent, world: World) {
    // Walk back to the claimed bed (or just inward) over anything we can
    // pass in truth — breaches we made are open; fences must be re-climbed
    // (abstracted: retreat paths only through passable tiles; if boxed in,
    // climb back over the nearest known fence).
    const size = world.size;
    const home = ag.bedIdx >= 0 ? ag.bedIdx : mem(ag, Obj.Table).values().next().value ?? -1;
    if (home < 0) { ag.plan = null; ag.state = "idle"; return; }
    if (pathAdjacent(ag, world, home, fleeOpen(ag))) {
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

  enterTunnel(ag: Agent, world: World) {
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

  updateUnderground(ag: Agent, dt: number, world: World) {
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
        stepOff(ag, world);
        ag.state = "idle";
        if (ag.plan) ag.plan.stage = "prepare"; // gather more spoons
        for (const g of this.agents) {
          if (g.kind === Obj.Guard && g.stakeTunnel === t) {
            capture(this, g, ag, world);
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
        look(ag, world);
        ag.state = "outside";
        ag.timer = 12 + rnd() * 8;
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
        t.drift += (rnd() - 0.5) * 2 * TUNNEL_DRIFT;
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

  surface(ag: Agent, world: World) {
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
    look(ag, world);
    if (ag.plan) {
      ag.plan.stage = "flee";
      ag.decideT = 0;
    }
    ag.state = "idle";
  }

  // --- Capture -------------------------------------------------------------------

  // --- Guard ------------------------------------------------------------------

  updateGuard(ag: Agent, dt: number, world: World) {
    const size = world.size;

    if (ag.state === "escorting") {
      const done = ag.path ? followPath(ag, dt, world, true) : true;
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
      const done = ag.path ? followPath(ag, dt, world, true) : true;
      if (!done) return;
      // Attached: head for a free bed in the assigned cell/dorm.
      const bed = this.freeBedInRoom(world, room);
      if (bed < 0 || !pathAdjacent(ag, world, bed, (i) => passable(world, i, true))) {
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
      const done = ag.path ? followPath(ag, dt, world, true) : true;
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
      const done = ag.path ? followPath(ag, dt, world, true) : true;
      if (!done) return;
      if (!pathAdjacent(ag, world, ag.aux, (i) => passable(world, i, true))) {
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
      const done = ag.path ? followPath(ag, dt, world, true) : true;
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
      const done = ag.path ? followPath(ag, dt, world, true) : true;
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
        (isEscaping(target) || target.state === "knockedOut");
      if (!target || !bad) { ag.chaseId = -1; ag.state = "patrol"; ag.path = null; }
      else {
        if (Math.hypot(target.x - ag.x, target.z - ag.z) < 1.4) {
          capture(this, ag, target, world);
          return;
        }
        // Re-path toward the runner occasionally.
        ag.aux -= dt;
        if (!ag.path || ag.aux <= 0) {
          ag.aux = 0.8;
          const ti = Math.floor(target.z) * size + Math.floor(target.x);
          if (!pathAdjacent(ag, world, ti, (i) => passable(world, i, true))) {
            ag.chaseId = -1; ag.state = "patrol"; ag.path = null; // unreachable (other side)
          }
        }
        if (ag.path) followPath(ag, dt, world, true);
        return;
      }
    }

    if (ag.state === "stakeout") {
      if (ag.path) { followPath(ag, dt, world, true); return; } // walk to the hole first
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
        if (!pathAdjacent(ag, world, ti, (i) => passable(world, i, true))) continue;
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
        if (!canSee(ag, world, p.x, p.z, noisy ? 10 : AWARE_R)) continue;
        ag.chaseId = p.id;
        ag.state = "chasing";
        ag.path = null;
        ag.aux = 0;
        // One man on the wire is everyone's problem. Whoever spots it calls it
        // in, and the nearest few drop their beats and postings to help.
        raiseAlarm(this, p, world);
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
          usingKind(world, p) === Obj.Shower;
        const defying = this.curActivity !== REG.Free && !p.compliant &&
          !actingInRegime(this.curActivity, p, world) && !excused;
        if (!outOfLine && !defying) continue;
        if (!canSee(ag, world, p.x, p.z)) continue;
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
        if (dest < 0) dest = outOfLine && p.bedIdx >= 0 ? p.bedIdx : regimeDestination(this, world, p);
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
        if (!pathAdjacent(ag, world, pi, (i) => passable(world, i, true))) {
          p.escortedBy = -1;
          ag.state = "patrol";
          ag.decideT = 1.6; // unreachable: don't hammer the pathfinder
          continue;
        }
        return;
      }

      // Chores — jail doors and intake — belong to the guards the player has
      // NOT assigned. A man on a beat or standing a post keeps watching people;
      // pulling him off to work a door is what left the wings unwatched in the
      // first place. He still has eyes, though: breach-spotting below is
      // everyone's job.
      if (!this.onDuty(ag)) {
        // Jail door tasks trump the rest of the routine.
        let task = null, bd = Infinity;
        for (const t of this.doorTasks) {
          if (t.claimedBy >= 0) continue;
          const d = Math.abs((t.idx % size) - ag.x) + Math.abs(((t.idx / size) | 0) - ag.z);
          if (d < bd) { bd = d; task = t; }
        }
        if (task) {
          if (pathAdjacent(ag, world, task.idx, (i) => passable(world, i, true))) {
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
            if (!pathAdjacent(ag, world, pi, (i) => passable(world, i, true))) continue;
            p.escortedBy = ag.id;
            ag.interact = p.id;
            ag.aux = room.id;
            ag.state = "intakeGo";
            return;
          }
        }
      }

      // Unflagged breaches.
      for (const b of this.cutFences) {
        if (this.flaggedCuts.has(b)) continue;
        if (!canSee(ag, world, (b % size) + 0.5, ((b / size) | 0) + 0.5)) continue;
        this.flaggedCuts.add(b);
        this.repairJobs.push({ kind: "fence", idx: b, claimedBy: -1 });
      }
      for (const t of this.tunnels) {
        if (!t.flagged) {
          const ex = (t.entry % size) + 0.5, ez = ((t.entry / size) | 0) + 0.5;
          if (canSee(ag, world, ex, ez)) {
            t.flagged = true;
            this.repairJobs.push({ kind: "tunnel", idx: t.entry, claimedBy: -1 });
            if (t.occupied) {
              // Someone's down there: stake out the hole.
              ag.stakeTunnel = t;
              ag.timer = STAKEOUT_TIME;
              if (pathAdjacent(ag, world, t.entry, (i) => passable(world, i, true))) {
                ag.state = "stakeout"; // walks there, then waits (path runs first)
              }
              return;
            }
          }
        }
        if (t.surfHole >= 0 && !this.flaggedHoles.has(t.surfHole)) {
          if (canSee(ag, world, (t.surfHole % size) + 0.5, ((t.surfHole / size) | 0) + 0.5)) {
            this.flaggedHoles.add(t.surfHole);
            this.repairJobs.push({ kind: "hole", idx: t.surfHole, claimedBy: -1 });
          }
        }
      }
    }

    // Moving.
    if (ag.path) { followPath(ag, dt, world, true); return; }

    ag.amp = Math.max(0, ag.amp - dt * 8);
    ag.timer -= dt;
    if (ag.timer > 0) return;
    ag.timer = 1.5 + rnd() * 2.5;

    // A man with a beat walks his beat; a man with a post holds it. Everyone
    // else wanders toward whoever needs watching.
    if (ag.routeId >= 0) { if (this.walkRoute(ag, world)) return; }
    if (ag.postRoom >= 0) { if (this.holdRoom(ag, world)) return; }
    if (!this.onDuty(ag)) this.pickPatrolTarget(ag, world);
  }

  /** An unclaimed bed anchor inside a room, or -1. */
  freeBedInRoom(world: World, room: Room): number {
    for (const b of world.piecesOfKind(Obj.Bed)) {
      const anchor = world.idx(b.x, b.z);
      if (!room.tiles.has(anchor) || this.claimedBeds.has(anchor)) continue;
      return anchor;
    }
    return -1;
  }

  /** Nearest valid cell/dorm with capacity for one more prisoner. */
  findFreeCell(world: World, p: Agent): Room | null {
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
  pickPatrolTarget(ag: Agent, world: World) {
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
        const p = crowd[(rnd() * crowd.length) | 0];
        let nearest = Infinity;
        for (const g of this.agents) {
          if (g.kind !== Obj.Guard || g.id === ag.id) continue;
          nearest = Math.min(nearest, Math.abs(g.x - p.x) + Math.abs(g.z - p.z));
        }
        const mine = Math.abs(ag.x - p.x) + Math.abs(ag.z - p.z);
        const score = Math.min(nearest, 60) - mine * 0.35 + rnd() * 6;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (best) {
        const ti = world.idx(Math.floor(best.x), Math.floor(best.z));
        if (pathAdjacent(ag, world, ti, open)) return;
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
      const t = pool[(rnd() * pool.length) | 0];
      const d = Math.abs((t % world.size) - ag.x) + Math.abs(((t / world.size) | 0) - ag.z) +
        rnd() * 10;
      if (d < bd) { bd = d; best = t; }
    }
    if (best >= 0) pathAdjacent(ag, world, best, open);
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
  manTowers(world: World) {
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
        ...blankAgent(Obj.Sniper),
        id: this.nextId++,
        x: sx / tiles.length + 0.5, z: sz / tiles.length + 0.5,
        elev: TOWER_HEIGHT,
        postIdx: anchor,
        state: "scanning",
      });
    }
  }

  /** A guard is "on duty" if the player gave him a beat or a post. Those men
   *  watch prisoners and nothing else — the chores are for everyone else. */
  onDuty(ag: Agent): boolean {
    return ag.routeId >= 0 || ag.postRoom >= 0;
  }

  /** Match guards to the beats and postings the player asked for.
   *
   *  A quota that can't be met just goes unmet — the player sees his guards
   *  spread thin rather than the game silently inventing more of them. */
  assignGuards(world: World) {
    const guards = this.agents.filter((a) => a.kind === Obj.Guard);

    // Drop assignments whose beat or room the player has since deleted.
    for (const g of guards) {
      if (g.routeId >= 0 && !world.routes.has(g.routeId)) { g.routeId = -1; g.routeI = 0; }
      if (g.postRoom >= 0) {
        const r = world.rooms.get(g.postRoom);
        if (!r || r.guards <= 0) g.postRoom = -1;
      }
    }

    const wanted: { route: number; room: number; x: number; z: number }[] = [];
    for (const r of world.routes.values()) {
      const have = guards.filter((g) => g.routeId === r.id).length;
      for (let n = have; n < (r.tiles.length > 0 ? this.routeQuota(r.id) : 0); n++) {
        wanted.push({
          route: r.id, room: -1,
          x: r.tiles[0] % world.size, z: (r.tiles[0] / world.size) | 0,
        });
      }
    }
    for (const room of world.rooms.values()) {
      if (room.guards <= 0 || room.tiles.size === 0) continue;
      const have = guards.filter((g) => g.postRoom === room.id).length;
      const t: number = room.tiles.values().next().value!;
      for (let n = have; n < room.guards; n++) {
        wanted.push({
          route: -1, room: room.id,
          x: t % world.size, z: (t / world.size) | 0,
        });
      }
    }
    if (wanted.length === 0) return;

    // Give each opening to the nearest guard who has nothing assigned.
    for (const w of wanted) {
      let best: Agent | null = null, bd = Infinity;
      for (const g of guards) {
        if (this.onDuty(g)) continue;
        const d = Math.abs(g.x - w.x) + Math.abs(g.z - w.z);
        if (d < bd) { bd = d; best = g; }
      }
      if (!best) return; // nobody spare
      best.routeId = w.route;
      best.postRoom = w.room;
      best.routeI = 0;
      best.routeDir = 1;
      best.path = null;
      best.state = "patrol";
    }
  }

  /** How many guards the player asked for on a beat (one per click). */
  routeQuota(routeId: number): number {
    return this.routeGuards.get(routeId) ?? 0;
  }
  setRouteQuota(routeId: number, n: number) {
    if (n <= 0) this.routeGuards.delete(routeId);
    else this.routeGuards.set(routeId, n);
    // Anyone over quota goes back in the pool.
    const on = this.agents.filter((a) => a.kind === Obj.Guard && a.routeId === routeId);
    for (let i = n; i < on.length; i++) { on[i].routeId = -1; on[i].path = null; }
  }

  /** Walk the beat, end to end and back again. */
  walkRoute(ag: Agent, world: World): boolean {
    const r = world.routes.get(ag.routeId);
    if (!r || r.tiles.length < 2) { ag.routeId = -1; return false; }
    ag.routeI += ag.routeDir;
    if (ag.routeI >= r.tiles.length) { ag.routeI = r.tiles.length - 2; ag.routeDir = -1; }
    if (ag.routeI < 0) { ag.routeI = 1; ag.routeDir = 1; }
    const t = r.tiles[ag.routeI];
    const size = world.size;
    const start = world.idx(Math.floor(ag.x), Math.floor(ag.z));
    const open = (i: number) => passable(world, i, true);
    const path = astar(size, start, t, open);
    if (!path) return false;
    ag.path = path; ag.pathI = 0;
    return true;
  }

  /** Stand your post: mill about inside the room you were given. */
  holdRoom(ag: Agent, world: World): boolean {
    const room = world.rooms.get(ag.postRoom);
    if (!room || room.tiles.size === 0) { ag.postRoom = -1; return false; }
    const tiles = [...room.tiles];
    const open = (i: number) => passable(world, i, true);
    for (let n = 0; n < 12; n++) {
      const t = tiles[(rnd() * tiles.length) | 0];
      if (!open(t)) continue;
      const path = astar(world.size, world.idx(Math.floor(ag.x), Math.floor(ag.z)), t, open);
      if (path) { ag.path = path; ag.pathI = 0; return true; }
    }
    return false;
  }

  updateSniper(ag: Agent, dt: number, world: World) {
    ag.amp = 0;
    ag.pose = POSE_STAND;
    ag.timer -= dt;

    // Lining one up already?
    if (ag.state === "aiming") {
      const target = this.agents.find((a) => a.id === ag.chaseId);
      if (!target || !isEscaping(target) || !canSee(ag, world, target.x, target.z)) {
        ag.chaseId = -1;
        ag.state = "scanning";
        return;
      }
      ag.heading = Math.atan2(target.z - ag.z, target.x - ag.x);
      if (ag.timer <= 0) {
        knockOut(this, target, world);
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
      if (!isEscaping(p)) continue;
      // A tower has line of sight over the whole yard, so no facing cone —
      // he is looking for exactly this and nothing else.
      if (!canSee(ag, world, p.x, p.z, SNIPER_RANGE)) continue;
      const d = Math.hypot(p.x - ag.x, p.z - ag.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    ag.chaseId = best.id;
    ag.state = "aiming";
    ag.timer = SNIPER_AIM;
    // Every guard who can be spared converges on the shot.
    raiseAlarm(this, best, world);
  }

  // --- Workman -----------------------------------------------------------------

  updateWorkman(ag: Agent, dt: number, world: World) {
    const size = world.size;
    if (ag.path) {
      const done = followPath(ag, dt, world, true);
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
    if (best && pathAdjacent(ag, world, best.idx, (i) => passable(world, i, true))) {
      best.claimedBy = ag.id;
      ag.job = best;
      ag.state = "toJob";
    }
  }

  // --- Cook --------------------------------------------------------------------

  updateCook(ag: Agent, dt: number, world: World) {
    const size = world.size;
    if (ag.cookerIdx >= 0 && world.objKind[ag.cookerIdx] !== Obj.Cooker) {
      this.claimedCookers.delete(ag.cookerIdx);
      ag.cookerIdx = -1;
      ag.state = "idle";
    }

    if (ag.path) {
      const arrived = followPath(ag, dt, world, true);
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
            if (pathAdjacent(ag, world, s, (i) => passable(world, i, true))) {
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
        if (best >= 0 && pathAdjacent(ag, world, best, (i) => passable(world, i, true))) {
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
            if (pathAdjacent(ag, world, s, (i) => passable(world, i, true))) {
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
        if (pathAdjacent(ag, world, ag.cookerIdx, (i) => passable(world, i, true))) {
          ag.state = "toCooker";
        }
        return;
      }
    }
  }

  // --- UI diagnostics ------------------------------------------------------------

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
      routeGuards: [...this.routeGuards].map(([route, n]) => ({ route, n })),
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
    this.routeGuards.clear();
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
    for (const { route, n } of data.routeGuards ?? []) this.routeGuards.set(route, n);
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
        routeId: raw.routeId ?? -1,
        routeI: raw.routeI ?? 0,
        routeDir: raw.routeDir ?? 1,
        postRoom: raw.postRoom ?? -1,
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
