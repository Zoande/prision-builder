// Furniture pass: instanced flat-colored props — toilet, shower, drain,
// fence gates (open/guard-only), table, benches, cooker. Box meshes with a
// per-vertex palette index (see furniture.wgsl); one pipeline, one draw per
// furniture kind.

import furnitureShader from "../furniture.wgsl?raw";
import { CARGO_KIND, DRIVER_KIND, FOOD_KIND, HOLE_ENTRY_KIND, HOLE_SURF_KIND, INTAKE_TRUCK_KIND, TRAY_STACK_KIND, TRUCK_KIND } from "../sim/agents";
import { OBJ_DEFS, Obj } from "../sim/world";
import { FENCE_H, PRELUDE, sceneLightEntries, type SceneLight } from "./shaderCommon";

// Palette indices (mirror furniture.wgsl).
const CERAMIC = 0, CERAMIC_DK = 1, STEEL = 2, DARK = 3, BLACK = 4;
const ORANGE = 5, RED = 6, TABLE = 7, SEAT = 8, CHROME = 9, LINK = 10, STOVE = 11;
const FOOD_A = 12, FOOD_B = 13, WOOD = 14, BOOKS = 15;
const CLOTH = 16, DARKWOOD = 17, LEAF = 18, RUBBER = 19, SCREEN = 20;
const BAIZE = 21, CLAY = 22, BRASS = 23;

// Box tagged with a palette index on every vertex (pos3 + part1), no bottom.
function box(
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, part: number,
): number[] {
  const out: number[] = [];
  const v = (x: number, y: number, z: number) => out.push(x, y, z, part);
  const quad = (a: number[], b: number[], c: number[], d: number[]) => {
    for (const p of [a, b, c, a, c, d]) v(p[0], p[1], p[2]);
  };
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // top
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]);
  quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]);
  return out;
}

// Toilet, facing +X: tank at the back, bowl, seat, flush button.
const toiletMesh = () => new Float32Array([
  ...box(0.30, 0.55, 0.00, 0.15, 0.42, 0.58, CERAMIC_DK),
  ...box(0.28, 0.62, 0.15, 0.38, 0.36, 0.64, CERAMIC),
  ...box(0.26, 0.64, 0.38, 0.44, 0.34, 0.66, SEAT),
  ...box(0.12, 0.26, 0.15, 0.78, 0.34, 0.66, CERAMIC),
  ...box(0.16, 0.22, 0.78, 0.82, 0.45, 0.55, CHROME),
]);

// Shower: pipe up the back of the tile, arm forward (+X), head angled down.
const showerMesh = () => new Float32Array([
  ...box(0.10, 0.16, 0.00, 2.10, 0.47, 0.53, CHROME),
  ...box(0.10, 0.42, 2.10, 2.16, 0.47, 0.53, CHROME),
  ...box(0.30, 0.48, 2.02, 2.10, 0.41, 0.59, STEEL),
  ...box(0.31, 0.47, 2.00, 2.03, 0.42, 0.58, DARK),
]);

// Floor drain: recessed plate with grate strips.
const drainMesh = () => {
  const out = [...box(0.30, 0.70, 0.030, 0.055, 0.30, 0.70, DARK)];
  for (const z of [0.36, 0.48, 0.60]) out.push(...box(0.34, 0.66, 0.055, 0.058, z, z + 0.04, BLACK));
  return new Float32Array(out);
};

// Fence gate (accent = ORANGE for open, RED for guard-only): full-height
// jambs with a chain-link leaf, transom above, and two accent stripes.
function fenceGateMesh(accent: number): Float32Array {
  const H = FENCE_H;
  return new Float32Array([
    ...box(0.03, 0.10, 0, H - 0.05, 0.45, 0.55, STEEL), // jambs
    ...box(0.90, 0.97, 0, H - 0.05, 0.45, 0.55, STEEL),
    ...box(0.03, 0.97, H - 0.13, H - 0.05, 0.45, 0.55, STEEL), // top rail
    ...box(0.08, 0.92, 1.96, 2.04, 0.46, 0.54, STEEL), // gate header
    ...box(0.10, 0.90, 0.06, 0.13, 0.46, 0.54, STEEL), // gate bottom rail
    ...box(0.10, 0.90, 0.13, 1.96, 0.492, 0.508, LINK), // gate leaf mesh
    ...box(0.10, 0.90, 2.04, H - 0.13, 0.492, 0.508, LINK), // transom mesh
    ...box(0.12, 0.88, 1.02, 1.16, 0.44, 0.56, accent), // stripes
    ...box(0.12, 0.88, 0.44, 0.58, 0.44, 0.56, accent),
    ...box(0.80, 0.90, 0.95, 1.25, 0.43, 0.57, DARK), // latch box
  ]);
}

// Canteen table: white top on steel legs.
const tableMesh = () => new Float32Array([
  ...box(0.08, 0.92, 0.72, 0.78, 0.08, 0.92, TABLE),
  ...box(0.10, 0.16, 0.00, 0.72, 0.10, 0.16, STEEL),
  ...box(0.84, 0.90, 0.00, 0.72, 0.10, 0.16, STEEL),
  ...box(0.10, 0.16, 0.00, 0.72, 0.84, 0.90, STEEL),
  ...box(0.84, 0.90, 0.00, 0.72, 0.84, 0.90, STEEL),
]);

