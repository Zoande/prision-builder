// Wants, and what a man will do about them.
//
// Every need argues for itself with (how empty it is) x (how loud it is), and
// the loudest one that can actually be acted on wins. Most needs are met by
// walking to an object whose registry row fills them — that is the use-slot
// engine next door, and it means a new need costs a row, not a branch.
//
// The interesting part is what happens when a need CANNOT be met lawfully: a
// filthy man with no reachable shower, or one who has not been outdoors in
// days, will start breaking the rules quietly — gated by `risk`, a learned
// wariness that grows with every close call.

import { RoomType, World } from "./world.ts";
import { NEEDS, Obj, SHELF_KINDS, type NeedName } from "./objects.ts";
import { Item, hasItem } from "./items.ts";
import { astar, bfsFind, prisonerAllowed } from "./nav.ts";
import { isNextTo, knownOpen, lawfulOpen, pathAdjacent } from "./move.ts";
import { rnd } from "./rng.ts";
import { CRAWL_SPEED, K_CUT, K_DOOR, K_OPEN, NEED_TUNING, POSE_LIE_FLOOR, POSE_STAND, READ_TIME, type Agent } from "./agent.ts";
import type { Agents } from "./agents.ts";
import { tryStashTrip } from "./contraband.ts";
import { nearestUsable, tryUse, useable, walkToUse } from "./useSlots.ts";
import { mem } from "./vision.ts";
import { guardInSight } from "./enforcement.ts";

export function decide(A: Agents, ag: Agent, world: World, isNight: boolean) {
  const n = ag.needs;
  const gathering = ag.plan?.stage === "prepare" &&
    (ag.plan.method === "cut" || ag.plan.method === "dig");

  // Housekeeping first. A finished book goes back on the shelf, and anything
  // incriminating in his hands goes under the bunk before a guard sees it.
  if (hasItem(ag.inv, Item.Book) && n.recreation > 0.95 &&
      returnBook(A, ag, world)) return;
  if (tryStashTrip(ag, world)) return;

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
    if (trySatisfy(A, ag, world, need)) return;
  }
  explore(ag, world);
}


