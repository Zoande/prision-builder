// The object registry: one row per placeable kind, and the single source of
// truth for everything the rest of the codebase used to hard-code in separate
// switch statements — footprint, walkability, sight blocking, room/roof
// barriers, which pass draws it, whether prisoners memorise it, and what need
// using it fills.
//
// Adding an object is a row here plus a mesh. Nothing else should grow a new
// `case`.
//
// Footprint convention (matches the furniture/bed shaders): a piece is authored
// along +X for `w` tiles and +Z for `d` tiles. At orient `o` the w axis runs
// along DIRS[o] and the d axis along DIRS[(o + 1) & 3], anchored at its tile.

export const Obj = {
  None: 0, Wall: 1, Door: 2, Fence: 3, Bed: 4,
  Lamp: 5, WallLight: 6, RoofLight: 7,
  Prisoner: 8, Guard: 9,
  JailDoor: 10, Toilet: 11, Shower: 12, Drain: 13,
  FenceDoor: 14, FenceJailDoor: 15,
  Table: 16, Bench2: 17, Bench4: 18, Cooker: 19,
  Cook: 20, CutFence: 21, Workman: 22, ServingTable: 23,
  Bookshelf: 24, BookshelfLarge: 25,
} as const;
export type ObjKind = (typeof Obj)[keyof typeof Obj];

/** Quarter-turn direction table; the w axis of a piece runs along DIRS[orient]. */
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;

// Poses (mirrored by person.wgsl).
export const POSE_STAND = 0, POSE_SIT = 2, POSE_LIE_BED = 3, POSE_LIE_FLOOR = 4, POSE_CLIMB = 5;

export type NeedName =
  | "food" | "sleep" | "outdoors" | "comfort" | "hygiene" | "recreation";

/** How a kind gets onto the map, which decides which world setter owns it. */
export type Placement =
  | "piece"      // a w x d footprint the player places (bed, bench, toilet, shelf)
  | "structure"  // walls, fences: one tile, painted in runs
  | "opening"    // doors and gates: converted from a wall/fence tile in place
  | "mount"      // lights: attached to a wall, a roof, or the floor
  | "person"     // spawns an agent on sync
  | "sim";       // only the simulation places it (cut fences)

export interface UseDef {
  /** Stand on one of the object's own tiles, or on a tile beside it. */
  from: "on" | "adjacent";
  pose: number;
  /** How many agents may use it at once. */
  capacity: number;
  /** Need refilled per second while in use. */
  needs: Partial<Record<NeedName, number>>;
  /** Give up after this long even if the need isn't full. */
  seconds: number;
}

export interface ObjDef {
  kind: number;
  name: string;
  place: Placement;
  /** Footprint: w along the orient axis, d across it. */
  w: number;
  d: number;
  /** Agents may walk over this tile (jail doors are conditional — see passable). */
  walkable: boolean;
  /** Blocks a prisoner's line of sight (bars and fences do not). */
  blocksSight: boolean;
  /** Bounds rooms. Walls AND fences do. */
  roomBarrier: boolean;
  /** Stops the auto-roof flood fill. Walls and doors, but not fences. */
  roofBarrier: boolean;
  /** Which pass draws it. "own" = it has a dedicated pass (walls, doors, ...). */
  render: "furniture" | "bed" | "own";
  /** Prisoners memorise it on sight — by each tile, or by the piece anchor. */
  remember: false | "tile" | "anchor";
  /** Contribution to a room's ambience (unused until the ambience pass lands). */
  ambience: number;
  /** Build-palette button. null = not player-placeable. */
  palette: { label: string; swatch: string } | null;
  /** Fills needs when an agent uses it. */
  use: UseDef | null;
}

function def(kind: number, name: string, o: Partial<ObjDef> = {}): ObjDef {
  return {
    kind, name,
    place: "piece", w: 1, d: 1,
    walkable: false, blocksSight: false, roomBarrier: false, roofBarrier: false,
    render: "own", remember: false, ambience: 0, palette: null, use: null,
    ...o,
  };
}

