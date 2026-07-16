// The daily regime: what a prisoner is SUPPOSED to be doing this hour.
//
// The regime is the contract. Guards read it to decide who is out of line;
// prisoners follow it unless a need has grown urgent enough to defy it. Note
// that a state name no longer tells you what a man is doing — everything runs
// through one generic "using" state — so compliance is judged by what he is
// walking to or using, not by which branch of the machine he sits in.

import { RoomType, World } from "./world.ts";
import { Obj } from "./objects.ts";
import { Item, hasItem } from "./items.ts";
import { lawfulOpen, pathAdjacent } from "./move.ts";
import { astar, bfsFind } from "./nav.ts";
import { REG, type Agent } from "./agent.ts";
import type { Agents } from "./agents.ts";
import { trySatisfy } from "./needs.ts";

export function insideOwnCell(ag: Agent, world: World): boolean {
  if (ag.cellRoom < 0) return false;
  return world.roomId[world.idx(Math.floor(ag.x), Math.floor(ag.z))] === ag.cellRoom;
}


/** Queue lock-up tasks for the agent's cell doors. */
export function lockCell(A: Agents, ag: Agent, world: World) {
  const room = world.rooms.get(ag.cellRoom);
  if (!room) return;
  for (const d of world.roomJailDoors(room)) {
    if (!world.jailClosed[d] && !A.doorTasks.some((t) => t.idx === d)) {
      A.doorTasks.push({ idx: d, close: true, claimedBy: -1 });
    }
  }
}


/** Follow this hour's regime. Returns true if it consumed the decision. */
export function regimeTick(A: Agents, ag: Agent, world: World): boolean {
  const act = A.curActivity;
  if (!ag.compliant || act === REG.Free) return false;
  // Defiance with a purpose: urgent needs break the schedule — but never
  // away from the very activity that would fix them.
  if (act !== REG.Eating && ag.needs.food < 0.15) return false;
  if (act !== REG.Sleep && ag.needs.sleep < 0.12) return false;
  if (act !== REG.Shower && ag.needs.hygiene < 0.05) return false;

  const showerCell = act === REG.Shower && ag.cellRoom >= 0 && cellHasShower(world, ag);
  switch (act) {
    case REG.Sleep:
    case REG.Lockup: {
      if (ag.cellRoom < 0 || ag.bedIdx < 0) return false;
      if (insideOwnCell(ag, world)) {
        lockCell(A, ag, world);
        if (act === REG.Sleep && trySatisfy(A, ag, world, "sleep")) return true;
        ag.state = "inCell";
        return true;
      }
      if (act === REG.Sleep && trySatisfy(A, ag, world, "sleep")) return true;
      if (pathAdjacent(ag, world, ag.bedIdx, lawfulOpen(ag, world))) {
        ag.state = "regimeToCell";
        return true;
      }
      return false;
    }
    case REG.Eating: {
      // Mid-meal already (tray in hand, or sat at a table).
      if (hasItem(ag.inv, Item.Tray) || ag.state === "using" || ag.state === "queueing") return true;
      if (ag.needs.food > 0.95) return false; // fed; do as you please
      return trySatisfy(A, ag, world, "food");
    }
    case REG.Yard: {
      const size = world.size;
      const here = world.idx(Math.floor(ag.x), Math.floor(ag.z));
      if (world.roomTypeAt(here) === RoomType.Yard) {
        ag.state = "yardTime";
        ag.timer = 0;
        return true;
      }
      const open = lawfulOpen(ag, world);
      const spot = bfsFind(size, here, open, (i) =>
        open(i) && world.roomTypeAt(i) === RoomType.Yard);
      if (spot < 0) return false;
      const path = astar(size, here, spot, open, 30000, (from, to) => world.canNavigateEdge(from, to));
      if (!path) return false;
      ag.path = path; ag.pathI = 0;
      ag.state = "toYard";
      return true;
    }
    case REG.Shower: {
      if (ag.needs.hygiene >= 0.98) return false;
      if (showerCell) {
        if (insideOwnCell(ag, world)) {
          lockCell(A, ag, world);
          ag.state = "inCell";
          return true;
        }
        if (ag.bedIdx >= 0 && pathAdjacent(ag, world, ag.bedIdx, lawfulOpen(ag, world))) {
          ag.state = "regimeToCell";
          return true;
        }
        return false;
      }
      return trySatisfy(A, ag, world, "hygiene");
    }
  }
  return false;
}


/** Is this prisoner's current state already serving the given activity?
 *
 *  Since needs run through one generic "toUse"/"using" pair, a state name no
 *  longer says WHAT he is doing — so ask what he is walking to or using. */
export function usingKind(world: World, p: Agent): number {
  if (p.state === "using" && p.useIdx >= 0) return world.objKind[p.useIdx];
  if ((p.state === "toUse" || p.state === "toQueue") && p.interact >= 0) {
    return world.objKind[p.interact];
  }
  return Obj.None;
}


export function actingInRegime(act: number, p: Agent, world: World): boolean {
  const s = p.state;
  const k = usingKind(world, p);
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
export function regimeDestination(A: Agents, world: World, p: Agent): number {
  const act = A.curActivity;
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
      if (p.cellRoom >= 0 && cellHasShower(world, p)) return p.bedIdx;
      for (const s of world.tilesOfKind(Obj.Shower)) {
        if (world.roomTypeAt(s) === RoomType.ShowerRoom) return s;
      }
      return -1;
    }
  }
  return -1;
}


/** Is this jail door on the boundary of a shower-equipped cell/dorm? */
export function doorServesShowerCell(world: World, door: number): boolean {
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


/** Does this prisoner's cell contain a shower (in-cell shower = lockup)? */
export function cellHasShower(world: World, ag: Agent): boolean {
  const r = world.rooms.get(ag.cellRoom);
  if (!r) return false;
  for (const t of r.tiles) if (world.objKind[t] === Obj.Shower) return true;
  return false;
}