const truckMesh = (accent: number) => new Float32Array([
  ...box(0.05, 1.95, 0.42, 1.90, 0.05, 4.20, CERAMIC),
  ...box(0.08, 1.92, 0.42, 1.62, 4.20, 5.85, accent),
  ...box(0.18, 0.82, 1.34, 1.56, 5.86, 5.90, SCREEN),
  ...box(1.18, 1.82, 1.34, 1.56, 5.86, 5.90, SCREEN),
  ...box(0.02, 0.32, 0.16, 0.72, 0.55, 1.20, BLACK),
  ...box(1.68, 1.98, 0.16, 0.72, 0.55, 1.20, BLACK),
  ...box(0.02, 0.32, 0.16, 0.72, 4.70, 5.35, BLACK),
  ...box(1.68, 1.98, 0.16, 0.72, 4.70, 5.35, BLACK),
]);

const cargoMesh = () => new Float32Array([
  ...box(0.05, 0.55, 0.00, 0.48, 0.05, 0.55, WOOD),
  ...box(0.03, 0.57, 0.19, 0.25, 0.02, 0.58, DARKWOOD),
]);

const driverMesh = () => new Float32Array([
  ...box(0.34, 0.66, 1.52, 1.88, 0.34, 0.66, CERAMIC),
  ...box(0.27, 0.73, 0.72, 1.52, 0.30, 0.70, ORANGE),
  ...box(0.30, 0.47, 0.00, 0.72, 0.35, 0.55, DARK),
  ...box(0.53, 0.70, 0.00, 0.72, 0.35, 0.55, DARK),
]);

const loadingPalletMesh = () => new Float32Array([
  ...box(0.05, 1.95, 0.10, 0.18, 0.05, 1.95, WOOD),
  ...box(0.10, 0.25, 0.00, 0.10, 0.12, 1.88, DARKWOOD),
  ...box(0.92, 1.08, 0.00, 0.10, 0.12, 1.88, DARKWOOD),
  ...box(1.75, 1.90, 0.00, 0.10, 0.12, 1.88, DARKWOOD),
]);

function genericEquipmentMesh(w: number, d: number): Float32Array {
  return new Float32Array([
    ...box(0.08, Math.max(.2, w - .08), 0.00, 0.72, 0.08, Math.max(.2, d - .08), STEEL),
    ...box(0.04, Math.max(.2, w - .04), 0.72, 0.82, 0.04, Math.max(.2, d - .04), DARK),
    ...box(0.18, Math.max(.2, w - .18), 0.82, 1.05, 0.18, Math.max(.2, d - .18), SCREEN),
  ]);
}

const freezerMesh = () => new Float32Array([
  ...box(0.04, 1.96, 0.00, 1.75, 0.10, 0.90, CERAMIC),
  ...box(0.02, 1.98, 0.82, 0.87, 0.08, 0.92, STEEL),
  ...box(0.92, 1.08, 0.25, 1.55, 0.075, 0.11, DARK),
  ...box(0.80, 0.86, 0.95, 1.35, 0.04, 0.10, CHROME),
]);

const sinkMesh = () => new Float32Array([
  ...box(0.08, 0.92, 0.70, 0.82, 0.08, 0.92, STEEL),
  ...box(0.17, 0.83, 0.72, 0.80, 0.17, 0.83, DARK),
  ...box(0.10, 0.18, 0.00, 0.70, 0.10, 0.18, STEEL),
  ...box(0.82, 0.90, 0.00, 0.70, 0.82, 0.90, STEEL),
  ...box(0.46, 0.54, 0.80, 1.25, 0.82, 0.90, CHROME),
  ...box(0.46, 0.78, 1.18, 1.25, 0.82, 0.90, CHROME),
]);

const uniformRackMesh = () => new Float32Array([
  ...box(0.10, 0.18, 0.00, 2.00, 0.12, 0.20, STEEL),
  ...box(0.82, 0.90, 0.00, 2.00, 0.12, 0.20, STEEL),
  ...box(0.10, 0.90, 1.88, 1.98, 0.12, 0.20, STEEL),
  ...box(0.18, 0.42, 0.55, 1.82, 0.16, 0.48, CLOTH),
  ...box(0.58, 0.82, 0.55, 1.82, 0.16, 0.48, SEAT),
]);

const secureBridgeMesh = () => new Float32Array([
  ...box(0.00, 10.00, 2.55, 2.78, 0.00, 2.00, STEEL),
  ...box(0.00, 10.00, 2.78, 2.88, 0.00, 0.10, DARK),
  ...box(0.00, 10.00, 2.78, 2.88, 1.90, 2.00, DARK),
  ...box(0.00, 10.00, 2.88, 4.15, 0.02, 0.08, LINK),
  ...box(0.00, 10.00, 2.88, 4.15, 1.92, 1.98, LINK),
  ...box(0.00, 10.00, 4.05, 4.18, 0.00, 0.10, STEEL),
  ...box(0.00, 10.00, 4.05, 4.18, 1.90, 2.00, STEEL),
]);

// Bench spanning `len` tiles along +X: seat plank + slab legs.
function benchMesh(len: number): Float32Array {
  const out = [
    ...box(0.10, len - 0.10, 0.42, 0.50, 0.30, 0.70, SEAT),
    ...box(0.16, 0.24, 0.00, 0.42, 0.32, 0.68, STEEL),
    ...box(len - 0.24, len - 0.16, 0.00, 0.42, 0.32, 0.68, STEEL),
  ];
  if (len >= 4) out.push(...box(len / 2 - 0.04, len / 2 + 0.04, 0.00, 0.42, 0.32, 0.68, STEEL));
  return new Float32Array(out);
}

