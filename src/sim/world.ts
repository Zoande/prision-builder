// Simulation layer — pure tile data, no GPU. The world starts empty; the player
// builds it. Stored as flat typed arrays (one value per tile) so a large map is
// cheap. An `active` set + bounding box keep edits and rebuilds O(touched tiles)
// instead of O(map).
//
// Per tile:
//   floorMat  0 = natural ground, else a floor material id
//   objKind   None | Wall | Door | Fence | Bed
//   objMat    material id for walls / fences
//   objOrient 0 (X) or 1 (Z), for doors / beds
//   roofed    derived: 1 if covered by an auto-roof

export const Obj = {
  None: 0, Wall: 1, Door: 2, Fence: 3, Bed: 4,
  Lamp: 5, WallLight: 6, RoofLight: 7,
  Prisoner: 8, Guard: 9,
  JailDoor: 10, Toilet: 11, Shower: 12, Drain: 13,
  FenceDoor: 14, FenceJailDoor: 15,
  Table: 16, Bench2: 17, Bench4: 18, Cooker: 19,
  Cook: 20, CutFence: 21, Workman: 22, ServingTable: 23,
} as const;

/** Multi-tile span object (benches): anchor tile, direction, length. */
export interface Span { x: number; z: number; orient: number; len: number; kind: number }

// --- Rooms & access ---------------------------------------------------------
export const RoomType = {
  Empty: 0, Kitchen: 1, Yard: 2, Canteen: 3, Cell: 4, Dorm: 5, ShowerRoom: 6,
} as const;
export const Access = { Staff: 0, Prisoners: 1, Forbidden: 2 } as const;

export interface Room {
  id: number;
  type: number;
  access: number;
  tiles: Set<number>;
  valid: boolean; // requirements met (invalid rooms behave as Empty)
}

export interface RoomLabel {
  id: number;
  name: string;
  valid: boolean;
  issue: string;
  x: number;
  z: number;
}

// Minimum contained square per room type (0 = none).
const ROOM_MIN_SQUARE: Record<number, number> = {
  [RoomType.Empty]: 0, [RoomType.Kitchen]: 5, [RoomType.Yard]: 10,
  [RoomType.Canteen]: 5, [RoomType.Cell]: 0, [RoomType.Dorm]: 0,
  [RoomType.ShowerRoom]: 5,
};

const PERSON_KINDS: number[] = [Obj.Prisoner, Obj.Guard, Obj.Cook, Obj.Workman];
const SPAN_LEN: Record<number, number> = { [Obj.Bench2]: 2, [Obj.Bench4]: 4 };
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export type ObjKind = (typeof Obj)[keyof typeof Obj];

const ROOM_NAMES: Record<number, string> = {
  [RoomType.Empty]: "Empty Room",
  [RoomType.Kitchen]: "Kitchen",
  [RoomType.Yard]: "Yard",
  [RoomType.Canteen]: "Canteen",
  [RoomType.Cell]: "Cell",
  [RoomType.Dorm]: "Dormitory",
  [RoomType.ShowerRoom]: "Shower Room",
};

// Light fixture emission: color (linear), reach in tiles, and intensity.
const LIGHT_DEFS: Record<number, { color: [number, number, number]; radius: number; power: number }> = {
  [Obj.Lamp]: { color: [1.00, 0.72, 0.42], radius: 6.5, power: 1.15 },
  [Obj.WallLight]: { color: [1.00, 0.85, 0.60], radius: 6.0, power: 1.0 },
  [Obj.RoofLight]: { color: [0.92, 0.95, 1.00], radius: 8.0, power: 1.35 },
};
const LIGHT_REACH = 9; // max radius, for region margins

/** A rectangular RGBA8 block of the world light grid, ready for the GPU. */
export interface LightField { x0: number; z0: number; w: number; h: number; data: Uint8Array }

export interface Bed {
  x: number;
  z: number;
  orient: number;
}

export class World {
  readonly size: number;
  readonly floorMat: Uint8Array;
  readonly objKind: Uint8Array;
  readonly objMat: Uint8Array;
  readonly objOrient: Uint8Array;
  readonly roofed: Uint8Array;

  readonly beds: Bed[] = [];
  private spans: Span[] = [];
  private active = new Set<number>();
  // Rooms: per-tile room id (0 = outside / none) + the room registry.
  readonly roomId: Int32Array;
  readonly rooms = new Map<number, Room>();
  private nextRoomId = 1;
  // Jail door state: 1 = closed (staff-only), 0 = open (everyone).
  readonly jailClosed: Uint8Array;
  // Bounding box of everything touched (for bounded roof flood fill).
  private bx0 = Infinity; private bz0 = Infinity;
  private bx1 = -Infinity; private bz1 = -Infinity;

  constructor(size: number) {
    this.size = size;
    const n = size * size;
    this.floorMat = new Uint8Array(n);
    this.objKind = new Uint8Array(n);
    this.objMat = new Uint8Array(n);
    this.objOrient = new Uint8Array(n);
    this.roofed = new Uint8Array(n);
    this.roomId = new Int32Array(n);
    this.jailClosed = new Uint8Array(n);
  }

  idx(x: number, z: number): number { return z * this.size + x; }