export const OBJ_DEFS: ObjDef[] = [
  def(Obj.None, "Empty", { place: "sim", walkable: true }),

  // --- Structure ------------------------------------------------------------
  def(Obj.Wall, "Wall", {
    place: "structure", blocksSight: true, roomBarrier: true, roofBarrier: true,
  }),
  def(Obj.Fence, "Fence", { place: "structure", roomBarrier: true }),
  def(Obj.Door, "Door", {
    place: "opening", walkable: true, blocksSight: true,
    roomBarrier: true, roofBarrier: true,
    palette: { label: "Door", swatch: "#b98a57" },
  }),
  // Barred: you can see through it, and only staff (or an unlocked one) pass.
  def(Obj.JailDoor, "Jail Door", {
    place: "opening", roomBarrier: true, roofBarrier: true,
    palette: { label: "Jail Door", swatch: "#7e868f" },
  }),
  def(Obj.FenceDoor, "Fence Door", {
    place: "opening", walkable: true, roomBarrier: true, render: "furniture",
    palette: { label: "Fence Door", swatch: "#e07a1f" },
  }),
  def(Obj.FenceJailDoor, "Fence Jail Door", {
    place: "opening", roomBarrier: true, render: "furniture",
    palette: { label: "Fence Jail Door", swatch: "#c03030" },
  }),
  def(Obj.CutFence, "Cut Fence", {
    place: "sim", walkable: true, roomBarrier: true, render: "furniture",
  }),

  // --- Lights ---------------------------------------------------------------
  def(Obj.Lamp, "Lamp", {
    place: "mount", palette: { label: "Lamp", swatch: "#e8b96a" },
  }),
  // A wall light is still a wall block, with a fixture drawn on it.
  def(Obj.WallLight, "Wall Light", {
    place: "mount", blocksSight: true, roomBarrier: true, roofBarrier: true,
    palette: { label: "Wall Light", swatch: "#f0d9a0" },
  }),
  def(Obj.RoofLight, "Roof Light", {
    place: "mount", walkable: true,
    palette: { label: "Roof Light", swatch: "#dfe8f2" },
  }),

  // --- Furniture (pieces) ---------------------------------------------------
  def(Obj.Bed, "Bed", {
    w: 2, render: "bed", remember: "anchor", ambience: 1,
    palette: { label: "Bed", swatch: "#cabfa6" },
  }),
  def(Obj.Toilet, "Toilet", {
    render: "furniture", remember: "tile",
    palette: { label: "Toilet", swatch: "#dfe4ea" },
  }),
  def(Obj.Shower, "Shower", {
    walkable: true, render: "furniture", remember: "tile",
    palette: { label: "Shower", swatch: "#9fb4c8" },
  }),
  def(Obj.Drain, "Drain", {
    walkable: true, render: "furniture",
    palette: { label: "Drain", swatch: "#4a4f55" },
  }),
  def(Obj.Table, "Table", {
    render: "furniture", remember: "tile", ambience: 1,
    palette: { label: "Table", swatch: "#d8d8d2" },
  }),
  def(Obj.ServingTable, "Serving Table", {
    render: "furniture", remember: "tile",
    palette: { label: "Serving Table", swatch: "#aeb6ba" },
  }),
  // Benches are remembered per tile: a prisoner sits on the tile he reached,
  // not on the anchor, and diners pick the bench tile beside their table.
  def(Obj.Bench2, "Bench 2x1", {
    w: 2, render: "furniture", remember: "tile", ambience: 1,
    palette: { label: "Bench 2x1", swatch: "#cfcfc8" },
  }),
  def(Obj.Bench4, "Bench 4x1", {
    w: 4, render: "furniture", remember: "tile", ambience: 1,
    palette: { label: "Bench 4x1", swatch: "#c4c4bc" },
  }),
  def(Obj.Cooker, "Cooker", {
    render: "furniture",
    palette: { label: "Cooker", swatch: "#666c73" },
  }),

  // The small/large tier: same use-slot, bigger footprint, more readers, faster
  // fill. The small one fits a cell; the large one is the library's.
  def(Obj.Bookshelf, "Small Bookshelf", {
    render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Small Bookshelf", swatch: "#8a6a43" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: { recreation: 1 / 45 }, seconds: 50,
    },
  }),
  def(Obj.BookshelfLarge, "Large Bookshelf", {
    w: 2, render: "furniture", remember: "anchor", ambience: 3,
    palette: { label: "Large Bookshelf", swatch: "#6f5334" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 2,
      needs: { recreation: 1 / 30 }, seconds: 40,
    },
  }),

  // --- People ---------------------------------------------------------------
  def(Obj.Prisoner, "Prisoner", {
    place: "person", palette: { label: "Prisoner", swatch: "#f07018" },
  }),
  def(Obj.Guard, "Guard", {
    place: "person", palette: { label: "Guard", swatch: "#3a4a6b" },
  }),
  def(Obj.Cook, "Cook", {
    place: "person", palette: { label: "Cook", swatch: "#e8e6e0" },
  }),
  def(Obj.Workman, "Workman", {
    place: "person", palette: { label: "Workman", swatch: "#f0c020" },
  }),
];

const BY_KIND: (ObjDef | undefined)[] = [];
for (const d of OBJ_DEFS) BY_KIND[d.kind] = d;

export function defOf(kind: number): ObjDef | undefined {
  return BY_KIND[kind];
}

/** Player-placeable pieces, in palette order. */
export const PIECE_DEFS = OBJ_DEFS.filter((d) => d.place === "piece" && d.palette);

/** Kinds an agent can walk over unconditionally (jail doors are conditional). */
export function isWalkable(kind: number): boolean {
  return defOf(kind)?.walkable ?? false;
}

/** Every kind that fills this need by being used. */
export function kindsServing(need: NeedName): number[] {
  return OBJ_DEFS.filter((d) => d.use && (d.use.needs[need] ?? 0) > 0).map((d) => d.kind);
}