// Cut fence: the tile keeps its centre post and rails, but the chain-link
// panel is torn open in the middle with curled edges. Authored along X.
function cutFenceMesh(): Float32Array {
  const H = FENCE_H;
  return new Float32Array([
    ...box(0.43, 0.57, 0, H + 0.45, 0.43, 0.57, STEEL), // post
    ...box(0.0, 1.0, H - 0.12, H - 0.02, 0.46, 0.54, STEEL), // top rail
    ...box(0.0, 1.0, 0.06, 0.14, 0.46, 0.54, STEEL), // bottom rail
    ...box(0.0, 1.0, 1.7, H - 0.08, 0.492, 0.508, LINK), // intact upper panel
    ...box(0.0, 0.16, 0.10, 1.7, 0.492, 0.508, LINK), // side scraps
    ...box(0.84, 1.0, 0.10, 1.7, 0.492, 0.508, LINK),
    ...box(0.14, 0.24, 0.14, 1.55, 0.46, 0.56, DARK), // curled edges
    ...box(0.76, 0.86, 0.14, 1.55, 0.44, 0.54, DARK),
  ]);
}

// Tunnel entry: the hole beside a displaced toilet, plus a dirt spill.
const holeEntryMesh = () => new Float32Array([
  ...box(0.52, 0.96, 0.012, 0.04, 0.24, 0.76, BLACK),
  ...box(0.44, 1.0, 0.04, 0.10, 0.16, 0.84, 12 /* dirt */),
  ...box(0.52, 0.96, 0.10, 0.115, 0.24, 0.76, BLACK),
]);

// Surfacing hole: a dark pit with a dirt ring.
const holeSurfMesh = () => new Float32Array([
  ...box(0.14, 0.86, 0.04, 0.11, 0.10, 0.90, 12 /* dirt */),
  ...box(0.22, 0.78, 0.11, 0.125, 0.18, 0.82, BLACK),
  ...box(0.22, 0.78, 0.012, 0.05, 0.18, 0.82, BLACK),
]);

// Serving table: a counter with a tray rail; trays stack on top when stocked.
const servingTableMesh = () => new Float32Array([
  ...box(0.06, 0.94, 0.00, 0.86, 0.20, 0.80, STEEL),
  ...box(0.00, 1.00, 0.86, 0.94, 0.12, 0.88, TABLE),
  ...box(0.02, 0.98, 0.70, 0.74, 0.06, 0.12, CHROME), // tray rail (front, +Z... -Z side)
]);

// Stack of trays shown while a serving table has stock.
const trayStackMesh = () => new Float32Array([
  ...box(0.28, 0.72, 0.94, 0.975, 0.30, 0.70, DARK),
  ...box(0.32, 0.68, 0.975, 1.005, 0.34, 0.66, DARK),
  ...box(0.38, 0.58, 1.005, 1.05, 0.40, 0.60, FOOD_A),
]);

// Meal tray sitting on a table top (top at y 0.78).
const foodMesh = () => new Float32Array([
  ...box(0.32, 0.68, 0.785, 0.815, 0.36, 0.64, DARK),
  ...box(0.37, 0.52, 0.815, 0.87, 0.42, 0.58, FOOD_A),
  ...box(0.55, 0.64, 0.815, 0.85, 0.44, 0.56, FOOD_B),
]);

// Bookshelf spanning `len` tiles along +X: a wooden carcass against the back of
// the tile (-Z), with `shelves` rows of books. The first object built entirely
// from the registry — small and large are the same mesh at two sizes.
function bookshelfMesh(len: number, height: number): Float32Array {
  const z0 = 0.06, z1 = 0.40; // shallow: it sits against a wall, not in the room
  const out = [
    ...box(0.04, len - 0.04, 0.00, 0.08, z0, z1, WOOD), // plinth
    ...box(0.04, len - 0.04, height - 0.06, height, z0 - 0.02, z1 + 0.02, WOOD), // cornice
    ...box(0.04, 0.10, 0.00, height, z0, z1, WOOD), // side panels
    ...box(len - 0.10, len - 0.04, 0.00, height, z0, z1, WOOD),
    ...box(0.04, len - 0.04, 0.00, height, z0, z0 + 0.03, WOOD), // back panel
  ];
  // Shelf boards, with a run of books standing on each.
  const shelves = Math.max(2, Math.round((height - 0.20) / 0.36));
  for (let s = 0; s < shelves; s++) {
    const y = 0.08 + ((height - 0.22) / shelves) * s;
    out.push(...box(0.10, len - 0.10, y, y + 0.04, z0 + 0.02, z1, WOOD));
    const top = y + 0.04 + (height - 0.22) / shelves - 0.10;
    for (let x = 0.16; x < len - 0.20; x += 0.075) {
      // Vary the height a little so the spines don't read as one solid block.
      const h = top - (((x * 37) % 5) / 5) * 0.06;
      out.push(...box(x, x + 0.055, y + 0.04, h, z0 + 0.05, z1 - 0.05, BOOKS));
    }
  }
  return new Float32Array(out);
}

// --- Library ----------------------------------------------------------------

// Reading desk spanning `len` tiles: a wooden top on turned legs, with a lip.
function readingDeskMesh(len: number): Float32Array {
  const out = [
    ...box(0.04, len - 0.04, 0.70, 0.76, 0.14, 0.86, WOOD),
    ...box(0.06, len - 0.06, 0.62, 0.70, 0.16, 0.84, DARKWOOD), // apron
    ...box(0.10, 0.18, 0.00, 0.62, 0.18, 0.26, DARKWOOD),
    ...box(len - 0.18, len - 0.10, 0.00, 0.62, 0.18, 0.26, DARKWOOD),
    ...box(0.10, 0.18, 0.00, 0.62, 0.74, 0.82, DARKWOOD),
    ...box(len - 0.18, len - 0.10, 0.00, 0.62, 0.74, 0.82, DARKWOOD),
  ];
  // An open book left on the top.
  out.push(...box(len / 2 - 0.18, len / 2 + 0.18, 0.76, 0.79, 0.40, 0.64, BOOKS));
  return new Float32Array(out);
}

