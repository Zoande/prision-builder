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

import { Item } from "./items.ts";

export const Obj = {
  None: 0, Wall: 1, Door: 2, Fence: 3, Bed: 4,
  Lamp: 5, WallLight: 6, RoofLight: 7,
  Prisoner: 8, Guard: 9,
  JailDoor: 10, Toilet: 11, Shower: 12, Drain: 13,
  FenceDoor: 14, FenceJailDoor: 15,
  Table: 16, Bench2: 17, Bench4: 18, Cooker: 19,
  Cook: 20, CutFence: 21, Workman: 22, ServingTable: 23,
  // --- Library ---
  Bookshelf: 24, BookshelfLarge: 25, BookshelfTall: 26, ReadingDesk: 27,
  WoodenTable: 28, WoodenTableLarge: 29, Armchair: 30, Chair: 31,
  // --- Gym ---
  WeightBench: 32, Treadmill: 33, PunchingBag: 34, ExerciseMat: 35, PullUpBar: 36,
  // --- Common room ---
  Sofa: 37, Television: 38, PoolTable: 39, ChessTable: 40, CoffeeTable: 41,
  // --- Chapel ---
  Altar: 42, Pew: 43, Lectern: 44,
  // --- Staff room ---
  CoffeeMachine: 45, VendingMachine: 46, WaterCooler: 47, Lockers: 48,
  // --- Decor ---
  PottedPlant: 49, LargePlant: 50, Rug: 51, TrashCan: 52,
  // --- Security ---
  SniperTower: 53, Sniper: 54,
} as const;
export type ObjKind = (typeof Obj)[keyof typeof Obj];

/** Quarter-turn direction table; the w axis of a piece runs along DIRS[orient]. */
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;

// Poses (mirrored by person.wgsl).
export const POSE_STAND = 0, POSE_SIT = 2, POSE_LIE_BED = 3, POSE_LIE_FLOOR = 4, POSE_CLIMB = 5;

export type NeedName =
  | "food" | "sleep" | "outdoors" | "comfort" | "hygiene"
  | "recreation" | "exercise" | "bladder" | "spirituality";

