// The use-slot engine: how an agent uses an object.
//
// Any object whose registry row carries a `use` block can be walked to, stood
// (or sat, or lain) at, and drained for the needs it lists. One state pair —
// "toUse" then "using" — serves every one of them, so a new usable thing is a
// row in objects.ts, not a new branch in anybody's state machine.
//
// It also moves items: a shelf lends a book, a counter hands over a tray, a
// table eats the tray. That is what `gives`, `requires` and `consumes` are for.

import { World } from "./world.ts";
import { DIRS, Obj, defOf, kindsServing, type NeedName } from "./objects.ts";
import { Item, canHold, canPocket, hasItem, itemDef, removeItem, stow } from "./items.ts";
import { isNextTo, lawfulOpen, pathAdjacent, stepOff } from "./move.ts";
import {
  BOOK_READ_RATE, POSE_SIT, POSE_STAND, READ_TIME, REG, type Agent,
} from "./agent.ts";
import type { Agents } from "./agents.ts";
import { mem } from "./vision.ts";
import { insideOwnCell, lockCell } from "./regime.ts";
import { guardInSight } from "./enforcement.ts";
import { mealContraband } from "./contraband.ts";

export function useCount(A: Agents, anchor: number): number {
  return A.useClaims.get(anchor)?.size ?? 0;
}


export function releaseUse(A: Agents, ag: Agent) {
  if (ag.useIdx < 0) return;
  const set = A.useClaims.get(ag.useIdx);
  if (set) {
    set.delete(ag.id);
    if (set.size === 0) A.useClaims.delete(ag.useIdx);
  }
  ag.useIdx = -1;
}


/** Is this remembered anchor still a usable object with room for one more —
 *  and does this particular agent qualify to use it right now? */
export function useable(A: Agents, ag: Agent, world: World, anchor: number, kind: number): boolean {
  if (world.objKind[anchor] !== kind) return false;
  const use = defOf(kind)?.use;
  if (!use) return false;
  if (useCount(A, anchor) >= use.capacity) return false;
  // Your bunk is yours.
  if (use.owned && ag.bedIdx !== anchor) return false;
  // You can't eat at a table without a tray — unless someone left one there.
  if (use.requires !== undefined && !hasItem(ag.inv, use.requires)) {
    if (!(kind === Obj.Table && A.mealTables.has(anchor))) return false;
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
    if ((A.servingStock.get(anchor) ?? 0) <= 0) return false;
    const mustBeServed = A.curActivity === REG.Eating && ag.needs.food >= 0.15;
    if (mustBeServed && !A.servers.has(anchor)) return false;
  }
  return true;
}


/** A tile a sitter can actually sit on (a bench beside the dining table). */
export function isSeatTile(world: World, i: number): boolean {
  const use = defOf(world.objKind[i])?.use;
  return !!use && use.from === "on" && use.pose === POSE_SIT;
}


/** Where an agent stands to use an object: on it, or on a tile beside it —
 *  preferring a seat, which is how diners end up on the bench by the table. */
export function walkToUse(ag: Agent, world: World, anchor: number, trespass = false): boolean {
  const size = world.size;
  const use = defOf(world.objKind[anchor])!.use!;
  const open = lawfulOpen(ag, world, trespass);

  if (use.from === "on") {
    // A bed, an armchair and a bench are all things you stand next to and
    // then get onto — they are not walkable, so pathing *through* them fails.
    // Walk to a tile beside it; startUse settles him onto the object itself.
    return pathAdjacent(ag, world, anchor, open);
  }
  // Adjacent. A bench beside the table is the obvious place to eat, but a
  // bench is furniture, not floor — he walks to a tile beside the BENCH and
  // then sits down on it (startUse does the sitting).
  ag.seatIdx = -1;
  for (const [dx, dz] of DIRS) {
    const nx = (anchor % size) + dx, nz = ((anchor / size) | 0) + dz;
    if (!world.inBounds(nx, nz)) continue;
    const seat = nz * size + nx;
    if (!isSeatTile(world, seat)) continue;
    if (pathAdjacent(ag, world, seat, open)) {
      ag.seatIdx = seat;
      return true;
    }
  }
  // No seat: stand at it.
  return pathAdjacent(ag, world, anchor, open);
}


/** The tile at the middle of a piece's footprint (a 2-tile bed's middle is
 *  between its tiles, so the far tile is the honest choice for lying on). */
export function useCenterTile(world: World, anchor: number): number {
  const p = world.pieceAtTile(anchor);
  if (!p) return anchor;
  const tiles = world.pieceTiles(p);
  return tiles[Math.floor(tiles.length / 2)] ?? anchor;
}


/** Walk to the nearest remembered object that fills `need`. */
export function tryUse(A: Agents, ag: Agent, world: World, need: NeedName, kinds = kindsServing(need)): boolean {
  const anchor = nearestUsable(A, ag, world, kinds);
  if (anchor < 0) return false;
  if (!walkToUse(ag, world, anchor)) return false;
  ag.state = "toUse";
  ag.interact = anchor;
  return true;
}