  /** Tile indices of every object of a kind (scans only touched tiles). */
  tilesOfKind(kind: number): number[] {
    const out: number[] = [];
    for (const i of this.active) if (this.objKind[i] === kind) out.push(i);
    return out;
  }
  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.size && z < this.size;
  }

  private touch(x: number, z: number) {
    this.active.add(this.idx(x, z));
    if (x < this.bx0) this.bx0 = x;
    if (z < this.bz0) this.bz0 = z;
    if (x > this.bx1) this.bx1 = x;
    if (z > this.bz1) this.bz1 = z;
  }

  // --- Edits -------------------------------------------------------------
  setFloor(x: number, z: number, mat: number) {
    if (!this.inBounds(x, z)) return;
    this.floorMat[this.idx(x, z)] = mat;
    this.touch(x, z);
  }

  private canObj(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const k = this.objKind[this.idx(x, z)];
    return k !== Obj.Bed && k !== Obj.Bench2 && k !== Obj.Bench4;
  }

  setWall(x: number, z: number, mat: number) {
    if (!this.canObj(x, z)) return;
    const i = this.idx(x, z);
    this.objKind[i] = Obj.Wall;
    this.objMat[i] = mat;
    this.touch(x, z);
  }

  setFence(x: number, z: number, mat: number) {
    if (!this.canObj(x, z)) return;
    const i = this.idx(x, z);
    this.objKind[i] = Obj.Fence;
    this.objMat[i] = mat;
    this.touch(x, z);
  }

  setLamp(x: number, z: number) {
    if (!this.canObj(x, z)) return;
    const i = this.idx(x, z);
    this.objKind[i] = Obj.Lamp;
    this.touch(x, z);
  }

  /** Place a person (Prisoner/Guard/Cook) facing orient (0..3 quarter turns).
   *  Guards carry a baton by default (objMat doubles as the baton flag). */
  setPerson(x: number, z: number, kind: number, orient: number) {
    if (!this.canObj(x, z) || !PERSON_KINDS.includes(kind)) return;
    const i = this.idx(x, z);
    this.objKind[i] = kind;
    this.objOrient[i] = orient & 3;
    this.objMat[i] = kind === Obj.Guard ? 1 : 0;
    this.touch(x, z);
  }

  /** Give the person on a tile a baton (guards already have one). */
  setBaton(x: number, z: number) {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    if (!PERSON_KINDS.includes(this.objKind[i])) return;
    this.objMat[i] = 1;
    this.touch(x, z);
  }

  /** Person instances (x, z, orient, baton) per kind. */
  personInstances(): { prisoners: Float32Array; guards: Float32Array; cooks: Float32Array } {
    const out: Record<number, number[]> = { [Obj.Prisoner]: [], [Obj.Guard]: [], [Obj.Cook]: [] };
    for (const i of this.active) {
      const k = this.objKind[i];
      const a = out[k];
      if (!a) continue;
      a.push(i % this.size, (i / this.size) | 0, this.objOrient[i], this.objMat[i] ? 1 : 0);
    }
    return {
      prisoners: new Float32Array(out[Obj.Prisoner]),
      guards: new Float32Array(out[Obj.Guard]),
      cooks: new Float32Array(out[Obj.Cook]),
    };
  }

  /** Simple one-tile furniture (toilet, shower, drain, table, cooker). */
  setFurniture(x: number, z: number, kind: number, orient: number) {
    if (!this.canObj(x, z)) return;
    const i = this.idx(x, z);
    this.objKind[i] = kind;
    this.objOrient[i] = orient & 3;
    this.objMat[i] = 0;
    this.touch(x, z);
  }

  /** Turn a fence tile into a gate (open FenceDoor / guard-only FenceJailDoor);
   *  orientation follows the fence run, like doors follow walls. */
  setFenceGate(x: number, z: number, locked: boolean) {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    const k = this.objKind[i];
    if (k !== Obj.Fence && k !== Obj.FenceDoor && k !== Obj.FenceJailDoor) return;
    const horiz = this.isFence(x - 1, z) && this.isFence(x + 1, z);
    this.objKind[i] = locked ? Obj.FenceJailDoor : Obj.FenceDoor;
    this.objOrient[i] = horiz ? 0 : 1;
    this.touch(x, z);
  }

  /** Place a multi-tile span object (benches) from an anchor tile. */
  placeSpan(x: number, z: number, orient: number, kind: number): boolean {
    const len = SPAN_LEN[kind];
    if (!len) return false;
    const [dx, dz] = DIRS[orient & 3];
    for (let k = 0; k < len; k++) {
      const tx = x + dx * k, tz = z + dz * k;
      if (!this.inBounds(tx, tz) || this.objKind[this.idx(tx, tz)] !== Obj.None) return false;
    }
    for (let k = 0; k < len; k++) {
      const tx = x + dx * k, tz = z + dz * k;
      const i = this.idx(tx, tz);
      this.objKind[i] = kind;
      this.objOrient[i] = orient & 3;
      this.touch(tx, tz);
    }
    this.spans.push({ x, z, orient: orient & 3, len, kind });
    return true;
  }

  /** Mount a light on an existing wall, facing its most useful open side. */
  setWallLight(x: number, z: number) {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    if (this.objKind[i] !== Obj.Wall && this.objKind[i] !== Obj.WallLight) return;
    // Facing order: +X, +Z, -X, -Z. Prefer an open neighbour with a built
    // floor (a room interior), else any open neighbour.
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let facing = -1;
    for (let pass = 0; pass < 2 && facing < 0; pass++) {
      for (let o = 0; o < 4; o++) {
        const nx = x + dirs[o][0], nz = z + dirs[o][1];
        if (!this.inBounds(nx, nz) || this.wallLike(nx, nz)) continue;
        if (pass === 0 && this.floorMat[this.idx(nx, nz)] === 0) continue;
        facing = o; break;
      }
    }
    if (facing < 0) return;
    this.objKind[i] = Obj.WallLight;
    this.objOrient[i] = facing;
    this.touch(x, z);
  }

  /** Hang a ceiling light; only makes sense under a roof. */
  setRoofLight(x: number, z: number) {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    if (this.roofed[i] !== 1 || this.objKind[i] !== Obj.None) return;
    this.objKind[i] = Obj.RoofLight;
    this.touch(x, z);
  }

  /** Turn a wall tile into a door; orientation follows the surrounding wall run. */
  setDoor(x: number, z: number, jail = false) {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    const k = this.objKind[i];
    if (k !== Obj.Wall && k !== Obj.Door && k !== Obj.JailDoor) return;
    const horiz = this.wallLike(x - 1, z) && this.wallLike(x + 1, z);
    this.objKind[i] = jail ? Obj.JailDoor : Obj.Door;
    this.objOrient[i] = horiz ? 0 : 1;
    this.jailClosed[i] = 0; // doors start open
    this.touch(x, z);
  }

  placeBed(x: number, z: number, orient: number): boolean {
    orient &= 3;
    const x2 = x + (orient === 0 ? 1 : orient === 2 ? -1 : 0);
    const z2 = z + (orient === 1 ? 1 : orient === 3 ? -1 : 0);
    if (!this.inBounds(x, z) || !this.inBounds(x2, z2)) return false;
    if (this.objKind[this.idx(x, z)] !== Obj.None) return false;
    if (this.objKind[this.idx(x2, z2)] !== Obj.None) return false;
    for (const [tx, tz] of [[x, z], [x2, z2]]) {
      const i = this.idx(tx, tz);
      this.objKind[i] = Obj.Bed;
      this.objOrient[i] = orient;
      this.touch(tx, tz);
    }
    this.beds.push({ x, z, orient });
    return true;
  }

  /** Erase the object on a tile, or the floor if there is no object. */
  erase(x: number, z: number) {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    const k = this.objKind[i];
    if (k === Obj.Bench2 || k === Obj.Bench4) {
      const span = this.spans.find((s) => {
        const [dx, dz] = DIRS[s.orient];
        for (let n = 0; n < s.len; n++) {
          if (s.x + dx * n === x && s.z + dz * n === z) return true;
        }
        return false;
      });
      if (span) {
        const [dx, dz] = DIRS[span.orient];
        for (let n = 0; n < span.len; n++) {
          this.objKind[this.idx(span.x + dx * n, span.z + dz * n)] = Obj.None;
        }
        this.spans.splice(this.spans.indexOf(span), 1);
      }
      return;
    }
    if (this.objKind[i] === Obj.Bed) {
      const bed = this.beds.find((b) => {
        const x2 = b.x + (b.orient === 0 ? 1 : b.orient === 2 ? -1 : 0);
        const z2 = b.z + (b.orient === 1 ? 1 : b.orient === 3 ? -1 : 0);
        return (b.x === x && b.z === z) || (x2 === x && z2 === z);
      });
      if (bed) {
        const x2 = bed.x + (bed.orient === 0 ? 1 : bed.orient === 2 ? -1 : 0);
        const z2 = bed.z + (bed.orient === 1 ? 1 : bed.orient === 3 ? -1 : 0);
        this.objKind[this.idx(bed.x, bed.z)] = Obj.None;
        this.objKind[this.idx(x2, z2)] = Obj.None;
        this.beds.splice(this.beds.indexOf(bed), 1);
      }
      return;
    }
    if (this.objKind[i] !== Obj.None) { this.objKind[i] = Obj.None; this.objMat[i] = 0; return; }
    this.floorMat[i] = 0;
  }

  private wallLike(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const k = this.objKind[this.idx(x, z)];
    return k === Obj.Wall || k === Obj.Door || k === Obj.WallLight || k === Obj.JailDoor;
  }

  // --- Auto-roof: flood from outside; enclosed built floors get roofed -----
  recomputeRoofs() {
    for (const i of this.active) this.roofed[i] = 0;
    if (this.bx1 < this.bx0) return;
    const x0 = Math.max(0, this.bx0 - 1), z0 = Math.max(0, this.bz0 - 1);
    const x1 = Math.min(this.size - 1, this.bx1 + 1), z1 = Math.min(this.size - 1, this.bz1 + 1);
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    const reached = new Uint8Array(w * h);
    const ri = (x: number, z: number) => (z - z0) * w + (x - x0);
    const barrier = (x: number, z: number) => {
      const k = this.objKind[this.idx(x, z)];
      return k === Obj.Wall || k === Obj.Door || k === Obj.WallLight || k === Obj.JailDoor;
    };

    // BFS from the region border (which is open ground) through non-barriers.
    const stack: number[] = [];
    const seed = (x: number, z: number) => {
      if (!barrier(x, z) && !reached[ri(x, z)]) { reached[ri(x, z)] = 1; stack.push(x, z); }
    };
    for (let x = x0; x <= x1; x++) { seed(x, z0); seed(x, z1); }
    for (let z = z0; z <= z1; z++) { seed(x0, z); seed(x1, z); }
    while (stack.length) {
      const z = stack.pop()!, x = stack.pop()!;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < x0 || nx > x1 || nz < z0 || nz > z1) continue;
        if (reached[ri(nx, nz)] || barrier(nx, nz)) continue;
        reached[ri(nx, nz)] = 1; stack.push(nx, nz);
      }
    }

    // Enclosed, built-floor interior tiles get roofed...
    const interior = (x: number, z: number) =>
      !barrier(x, z) && !reached[ri(x, z)] && this.floorMat[this.idx(x, z)] > 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (interior(x, z)) this.roofed[this.idx(x, z)] = 1;
      }
    }
    // ...and the bounding walls/doors adjacent (incl. diagonally, so building
    // corners are covered) to a roofed interior.
    const near8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        if (!barrier(x, z)) continue;
        const near = near8.some(([dx, dz]) => {
          const nx = x + dx, nz = z + dz;
          return nx >= x0 && nx <= x1 && nz >= z0 && nz <= z1 && interior(nx, nz);
        });
        if (near) this.roofed[this.idx(x, z)] = 1;
      }
    }
  }

  // --- Rooms ----------------------------------------------------------------

  /** Room-bounding barrier: walls AND fences (and everything door-like). */
  private roomBarrier(i: number): boolean {
    const k = this.objKind[i];
    return k === Obj.Wall || k === Obj.Door || k === Obj.WallLight || k === Obj.JailDoor ||
      k === Obj.Fence || k === Obj.FenceDoor || k === Obj.FenceJailDoor || k === Obj.CutFence;
  }

  /** Re-derive rooms in the touched region: enclosed tiles get a room (new
   *  areas become Empty), tiles no longer enclosed lose theirs. Painted
   *  sub-rooms keep their tiles — enclosure only gates existence. */
  recomputeRooms() {
    if (this.bx1 < this.bx0) return;
    const x0 = Math.max(0, this.bx0 - 1), z0 = Math.max(0, this.bz0 - 1);
    const x1 = Math.min(this.size - 1, this.bx1 + 1), z1 = Math.min(this.size - 1, this.bz1 + 1);
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    const reached = new Uint8Array(w * h);
    const ri = (x: number, z: number) => (z - z0) * w + (x - x0);

    // Flood from the region border: anything reached is open to the outside.
    const stack: number[] = [];
    const seed = (x: number, z: number) => {
      if (!this.roomBarrier(this.idx(x, z)) && !reached[ri(x, z)]) {
        reached[ri(x, z)] = 1; stack.push(x, z);
      }
    };
    for (let x = x0; x <= x1; x++) { seed(x, z0); seed(x, z1); }
    for (let z = z0; z <= z1; z++) { seed(x0, z); seed(x1, z); }
    while (stack.length) {
      const z = stack.pop()!, x = stack.pop()!;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (nx < x0 || nx > x1 || nz < z0 || nz > z1) continue;
        if (reached[ri(nx, nz)] || this.roomBarrier(this.idx(nx, nz))) continue;
        reached[ri(nx, nz)] = 1; stack.push(nx, nz);
      }
    }

    const dropTile = (i: number) => {
      const r = this.rooms.get(this.roomId[i]);
      if (r) { r.tiles.delete(i); if (r.tiles.size === 0) this.rooms.delete(r.id); }
      this.roomId[i] = 0;
    };

    // Clear rooms from barrier/open tiles; note enclosed unassigned ones.
    const orphans: number[] = [];
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = this.idx(x, z);
        const enclosed = !this.roomBarrier(i) && !reached[ri(x, z)];
        if (!enclosed) { if (this.roomId[i] !== 0) dropTile(i); continue; }
        if (this.roomId[i] === 0) orphans.push(i);
        else if (!this.rooms.has(this.roomId[i])) this.roomId[i] = 0; // stale id
      }
    }

    // Assign orphan areas: flood contiguous unassigned tiles; join an adjacent
    // Empty room if one touches, else create a fresh Empty room.
    for (const start of orphans) {
      if (this.roomId[start] !== 0) continue;
      const tiles: number[] = [start];
      const seen = new Set<number>([start]);
      let join: Room | null = null;
      for (let qi = 0; qi < tiles.length; qi++) {
        const cur = tiles[qi];
        const cx = cur % this.size, cz = (cur / this.size) | 0;
        for (const [nx, nz] of [[cx + 1, cz], [cx - 1, cz], [cx, cz + 1], [cx, cz - 1]]) {
          if (nx < x0 || nx > x1 || nz < z0 || nz > z1) continue;
          const ni = this.idx(nx, nz);
          if (seen.has(ni) || this.roomBarrier(ni) || reached[ri(nx, nz)]) continue;
          if (this.roomId[ni] !== 0) {
            const r = this.rooms.get(this.roomId[ni]);
            if (r && r.type === RoomType.Empty && !join) join = r;
            continue;
          }
          seen.add(ni);
          tiles.push(ni);
        }
      }
      const room = join ?? {
        id: this.nextRoomId++, type: RoomType.Empty, access: Access.Staff,
        tiles: new Set<number>(), valid: true,
      };
      if (!join) this.rooms.set(room.id, room);
      for (const t of tiles) { this.roomId[t] = room.id; room.tiles.add(t); }
    }

    this.validateRooms();
  }

  /** Paint a tile with a room type: joins an adjacent same-type room or
   *  starts a new one — this is how one enclosure splits into many rooms. */
  paintRoom(x: number, z: number, type: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    const cur = this.rooms.get(this.roomId[i]);
    if (!cur) return false; // not enclosed (or a wall/fence tile)
    if (cur.type === type && cur.tiles.size > 1) {
      // Painting its own type over a room is a no-op unless it's a re-join.
    }
    let target: Room | null = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (!this.inBounds(nx, nz)) continue;
      const r = this.rooms.get(this.roomId[this.idx(nx, nz)]);
      if (r && r !== cur && r.type === type) { target = r; break; }
      if (r && r === cur && cur.type === type) { target = cur; break; }
    }
    if (!target) {
      if (cur.type === type) return false; // already exactly this
      // Prisoner-facing room types default to prisoner access.
      const prisonerRoom = type === RoomType.Cell || type === RoomType.Dorm ||
        type === RoomType.Yard || type === RoomType.Canteen || type === RoomType.ShowerRoom;
      target = {
        id: this.nextRoomId++, type,
        access: prisonerRoom ? Access.Prisoners : cur.access,
        tiles: new Set<number>(), valid: false,
      };
      this.rooms.set(target.id, target);
    }
    if (target === cur) return false;
    cur.tiles.delete(i);
    if (cur.tiles.size === 0) this.rooms.delete(cur.id);
    target.tiles.add(i);
    this.roomId[i] = target.id;
    this.validateRooms();
    return true;
  }

  /** Set the access level of the room covering a tile. */
  setRoomAccess(x: number, z: number, access: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const r = this.rooms.get(this.roomId[this.idx(x, z)]);
    if (!r || r.access === access) return false;
    r.access = access;
    return true;
  }

  /** Recheck every room's requirements. */
  validateRooms() {
    for (const r of this.rooms.values()) r.valid = this.roomValid(r);
  }

  private roomValid(r: Room): boolean {
    return this.roomIssue(r) === "";
  }

  private roomIssue(r: Room): string {
    const sq = ROOM_MIN_SQUARE[r.type] ?? 0;
    if (sq > 0 && !this.containsSquare(r.tiles, sq)) return `Needs a ${sq}x${sq} clear area.`;
    const has = (kind: number) => {
      for (const t of r.tiles) if (this.objKind[t] === kind) return true;
      return false;
    };
    switch (r.type) {
      case RoomType.Kitchen: return has(Obj.Cooker) ? "" : "Needs a cooker.";
      case RoomType.Canteen:
        if (!has(Obj.Table)) return "Needs a table.";
        if (!has(Obj.Bench2) && !has(Obj.Bench4)) return "Needs a bench.";
        return "";
      case RoomType.Cell:
      case RoomType.Dorm:
        if (!has(Obj.Bed)) return "Needs a bed.";
        if (!has(Obj.Toilet)) return "Needs a toilet.";
        if (!this.roomHasJailDoor(r)) return "Needs a jail door on its boundary.";
        return "";
      case RoomType.ShowerRoom: return has(Obj.Shower) ? "" : "Needs a shower.";
      default: return "";
    }
  }

  private containsSquare(tiles: Set<number>, n: number): boolean {
    for (const t of tiles) {
      const x = t % this.size, z = (t / this.size) | 0;
      let ok = true;
      for (let dz = 0; dz < n && ok; dz++) {
        for (let dx = 0; dx < n; dx++) {
          if (!tiles.has(this.idx(x + dx, z + dz))) { ok = false; break; }
        }
      }
      if (ok) return true;
    }
    return false;
  }

  roomHasJailDoor(r: Room): boolean {
    return this.roomJailDoors(r).length > 0;
  }

  /** Jail door tiles on a room's boundary. */
  roomJailDoors(r: Room): number[] {
    const out = new Set<number>();
    for (const t of r.tiles) {
      const x = t % this.size, z = (t / this.size) | 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (!this.inBounds(nx, nz)) continue;
        const ni = this.idx(nx, nz);
        if (this.objKind[ni] === Obj.JailDoor) out.add(ni);
      }
    }
    return [...out];
  }

  roomAt(i: number): Room | null {
    return this.rooms.get(this.roomId[i]) ?? null;
  }

  /** Access at a tile; outside every room is staff territory. */
  accessAt(i: number): number {
    return this.rooms.get(this.roomId[i])?.access ?? Access.Staff;
  }

  /** Effective room type (invalid rooms behave as Empty). */
  roomTypeAt(i: number): number {
    const r = this.rooms.get(this.roomId[i]);
    return r && r.valid ? r.type : RoomType.Empty;
  }

  /** Room border strips for rendering: (x, z, edgeDir 0..3 = +X,-X,+Z,-Z, access). */
  roomOutline(): Float32Array {
    const out: number[] = [];
    for (const r of this.rooms.values()) {
      for (const t of r.tiles) {
        const x = t % this.size, z = (t / this.size) | 0;
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (let d = 0; d < 4; d++) {
          const nx = x + dirs[d][0], nz = z + dirs[d][1];
          const ni = this.inBounds(nx, nz) ? this.idx(nx, nz) : -1;
          if (ni >= 0 && this.roomId[ni] === r.id) continue;
          out.push(x, z, d, r.access);
        }
      }
    }
    return new Float32Array(out);
  }

  roomLabels(): RoomLabel[] {
    const labels: RoomLabel[] = [];
    for (const r of this.rooms.values()) {
      if (r.tiles.size === 0) continue;
      let sx = 0, sz = 0;
      for (const t of r.tiles) {
        sx += t % this.size;
        sz += (t / this.size) | 0;
      }
      const issue = this.roomIssue(r);
      labels.push({
        id: r.id,
        name: ROOM_NAMES[r.type] ?? "Room",
        valid: issue === "",
        issue,
        x: sx / r.tiles.size + 0.5,
        z: sz / r.tiles.size + 0.5,
      });
    }
    return labels;
  }

  prisonerCapacity(): number {
    let cap = 0;
    for (const b of this.beds) {
      const i = this.idx(b.x, b.z);
      const r = this.rooms.get(this.roomId[i]);
      if (!r || !r.valid || (r.type !== RoomType.Cell && r.type !== RoomType.Dorm)) continue;
      cap++;
    }
    return cap;
  }

  saveData() {
    const tiles: number[][] = [];
    for (const i of this.active) {
      const f = this.floorMat[i], k = this.objKind[i], m = this.objMat[i];
      const o = this.objOrient[i], j = this.jailClosed[i];
      if (f || k || m || o || j) tiles.push([i, f, k, m, o, j]);
    }
    return {
      size: this.size,
      tiles,
      beds: this.beds.map((b) => ({ ...b })),
      spans: this.spans.map((s) => ({ ...s })),
      rooms: [...this.rooms.values()].map((r) => ({
        id: r.id,
        type: r.type,
        access: r.access,
        valid: r.valid,
        tiles: [...r.tiles],
      })),
      nextRoomId: this.nextRoomId,
    };
  }

  loadData(data: ReturnType<World["saveData"]>) {
    this.floorMat.fill(0);
    this.objKind.fill(0);
    this.objMat.fill(0);
    this.objOrient.fill(0);
    this.roofed.fill(0);
    this.roomId.fill(0);
    this.jailClosed.fill(0);
    this.beds.length = 0;
    this.spans = [];
    this.active.clear();
    this.rooms.clear();
    this.nextRoomId = data.nextRoomId ?? 1;
    this.bx0 = Infinity; this.bz0 = Infinity;
    this.bx1 = -Infinity; this.bz1 = -Infinity;

    for (const t of data.tiles ?? []) {
      const [i, f, k, m, o, j] = t;
      this.floorMat[i] = f;
      this.objKind[i] = k;
      this.objMat[i] = m;
      this.objOrient[i] = o;
      this.jailClosed[i] = j;
      this.touch(i % this.size, (i / this.size) | 0);
    }
    for (const b of data.beds ?? []) this.beds.push({ x: b.x, z: b.z, orient: b.orient });
    this.spans = (data.spans ?? []).map((s) => ({ ...s }));
    for (const r of data.rooms ?? []) {
      const room: Room = {
        id: r.id,
        type: r.type,
        access: r.access,
        valid: r.valid,
        tiles: new Set(r.tiles),
      };
      this.rooms.set(room.id, room);
      for (const t of room.tiles) this.roomId[t] = room.id;
    }
    this.recomputeRoofs();
    this.validateRooms();
  }

  // --- Instance data (iterate only touched tiles) ------------------------
  floorsByMat(): Map<number, Float32Array> {
    const buckets = new Map<number, number[]>();
    for (const i of this.active) {
      const m = this.floorMat[i];
      if (m === 0) continue;
      let a = buckets.get(m); if (!a) buckets.set(m, a = []);
      a.push(i % this.size, (i / this.size) | 0);
    }
    return new Map([...buckets].map(([m, a]) => [m, new Float32Array(a)]));
  }

  wallsByMat(): Map<number, Float32Array> {
    const buckets = new Map<number, number[]>();
    for (const i of this.active) {
      // A wall light is still a wall block (with a fixture drawn on top).
      if (this.objKind[i] !== Obj.Wall && this.objKind[i] !== Obj.WallLight) continue;
      const x = i % this.size, z = (i / this.size) | 0;
      let a = buckets.get(this.objMat[i]); if (!a) buckets.set(this.objMat[i], a = []);
      a.push(
        x, z,
        this.wallLike(x, z - 1) ? 0 : 1, this.wallLike(x, z + 1) ? 0 : 1,
        this.wallLike(x + 1, z) ? 0 : 1, this.wallLike(x - 1, z) ? 0 : 1,
      );
    }
    return new Map([...buckets].map(([m, a]) => [m, new Float32Array(a)]));
  }

  private isFence(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const k = this.objKind[this.idx(x, z)];
    return k === Obj.Fence || k === Obj.FenceDoor || k === Obj.FenceJailDoor || k === Obj.CutFence;
  }

  /** Sim: a fence tile is cut open (escape). Keeps material for repair. */
  cutFenceAt(i: number) {
    if (this.objKind[i] !== Obj.Fence && this.objKind[i] !== Obj.FenceJailDoor) return;
    const x = i % this.size, z = (i / this.size) | 0;
    this.objKind[i] = Obj.CutFence;
    this.objOrient[i] = this.isFence(x - 1, z) && this.isFence(x + 1, z) ? 0 : 1;
    this.touch(x, z);
  }

  /** Sim: a workman restores a cut fence. */
  repairFenceAt(i: number) {
    if (this.objKind[i] !== Obj.CutFence) return;
    this.objKind[i] = Obj.Fence;
    this.touch(i % this.size, (i / this.size) | 0);
  }

  /** Fence instances by material: x, z, connect flags N,S,E,W (1 = rail to neighbour). */
  fencesByMat(): Map<number, Float32Array> {
    const buckets = new Map<number, number[]>();
    for (const i of this.active) {
      if (this.objKind[i] !== Obj.Fence) continue;
      const x = i % this.size, z = (i / this.size) | 0;
      let a = buckets.get(this.objMat[i]); if (!a) buckets.set(this.objMat[i], a = []);
      a.push(
        x, z,
        this.isFence(x, z - 1) ? 1 : 0, this.isFence(x, z + 1) ? 1 : 0,
        this.isFence(x + 1, z) ? 1 : 0, this.isFence(x - 1, z) ? 1 : 0,
      );
    }
    return new Map([...buckets].map(([m, a]) => [m, new Float32Array(a)]));
  }

  doorInstances(): Float32Array {
    const out: number[] = [];
    for (const i of this.active) {
      if (this.objKind[i] !== Obj.Door) continue;
      out.push(i % this.size, (i / this.size) | 0, this.objOrient[i], 0);
    }
    return new Float32Array(out);
  }

  jailDoorInstances(): Float32Array {
    const out: number[] = [];
    for (const i of this.active) {
      if (this.objKind[i] !== Obj.JailDoor) continue;
      out.push(i % this.size, (i / this.size) | 0, this.objOrient[i], this.jailClosed[i] ? 0 : 1);
    }
    return new Float32Array(out);
  }

  /** Single-tile + span furniture instances (x, z, orient) keyed by Obj kind. */
  furnitureInstances(): Map<number, Float32Array> {
    const buckets = new Map<number, number[]>();
    const push = (kind: number, x: number, z: number, o: number) => {
      let a = buckets.get(kind); if (!a) buckets.set(kind, a = []);
      a.push(x, z, o);
    };
    const SINGLE = new Set<number>([
      Obj.Toilet, Obj.Shower, Obj.Drain, Obj.FenceDoor, Obj.FenceJailDoor,
      Obj.Table, Obj.Cooker, Obj.CutFence, Obj.ServingTable,
    ]);
    for (const i of this.active) {
      const k = this.objKind[i];
      if (!SINGLE.has(k)) continue;
      push(k, i % this.size, (i / this.size) | 0, this.objOrient[i]);
    }
    for (const s of this.spans) push(s.kind, s.x, s.z, s.orient);
    return new Map([...buckets].map(([k, a]) => [k, new Float32Array(a)]));
  }

  bedInstances(): Float32Array {
    const out: number[] = [];
    for (const b of this.beds) out.push(b.x, b.z, b.orient);
    return new Float32Array(out);
  }

  /** Fixture instances (x, z, orient) per light type. */
  lightInstances(): { lamps: Float32Array; wallLights: Float32Array; roofLights: Float32Array } {
    const lamps: number[] = [], wallLights: number[] = [], roofLights: number[] = [];
    for (const i of this.active) {
      const k = this.objKind[i];
      const x = i % this.size, z = (i / this.size) | 0;
      if (k === Obj.Lamp) lamps.push(x, z, 0);
      else if (k === Obj.WallLight) wallLights.push(x, z, this.objOrient[i]);
      else if (k === Obj.RoofLight) roofLights.push(x, z, 0);
    }
    return {
      lamps: new Float32Array(lamps),
      wallLights: new Float32Array(wallLights),
      roofLights: new Float32Array(roofLights),
    };
  }

  /** Recompute the light grid over the touched region: every fixture spreads
   *  its color with a chamfer distance transform that walls block, so light
   *  pools in rooms, spills through doorways, and never leaks through walls.
   *  Returns the RGBA8 block to upload (covers all lights + their reach). */
  lightField(): LightField | null {
    if (this.bx1 < this.bx0) return null;
    const x0 = Math.max(0, this.bx0 - LIGHT_REACH), z0 = Math.max(0, this.bz0 - LIGHT_REACH);
    const x1 = Math.min(this.size - 1, this.bx1 + LIGHT_REACH);
    const z1 = Math.min(this.size - 1, this.bz1 + LIGHT_REACH);
    const w = x1 - x0 + 1, h = z1 - z0 + 1;
    const acc = new Float32Array(w * h * 3);

    const solid = (x: number, z: number) => {
      if (!this.inBounds(x, z)) return true;
      const k = this.objKind[this.idx(x, z)];
      return k === Obj.Wall || k === Obj.WallLight; // doors let light through
    };

    for (const i of this.active) {
      const def = LIGHT_DEFS[this.objKind[i]];
      if (!def) continue;
      let sx = i % this.size, sz = (i / this.size) | 0;
      if (this.objKind[i] === Obj.WallLight) {
        // The fixture hangs on the open side of its wall; light starts there.
        const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
        const o = this.objOrient[i];
        sx += dirs[o][0]; sz += dirs[o][1];
      }
      if (solid(sx, sz)) continue;

      // Chamfer distance transform on a small local grid around the light.
      const RL = Math.ceil(def.radius), S = RL * 2 + 1;
      const dist = new Float32Array(S * S).fill(1e9);
      dist[RL * S + RL] = 0;
      const D = Math.SQRT2;
      for (let pass = 0; pass < 3; pass++) {
        for (let sweep = 0; sweep < 2; sweep++) {
          const rev = sweep === 1;
          for (let j = 0; j < S * S; j++) {
            const n = rev ? S * S - 1 - j : j;
            const lz = (n / S) | 0, lx = n % S;
            if (solid(sx - RL + lx, sz - RL + lz)) continue;
            let d = dist[n];
            for (let dz = -1; dz <= 1; dz++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dz === 0) continue;
                const nx = lx + dx, nz = lz + dz;
                if (nx < 0 || nz < 0 || nx >= S || nz >= S) continue;
                const nd = dist[nz * S + nx] + (dx !== 0 && dz !== 0 ? D : 1);
                if (nd < d) d = nd;
              }
            }
            dist[n] = d;
          }
        }
      }

      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const d = dist[lz * S + lx];
          if (d > def.radius) continue;
          const wx = sx - RL + lx, wz = sz - RL + lz;
          if (wx < x0 || wx > x1 || wz < z0 || wz > z1) continue;
          const f = 1 - d / def.radius;
          const e = f * f * def.power;
          const a = ((wz - z0) * w + (wx - x0)) * 3;
          acc[a] += def.color[0] * e;
          acc[a + 1] += def.color[1] * e;
          acc[a + 2] += def.color[2] * e;
        }
      }
    }

    // Pack to RGBA8; intensity range [0,2] maps to [0,255] (shader re-scales).
    const data = new Uint8Array(w * h * 4);
    for (let n = 0; n < w * h; n++) {
      data[n * 4] = Math.min(255, (acc[n * 3] * 127.5) | 0);
      data[n * 4 + 1] = Math.min(255, (acc[n * 3 + 1] * 127.5) | 0);
      data[n * 4 + 2] = Math.min(255, (acc[n * 3 + 2] * 127.5) | 0);
      data[n * 4 + 3] = 255;
    }
    return { x0, z0, w, h, data };
  }

  /** Roof instances bucketed by the wall material of the building they cover.
   *  Interior tiles inherit the nearest bounding wall's material (BFS inward),
   *  so a roof always matches the walls it rises from. */
  roofsByMat(): Map<number, Float32Array> {
    // Seed from roofed wall/door tiles, flood across roofed interior tiles.
    const mat = new Map<number, number>();
    const queue: number[] = [];
    for (const i of this.active) {
      if (this.roofed[i] !== 1) continue;
      const k = this.objKind[i];
      if (k === Obj.Wall || k === Obj.Door || k === Obj.WallLight || k === Obj.JailDoor) {
        mat.set(i, this.objMat[i] || 1);
        queue.push(i);
      }
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi];
      const m = mat.get(i)!;
      const x = i % this.size, z = (i / this.size) | 0;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]) {
        if (!this.inBounds(nx, nz)) continue;
        const ni = this.idx(nx, nz);
        if (this.roofed[ni] !== 1 || mat.has(ni)) continue;
        mat.set(ni, m);
        queue.push(ni);
      }
    }

    const roofed = (x: number, z: number) =>
      this.inBounds(x, z) && this.roofed[this.idx(x, z)] === 1;
    const buckets = new Map<number, number[]>();
    for (const i of this.active) {
      if (this.roofed[i] !== 1) continue;
      const x = i % this.size, z = (i / this.size) | 0;
      const m = mat.get(i) ?? 1;
      let a = buckets.get(m); if (!a) buckets.set(m, a = []);
      a.push(
        x, z,
        roofed(x, z - 1) ? 0 : 1, roofed(x, z + 1) ? 0 : 1,
        roofed(x + 1, z) ? 0 : 1, roofed(x - 1, z) ? 0 : 1,
      );
    }
    return new Map([...buckets].map(([m, a]) => [m, new Float32Array(a)]));
  }
}