// Plain wooden table: warm counterpart to the steel canteen table.
function woodTableMesh(w: number, d: number): Float32Array {
  const legs: number[] = [];
  for (const [lx, lz] of [[0.12, 0.12], [w - 0.20, 0.12], [0.12, d - 0.20], [w - 0.20, d - 0.20]]) {
    legs.push(...box(lx, lx + 0.08, 0.00, 0.70, lz, lz + 0.08, DARKWOOD));
  }
  return new Float32Array([
    ...box(0.04, w - 0.04, 0.70, 0.78, 0.04, d - 0.04, WOOD),
    ...box(0.08, w - 0.08, 0.62, 0.70, 0.08, d - 0.08, DARKWOOD),
    ...legs,
  ]);
}

// --- Seating ----------------------------------------------------------------

// Chair facing +X: seat, four legs, a slatted back at the -X end.
const chairMesh = () => new Float32Array([
  ...box(0.22, 0.78, 0.42, 0.48, 0.22, 0.78, WOOD),
  ...box(0.24, 0.30, 0.00, 0.42, 0.24, 0.30, DARKWOOD),
  ...box(0.70, 0.76, 0.00, 0.42, 0.24, 0.30, DARKWOOD),
  ...box(0.24, 0.30, 0.00, 0.42, 0.70, 0.76, DARKWOOD),
  ...box(0.70, 0.76, 0.00, 0.42, 0.70, 0.76, DARKWOOD),
  ...box(0.22, 0.28, 0.48, 0.92, 0.24, 0.76, DARKWOOD), // back posts + slats
  ...box(0.23, 0.27, 0.60, 0.68, 0.26, 0.74, WOOD),
]);

// Armchair facing +X: upholstered box with arms and a back cushion.
const armchairMesh = () => new Float32Array([
  ...box(0.14, 0.86, 0.00, 0.34, 0.10, 0.90, DARKWOOD), // base
  ...box(0.18, 0.86, 0.34, 0.46, 0.16, 0.84, CLOTH), // seat cushion
  ...box(0.10, 0.24, 0.34, 0.86, 0.10, 0.90, CLOTH), // back
  ...box(0.24, 0.86, 0.34, 0.60, 0.10, 0.22, CLOTH), // arms
  ...box(0.24, 0.86, 0.34, 0.60, 0.78, 0.90, CLOTH),
]);

// Sofa spanning `len` tiles along +X, facing +Z.
function sofaMesh(len: number): Float32Array {
  return new Float32Array([
    ...box(0.06, len - 0.06, 0.00, 0.32, 0.10, 0.86, DARKWOOD),
    ...box(0.10, len - 0.10, 0.32, 0.44, 0.16, 0.84, CLOTH), // seat
    ...box(0.06, len - 0.06, 0.32, 0.84, 0.10, 0.26, CLOTH), // back (-Z)
    ...box(0.06, 0.22, 0.32, 0.58, 0.10, 0.86, CLOTH), // arms
    ...box(len - 0.22, len - 0.06, 0.32, 0.58, 0.10, 0.86, CLOTH),
  ]);
}

// --- Gym --------------------------------------------------------------------

// Weight bench spanning `len` along +X: padded bench with an uprights rack.
function weightBenchMesh(len: number): Float32Array {
  return new Float32Array([
    ...box(0.16, len - 0.16, 0.40, 0.50, 0.32, 0.68, RUBBER), // pad
    ...box(0.20, 0.30, 0.00, 0.40, 0.38, 0.62, STEEL), // legs
    ...box(len - 0.30, len - 0.20, 0.00, 0.40, 0.38, 0.62, STEEL),
    ...box(0.10, 0.18, 0.00, 1.05, 0.24, 0.32, STEEL), // uprights
    ...box(0.10, 0.18, 0.00, 1.05, 0.68, 0.76, STEEL),
    ...box(0.06, 0.22, 1.05, 1.12, 0.10, 0.90, DARK), // barbell
    ...box(0.02, 0.26, 0.95, 1.22, 0.10, 0.20, BLACK), // plates
    ...box(0.02, 0.26, 0.95, 1.22, 0.80, 0.90, BLACK),
  ]);
}

// Treadmill facing +X: deck, belt, console on uprights.
const treadmillMesh = () => new Float32Array([
  ...box(0.10, 0.90, 0.00, 0.22, 0.18, 0.82, DARK),
  ...box(0.14, 0.86, 0.22, 0.26, 0.24, 0.76, RUBBER), // belt
  ...box(0.10, 0.18, 0.22, 1.00, 0.18, 0.26, STEEL), // uprights
  ...box(0.10, 0.18, 0.22, 1.00, 0.74, 0.82, STEEL),
  ...box(0.08, 0.20, 1.00, 1.10, 0.18, 0.82, DARK), // console
  ...box(0.09, 0.13, 1.02, 1.08, 0.28, 0.72, SCREEN),
]);

// Punching bag: a heavy bag on a ceiling-mounted chain.
const punchingBagMesh = () => new Float32Array([
  ...box(0.46, 0.54, 1.55, 2.30, 0.46, 0.54, CHROME), // chain
  ...box(0.36, 0.64, 1.45, 1.58, 0.36, 0.64, DARK), // cap
  ...box(0.32, 0.68, 0.32, 1.48, 0.32, 0.68, RUBBER), // bag
  ...box(0.34, 0.66, 0.92, 1.00, 0.34, 0.66, DARK), // seam band
]);

// Pull-up bar spanning `len` along +X: two posts and a crossbar.
function pullUpBarMesh(len: number): Float32Array {
  return new Float32Array([
    ...box(0.10, 0.22, 0.00, 2.05, 0.44, 0.56, STEEL),
    ...box(len - 0.22, len - 0.10, 0.00, 2.05, 0.44, 0.56, STEEL),
    ...box(0.04, len - 0.04, 2.05, 2.14, 0.46, 0.54, CHROME), // bar
    ...box(0.02, 0.30, 0.00, 0.06, 0.36, 0.64, DARK), // base plates
    ...box(len - 0.30, len - 0.02, 0.00, 0.06, 0.36, 0.64, DARK),
  ]);
}

