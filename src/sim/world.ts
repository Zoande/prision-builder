// Simulation layer — pure tile data, no GPU. The world starts empty; the player
// builds it. Stored as flat typed arrays (one value per tile) so a large map is
// cheap. An `active` set + bounding box keep edits and rebuilds O(touched tiles)
// instead of O(map).
//
// Per tile:
//   floorMat  0 = natural ground, else a floor material id
//   objKind   an Obj kind (see objects.ts — that table owns every per-kind fact)
//   objMat    material id for walls / fences
//   objOrient 0..3 quarter turns
//   roofed    derived: 1 if covered by an auto-roof
//   pieceAt   0 = none, else the id of the multi-tile piece covering this tile
//
// Furniture is placed as a `Piece`: a w x d footprint with one anchor tile. A
// bed is a 2x1 piece, a 4-seat bench a 4x1 piece, a toilet a 1x1 piece — the
// three ad-hoc systems this replaced are now one.

// .ts extensions: the dev scripts import this module through Node's native type
// stripping, which will not resolve an extensionless specifier.
import { DIRS, Obj, OBJ_DEFS, RoomType, defOf, roomDef } from "./objects.ts";

export {
  Obj, DIRS, OBJ_DEFS, PIECE_DEFS, NEEDS, RoomType, ROOM_DEFS, SHELF_KINDS,
  defOf, roomDef, kindsServing,
} from "./objects.ts";
export type { ObjDef, ObjKind, NeedName, UseDef, RoomDef } from "./objects.ts";

/** A placed footprint object. `w` runs along DIRS[orient], `d` across it. */
export interface Piece {
  id: number;
  kind: number;
  x: number;
  z: number;
  orient: number;
  w: number;
  d: number;
}

/** A patrol beat: an ordered run of tiles a guard walks up and down.
 *
 *  Two colours exist for one reason — so two beats can cross without merging
 *  into one. A tile can carry one route of each colour, never two of the same. */
export interface PatrolRoute {
  id: number;
  color: number; // 0 = blue, 1 = purple
  tiles: number[];
}
export const ROUTE_COLORS = 2;

/** Saves written before pieces existed: separate bed and bench-span lists. */
interface LegacySave {
  beds?: { x: number; z: number; orient: number }[];
  spans?: { x: number; z: number; orient: number; len: number; kind: number }[];
}

// --- Rooms & access ---------------------------------------------------------
export const Access = { Staff: 0, Prisoners: 1, Forbidden: 2 } as const;

export interface Room {
  id: number;
  type: number;
  access: number;
  tiles: Set<number>;
  valid: boolean; // requirements met (invalid rooms behave as Empty)
  /** Furnishing quality: the room's ambience points spread over its area. */
  ambience: number;
  /** How many guards the player has posted here. 0 = none. */
  guards: number;
}

export interface RoomLabel {
  id: number;
  name: string;
  valid: boolean;
  issue: string;
  ambience: number;
  x: number;
  z: number;
}

// How much a well-furnished room speeds up the needs filled inside it. A bare
// room fills at 1.0x; a lavish one at 1 + AMBIENCE_MAX.
const AMBIENCE_MAX = 0.5;
const AMBIENCE_FULL = 1.4; // points per tile that count as fully furnished

const PERSON_KINDS: number[] = OBJ_DEFS.filter((d) => d.place === "person").map((d) => d.kind);

// Light fixture emission: color (linear), reach in tiles, and intensity.
const LIGHT_DEFS: Record<number, { color: [number, number, number]; radius: number; power: number }> = {
  [Obj.Lamp]: { color: [1.00, 0.72, 0.42], radius: 6.5, power: 1.15 },
  [Obj.WallLight]: { color: [1.00, 0.85, 0.60], radius: 6.0, power: 1.0 },
  [Obj.RoofLight]: { color: [0.92, 0.95, 1.00], radius: 8.0, power: 1.35 },
};
const LIGHT_REACH = 9; // max radius, for region margins

