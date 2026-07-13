// Enforcement: the moments the prison acts on a prisoner.
//
// Spotting him, shooting him, seizing his kit, marching him home, and calling
// for help. This lives apart from guard.ts because a sniper, a tunnel stakeout
// and a foot patrol all end in the same few outcomes, and none of them should
// have to import each other to get there.

import { World } from "./world.ts";
import { Obj } from "./objects.ts";
import { clearInventory, seizeContraband } from "./items.ts";
import { passable } from "./nav.ts";
import { pathAdjacent } from "./move.ts";
import { canSee } from "./vision.ts";
import { KO_TIME, POSE_LIE_FLOOR, POSE_STAND, type Agent } from "./agent.ts";
import type { Agents } from "./agents.ts";
import { releaseUse } from "./useSlots.ts";

/** Any guard this agent can currently see nearby (his own eyes)? */
export function guardInSight(A: Agents, ag: Agent, world: World, r = 14): boolean {
  for (const g of A.agents) {
    if (g.kind !== Obj.Guard) continue;
    if (Math.hypot(g.x - ag.x, g.z - ag.z) > r) continue;
    if (canSee(ag, world, g.x, g.z)) return true;
  }
  return false;
}


/** Is this man visibly in the middle of getting out? */
export function isEscaping(p: Agent): boolean {
  if (p.kind !== Obj.Prisoner || p.underground) return false;
  if (p.state === "climbing" || p.state === "cutting" || p.state === "fleeing") return true;
  return p.plan?.stage === "flee";
}


export function capture(A: Agents, guard: Agent, prisoner: Agent, world: World) {
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
  A.caughtCount++;
  // Guard marches him home.
  guard.chaseId = -1;
  guard.stakeTunnel = null;
  guard.state = "escorting";
  guard.interact = prisoner.id;
  const home = prisoner.bedIdx >= 0 ? prisoner.bedIdx
    : Math.floor(prisoner.z) * world.size + Math.floor(prisoner.x);
  if (!pathAdjacent(guard, world, home, (i) => passable(world, i, true))) {
    guard.path = null;
    guard.state = "patrol"; // nowhere to take him; release on the spot
    prisoner.state = "idle";
    prisoner.escortedBy = -1;
  }
}


/** A non-lethal round: he goes down, his kit is scattered, the escape is off.
 *  He comes round in KO_TIME — sooner if a guard collects him first. */
export function knockOut(A: Agents, p: Agent, world: World) {
  if (p.state === "knockedOut") return;
  seizeContraband(p.inv);
  clearInventory(p.inv);
  releaseUse(A, p);
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
  A.caughtCount++;
  A.worldDirty = true;
  void world;
}


/** An escape in progress outranks every patrol and every posting: the nearest
 *  few guards drop what they are doing and run at it. */
export function raiseAlarm(A: Agents, runner: Agent, world: World) {
  const RESPONDERS = 3;
  const free = A.agents
    .filter((a) => a.kind === Obj.Guard && a.state !== "escorting" &&
      a.state !== "intakeEscort" && a.state !== "regimeEscort" && a.chaseId !== runner.id)
    .sort((a, b) =>
      (Math.hypot(a.x - runner.x, a.z - runner.z)) -
      (Math.hypot(b.x - runner.x, b.z - runner.z)));
  let sent = 0;
  for (const g of free) {
    if (sent >= RESPONDERS) break;
    const ti = world.idx(Math.floor(runner.x), Math.floor(runner.z));
    if (!pathAdjacent(g, world, ti, (i) => passable(world, i, true))) continue;
    g.chaseId = runner.id;
    g.state = "chasing";
    g.aux = 0;
    sent++;
  }
}