// Exercise mat: a low w x d rubber pad, walkable.
function matMesh(w: number, d: number): Float32Array {
  return new Float32Array([
    ...box(0.05, w - 0.05, 0.00, 0.05, 0.05, d - 0.05, RUBBER),
    ...box(0.12, w - 0.12, 0.05, 0.055, 0.12, d - 0.12, DARK), // inlay
  ]);
}

// --- Common room ------------------------------------------------------------

// Television facing +X: a screen on a low stand.
const tvMesh = () => new Float32Array([
  ...box(0.30, 0.70, 0.00, 0.46, 0.20, 0.80, DARKWOOD), // stand
  ...box(0.36, 0.60, 0.46, 0.58, 0.42, 0.58, DARK), // neck
  ...box(0.30, 0.40, 0.58, 1.30, 0.08, 0.92, DARK), // bezel
  ...box(0.28, 0.31, 0.62, 1.26, 0.12, 0.88, SCREEN), // screen face (+X)
]);

// Pool table spanning `len` along +X: baize bed, rails, pockets, legs.
function poolTableMesh(len: number): Float32Array {
  const out = [
    ...box(0.08, len - 0.08, 0.52, 0.62, 0.08, 0.92, BAIZE), // bed
    ...box(0.02, len - 0.02, 0.62, 0.70, 0.02, 0.14, DARKWOOD), // rails
    ...box(0.02, len - 0.02, 0.62, 0.70, 0.86, 0.98, DARKWOOD),
    ...box(0.02, 0.14, 0.62, 0.70, 0.02, 0.98, DARKWOOD),
    ...box(len - 0.14, len - 0.02, 0.62, 0.70, 0.02, 0.98, DARKWOOD),
    ...box(0.04, len - 0.04, 0.30, 0.52, 0.04, 0.96, DARKWOOD), // body
  ];
  for (const [lx, lz] of [[0.06, 0.06], [len - 0.20, 0.06], [0.06, 0.82], [len - 0.20, 0.82]]) {
    out.push(...box(lx, lx + 0.14, 0.00, 0.30, lz, lz + 0.14, DARKWOOD));
  }
  // Balls racked at one end.
  for (let n = 0; n < 5; n++) {
    const bx = len * 0.68 + (n % 3) * 0.07, bz = 0.44 + ((n / 3) | 0) * 0.07;
    out.push(...box(bx, bx + 0.05, 0.62, 0.67, bz, bz + 0.05, n % 2 ? FOOD_B : ORANGE));
  }
  return new Float32Array(out);
}

// Chess table: a round-ish pedestal table with a checkered top.
const chessTableMesh = () => {
  const out = [
    ...box(0.42, 0.58, 0.00, 0.62, 0.42, 0.58, STEEL), // pedestal
    ...box(0.30, 0.70, 0.00, 0.05, 0.30, 0.70, DARK), // foot
    ...box(0.16, 0.84, 0.62, 0.70, 0.16, 0.84, TABLE), // top
  ];
  // Checkerboard inlay: only the dark squares need geometry.
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      if ((a + b) % 2 === 0) continue;
      const cx = 0.22 + a * 0.14, cz = 0.22 + b * 0.14;
      out.push(...box(cx, cx + 0.14, 0.70, 0.712, cz, cz + 0.14, DARKWOOD));
    }
  }
  return new Float32Array(out);
};

// Coffee table: a low wooden slab.
const coffeeTableMesh = () => new Float32Array([
  ...box(0.10, 0.90, 0.34, 0.40, 0.16, 0.84, WOOD),
  ...box(0.14, 0.20, 0.00, 0.34, 0.20, 0.26, DARKWOOD),
  ...box(0.80, 0.86, 0.00, 0.34, 0.20, 0.26, DARKWOOD),
  ...box(0.14, 0.20, 0.00, 0.34, 0.74, 0.80, DARKWOOD),
  ...box(0.80, 0.86, 0.00, 0.34, 0.74, 0.80, DARKWOOD),
]);

// --- Chapel -----------------------------------------------------------------

// Altar facing +X: a draped table with a brass cross and two candles.
const altarMesh = () => new Float32Array([
  ...box(0.24, 0.76, 0.00, 0.86, 0.10, 0.90, TABLE), // cloth-draped block
  ...box(0.20, 0.80, 0.86, 0.94, 0.06, 0.94, WOOD), // top slab
  ...box(0.22, 0.78, 0.30, 0.38, 0.08, 0.92, BRASS), // orphrey band
  ...box(0.46, 0.54, 0.94, 1.36, 0.47, 0.53, BRASS), // cross upright
  ...box(0.47, 0.53, 1.18, 1.26, 0.34, 0.66, BRASS), // cross arms
  ...box(0.44, 0.56, 0.94, 1.10, 0.16, 0.22, CHROME), // candles
  ...box(0.44, 0.56, 0.94, 1.10, 0.78, 0.84, CHROME),
]);

// Pew spanning `len` along +X, facing +Z: bench with a tall back and kneeler.
function pewMesh(len: number): Float32Array {
  return new Float32Array([
    ...box(0.04, len - 0.04, 0.42, 0.50, 0.30, 0.70, WOOD), // seat
    ...box(0.04, len - 0.04, 0.50, 1.00, 0.24, 0.32, DARKWOOD), // back (-Z)
    ...box(0.06, 0.16, 0.00, 0.42, 0.28, 0.68, DARKWOOD), // end panels
    ...box(len - 0.16, len - 0.06, 0.00, 0.42, 0.28, 0.68, DARKWOOD),
    ...box(0.08, len - 0.08, 0.10, 0.16, 0.72, 0.88, WOOD), // kneeler
  ]);
}

