// Vision and memory: what an agent has actually seen.
//
// Prisoners only know what they have looked at — a facing cone plus a small
// awareness ring, with walls blocking sight but fences and bars not. That map
// is what they plan escapes over, which is why a man will happily dig toward a
// fence he has never seen the far side of.
//
// Staff have no `known` map: they are given the real layout.

import { World } from "./world.ts";
import { Obj, defOf } from "./objects.ts";
import { sightBlocks, passable, isFenceKind } from "./nav.ts";
import {
  type Agent,
  AWARE_R, K_BLOCKED, K_CUT, K_DOOR, K_FENCE, K_OPEN,
  SNIPER_RANGE, VISION_HALF, VISION_RANGE, VISION_RAYS,
} from "./agent.ts";


export function record(ag: Agent, world: World, i: number) {
  const k = world.objKind[i];
  let v = K_BLOCKED;
  if (isFenceKind(k)) v = K_FENCE;
  else if (k === Obj.CutFence) v = K_CUT;
  else if (k === Obj.JailDoor || k === Obj.StaffDoor || k === Obj.StaffFenceDoor || k === Obj.FenceJailDoor) v = K_DOOR;
  else if (passable(world, i, false)) v = K_OPEN;
  ag.known!.set(i, v);

  // Objects are remembered straight off the registry. Beds and use-slot
  // objects are remembered by anchor (a bed claim and a use claim are both
  // keyed by it); benches and tables by tile, because a diner sits on the
  // tile he reached, not on the anchor.
  const def = defOf(k);
  if (!def || !def.remember) return;
  const at = def.remember === "anchor" ? world.anchorOf(i) : i;
  mem(ag, k).add(at);
}

/** An agent's remembered tiles for one object kind. */
export function mem(ag: Agent, kind: number): Set<number> {
  let s = ag.objMem!.get(kind);
  if (!s) ag.objMem!.set(kind, s = new Set());
  return s;
}

export function look(ag: Agent, world: World) {
  const size = world.size;
  const ax = Math.floor(ag.x), az = Math.floor(ag.z);
  const R = Math.ceil(AWARE_R);
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > AWARE_R * AWARE_R) continue;
      const nx = ax + dx, nz = az + dz;
      if (!world.inBounds(nx, nz)) continue;
      record(ag, world, nz * size + nx);
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
      record(ag, world, i);
      if (sightBlocks(world, i)) break;
    }
  }
}

/** Line-of-sight visibility check (guards spotting, prisoners sneaking).
 *  `nearR` is the omnidirectional radius — noisy acts (climbing, cutting)
 *  are noticed all around, not just in the facing cone. */
export function canSee(
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
