// Navigation: what a tile permits, and how to get from one to another.
//
// The leaf of the sim's dependency graph — it knows about the World and nothing
// about agents' minds. vision.ts and move.ts build on it; nothing here imports
// them back.

import { Access, World } from "./world.ts";
import { Obj, defOf } from "./objects.ts";

export function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function passable(world: World, i: number, staff: boolean): boolean {
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
export function prisonerAllowed(world: World, i: number): boolean {
  const k = world.objKind[i];
  if (k === Obj.Door || k === Obj.JailDoor || k === Obj.FenceDoor || k === Obj.CutFence) return true;
  return world.accessAt(i) === Access.Prisoners;
}

export function sightBlocks(world: World, i: number): boolean {
  return defOf(world.objKind[i])?.blocksSight ?? false;
}

export function isFenceKind(k: number): boolean {
  return k === Obj.Fence || k === Obj.FenceJailDoor;
}

/** A* over the tile grid. `open` decides what counts as walkable — which is how
 *  the same routine serves a guard (real walls), a prisoner (REMEMBERED walls)
 *  and an escaper (optimistic guesses about what he hasn't seen). */
export function astar(
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

export function bfsFind(
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