export function trySatisfy(A: Agents, ag: Agent, world: World, need: NeedName): boolean {
  const size = world.size;
  const ax = Math.floor(ag.x), az = Math.floor(ag.z);
  switch (need) {
    case "food": {
      // Holding a tray already? Then all that is left is to find a table.
      if (hasItem(ag.inv, Item.Tray)) return tryUse(A, ag, world, "food", [Obj.Table]);
      // A table with a tray already on it is a free meal — take it.
      if (tryUse(A, ag, world, "food", [Obj.Table])) return true;

      // Otherwise queue at a serving counter. Hunger is shameless: past a
      // point he will cut through staff territory to reach one.
      const trespass = ag.needs.food < 0.2;
      const counter = nearestUsable(A, ag, world, [Obj.ServingTable]);
      if (counter >= 0 && walkToUse(ag, world, counter, trespass)) {
        ag.state = "toUse";
        ag.interact = counter;
        return true;
      }
      // A counter he knows of, but it is empty or unmanned: wait beside it.
      let known = -1, kd = Infinity;
      for (const t of mem(ag, Obj.ServingTable)) {
        if (world.objKind[t] !== Obj.ServingTable) continue;
        const d = Math.abs((t % size) - ax) + Math.abs(((t / size) | 0) - az);
        if (d < kd) { kd = d; known = t; }
      }
      if (known >= 0 && ag.needs.food < 0.6) {
        if (isNextTo(ag, world, known)) {
          ag.state = "queueing";
          ag.interact = known;
          ag.timer = 2;
          return true;
        }
        if (pathAdjacent(ag, world, known, lawfulOpen(ag, world, trespass))) {
          ag.state = "toQueue";
          ag.interact = known;
          return true;
        }
      }
      // Starving and knows of no food anywhere: go and look, rules be damned.
      if (ag.needs.food < 0.15) { explore(ag, world, true); return true; }
      return false;
    }

    case "sleep": {
      // His own bunk, through the generic machinery — which lies him down at
      // the middle of the bed instead of snapping him to the pillow end.
      if (ag.bedIdx >= 0 && useable(A, ag, world, ag.bedIdx, Obj.Bed) &&
          walkToUse(ag, world, ag.bedIdx)) {
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
      const open = lawfulOpen(ag, world);
      const spot = bfsFind(size, start, open, (i) => open(i) && world.roofed[i] === 0);
      if (spot >= 0) {
        const path = astar(size, start, spot, open, 30000, (from, to) => world.canNavigateEdge(from, to));
        if (path) {
          ag.path = path; ag.pathI = 0;
          ag.state = "toOutside";
          return true;
        }
      }
      // No lawful way to fresh air: consider breaking the rules quietly.
      return trySneak(A, ag, world, "outdoors");
    }

    case "hygiene": {
      const shower = nearestUsableIn(A, ag, world, [Obj.Shower], RoomType.ShowerRoom);
      if (shower >= 0 && walkToUse(ag, world, shower)) {
        ag.state = "toUse";
        ag.interact = shower;
        return true;
      }
      // No lawful route to a shower: consider a quiet unauthorized one.
      return trySneak(A, ag, world, "hygiene");
    }

    case "recreation": {
      // With a book in hand, the job is to find somewhere to read it.
      if (hasItem(ag.inv, Item.Book)) return startReading(A, ag, world);
      // A television or a pool table needs no props.
      if (tryUse(A, ag, world, "recreation")) return true;
      // Otherwise borrow a book — that is what the shelves are for.
      return tryUse(A, ag, world, "recreation", SHELF_KINDS);
    }

    // Comfort, exercise, bladder, spirituality: nothing bespoke about any of
    // them — find a remembered object whose registry row fills it, and go.
    default:
      return tryUse(A, ag, world, need);
  }
}


/** Nearest usable object of these kinds that also sits in the right room. */
export function nearestUsableIn(
  A: Agents,
  ag: Agent, world: World, kinds: number[], roomType: number,
): number {
  const size = world.size;
  const ax = Math.floor(ag.x), az = Math.floor(ag.z);
  let best = -1, bd = Infinity;
  for (const kind of kinds) {
    for (const anchor of mem(ag, kind)) {
      if (!useable(A, ag, world, anchor, kind)) continue;
      if (world.roomTypeAt(anchor) !== roomType) continue;
      const d = Math.abs((anchor % size) - ax) + Math.abs(((anchor / size) | 0) - az);
      if (d < bd) { bd = d; best = anchor; }
    }
  }
  return best;
}


/** He has a book. Settle somewhere to read it — a chair if he knows of one,
 *  his bunk if not, and failing both, right where he stands. */
export function startReading(A: Agents, ag: Agent, world: World): boolean {
  if (tryUse(A, ag, world, "comfort")) return true; // read it in the armchair
  if (ag.bedIdx >= 0 && useable(A, ag, world, ag.bedIdx, Obj.Bed) &&
      walkToUse(ag, world, ag.bedIdx)) {
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
export function returnBook(A: Agents, ag: Agent, world: World): boolean {
  const shelf = nearestUsable(A, ag, world, SHELF_KINDS);
  if (shelf >= 0 && pathAdjacent(ag, world, shelf, lawfulOpen(ag, world))) {
    ag.state = "toShelf";
    ag.interact = shelf;
    return true;
  }
  if (ag.bedIdx >= 0 && pathAdjacent(ag, world, ag.bedIdx, lawfulOpen(ag, world))) {
    ag.state = "toStash";
    ag.interact = ag.bedIdx;
    return true;
  }
  return false;
}


/** Quiet trespass to fix hygiene/outdoors. Unlike food runs (starving men
 *  are shameless), these trips are risk-gated: the more often he has been
 *  busted, the more desperate he must be before trying again. */
export function trySneak(A: Agents, ag: Agent, world: World, need: "outdoors" | "hygiene"): boolean {
  const urgency = 1 - ag.needs[need];
  if (urgency < 0.55 + 0.4 * ag.risk) return false;
  if (guardInSight(A, ag, world)) return false; // wait for a clear moment
  const size = world.size;
  const start = Math.floor(ag.z) * size + Math.floor(ag.x);
  const open = lawfulOpen(ag, world, true); // break the rules, not walls
  if (need === "outdoors") {
    const spot = bfsFind(size, start, open, (i) => open(i) && world.roofed[i] === 0);
    if (spot >= 0) {
      const path = astar(size, start, spot, open, 30000, (from, to) => world.canNavigateEdge(from, to));
      if (path) {
        ag.path = path; ag.pathI = 0;
        ag.state = "toOutside";
        ag.sneaking = true;
        return true;
      }
    }
    return tryTunnelTrip(A, ag, world);
  }
  // Hygiene: nearest remembered shower head, access rules be damned
  // (someone else's in-cell shower counts). It runs through the same use-slot
  // machinery as a lawful shower — the only difference is `sneaking`, which
  // makes him bolt the moment a uniform appears.
  let best = -1, bd = Infinity;
  for (const s of mem(ag, Obj.Shower)) {
    if (!useable(A, ag, world, s, Obj.Shower)) continue;
    const d = Math.abs((s % size) - ag.x) + Math.abs(((s / size) | 0) - ag.z);
    if (d < bd) { bd = d; best = s; }
  }
  if (best < 0) return false;
  if (!walkToUse(ag, world, best, true /* trespassing */)) return false;
  ag.state = "toUse";
  ag.interact = best;
  ag.sneaking = true;
  return true;
}


/** Pop out of his own surfaced tunnel just to breathe for a while. */
export function tryTunnelTrip(A: Agents, ag: Agent, world: World): boolean {
  if (ag.needs.outdoors > 0.35) return false;
  if (rnd() < ag.risk) return false; // still spooked from last time
  const t = A.tunnels.find((tn) => tn.owner === ag.id && tn.surfHole >= 0 && !tn.occupied);
  if (!t || world.objKind[t.entry] !== Obj.Toilet) return false;
  if (isNextTo(ag, world, t.entry)) {
    ag.tunnel = t;
    t.occupied = true;
    ag.underground = true;
    ag.state = "crawlingOut";
    ag.timer = t.believed / CRAWL_SPEED;
    ag.sneaking = true;
    return true;
  }
  if (!pathAdjacent(ag, world, t.entry, knownOpen(ag))) return false;
  ag.tunnel = t;
  ag.state = "toTrip";
  ag.sneaking = true;
  return true;
}


/** End an outdoors break; sneaks that came up a tunnel crawl back down. */
export function finishOutside(A: Agents, ag: Agent, world: World) {
  const t = ag.tunnel;
  if (ag.sneaking && t && t.surfHole >= 0 && A.tunnels.includes(t) &&
      !t.occupied && isNextTo(ag, world, t.surfHole)) {
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
export function explore(ag: Agent, world: World, trespass = false) {
  const size = world.size;
  const ax = Math.floor(ag.x), az = Math.floor(ag.z);
  const start = az * size + ax;
  const open = lawfulOpen(ag, world, trespass); // wandering respects access

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
    const s = dirBonus * 2 - d * 0.15 + rnd() * 0.8;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  if (best >= 0) {
    const path = astar(size, start, best, open, 30000, (from, to) => world.canNavigateEdge(from, to));
    if (path) {
      ag.path = path; ag.pathI = 0;
      ag.state = "exploring";
      return;
    }
  }
  const keys = [...ag.known!.keys()].filter(open);
  if (keys.length > 0) {
    const t = keys[(rnd() * keys.length) | 0];
    const path = astar(size, start, t, open, 30000, (from, to) => world.canNavigateEdge(from, to));
    if (path) {
      ag.path = path; ag.pathI = 0;
      ag.state = "wandering";
      return;
    }
  }
  ag.state = "idle";
}