/** The closest remembered object of any of these kinds that he could use. */
export function nearestUsable(A: Agents, ag: Agent, world: World, kinds: number[]): number {
  const size = world.size;
  const ax = Math.floor(ag.x), az = Math.floor(ag.z);
  let best = -1, bd = Infinity;
  for (const kind of kinds) {
    for (const anchor of mem(ag, kind)) {
      if (!useable(A, ag, world, anchor, kind)) continue;
      const d = Math.abs((anchor % size) - ax) + Math.abs(((anchor / size) | 0) - az);
      if (d < bd) { bd = d; best = anchor; }
    }
  }
  return best;
}


/** Arrived at a use-slot object: claim it, take/consume items, settle in. */
export function startUse(A: Agents, ag: Agent, world: World) {
  const anchor = ag.interact;
  const kind = world.objKind[anchor];
  const use = defOf(kind)?.use;
  if (!use || !useable(A, ag, world, anchor, kind)) { ag.state = "idle"; return; }

  let set = A.useClaims.get(anchor);
  if (!set) A.useClaims.set(anchor, set = new Set());
  set.add(ag.id);
  ag.useIdx = anchor;

  const size = world.size;
  if (use.from === "on") {
    const tile = use.center ? useCenterTile(world, anchor) : anchor;
    ag.x = (tile % size) + 0.5;
    ag.z = ((tile / size) | 0) + 0.5;
    // Lie along the bed, not across it.
    const p = world.pieceAtTile(anchor);
    ag.heading = use.center && p
      ? [0, Math.PI / 2, Math.PI, -Math.PI / 2][p.orient & 3]
      : ag.heading;
  } else {
    // Sit down on the bench he walked over to, if he lined one up.
    if (ag.seatIdx >= 0 && isSeatTile(world, ag.seatIdx) &&
        isNextTo(ag, world, ag.seatIdx)) {
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
  ag.pose = (use.pose === POSE_SIT && use.from === "adjacent" && !isSeatTile(world, here))
    ? POSE_STAND : use.pose;

  // Set the tray down on the table before eating it (a leftover if he's
  // interrupted — which is exactly how leftovers happen today).
  if (use.requires !== undefined && hasItem(ag.inv, use.requires)) {
    if (use.consumes !== undefined) {
      removeItem(ag.inv, use.consumes);
      if (kind === Obj.Table) { A.mealTables.add(anchor); A.mealsDirty = true; }
    }
  }
  // Take what it hands out.
  if (use.gives !== undefined) {
    stow(ag.inv, use.gives);
    if (kind === Obj.ServingTable) {
      A.servingStock.set(anchor, (A.servingStock.get(anchor) ?? 1) - 1);
      A.mealsDirty = true;
    }
  }

  // Bedding down during lock-up hours calls for the doors to be shut.
  if (kind === Obj.Bed && (A.curActivity === REG.Sleep || A.curActivity === REG.Lockup) &&
      ag.cellRoom >= 0 && insideOwnCell(ag, world)) {
    lockCell(A, ag, world);
  }

  // A man with a book stays in the chair long enough to actually read it.
  const base = use.seconds > 0 ? use.seconds : Infinity;
  ag.timer = hasItem(ag.inv, Item.Book) ? Math.max(base, READ_TIME) : base;
  ag.state = "using";
}


/** Drain the object's needs into the agent; stop when full, bored, or the
 *  object is gone (a player can erase a bookshelf out from under a reader). */
export function updateUsing(A: Agents, ag: Agent, dt: number, world: World, isNight: boolean) {
  ag.amp = Math.max(0, ag.amp - dt * 8);
  const kind = ag.useIdx >= 0 ? world.objKind[ag.useIdx] : Obj.None;
  const use = defOf(kind)?.use;
  if (!use) { finishUse(A, ag, world); return; }

  // Doing this without permission? Bail the moment a uniform appears.
  if (ag.sneaking) {
    ag.decideT -= dt;
    if (ag.decideT <= 0) {
      ag.decideT = 0.5;
      if (guardInSight(A, ag, world)) {
        ag.risk = Math.min(1, ag.risk + 0.15); // a close call, remembered
        ag.sneaking = false;
        finishUse(A, ag, world);
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
  if (kind === Obj.Bed && !isNight && ag.needs.sleep > 0.75) { finishUse(A, ag, world); return; }
  if (full || ag.timer <= 0) finishUse(A, ag, world);
}


export function finishUse(A: Agents, ag: Agent, world: World) {
  const kind = ag.useIdx >= 0 ? world.objKind[ag.useIdx] : Obj.None;
  const use = defOf(kind)?.use;
  // The meal is finished, so the tray goes.
  if (kind === Obj.Table && A.mealTables.delete(ag.useIdx)) A.mealsDirty = true;
  // Eating is also how a man squirrels away a spoon or works a cutter loose.
  if (kind === Obj.Table) mealContraband(A, ag);

  const on = use?.from === "on";
  releaseUse(A, ag);
  ag.pose = POSE_STAND;
  ag.sneaking = false;
  ag.state = "idle";
  if (on) stepOff(ag, world);
}