// Lectern facing +X: a slanted reading stand on a column.
const lecternMesh = () => new Float32Array([
  ...box(0.34, 0.66, 0.00, 0.06, 0.30, 0.70, DARKWOOD),
  ...box(0.44, 0.56, 0.06, 1.02, 0.44, 0.56, DARKWOOD),
  ...box(0.28, 0.72, 1.02, 1.10, 0.24, 0.76, WOOD), // desk
  ...box(0.30, 0.70, 1.10, 1.14, 0.26, 0.74, BOOKS), // open book
]);

// --- Staff room -------------------------------------------------------------

const coffeeMachineMesh = () => new Float32Array([
  ...box(0.22, 0.78, 0.00, 0.24, 0.24, 0.76, DARK), // counter block
  ...box(0.24, 0.76, 0.24, 0.80, 0.26, 0.74, STEEL), // body
  ...box(0.26, 0.40, 0.30, 0.44, 0.30, 0.70, BLACK), // recess + jug
  ...box(0.28, 0.38, 0.32, 0.42, 0.36, 0.64, FOOD_A),
  ...box(0.24, 0.76, 0.80, 0.86, 0.24, 0.76, DARK), // top
  ...box(0.60, 0.74, 0.50, 0.62, 0.34, 0.66, CHROME), // control strip
]);

const vendingMachineMesh = () => new Float32Array([
  ...box(0.14, 0.86, 0.00, 1.90, 0.20, 0.80, RED), // cabinet
  ...box(0.10, 0.16, 0.10, 1.80, 0.24, 0.76, SCREEN), // glass front (+X face)
  ...box(0.12, 0.15, 0.30, 1.70, 0.28, 0.72, FOOD_B), // stocked shelves
  ...box(0.12, 0.15, 0.90, 1.00, 0.28, 0.72, FOOD_A),
  ...box(0.10, 0.18, 0.10, 0.26, 0.28, 0.72, DARK), // dispensing tray
]);

const waterCoolerMesh = () => new Float32Array([
  ...box(0.30, 0.70, 0.00, 0.86, 0.30, 0.70, CERAMIC),
  ...box(0.34, 0.66, 0.86, 1.30, 0.34, 0.66, CHROME), // bottle
  ...box(0.36, 0.64, 0.90, 1.26, 0.36, 0.64, SCREEN), // water
  ...box(0.24, 0.32, 0.50, 0.58, 0.42, 0.58, DARK), // tap + cup shelf
]);

const lockersMesh = () => {
  const out = [...box(0.16, 0.84, 0.00, 1.80, 0.20, 0.80, STEEL)];
  // Two doors, each with a vent slot and a handle.
  for (const [y0, y1] of [[0.06, 0.90], [0.92, 1.76]]) {
    out.push(...box(0.14, 0.17, y0, y1, 0.24, 0.76, DARK));
    out.push(...box(0.13, 0.16, y1 - 0.12, y1 - 0.06, 0.32, 0.68, BLACK)); // vent
    out.push(...box(0.12, 0.16, (y0 + y1) / 2, (y0 + y1) / 2 + 0.05, 0.66, 0.72, CHROME));
  }
  return new Float32Array(out);
};

// --- Decor ------------------------------------------------------------------

// Potted plant: terracotta pot, stem, a few leaf slabs.
function plantMesh(scale: number): Float32Array {
  const s = scale;
  const out = [
    ...box(0.34, 0.66, 0.00, 0.26 * s, 0.34, 0.66, CLAY),
    ...box(0.31, 0.69, 0.22 * s, 0.28 * s, 0.31, 0.69, CLAY), // rim
    ...box(0.46, 0.54, 0.26 * s, 0.70 * s, 0.46, 0.54, DARKWOOD), // stem
  ];
  // Leaves fanned around the stem at two heights.
  const tiers: [number, number][] = [[0.55, 0.30], [0.80, 0.22]];
  for (const [h, r] of tiers) {
    for (let a = 0; a < 4; a++) {
      const ang = (a / 4) * Math.PI * 2 + h;
      const cx = 0.5 + Math.cos(ang) * r * 0.5, cz = 0.5 + Math.sin(ang) * r * 0.5;
      out.push(...box(cx - r * 0.5, cx + r * 0.5, h * s, h * s + 0.05,
        cz - r * 0.5, cz + r * 0.5, LEAF));
    }
  }
  return new Float32Array(out);
}

// Rug: a flat woven mat with a border. Walkable, so it must stay very low.
const rugMesh = () => new Float32Array([
  ...box(0.03, 0.97, 0.00, 0.018, 0.03, 0.97, CLAY),
  ...box(0.12, 0.88, 0.018, 0.022, 0.12, 0.88, FOOD_B),
  ...box(0.24, 0.76, 0.022, 0.026, 0.24, 0.76, CLAY),
]);

const trashCanMesh = () => new Float32Array([
  ...box(0.30, 0.70, 0.00, 0.62, 0.30, 0.70, STEEL),
  ...box(0.27, 0.73, 0.62, 0.68, 0.27, 0.73, DARK), // rim
  ...box(0.33, 0.67, 0.66, 0.70, 0.33, 0.67, BLACK), // bag mouth
]);

