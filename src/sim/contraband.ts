// Contraband: where a spoon lives between meals.
//
// Pockets hold what fits; hands hold the overflow — and hands are VISIBLE, so
// anything showing gets walked back to the bunk and hidden. That trip is the
// whole point of the stash: a guard who catches you takes what is on you, and
// leaves what is under your bed.

import { World } from "./world.ts";
import {
  Item, type Stack,
  canPocket, itemDef, pocket, removeFromHands, removeItem, stashAdd, stashCount, stashTake,
  countItem, stow, takeInHands,
} from "./items.ts";
import { pathAdjacent } from "./move.ts";
import type { Agent } from "./agent.ts";
import { lawfulOpen } from "./move.ts";
import type { Agents } from "./agents.ts";

/** Meals feed the escape kit: a tucked-away spoon, or progress on a cutter. */
export function mealContraband(A: Agents, ag: Agent): boolean {
  if (!A.kitchen || !ag.plan) return false;
  if (ag.plan.method === "dig") {
    if (toolCount(A, ag, Item.Spoon) >= 4) return false;
    return acquire(A, ag, Item.Spoon);
  }
  if (ag.plan.method === "cut") {
    const stolen = acquire(A, ag, Item.Spoon);
    if (!stolen) return false;
    if (toolCount(A, ag, Item.Spoon) >= 3) {
      consumeTools(A, ag, Item.Spoon, 3);
      acquire(A, ag, Item.Cutter);
    }
    return true;
  }
  return false;
}

function consumeTools(A: Agents, ag: Agent, kind: number, count: number): void {
  let left = count;
  while (left > 0 && removeItem(ag.inv, kind)) left--;
  if (ag.bedIdx < 0) return;
  const hidden = stashOf(A, ag.bedIdx);
  while (left > 0 && stashTake(hidden, kind)) left--;
}


/** Take an item: into a pocket if it fits, else into a hand. If neither, it
 *  goes straight under the bunk (he can't very well stand there holding it). */
export function acquire(A: Agents, ag: Agent, kind: number): boolean {
  if (stow(ag.inv, kind)) return true;
  return stashUnderBed(A, ag, kind);
}


export function stashOf(A: Agents, bed: number): Stack[] {
  let s = A.stashes.get(bed);
  if (!s) A.stashes.set(bed, s = []);
  return s;
}


export function stashUnderBed(A: Agents, ag: Agent, kind: number): boolean {
  if (ag.bedIdx < 0) return false;
  return stashAdd(stashOf(A, ag.bedIdx), kind);
}


/** Everything he owns of a kind — on him and hidden under his bunk. */
export function toolCount(A: Agents, ag: Agent, kind: number): number {
  const hidden = ag.bedIdx >= 0 ? stashCount(stashOf(A, ag.bedIdx), kind) : 0;
  return countItem(ag.inv, kind) + hidden;
}


/** Contraband in your HANDS is contraband a guard can see. Once the pockets
 *  are full, the only place left to put it is under the bunk. */
export function needsToStash(ag: Agent): boolean {
  return ag.inv.hands.some((s) => itemDef(s.kind)?.contraband);
}


export function tryStashTrip(ag: Agent, world: World): boolean {
  if (ag.bedIdx < 0 || !needsToStash(ag)) return false;
  if (!pathAdjacent(ag, world, ag.bedIdx, lawfulOpen(ag, world))) return false;
  ag.state = "toStash";
  ag.interact = ag.bedIdx;
  return true;
}


/** At the bunk: push whatever is showing in his hands out of sight. */
export function doStash(A: Agents, ag: Agent) {
  if (ag.bedIdx < 0) return;
  const items = stashOf(A, ag.bedIdx);
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
  if (items.length > 0) A.social.addFact(ag.id, {
    key: `stash:${ag.bedIdx}`, type: "stash", subject: "hidden bunk cache", tile: ag.bedIdx,
    value: items.map((s) => `${s.kind}:${s.count}`).join(","), sourceId: ag.id,
    observedAt: A.simTime, confidence: 1, precision: 1, firsthand: true, expiresAt: Infinity,
  });
}


/** Fetch the tools he hid, because a plan needs them on his person. */
export function tryRetrieveTools(A: Agents, ag: Agent, world: World, kind: number): boolean {
  if (ag.bedIdx < 0) return false;
  if (stashCount(stashOf(A, ag.bedIdx), kind) <= 0) return false;
  if (!pathAdjacent(ag, world, ag.bedIdx, lawfulOpen(ag, world))) return false;
  ag.state = "toRetrieve";
  ag.interact = ag.bedIdx;
  ag.aux = kind;
  return true;
}


export function doRetrieve(A: Agents, ag: Agent, kind: number) {
  if (ag.bedIdx < 0) return;
  const items = stashOf(A, ag.bedIdx);
  while (stashCount(items, kind) > 0) {
    if (pocket(ag.inv, kind) || takeInHands(ag.inv, kind)) { stashTake(items, kind); continue; }
    break; // he cannot carry any more
  }
}