/** Every need, in HUD order. Adding one here and to NeedName is the whole job. */
export const NEEDS: NeedName[] = [
  "food", "sleep", "outdoors", "comfort", "hygiene",
  "recreation", "exercise", "bladder", "spirituality",
];

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
  /** Give up after this long even if the need isn't full. 0 = until full. */
  seconds: number;

  // --- Items ---------------------------------------------------------------
  /** Using it hands you one of these (a shelf lends a book; a counter, a tray). */
  gives?: number;
  /** You must be holding one of these to use it at all (a table needs a tray). */
  requires?: number;
  /** Using it destroys the required item (the tray is eaten off). */
  consumes?: number;

  // --- Placement -----------------------------------------------------------
  /** Only the agent who has claimed this object may use it (his own bunk). */
  owned?: boolean;
  /** Lie/sit at the footprint's centre rather than on its anchor tile — this is
   *  what stops a man sleeping on the pillow end of a two-tile bed. */
  center?: boolean;
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
  palette: { label: string; swatch: string; group: string } | null;
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
    palette: { label: "Door", swatch: "#b98a57", group: "Doors" },
  }),
  // Barred: you can see through it, and only staff (or an unlocked one) pass.
  def(Obj.JailDoor, "Jail Door", {
    place: "opening", roomBarrier: true, roofBarrier: true,
    palette: { label: "Jail Door", swatch: "#7e868f", group: "Doors" },
  }),
  def(Obj.FenceDoor, "Fence Door", {
    place: "opening", walkable: true, roomBarrier: true, render: "furniture",
    palette: { label: "Fence Door", swatch: "#e07a1f", group: "Doors" },
  }),
  def(Obj.FenceJailDoor, "Fence Jail Door", {
    place: "opening", roomBarrier: true, render: "furniture",
    palette: { label: "Fence Jail Door", swatch: "#c03030", group: "Doors" },
  }),
  def(Obj.CutFence, "Cut Fence", {
    place: "sim", walkable: true, roomBarrier: true, render: "furniture",
  }),

  // --- Lights ---------------------------------------------------------------
  def(Obj.Lamp, "Lamp", {
    place: "mount", palette: { label: "Lamp", swatch: "#e8b96a", group: "Lights" },
  }),
  // A wall light is still a wall block, with a fixture drawn on it.
  def(Obj.WallLight, "Wall Light", {
    place: "mount", blocksSight: true, roomBarrier: true, roofBarrier: true,
    palette: { label: "Wall Light", swatch: "#f0d9a0", group: "Lights" },
  }),
  def(Obj.RoofLight, "Roof Light", {
    place: "mount", walkable: true,
    palette: { label: "Roof Light", swatch: "#dfe8f2", group: "Lights" },
  }),

  // --- Furniture (pieces) ---------------------------------------------------
  def(Obj.Bed, "Bed", {
    w: 2, render: "bed", remember: "anchor", ambience: 1,
    palette: { label: "Bed", swatch: "#cabfa6", group: "Cells" },
    use: {
      from: "on", pose: POSE_LIE_BED, capacity: 1, owned: true, center: true,
      needs: { sleep: 1 / 90, comfort: 1 / 60 }, seconds: 0,
    },
  }),
  def(Obj.Toilet, "Toilet", {
    render: "furniture", remember: "tile",
    palette: { label: "Toilet", swatch: "#dfe4ea", group: "Cells" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: { bladder: 1 / 4 }, seconds: 8,
    },
  }),
  def(Obj.Shower, "Shower", {
    walkable: true, render: "furniture", remember: "tile",
    palette: { label: "Shower", swatch: "#9fb4c8", group: "Cells" },
    use: {
      from: "on", pose: POSE_STAND, capacity: 1,
      needs: { hygiene: 1 / 10 }, seconds: 0,
    },
  }),
  def(Obj.Drain, "Drain", {
    walkable: true, render: "furniture",
    palette: { label: "Drain", swatch: "#4a4f55", group: "Cells" },
  }),
  def(Obj.Table, "Table", {
    render: "furniture", remember: "tile", ambience: 1,
    palette: { label: "Table", swatch: "#d8d8d2", group: "Dining" },
    use: {
      from: "adjacent", pose: POSE_SIT, capacity: 4,
      needs: { food: 1 / 6 }, seconds: 6,
      requires: Item.Tray, consumes: Item.Tray,
    },
  }),
  def(Obj.ServingTable, "Serving Table", {
    render: "furniture", remember: "tile",
    palette: { label: "Serving Table", swatch: "#aeb6ba", group: "Dining" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 2,
      needs: {}, seconds: 1.5, gives: Item.Tray,
    },
  }),
  // Benches are remembered per tile: a prisoner sits on the tile he reached,
  // not on the anchor, and diners pick the bench tile beside their table.
  def(Obj.Bench2, "Bench 2x1", {
    w: 2, render: "furniture", remember: "tile", ambience: 1,
    palette: { label: "Bench 2x1", swatch: "#cfcfc8", group: "Dining" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 2,
      needs: { comfort: 1 / 30 }, seconds: 40,
    },
  }),
  def(Obj.Bench4, "Bench 4x1", {
    w: 4, render: "furniture", remember: "tile", ambience: 1,
    palette: { label: "Bench 4x1", swatch: "#c4c4bc", group: "Dining" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 4,
      needs: { comfort: 1 / 30 }, seconds: 40,
    },
  }),
  def(Obj.Cooker, "Cooker", {
    render: "furniture",
    palette: { label: "Cooker", swatch: "#666c73", group: "Dining" },
  }),

  // Shelves lend books; they aren't read at. A prisoner takes one in a hand,
  // carries it to somewhere comfortable, reads it, and puts it back — so the
  // small/large tier is about how many can borrow at once, not fill rate.
  def(Obj.Bookshelf, "Small Bookshelf", {
    render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Small Bookshelf", swatch: "#8a6a43", group: "Library" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: {}, seconds: 3, gives: Item.Book,
    },
  }),
  def(Obj.BookshelfLarge, "Large Bookshelf", {
    w: 2, render: "furniture", remember: "anchor", ambience: 3,
    palette: { label: "Large Bookshelf", swatch: "#6f5334", group: "Library" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 2,
      needs: {}, seconds: 3, gives: Item.Book,
    },
  }),
  // Tall enough to hide behind: the best shelf is also the one that makes a
  // library hard to supervise.
  def(Obj.BookshelfTall, "Tall Bookshelf", {
    w: 2, blocksSight: true, render: "furniture", remember: "anchor", ambience: 3,
    palette: { label: "Tall Bookshelf", swatch: "#5a4229", group: "Library" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 2,
      needs: {}, seconds: 3, gives: Item.Book,
    },
  }),
  def(Obj.ReadingDesk, "Reading Desk", {
    w: 2, render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Reading Desk", swatch: "#a97f4e", group: "Library" },
    use: {
      from: "adjacent", pose: POSE_SIT, capacity: 2,
      needs: { comfort: 1 / 40 }, seconds: 45,
    },
  }),

  // --- Seating --------------------------------------------------------------
  def(Obj.Chair, "Chair", {
    render: "furniture", remember: "anchor", ambience: 1,
    palette: { label: "Chair", swatch: "#b08b5c", group: "Seating" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 1,
      needs: { comfort: 1 / 35 }, seconds: 40,
    },
  }),
  def(Obj.Armchair, "Armchair", {
    render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Armchair", swatch: "#7d5f52", group: "Seating" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 1,
      needs: { comfort: 1 / 25 }, seconds: 45,
    },
  }),
  def(Obj.Sofa, "Sofa", {
    w: 2, render: "furniture", remember: "anchor", ambience: 3,
    palette: { label: "Sofa", swatch: "#6b7a8c", group: "Seating" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 2,
      needs: { comfort: 1 / 22 }, seconds: 50,
    },
  }),

  // --- Gym ------------------------------------------------------------------
  def(Obj.WeightBench, "Weight Bench", {
    w: 2, render: "furniture", remember: "anchor", ambience: 1,
    palette: { label: "Weight Bench", swatch: "#4c5157", group: "Gym" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 1,
      needs: { exercise: 1 / 22 }, seconds: 35,
    },
  }),
  def(Obj.Treadmill, "Treadmill", {
    render: "furniture", remember: "anchor", ambience: 1,
    palette: { label: "Treadmill", swatch: "#3f444a", group: "Gym" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: { exercise: 1 / 25 }, seconds: 35,
    },
  }),
  def(Obj.PunchingBag, "Punching Bag", {
    render: "furniture", remember: "anchor", ambience: 1,
    palette: { label: "Punching Bag", swatch: "#6b4636", group: "Gym" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: { exercise: 1 / 20 }, seconds: 30,
    },
  }),
  def(Obj.PullUpBar, "Pull-up Bar", {
    w: 2, render: "furniture", remember: "anchor", ambience: 1,
    palette: { label: "Pull-up Bar", swatch: "#7f868d", group: "Gym" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: { exercise: 1 / 24 }, seconds: 30,
    },
  }),
  // Walkable: a mat on the floor shouldn't wall the gym off.
  def(Obj.ExerciseMat, "Exercise Mat", {
    w: 2, d: 2, walkable: true, render: "furniture", remember: "anchor", ambience: 1,
    palette: { label: "Exercise Mat", swatch: "#2f6f6a", group: "Gym" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 4,
      needs: { exercise: 1 / 30 }, seconds: 35,
    },
  }),

  // --- Common room ----------------------------------------------------------
  def(Obj.Television, "Television", {
    render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Television", swatch: "#23272b", group: "Common" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 4,
      needs: { recreation: 1 / 22 }, seconds: 50,
    },
  }),
  def(Obj.PoolTable, "Pool Table", {
    w: 2, render: "furniture", remember: "anchor", ambience: 3,
    palette: { label: "Pool Table", swatch: "#2f6b3f", group: "Common" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 2,
      needs: { recreation: 1 / 20 }, seconds: 45,
    },
  }),
  def(Obj.ChessTable, "Chess Table", {
    render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Chess Table", swatch: "#8c8378", group: "Common" },
    use: {
      from: "adjacent", pose: POSE_SIT, capacity: 2,
      needs: { recreation: 1 / 30 }, seconds: 45,
    },
  }),

  // --- Chapel ---------------------------------------------------------------
  def(Obj.Altar, "Altar", {
    render: "furniture", remember: "anchor", ambience: 3,
    palette: { label: "Altar", swatch: "#b99247", group: "Chapel" },
    use: {
      from: "adjacent", pose: POSE_STAND, capacity: 1,
      needs: { spirituality: 1 / 22 }, seconds: 35,
    },
  }),
  def(Obj.Pew, "Pew", {
    w: 3, render: "furniture", remember: "anchor", ambience: 2,
    palette: { label: "Pew", swatch: "#8a6a43", group: "Chapel" },
    use: {
      from: "on", pose: POSE_SIT, capacity: 3,
      needs: { spirituality: 1 / 30, comfort: 1 / 70 }, seconds: 45,
    },
  }),

  // --- Cosmetics. No use-slot: they pay out through the room's ambience, which
  // multiplies how fast every other object in the room fills a need. ----------
  def(Obj.WoodenTable, "Wooden Table", {
    w: 2, render: "furniture", ambience: 3,
    palette: { label: "Wooden Table", swatch: "#9c7145", group: "Library" },
  }),
  def(Obj.WoodenTableLarge, "Wooden Table (large)", {
    w: 2, d: 2, render: "furniture", ambience: 4,
    palette: { label: "Wooden Table 2x2", swatch: "#8a6238", group: "Library" },
  }),
  def(Obj.CoffeeTable, "Coffee Table", {
    render: "furniture", ambience: 1,
    palette: { label: "Coffee Table", swatch: "#a4855f", group: "Common" },
  }),
  def(Obj.Lectern, "Lectern", {
    render: "furniture", ambience: 1,
    palette: { label: "Lectern", swatch: "#7a5c38", group: "Chapel" },
  }),
  def(Obj.CoffeeMachine, "Coffee Machine", {
    render: "furniture", ambience: 1,
    palette: { label: "Coffee Machine", swatch: "#4a4f55", group: "Staff" },
  }),
  def(Obj.VendingMachine, "Vending Machine", {
    render: "furniture", ambience: 1,
    palette: { label: "Vending Machine", swatch: "#b03a3a", group: "Staff" },
  }),
  def(Obj.WaterCooler, "Water Cooler", {
    render: "furniture", ambience: 1,
    palette: { label: "Water Cooler", swatch: "#8fbcd4", group: "Staff" },
  }),
  def(Obj.Lockers, "Lockers", {
    render: "furniture", ambience: 1,
    palette: { label: "Lockers", swatch: "#5d6b78", group: "Staff" },
  }),
  def(Obj.PottedPlant, "Potted Plant", {
    render: "furniture", ambience: 3,
    palette: { label: "Potted Plant", swatch: "#4f8f3f", group: "Decor" },
  }),
  def(Obj.LargePlant, "Large Plant", {
    render: "furniture", ambience: 5,
    palette: { label: "Large Plant", swatch: "#3d7a32", group: "Decor" },
  }),
  def(Obj.Rug, "Rug", {
    walkable: true, render: "furniture", ambience: 3,
    palette: { label: "Rug", swatch: "#a05040", group: "Decor" },
  }),
  def(Obj.TrashCan, "Trash Can", {
    render: "furniture",
    palette: { label: "Trash Can", swatch: "#59606a", group: "Decor" },
  }),

  // --- Security -------------------------------------------------------------
  // A tower is a post, not a person: build one and a sniper is posted to it.
  // It exists to watch the perimeter, so the guards on foot don't have to.
  def(Obj.SniperTower, "Sniper Tower", {
    w: 2, d: 2, render: "furniture", ambience: 0,
    palette: { label: "Sniper Tower", swatch: "#5c6b52", group: "Security" },
  }),

  // --- People ---------------------------------------------------------------
  // No palette button: a sniper is posted by building him a tower.
  def(Obj.Sniper, "Sniper", { place: "person" }),
  def(Obj.Prisoner, "Prisoner", {
    place: "person", palette: { label: "Prisoner", swatch: "#f07018", group: "People" },
  }),
  def(Obj.Guard, "Guard", {
    place: "person", palette: { label: "Guard", swatch: "#3a4a6b", group: "People" },
  }),
  def(Obj.Cook, "Cook", {
    place: "person", palette: { label: "Cook", swatch: "#e8e6e0", group: "People" },
  }),
  def(Obj.Workman, "Workman", {
    place: "person", palette: { label: "Workman", swatch: "#f0c020", group: "People" },
  }),
];

