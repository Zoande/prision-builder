import { NEEDS, OBJ_DEFS, Obj, ROOM_DEFS } from "./objects.ts";
import { ITEM_DEFS } from "./items.ts";
import { COMMODITIES } from "./commodities.ts";

export const SAVE_VERSION = 6;

export interface SaveEnvelopeV6 {
  version: typeof SAVE_VERSION;
  savedAt: string;
  worldTime: number;
  view?: { target: [number, number, number]; yaw: number; pitch: number; distance: number };
  // Payload types evolve with their owning systems. This guard validates the
  // import envelope and structural records that are unsafe to load partially.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  world: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  infrastructure: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  economy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logistics: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  construction: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kitchen: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intake: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task2: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task3: any;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reject incomplete/malformed imports before any live system is mutated. */
export function isSaveV6(value: unknown): value is SaveEnvelopeV6 {
  if (!record(value) || value.version !== SAVE_VERSION ||
      typeof value.worldTime !== "number" || !Number.isFinite(value.worldTime) || value.worldTime < 0) return false;
  if (value.view !== undefined) {
    const view = value.view;
    if (!record(view) || !Array.isArray(view.target) || view.target.length !== 3 ||
        !view.target.every(n => typeof n === "number" && Number.isFinite(n)) ||
        view.target[0] < 0 || view.target[0] > 500 || view.target[1] !== 0 || view.target[2] < 0 || view.target[2] > 500 ||
        typeof view.yaw !== "number" || !Number.isFinite(view.yaw) ||
        typeof view.pitch !== "number" || !Number.isFinite(view.pitch) || view.pitch <= 0 || view.pitch >= Math.PI / 2 ||
        typeof view.distance !== "number" || !Number.isFinite(view.distance) || view.distance < 12 || view.distance > 1800) return false;
  }
  for (const key of ["world", "agents", "infrastructure", "economy", "logistics", "construction", "kitchen", "intake", "task2", "task3"]) {
    if (!record(value[key])) return false;
  }
  const world = value.world as Record<string, unknown>, agents = value.agents as Record<string, unknown>;
  const economy = value.economy as Record<string, unknown>, logistics = value.logistics as Record<string, unknown>;
  const kitchen = value.kitchen as Record<string, unknown>;
  // The browser world is fixed at 500 tiles. Importing a differently sized
  // sparse tile map would silently reinterpret every tile index.
  if (world.size !== 500 || !Array.isArray(world.tiles) || !Array.isArray(world.pieces) ||
      !Array.isArray(world.rooms) || !Array.isArray(world.routes) || !Array.isArray(agents.agents)) return false;
  if (agents.rngState !== undefined && (typeof agents.rngState !== "number" || !Number.isInteger(agents.rngState) ||
      agents.rngState < 1 || agents.rngState > 0xffffffff)) return false;
  const objectKinds = new Set<number>(Object.values(Obj));
  const personKinds = new Set(OBJ_DEFS.filter(def => def.place === "person").map(def => def.kind));
  const roomTypes = new Set(ROOM_DEFS.map(room => room.type));
  const itemKinds = new Set(ITEM_DEFS.map(item => item.kind));
  const commodityIds = new Set(COMMODITIES.map(commodity => commodity.id));
  const nonnegativeInteger = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  const validTile = (tile: unknown): tile is number => typeof tile === "number" && Number.isInteger(tile) && tile >= 0 && tile < 250000;
  const tiles = new Set<number>();
  for (const tile of world.tiles) {
    if (!Array.isArray(tile) || tile.length !== 6 || !tile.every((n) => Number.isInteger(n) && n >= 0) ||
        tile[0] >= 250000 || tiles.has(tile[0]) || tile[1] > 255 || !objectKinds.has(tile[2]) || tile[3] > 255 || tile[4] > 3 || tile[5] > 1) return false;
    tiles.add(tile[0]);
  }
  const ids = new Set<number>();
  for (const agent of agents.agents) {
    if (!record(agent) || typeof agent.id !== "number" || !Number.isInteger(agent.id) || agent.id < 0 || ids.has(agent.id) ||
        typeof agent.x !== "number" || !Number.isFinite(agent.x) || typeof agent.z !== "number" || !Number.isFinite(agent.z) ||
        typeof agent.kind !== "number" || !personKinds.has(agent.kind) || typeof agent.state !== "string" ||
        !record(agent.needs) || NEEDS.some(need => typeof (agent.needs as Record<string, unknown>)[need] !== "number" ||
          !Number.isFinite((agent.needs as Record<string, number>)[need]) || (agent.needs as Record<string, number>)[need] < 0 ||
          (agent.needs as Record<string, number>)[need] > 1) || !record(agent.inv) ||
        !Array.isArray(agent.inv.hands) || !Array.isArray(agent.inv.pockets) || agent.inv.pockets.length !== 2) return false;
    for (const stack of agent.inv.hands) {
      if (!record(stack) || typeof stack.kind !== "number" || !itemKinds.has(stack.kind) ||
          !nonnegativeInteger(stack.count) || stack.count === 0) return false;
    }
    for (const stack of agent.inv.pockets) {
      if (stack === null) continue;
      if (!record(stack) || typeof stack.kind !== "number" || !itemKinds.has(stack.kind) ||
          !nonnegativeInteger(stack.count) || stack.count === 0) return false;
    }
    ids.add(agent.id);
  }
  const pieceIds = new Set<number>();
  for (const piece of world.pieces) {
    if (!record(piece) || typeof piece.id !== "number" || !Number.isInteger(piece.id) || piece.id <= 0 || pieceIds.has(piece.id) ||
        typeof piece.kind !== "number" || !objectKinds.has(piece.kind) || personKinds.has(piece.kind) ||
        ![piece.x, piece.z, piece.w, piece.d, piece.orient].every(n => typeof n === "number" && Number.isInteger(n)) ||
        (piece.x as number) < 0 || (piece.z as number) < 0 || (piece.w as number) < 1 || (piece.d as number) < 1 ||
        (piece.x as number) + (piece.w as number) > 500 || (piece.z as number) + (piece.d as number) > 500 ||
        (piece.orient as number) < 0 || (piece.orient as number) > 3) return false;
    pieceIds.add(piece.id);
  }
  if (typeof economy.cash !== "number" || !Number.isFinite(economy.cash)) return false;
  for (const key of ["frozenMeals", "cleanTrays", "cleanSpoons", "dirtyTrays", "dirtySpoons", "books",
    "preparedSettings", "eatingSettings", "borrowedBooks"]) {
    // borrowedBooks was added after the first v6 saves; when present, it is a stock count too.
    if ((key !== "borrowedBooks" || kitchen[key] !== undefined) && !nonnegativeInteger(kitchen[key])) return false;
  }
  if (!Array.isArray(logistics.packages)) return false;
  const packageIds = new Set<number>();
  for (const pkg of logistics.packages) {
    if (!record(pkg) || typeof pkg.id !== "number" || !Number.isInteger(pkg.id) || pkg.id <= 0 || packageIds.has(pkg.id) ||
        typeof pkg.commodity !== "string" || !Number.isInteger(pkg.quantity) || (pkg.quantity as number) <= 0 ||
        !["ordered", "in-transit", "delivery", "reserved", "carried", "site", "exports"].includes(String(pkg.state)) ||
        typeof pkg.x !== "number" || !Number.isFinite(pkg.x) || typeof pkg.z !== "number" || !Number.isFinite(pkg.z) ||
        !(pkg.reservedBy === null || typeof pkg.reservedBy === "string") ||
        typeof pkg.truckId !== "number" || !Number.isInteger(pkg.truckId) ||
        !(commodityIds.has(pkg.commodity) || /^box:\d+$/.test(pkg.commodity))) return false;
    if (pkg.commodity.startsWith("box:") && !objectKinds.has(Number(pkg.commodity.slice(4)))) return false;
    packageIds.add(pkg.id);
  }
  const roomIds = new Set<number>();
  for (const room of world.rooms) {
    if (!record(room) || typeof room.id !== "number" || !Number.isInteger(room.id) || room.id <= 0 || roomIds.has(room.id) ||
        typeof room.type !== "number" || !roomTypes.has(room.type) || !Array.isArray(room.tiles) || !room.tiles.every(validTile)) return false;
    roomIds.add(room.id);
  }
  for (const route of world.routes) if (!record(route) || typeof route.id !== "number" || !Number.isInteger(route.id) || route.id <= 0 ||
    !Array.isArray(route.tiles) || !route.tiles.every(validTile) || (route.color !== 0 && route.color !== 1)) return false;
  return true;
}