/** A rectangular RGBA8 block of the world light grid, ready for the GPU. */
export interface LightField { x0: number; z0: number; w: number; h: number; data: Uint8Array }

export class World {
  /** Task-2 structural access resolver, installed at runtime by AreaSystem. */
  task2Access: ((tile: number, custody: string) => boolean) | null = null;
  /** Role-aware access resolver for staff, workers, drivers, and visitors. */
  task2RoleAccess: ((tile: number, role: string, custody?: string) => boolean) | null = null;
  readonly externalRoomIssues = new Map<number, string>();
  readonly size: number;
  readonly floorMat: Uint8Array;
  // Uint16: the object registry is meant to grow into the hundreds, and a
  // Uint8Array would have capped it at 255 kinds.
  readonly objKind: Uint16Array;
  readonly objMat: Uint8Array;
  readonly objOrient: Uint8Array;
  readonly roofed: Uint8Array;

  // Multi-tile furniture. `pieceAt` maps a tile to its piece id (0 = none), so
  // "which object is this tile part of" is O(1) — it used to be a linear scan
  // of every bed in the prison, run for every tile every agent could see.
  readonly pieces = new Map<number, Piece>();
  readonly pieceAt: Int32Array;
  /** 0 = player world, 1 = immutable fixed infrastructure. */
  readonly infrastructure: Uint8Array;
  private nextPieceId = 1;
  // Patrol beats. One lookup array per colour, so a blue and a purple beat can
  // cross on the same tile and stay two separate beats.
  readonly routes = new Map<number, PatrolRoute>();
  private routeAt: Int32Array[] = [];
  private nextRouteId = 1;
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
    this.objKind = new Uint16Array(n);
    this.objMat = new Uint8Array(n);
    this.objOrient = new Uint8Array(n);
    this.roofed = new Uint8Array(n);
    this.roomId = new Int32Array(n);
    this.jailClosed = new Uint8Array(n);
    this.pieceAt = new Int32Array(n);
    this.infrastructure = new Uint8Array(n);
    for (let c = 0; c < ROUTE_COLORS; c++) this.routeAt.push(new Int32Array(n));
  }

  // --- Patrol routes --------------------------------------------------------

  /** Begin drawing a beat of this colour. */
  startRoute(color: number): number {
    const r: PatrolRoute = { id: this.nextRouteId++, color: color & 1, tiles: [] };
    this.routes.set(r.id, r);
    return r.id;
  }

  /** Extend a beat by a tile. Skips repeats, and refuses to cross itself. */
  addRouteTile(routeId: number, x: number, z: number): boolean {
    const r = this.routes.get(routeId);
    if (!r || !this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (r.tiles.length > 0 && r.tiles[r.tiles.length - 1] === i) return false;
    if (this.routeAt[r.color][i] === r.id) return false;
    // A tile already used by another beat of the same colour is taken.
    if (this.routeAt[r.color][i] !== 0) return false;
    r.tiles.push(i);
    this.routeAt[r.color][i] = r.id;
    return true;
  }

  /** Finish a beat. One tile is a dot, not a patrol — throw it away. */
  endRoute(routeId: number) {
    const r = this.routes.get(routeId);
    if (r && r.tiles.length < 2) this.removeRoute(routeId);
  }

  removeRoute(routeId: number) {
    const r = this.routes.get(routeId);
    if (!r) return;
    for (const i of r.tiles) {
      if (this.routeAt[r.color][i] === r.id) this.routeAt[r.color][i] = 0;
    }
    this.routes.delete(routeId);
  }

  /** Any beat covering this tile (either colour), or 0. */
  routeAtTile(x: number, z: number): number {
    if (!this.inBounds(x, z)) return 0;
    const i = this.idx(x, z);
    for (let c = 0; c < ROUTE_COLORS; c++) {
      if (this.routeAt[c][i] !== 0) return this.routeAt[c][i];
    }
    return 0;
  }

  /** Beat tiles for the overlay: (x, z, colorId). Only drawn in patrol modes. */
  routeOverlay(): Float32Array {
    const out: number[] = [];
    for (const r of this.routes.values()) {
      for (const i of r.tiles) {
        out.push(i % this.size, (i / this.size) | 0, r.color === 0 ? 3 : 4);
      }
    }
    return new Float32Array(out);
  }

  /** Rooms with guards posted to them, for the same overlay. */
  postedOverlay(): Float32Array {
    const out: number[] = [];
    for (const r of this.rooms.values()) {
      if (r.guards <= 0) continue;
      for (const t of r.tiles) out.push(t % this.size, (t / this.size) | 0, 5);
    }
    return new Float32Array(out);
  }

  // --- Pieces ---------------------------------------------------------------

  /** The tiles a piece covers: w along DIRS[orient], d across it. */
  pieceTiles(p: Piece): number[] {
    const [ax, az] = DIRS[p.orient & 3];
    const [bx, bz] = DIRS[(p.orient + 1) & 3];
    const out: number[] = [];
    for (let a = 0; a < p.w; a++) {
      for (let b = 0; b < p.d; b++) {
        const tx = p.x + ax * a + bx * b, tz = p.z + az * a + bz * b;
        if (!this.inBounds(tx, tz)) return [];
        out.push(this.idx(tx, tz));
      }
    }
    return out;
  }

  /** The piece covering a tile, or null. */
  pieceAtTile(i: number): Piece | null {
    return this.pieces.get(this.pieceAt[i]) ?? null;
  }

  /** The anchor tile of the piece covering `i` — or `i` itself if it isn't one. */
  anchorOf(i: number): number {
    const p = this.pieceAtTile(i);
    return p ? this.idx(p.x, p.z) : i;
  }

  piecesOfKind(kind: number): Piece[] {
    return [...this.pieces.values()].filter((p) => p.kind === kind);
  }

  /** Place a footprint object. All its tiles must be empty. */
  placePiece(x: number, z: number, kind: number, orient: number): boolean {
    const d = defOf(kind);
    if (!d || d.place !== "piece" || !this.inBounds(x, z)) return false;
    const piece: Piece = {
      id: this.nextPieceId, kind, x, z, orient: orient & 3, w: d.w, d: d.d,
    };
    const tiles = this.pieceTiles(piece);
    if (tiles.length === 0) return false; // ran off the map
    for (const i of tiles) {
      if (this.objKind[i] !== Obj.None) return false;
      if (this.infrastructure[i] && kind !== Obj.SecureBridge) return false;
    }

    this.nextPieceId++;
    this.pieces.set(piece.id, piece);
    for (const i of tiles) {
      this.objKind[i] = kind;
      this.objOrient[i] = piece.orient;
      this.objMat[i] = 0;
      this.jailClosed[i] = 0;
      this.pieceAt[i] = piece.id;
      this.touch(i % this.size, (i / this.size) | 0);
    }
    return true;
  }

  private removePiece(p: Piece) {
    for (const i of this.pieceTiles(p)) {
      this.objKind[i] = Obj.None;
      this.objMat[i] = 0;
      this.objOrient[i] = 0;
      this.jailClosed[i] = 0;
      this.pieceAt[i] = 0;
      this.touch(i % this.size, (i / this.size) | 0);
    }
    this.pieces.delete(p.id);
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

  isInfrastructure(x: number, z: number): boolean {
    return this.inBounds(x, z) && this.infrastructure[this.idx(x, z)] !== 0;
  }

  /** Secure bridges are the one specialized elevated path. Their long ends
   *  are open; their two long sides are railings for navigation and room flood. */
  canNavigateEdge(from: number, to: number): boolean {
    const fromPiece = this.pieceAtTile(from);
    const toPiece = this.pieceAtTile(to);
    const bridge = fromPiece?.kind === Obj.SecureBridge ? fromPiece
      : toPiece?.kind === Obj.SecureBridge ? toPiece : null;
    if (!bridge || (fromPiece?.id === bridge.id && toPiece?.id === bridge.id)) return true;
    const inside = fromPiece?.id === bridge.id ? from : to;
    const outside = inside === from ? to : from;
    const ix = inside % this.size, iz = (inside / this.size) | 0;
    const ox = outside % this.size, oz = (outside / this.size) | 0;
    // Fixed east/west orientation: only x-adjacent entry/exit at x=anchor or
    // x=anchor+w-1. Both z lanes are valid open ends.
    if (iz !== oz) return false;
    return (ix === bridge.x && ox === bridge.x - 1) ||
      (ix === bridge.x + bridge.w - 1 && ox === bridge.x + bridge.w);
  }

  bridgeIsSecure(piece: Piece): boolean {
    if (piece.kind !== Obj.SecureBridge) return false;
    const barrier = (x: number, z: number) => this.inBounds(x, z) && this.roomBarrier(this.idx(x, z));
    const left = piece.x, right = piece.x + piece.w - 1;
    return barrier(left, piece.z - 1) && barrier(left, piece.z + piece.d) &&
      barrier(right, piece.z - 1) && barrier(right, piece.z + piece.d);
  }

  /** InfrastructureSystem is the only caller allowed to write fixed tiles. */
  setInfrastructureFloor(x: number, z: number, mat: number): void {
    if (!this.inBounds(x, z)) return;
    const i = this.idx(x, z);
    this.floorMat[i] = mat;
    this.infrastructure[i] = 1;
    this.touch(x, z);
  }

  // --- Edits -------------------------------------------------------------
  setFloor(x: number, z: number, mat: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    if (this.floorMat[i] === mat) return false;
    this.floorMat[i] = mat;
    this.touch(x, z);
    return true;
  }

  /** Structural placement never bulldozes furniture — erase the piece first. */
  private canObj(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    return this.infrastructure[i] === 0 && this.pieceAt[i] === 0;
  }

  setWall(x: number, z: number, mat: number): boolean {
    if (!this.canObj(x, z)) return false;
    const i = this.idx(x, z);
    if (this.objKind[i] === Obj.Wall && this.objMat[i] === mat &&
        this.objOrient[i] === 0 && this.jailClosed[i] === 0) return false;
    this.objKind[i] = Obj.Wall;
    this.objMat[i] = mat;
    this.objOrient[i] = 0;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  setFence(x: number, z: number, mat: number): boolean {
    if (!this.canObj(x, z)) return false;
    const i = this.idx(x, z);
    if (this.objKind[i] === Obj.Fence && this.objMat[i] === mat &&
        this.objOrient[i] === 0 && this.jailClosed[i] === 0) return false;
    this.objKind[i] = Obj.Fence;
    this.objMat[i] = mat;
    this.objOrient[i] = 0;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  setLamp(x: number, z: number): boolean {
    if (!this.canObj(x, z)) return false;
    const i = this.idx(x, z);
    if (this.objKind[i] === Obj.Lamp && this.objMat[i] === 0 &&
        this.objOrient[i] === 0 && this.jailClosed[i] === 0) return false;
    this.objKind[i] = Obj.Lamp;
    this.objMat[i] = 0;
    this.objOrient[i] = 0;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  /** Place a person (Prisoner/Guard/Cook) facing orient (0..3 quarter turns).
   *  Guards carry a baton by default (objMat doubles as the baton flag). */
  setPerson(x: number, z: number, kind: number, orient: number): boolean {
    if (!this.canObj(x, z) || !PERSON_KINDS.includes(kind)) return false;
    const i = this.idx(x, z);
    if (this.objKind[i] !== Obj.None) return false;
    const facing = orient & 3;
    const baton = kind === Obj.Guard ? 1 : 0;
    if (this.objKind[i] === kind && this.objOrient[i] === facing &&
        this.objMat[i] === baton && this.jailClosed[i] === 0) return false;
    this.objKind[i] = kind;
    this.objOrient[i] = facing;
    this.objMat[i] = baton;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  /** Give the person on a tile a baton (guards already have one). */
  setBaton(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    if (!PERSON_KINDS.includes(this.objKind[i]) || this.objMat[i] === 1) return false;
    this.objMat[i] = 1;
    this.touch(x, z);
    return true;
  }

  /** Turn a fence tile into a gate (open FenceDoor / guard-only FenceJailDoor);
   *  orientation follows the fence run, like doors follow walls. */
  setFenceGate(x: number, z: number, locked: boolean | "staff"): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    const k = this.objKind[i];
    if (k !== Obj.Fence && k !== Obj.FenceDoor && k !== Obj.StaffFenceDoor && k !== Obj.FenceJailDoor) return false;
    const horiz = this.isFence(x - 1, z) && this.isFence(x + 1, z);
    const kind = locked === "staff" ? Obj.StaffFenceDoor : locked ? Obj.FenceJailDoor : Obj.FenceDoor;
    const orient = horiz ? 0 : 1;
    if (k === kind && this.objOrient[i] === orient && this.jailClosed[i] === 0) return false;
    this.objKind[i] = kind;
    this.objOrient[i] = orient;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  /** Mount a light on an existing wall, facing its most useful open side. */
  setWallLight(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    if (this.objKind[i] !== Obj.Wall && this.objKind[i] !== Obj.WallLight) return false;
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
    if (facing < 0) return false;
    if (this.objKind[i] === Obj.WallLight && this.objOrient[i] === facing &&
        this.jailClosed[i] === 0) return false;
    this.objKind[i] = Obj.WallLight;
    this.objOrient[i] = facing;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  /** Hang a ceiling light; only makes sense under a roof. */
  setRoofLight(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    if (this.roofed[i] !== 1 || this.objKind[i] !== Obj.None) return false;
    this.objKind[i] = Obj.RoofLight;
    this.objMat[i] = 0;
    this.objOrient[i] = 0;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  /** Turn a wall tile into a door; orientation follows the surrounding wall run. */
  setDoor(x: number, z: number, jail: boolean | "staff" = false): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    const k = this.objKind[i];
    if (k !== Obj.Wall && k !== Obj.Door && k !== Obj.StaffDoor && k !== Obj.JailDoor) return false;
    const horiz = this.wallLike(x - 1, z) && this.wallLike(x + 1, z);
    const kind = jail === "staff" ? Obj.StaffDoor : jail ? Obj.JailDoor : Obj.Door;
    const orient = horiz ? 0 : 1;
    if (k === kind && this.objOrient[i] === orient && this.jailClosed[i] === 0) return false;
    this.objKind[i] = kind;
    this.objOrient[i] = orient;
    this.jailClosed[i] = 0; // doors start open
    this.touch(x, z);
    return true;
  }

  /** Erase the object on a tile (a whole piece if it is one), or the floor. */
  erase(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const i = this.idx(x, z);
    if (this.infrastructure[i]) return false;
    const piece = this.pieceAtTile(i);
    if (piece) { this.removePiece(piece); return true; }
    if (this.objKind[i] !== Obj.None) {
      this.objKind[i] = Obj.None;
      this.objMat[i] = 0;
      this.objOrient[i] = 0;
      this.jailClosed[i] = 0;
      this.touch(x, z);
      return true;
    }
    if (this.floorMat[i] === 0 && this.objMat[i] === 0 &&
        this.objOrient[i] === 0 && this.jailClosed[i] === 0) return false;
    this.floorMat[i] = 0;
    this.objMat[i] = 0;
    this.objOrient[i] = 0;
    this.jailClosed[i] = 0;
    this.touch(x, z);
    return true;
  }

  /** Roof/sight barrier: walls and doors, but not fences. */
  private wallLike(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    return defOf(this.objKind[this.idx(x, z)])?.roofBarrier ?? false;
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
    const barrier = (x: number, z: number) => this.wallLike(x, z);

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
    return defOf(this.objKind[i])?.roomBarrier ?? false;
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
        const ni = this.idx(nx, nz), cur = this.idx(x, z);
        if (reached[ri(nx, nz)] || this.roomBarrier(ni) || !this.canNavigateEdge(cur, ni)) continue;
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
          if (seen.has(ni) || this.roomBarrier(ni) || reached[ri(nx, nz)] || !this.canNavigateEdge(cur, ni)) continue;
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
        tiles: new Set<number>(), valid: true, ambience: 0, guards: 0,
      };
      if (!join) this.rooms.set(room.id, room);
      for (const t of tiles) { this.roomId[t] = room.id; room.tiles.add(t); }
    }

    this.validateRooms();
  }

  /** Begin a room-paint drag, and decide which room every tile of it joins.
   *
   *  Start inside a room of the type you're painting and you EXTEND that room,
   *  however far you drag — even back out over other rooms. Start anywhere else
   *  and you get a fresh room that OVERRIDES whatever it's dragged across.
   *  Returns the room id to paint into, or 0 if the start tile isn't enclosed. */
  startRoomPaint(x: number, z: number, type: number): number {
    if (!this.inBounds(x, z)) return 0;
    const cur = this.rooms.get(this.roomId[this.idx(x, z)]);
    if (!cur) return 0; // not enclosed (or a wall/fence tile)
    if (cur.type === type) return cur.id;
    const room: Room = {
      id: this.nextRoomId++, type,
      access: roomDef(type)?.prisonerAccess ? Access.Prisoners : cur.access,
      tiles: new Set<number>(), valid: false, ambience: 0, guards: 0,
    };
    this.rooms.set(room.id, room);
    return room.id;
  }

  /** Paint one tile into the room a drag claimed. */
  paintRoomInto(x: number, z: number, roomId: number): boolean {
    if (!this.inBounds(x, z)) return false;
    const target = this.rooms.get(roomId);
    if (!target) return false;
    const i = this.idx(x, z);
    const cur = this.rooms.get(this.roomId[i]);
    if (!cur || cur === target) return false; // not enclosed, or already ours
    cur.tiles.delete(i);
    if (cur.tiles.size === 0) this.rooms.delete(cur.id);
    target.tiles.add(i);
    this.roomId[i] = roomId;
    return true;
  }

  /** End a room-paint drag: drop it if it never covered a tile, then revalidate. */
  endRoomPaint(roomId: number) {
    const r = this.rooms.get(roomId);
    if (r && r.tiles.size === 0) this.rooms.delete(roomId);
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
      target = {
        id: this.nextRoomId++, type,
        access: roomDef(type)?.prisonerAccess ? Access.Prisoners : cur.access,
        tiles: new Set<number>(), valid: false, ambience: 0, guards: 0,
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

  /** Recheck every room's requirements and re-score its furnishing. */
  validateRooms() {
    for (const r of this.rooms.values()) {
      r.valid = this.roomIssue(r) === "";
      r.ambience = this.roomAmbience(r);
    }
  }

  /** Why this room doesn't work, straight off its ROOM_DEFS row. "" = it does. */
  private roomIssue(r: Room): string {
    const external = this.externalRoomIssues.get(r.id);
    if (external) return external;
    const def = roomDef(r.type);
    if (!def) return "";
    if (def.minSquare > 0 && !this.containsSquare(r.tiles, def.minSquare)) {
      return `Needs a ${def.minSquare}x${def.minSquare} clear area.`;
    }
    if (def.openSky) {
      for (const t of r.tiles) if (this.roofed[t]) return "Must be outdoors under open sky.";
    } else if (r.type === RoomType.Reception) {
      for (const t of r.tiles) if (!this.roofed[t]) return "Must be enclosed and roofed.";
    }
    for (const req of def.requires) {
      let found = false;
      for (const t of r.tiles) {
        if (req.kinds.includes(this.objKind[t])) { found = true; break; }
      }
      if (!found) return req.issue;
    }
    if (def.needsJailDoor && !this.roomHasJailDoor(r)) {
      return "Needs a jail door on its boundary.";
    }
    if (def.needsRoadGate && !this.roomHasRoadGate(r)) {
      return "Needs a road-facing gate.";
    }
    return "";
  }

  private roomHasRoadGate(r: Room): boolean {
    for (const t of r.tiles) {
      const x = t % this.size, z = (t / this.size) | 0;
      for (const [dx, dz] of DIRS) {
        const gx = x + dx, gz = z + dz;
        if (!this.inBounds(gx, gz)) continue;
        const gate = this.objKind[this.idx(gx, gz)];
        if (gate !== Obj.FenceDoor && gate !== Obj.StaffFenceDoor && gate !== Obj.FenceJailDoor &&
            gate !== Obj.Door && gate !== Obj.StaffDoor && gate !== Obj.JailDoor) continue;
        for (let distance = 1; distance <= 3; distance++) {
          const rx = gx + dx * distance, rz = gz + dz * distance;
          if (this.isInfrastructure(rx, rz)) return true;
        }
      }
    }
    return false;
  }

  /** Ambience points per tile, normalised to a 0..1 furnishing score. A piece
   *  counts once, at its anchor — a 2x2 table isn't four times as nice. */
  private roomAmbience(r: Room): number {
    if (r.tiles.size === 0) return 0;
    let points = 0;
    for (const t of r.tiles) {
      const p = this.pieceAtTile(t);
      if (!p || this.idx(p.x, p.z) !== t) continue; // anchors only
      points += defOf(p.kind)?.ambience ?? 0;
    }
    return Math.min(1, points / r.tiles.size / AMBIENCE_FULL);
  }

  /** Need-refill multiplier at a tile: nicer rooms restore people faster. */
  ambienceMul(i: number): number {
    const r = this.rooms.get(this.roomId[i]);
    return 1 + (r ? r.ambience * AMBIENCE_MAX : 0);
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
        name: roomDef(r.type)?.name ?? "Room",
        valid: issue === "",
        issue,
        ambience: r.ambience,
        x: sx / r.tiles.size + 0.5,
        z: sz / r.tiles.size + 0.5,
      });
    }
    return labels;
  }

  prisonerCapacity(): number {
    let cap = 0;
    for (const b of this.piecesOfKind(Obj.Bed)) {
      const r = this.rooms.get(this.roomId[this.idx(b.x, b.z)]);
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
      pieces: [...this.pieces.values()].map((p) => ({ ...p })),
      nextPieceId: this.nextPieceId,
      routes: [...this.routes.values()].map((r) => ({ ...r, tiles: [...r.tiles] })),
      nextRouteId: this.nextRouteId,
      rooms: [...this.rooms.values()].map((r) => ({
        id: r.id,
        type: r.type,
        access: r.access,
        valid: r.valid,
        ambience: r.ambience,
        guards: r.guards,
        tiles: [...r.tiles],
      })),
      nextRoomId: this.nextRoomId,
    };
  }

  loadData(data: ReturnType<World["saveData"]> & LegacySave) {
    this.floorMat.fill(0);
    this.objKind.fill(0);
    this.objMat.fill(0);
    this.objOrient.fill(0);
    this.roofed.fill(0);
    this.roomId.fill(0);
    this.jailClosed.fill(0);
    this.pieceAt.fill(0);
    // The immutable mask is rebuilt by InfrastructureSystem after loading.
    this.infrastructure.fill(0);
    this.pieces.clear();
    this.nextPieceId = 1;
    this.routes.clear();
    for (const a of this.routeAt) a.fill(0);
    this.nextRouteId = data.nextRouteId ?? 1;
    for (const r of data.routes ?? []) {
      this.routes.set(r.id, { ...r, tiles: [...r.tiles] });
      for (const i of r.tiles) this.routeAt[r.color & 1][i] = r.id;
      if (r.id >= this.nextRouteId) this.nextRouteId = r.id + 1;
    }
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

    // Pieces, or a pre-piece save's separate `beds` and `spans` lists.
    const pieces: Piece[] = (data.pieces ?? []).map((p) => ({ ...p }));
    if (!data.pieces) {
      let id = 1;
      for (const b of data.beds ?? []) {
        pieces.push({ id: id++, kind: Obj.Bed, x: b.x, z: b.z, orient: b.orient, w: 2, d: 1 });
      }
      for (const s of data.spans ?? []) {
        pieces.push({ id: id++, kind: s.kind, x: s.x, z: s.z, orient: s.orient, w: s.len, d: 1 });
      }
      // Single-tile furniture was tile-only before pieces; rebuild it from the
      // tiles we just loaded, so old saves come back with usable objects.
      for (const i of this.active) {
        const d = defOf(this.objKind[i]);
        if (!d || d.place !== "piece" || d.w !== 1 || d.d !== 1) continue;
        pieces.push({
          id: id++, kind: this.objKind[i],
          x: i % this.size, z: (i / this.size) | 0,
          orient: this.objOrient[i], w: 1, d: 1,
        });
      }
    }
    for (const p of pieces) {
      this.pieces.set(p.id, p);
      for (const i of this.pieceTiles(p)) this.pieceAt[i] = p.id;
      if (p.id >= this.nextPieceId) this.nextPieceId = p.id + 1;
    }
    if (data.nextPieceId) this.nextPieceId = Math.max(this.nextPieceId, data.nextPieceId);

    for (const r of data.rooms ?? []) {
      const room: Room = {
        id: r.id,
        type: r.type,
        access: r.access,
        valid: r.valid,
        ambience: r.ambience ?? 0,
        guards: r.guards ?? 0,
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
    return k === Obj.Fence || k === Obj.FenceDoor || k === Obj.StaffFenceDoor || k === Obj.FenceJailDoor || k === Obj.CutFence;
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

  /** Furniture instances (x, z, orient) keyed by Obj kind: every piece the
   *  furniture pass draws, plus the tile-placed kinds it also owns (gates and
   *  cut fences, which are conversions of a wall/fence rather than pieces). */
  furnitureInstances(): Map<number, Float32Array> {
    const buckets = new Map<number, number[]>();
    const push = (kind: number, x: number, z: number, o: number) => {
      let a = buckets.get(kind); if (!a) buckets.set(kind, a = []);
      a.push(x, z, o);
    };
    for (const i of this.active) {
      const k = this.objKind[i];
      const d = defOf(k);
      if (!d || d.render !== "furniture" || d.place === "piece") continue;
      push(k, i % this.size, (i / this.size) | 0, this.objOrient[i]);
    }
    for (const p of this.pieces.values()) {
      if (defOf(p.kind)?.render !== "furniture") continue;
      push(p.kind, p.x, p.z, p.orient);
    }
    return new Map([...buckets].map(([k, a]) => [k, new Float32Array(a)]));
  }

  bedInstances(): Float32Array {
    const out: number[] = [];
    for (const p of this.pieces.values()) {
      if (defOf(p.kind)?.render === "bed") out.push(p.x, p.z, p.orient);
    }
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

    // Doors let light through; solid walls do not.
    const solid = (x: number, z: number) => {
      if (!this.inBounds(x, z)) return true;
      const k = this.objKind[this.idx(x, z)];
      return k === Obj.Wall || k === Obj.WallLight;
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
      if (defOf(this.objKind[i])?.roofBarrier) {
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