// Sniper tower: four splayed legs, a cross-braced trunk, and a railed platform
// at TOWER_HEIGHT with a little roof over it. Authored 2x2.
function sniperTowerMesh(): Float32Array {
  const H = 3.4; // must match TOWER_HEIGHT in agents.ts
  const out: number[] = [];
  // Legs, splayed slightly outward at the base.
  for (const [lx, lz] of [[0.18, 0.18], [1.70, 0.18], [0.18, 1.70], [1.70, 1.70]]) {
    out.push(...box(lx, lx + 0.12, 0.00, H, lz, lz + 0.12, STEEL));
  }
  // Cross braces, halfway up.
  for (const y of [H * 0.35, H * 0.7]) {
    out.push(...box(0.18, 1.82, y, y + 0.06, 0.20, 0.26, STEEL));
    out.push(...box(0.18, 1.82, y, y + 0.06, 1.74, 1.80, STEEL));
    out.push(...box(0.20, 0.26, y, y + 0.06, 0.18, 1.82, STEEL));
    out.push(...box(1.74, 1.80, y, y + 0.06, 0.18, 1.82, STEEL));
  }
  // Ladder up one face.
  for (let y = 0.25; y < H - 0.1; y += 0.28) {
    out.push(...box(0.92, 1.08, y, y + 0.05, 0.10, 0.18, DARK));
  }
  // Platform deck + railing.
  out.push(...box(0.02, 1.98, H, H + 0.10, 0.02, 1.98, DARKWOOD));
  for (const [x0, x1, z0, z1] of [
    [0.02, 1.98, 0.02, 0.12], [0.02, 1.98, 1.88, 1.98],
    [0.02, 0.12, 0.02, 1.98], [1.88, 1.98, 0.02, 1.98],
  ]) {
    out.push(...box(x0, x1, H + 0.10, H + 0.62, z0, z1, STEEL));
  }
  // Roof on corner posts.
  for (const [px, pz] of [[0.10, 0.10], [1.78, 0.10], [0.10, 1.78], [1.78, 1.78]]) {
    out.push(...box(px, px + 0.08, H + 0.62, H + 1.70, pz, pz + 0.08, STEEL));
  }
  out.push(...box(-0.10, 2.10, H + 1.70, H + 1.82, -0.10, 2.10, DARK));
  return new Float32Array(out);
}

// Cooker: steel body, dark hob with four burners, front handle (+X).
const cookerMesh = () => {
  const out = [
    ...box(0.10, 0.90, 0.00, 0.82, 0.10, 0.90, STEEL),
    ...box(0.08, 0.92, 0.82, 0.88, 0.08, 0.92, STOVE),
    ...box(0.90, 0.96, 0.50, 0.56, 0.18, 0.82, CHROME),
  ];
  for (const [cx, cz] of [[0.32, 0.32], [0.32, 0.68], [0.68, 0.32], [0.68, 0.68]]) {
    out.push(...box(cx - 0.11, cx + 0.11, 0.88, 0.905, cz - 0.11, cz + 0.11, BLACK));
  }
  return new Float32Array(out);
};

interface Slot { kind: number; buf: GPUBuffer; verts: number; inst: GPUBuffer | null; count: number; }

export class FurniturePass {
  private pipeline!: GPURenderPipeline;
  private bind!: GPUBindGroup;
  private slots: Slot[] = [];

