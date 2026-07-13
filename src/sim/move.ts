// Movement: walking a path, and finding one to an object.
//
// Everything here works off a caller-supplied `open` predicate rather than the
// real world, because who can walk where is a matter of opinion: a guard sees
// real walls, a prisoner sees only the walls he remembers, and a man in flight
// optimistically assumes the tiles he has never seen are clear.

import { World } from "./world.ts";
import { Obj } from "./objects.ts";
import { astar, angleLerp, passable, prisonerAllowed } from "./nav.ts";
import { look, record } from "./vision.ts";
import {
  type Agent,
  K_CUT, K_DOOR, K_OPEN, PRISONER_SPEED, STAFF_SPEED,
} from "./agent.ts";


export function followPath(ag: Agent, dt: number, world: World, staff: boolean): boolean {
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
    if (ag.known) record(ag, world, ti);
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
    look(ag, world);
  }
  return false;
}

export function knownOpen(ag: Agent) {
  return (i: number) => {
    const v = ag.known!.get(i);
    return v === K_OPEN || v === K_CUT || v === K_DOOR;
  };
}

/** Normal-life predicate: remembered walkable AND access allows prisoners.
 *  `trespass` (critical hunger) ignores the access rules, not the walls. */
export function lawfulOpen(ag: Agent, world: World, trespass = false) {
  const open = knownOpen(ag);
  if (trespass) return open;
  return (i: number) => open(i) && prisonerAllowed(world, i);
}

/** Optimistic pathing for fleeing: unknown tiles are assumed walkable. */
export function fleeOpen(ag: Agent) {
  return (i: number) => {
    const v = ag.known!.get(i);
    return v === undefined || v === K_OPEN || v === K_CUT || v === K_DOOR;
  };
}

export function pathAdjacent(
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

export function stepOff(ag: Agent, world: World) {
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

export function isNextTo(ag: Agent, world: World, tile: number): boolean {
  const size = world.size;
  const x = Math.floor(ag.x), z = Math.floor(ag.z);
  const tx = tile % size, tz = (tile / size) | 0;
  return Math.abs(x - tx) + Math.abs(z - tz) <= 1;
}