// --- Rooms ------------------------------------------------------------------
// A room is its name, the clear square it needs, and the objects it must
// contain. All three are data, so a new room type is a row.

export const RoomType = {
  Empty: 0, Kitchen: 1, Yard: 2, Canteen: 3, Cell: 4, Dorm: 5, ShowerRoom: 6,
  Library: 7, Gym: 8, CommonRoom: 9, Chapel: 10, StaffRoom: 11,
} as const;

/** A requirement is satisfied by any one of `kinds`. */
export interface RoomReq { kinds: number[]; issue: string }

export interface RoomDef {
  type: number;
  name: string;
  swatch: string;
  /** Smallest clear square the room must contain (0 = no minimum). */
  minSquare: number;
  requires: RoomReq[];
  /** Must have a jail door on its boundary (cells and dorms). */
  needsJailDoor: boolean;
  /** Defaults to prisoner access when painted. */
  prisonerAccess: boolean;
}

function room(
  type: number, name: string, swatch: string, o: Partial<RoomDef> = {},
): RoomDef {
  return {
    type, name, swatch,
    minSquare: 0, requires: [], needsJailDoor: false, prisonerAccess: false,
    ...o,
  };
}

const BENCHES = [Obj.Bench2, Obj.Bench4];
const SHELVES = [Obj.Bookshelf, Obj.BookshelfLarge, Obj.BookshelfTall];
/** Everything that lends a book. */
export const SHELF_KINDS: number[] = SHELVES;
const GYM_GEAR = [
  Obj.WeightBench, Obj.Treadmill, Obj.PunchingBag, Obj.ExerciseMat, Obj.PullUpBar,
];
const SEATS = [Obj.Sofa, Obj.Armchair, Obj.Chair];