  static create(
    device: GPUDevice, format: GPUTextureFormat, uniformBuf: GPUBuffer, light: SceneLight,
  ): FurniturePass {
    const p = new FurniturePass();
    const module = device.createShaderModule({ code: PRELUDE + furnitureShader });
    p.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module, entryPoint: "vs",
        buffers: [
          {
            arrayStride: 16, stepMode: "vertex",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32" },
            ],
          },
          {
            arrayStride: 12, stepMode: "instance",
            attributes: [
              { shaderLocation: 2, offset: 0, format: "float32x2" },
              { shaderLocation: 3, offset: 8, format: "float32" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less" },
    });
    p.bind = device.createBindGroup({
      layout: p.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        ...sceneLightEntries(light),
      ],
    });

    const meshes: [number, Float32Array][] = [
      [Obj.Toilet, toiletMesh()],
      [Obj.Shower, showerMesh()],
      [Obj.Drain, drainMesh()],
      [Obj.FenceDoor, fenceGateMesh(ORANGE)],
      [Obj.FenceJailDoor, fenceGateMesh(RED)],
      [Obj.Table, tableMesh()],
      [Obj.Bench2, benchMesh(2)],
      [Obj.Bench4, benchMesh(4)],
      [Obj.Cooker, cookerMesh()],
      [Obj.CutFence, cutFenceMesh()],
      [Obj.ServingTable, servingTableMesh()],
      // Library
      [Obj.Bookshelf, bookshelfMesh(1, 1.15)],
      [Obj.BookshelfLarge, bookshelfMesh(2, 1.95)],
      [Obj.BookshelfTall, bookshelfMesh(2, 2.60)],
      [Obj.ReadingDesk, readingDeskMesh(2)],
      [Obj.WoodenTable, woodTableMesh(2, 1)],
      [Obj.WoodenTableLarge, woodTableMesh(2, 2)],
      // Seating
      [Obj.Chair, chairMesh()],
      [Obj.Armchair, armchairMesh()],
      [Obj.Sofa, sofaMesh(2)],
      // Gym
      [Obj.WeightBench, weightBenchMesh(2)],
      [Obj.Treadmill, treadmillMesh()],
      [Obj.PunchingBag, punchingBagMesh()],
      [Obj.PullUpBar, pullUpBarMesh(2)],
      [Obj.ExerciseMat, matMesh(2, 2)],
      // Common room
      [Obj.Television, tvMesh()],
      [Obj.PoolTable, poolTableMesh(2)],
      [Obj.ChessTable, chessTableMesh()],
      [Obj.CoffeeTable, coffeeTableMesh()],
      // Chapel
      [Obj.Altar, altarMesh()],
      [Obj.Pew, pewMesh(3)],
      [Obj.Lectern, lecternMesh()],
      // Staff room
      [Obj.CoffeeMachine, coffeeMachineMesh()],
      [Obj.VendingMachine, vendingMachineMesh()],
      [Obj.WaterCooler, waterCoolerMesh()],
      [Obj.Lockers, lockersMesh()],
      // Decor
      [Obj.PottedPlant, plantMesh(1.0)],
      [Obj.LargePlant, plantMesh(1.9)],
      [Obj.Rug, rugMesh()],
      [Obj.TrashCan, trashCanMesh()],
      // Security
      [Obj.SniperTower, sniperTowerMesh()],
      [Obj.LoadingPallet, loadingPalletMesh()],
      [Obj.Freezer, freezerMesh()],
      [Obj.Sink, sinkMesh()],
      [Obj.SearchTable, woodTableMesh(2, 1)],
      [Obj.UniformRack, uniformRackMesh()],
      [Obj.SecureBridge, secureBridgeMesh()],
      [TRUCK_KIND, truckMesh(CERAMIC_DK)],
      [INTAKE_TRUCK_KIND, truckMesh(ORANGE)],
      [CARGO_KIND, cargoMesh()],
      [DRIVER_KIND, driverMesh()],
      [FOOD_KIND, foodMesh()],
      [TRAY_STACK_KIND, trayStackMesh()],
      [HOLE_ENTRY_KIND, holeEntryMesh()],
      [HOLE_SURF_KIND, holeSurfMesh()],
    ];
    const present = new Set(meshes.map(([kind]) => kind));
    for (const def of OBJ_DEFS) {
      if (def.place !== "piece" || def.render !== "furniture" || present.has(def.kind)) continue;
      meshes.push([def.kind, genericEquipmentMesh(def.w, def.d)]);
    }
    for (const [kind, mesh] of meshes) {
      const buf = device.createBuffer({ size: mesh.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, mesh as BufferSource);
      p.slots.push({ kind, buf, verts: mesh.length / 4, inst: null, count: 0 });
    }
    return p;
  }

  setInstances(device: GPUDevice, byKind: Map<number, Float32Array>) {
    for (const slot of this.slots) {
      const data = byKind.get(slot.kind);
      slot.inst?.destroy();
      if (!data || data.length === 0) { slot.inst = null; slot.count = 0; continue; }
      slot.inst = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(slot.inst, 0, data as BufferSource);
      slot.count = data.length / 3;
    }
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    for (const slot of this.slots) {
      if (!slot.inst) continue;
      pass.setVertexBuffer(0, slot.buf);
      pass.setVertexBuffer(1, slot.inst);
      pass.draw(slot.verts, slot.count);
    }
  }
}

/** The ghost pass consumes the exact same authored meshes as completed
 * furniture, so planned objects do not collapse into generic cubes. */
export function furnitureMeshRegistry(): Map<number, Float32Array> {
  const result = new Map<number, Float32Array>([
    [Obj.Toilet, toiletMesh()], [Obj.Shower, showerMesh()], [Obj.Drain, drainMesh()],
    [Obj.FenceDoor, fenceGateMesh(ORANGE)], [Obj.FenceJailDoor, fenceGateMesh(RED)],
    [Obj.Table, tableMesh()], [Obj.Bench2, benchMesh(2)], [Obj.Bench4, benchMesh(4)],
    [Obj.Cooker, cookerMesh()], [Obj.ServingTable, servingTableMesh()],
    [Obj.Bookshelf, bookshelfMesh(1, 1.15)], [Obj.BookshelfLarge, bookshelfMesh(2, 1.95)],
    [Obj.BookshelfTall, bookshelfMesh(2, 2.60)], [Obj.ReadingDesk, readingDeskMesh(2)],
    [Obj.WoodenTable, woodTableMesh(2, 1)], [Obj.WoodenTableLarge, woodTableMesh(2, 2)],
    [Obj.Chair, chairMesh()], [Obj.Armchair, armchairMesh()], [Obj.Sofa, sofaMesh(2)],
    [Obj.WeightBench, weightBenchMesh(2)], [Obj.Treadmill, treadmillMesh()],
    [Obj.PunchingBag, punchingBagMesh()], [Obj.PullUpBar, pullUpBarMesh(2)],
    [Obj.ExerciseMat, matMesh(2, 2)], [Obj.Television, tvMesh()],
    [Obj.PoolTable, poolTableMesh(2)], [Obj.ChessTable, chessTableMesh()],
    [Obj.CoffeeTable, coffeeTableMesh()], [Obj.Altar, altarMesh()], [Obj.Pew, pewMesh(3)],
    [Obj.Lectern, lecternMesh()], [Obj.CoffeeMachine, coffeeMachineMesh()],
    [Obj.VendingMachine, vendingMachineMesh()], [Obj.WaterCooler, waterCoolerMesh()],
    [Obj.Lockers, lockersMesh()], [Obj.PottedPlant, plantMesh(1.0)],
    [Obj.LargePlant, plantMesh(1.9)], [Obj.Rug, rugMesh()], [Obj.TrashCan, trashCanMesh()],
    [Obj.SniperTower, sniperTowerMesh()], [Obj.LoadingPallet, loadingPalletMesh()],
    [Obj.Freezer, freezerMesh()], [Obj.Sink, sinkMesh()],
    [Obj.SearchTable, woodTableMesh(2, 1)], [Obj.UniformRack, uniformRackMesh()],
    [Obj.SecureBridge, secureBridgeMesh()],
  ]);
  for (const def of OBJ_DEFS) if (def.place === "piece" && def.render === "furniture" && !result.has(def.kind)) {
    result.set(def.kind, genericEquipmentMesh(def.w, def.d));
  }
  return result;
}