export const ROOM_DEFS: RoomDef[] = [
  room(RoomType.Empty, "Empty Room", "#9a9a9a"),
  room(RoomType.Kitchen, "Kitchen", "#c96f3b", {
    minSquare: 5,
    requires: [{ kinds: [Obj.Cooker], issue: "Needs a cooker." }],
  }),
  room(RoomType.Yard, "Yard", "#7fae5a", { minSquare: 10, prisonerAccess: true }),
  room(RoomType.Canteen, "Canteen", "#caa84f", {
    minSquare: 5, prisonerAccess: true,
    requires: [
      { kinds: [Obj.Table], issue: "Needs a table." },
      { kinds: BENCHES, issue: "Needs a bench." },
    ],
  }),
  room(RoomType.Cell, "Cell", "#7f8fa6", {
    prisonerAccess: true, needsJailDoor: true,
    requires: [
      { kinds: [Obj.Bed], issue: "Needs a bed." },
      { kinds: [Obj.Toilet], issue: "Needs a toilet." },
    ],
  }),
  room(RoomType.Dorm, "Dormitory", "#9aa7c0", {
    prisonerAccess: true, needsJailDoor: true,
    requires: [
      { kinds: [Obj.Bed], issue: "Needs a bed." },
      { kinds: [Obj.Toilet], issue: "Needs a toilet." },
    ],
  }),
  room(RoomType.ShowerRoom, "Shower Room", "#8fb8c8", {
    minSquare: 5, prisonerAccess: true,
    requires: [{ kinds: [Obj.Shower], issue: "Needs a shower." }],
  }),
  room(RoomType.Library, "Library", "#8a6a43", {
    minSquare: 5, prisonerAccess: true,
    requires: [
      { kinds: SHELVES, issue: "Needs a bookshelf." },
      { kinds: [Obj.ReadingDesk, Obj.WoodenTable, Obj.WoodenTableLarge], issue: "Needs a reading desk or table." },
    ],
  }),
  room(RoomType.Gym, "Gym", "#b0563a", {
    minSquare: 5, prisonerAccess: true,
    requires: [{ kinds: GYM_GEAR, issue: "Needs exercise equipment." }],
  }),
  room(RoomType.CommonRoom, "Common Room", "#6f8fa8", {
    minSquare: 5, prisonerAccess: true,
    requires: [
      { kinds: [Obj.Television, Obj.PoolTable, Obj.ChessTable], issue: "Needs something to do." },
      { kinds: SEATS, issue: "Needs somewhere to sit." },
    ],
  }),
  room(RoomType.Chapel, "Chapel", "#9a86c0", {
    minSquare: 5, prisonerAccess: true,
    requires: [
      { kinds: [Obj.Altar], issue: "Needs an altar." },
      { kinds: [Obj.Pew], issue: "Needs a pew." },
    ],
  }),
  // Staff-access by default — the point of it is that prisoners aren't there.
  room(RoomType.StaffRoom, "Staff Room", "#d3c05a", {
    minSquare: 4,
    requires: [
      { kinds: SEATS, issue: "Needs somewhere to sit." },
      { kinds: [Obj.CoffeeMachine, Obj.VendingMachine], issue: "Needs a coffee or vending machine." },
    ],
  }),
];

const ROOM_BY_TYPE: (RoomDef | undefined)[] = [];
for (const r of ROOM_DEFS) ROOM_BY_TYPE[r.type] = r;

export function roomDef(type: number): RoomDef | undefined {
  return ROOM_BY_TYPE[type];
}

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
