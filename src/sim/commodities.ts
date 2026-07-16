import { Obj, type ObjDef } from "./objects.ts";

export type HandlerRole = "workman" | "cook";

export interface CommodityDef {
  id: string;
  name: string;
  price: number;
  packageSize: number;
  handler: HandlerRole;
  exportValue: number;
}

function commodity(
  id: string, name: string, price: number, packageSize: number, handler: HandlerRole,
): CommodityDef {
  return { id, name, price, packageSize, handler, exportValue: price * 0.5 };
}

export const COMMODITIES: CommodityDef[] = [
  commodity("concrete", "Concrete", 20, 5, "workman"),
  commodity("metal", "Metal", 30, 5, "workman"),
  commodity("timber", "Timber", 15, 5, "workman"),
  commodity("frozen-meal", "Frozen meal", 5, 12, "cook"),
  commodity("tray", "Tray", 18, 6, "cook"),
  commodity("spoon", "Spoon", 2, 24, "cook"),
  commodity("book", "Book", 10, 8, "workman"),
];

const BY_ID = new Map(COMMODITIES.map((d) => [d.id, d]));

export function commodityDef(id: string): CommodityDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown commodity: ${id}`);
  return def;
}

export function boxCommodity(kind: number): string { return `box:${kind}`; }

const BOX_OVERRIDES = new Map<number, number>([
  [Obj.Cooker, 500], [Obj.ServingTable, 300], [Obj.Freezer, 600], [Obj.Sink, 250],
  [Obj.Television, 500], [Obj.Treadmill, 500], [Obj.CoffeeMachine, 300],
  [Obj.VendingMachine, 350], [Obj.SniperTower, 2000], [Obj.LoadingPallet, 100],
  [Obj.SearchTable, 250], [Obj.UniformRack, 200],
  [Obj.Door, 100], [Obj.Lamp, 100], [Obj.WallLight, 120], [Obj.RoofLight, 120],
  [Obj.JailDoor, 150], [Obj.FenceDoor, 150], [Obj.FenceJailDoor, 200],
]);

export function boxedPrice(def: ObjDef): number {
  return BOX_OVERRIDES.get(def.kind) ?? 75 + 75 * def.w * def.d + (def.use ? 75 : 0);
}

export function ensureBoxCommodity(def: ObjDef): CommodityDef {
  const id = boxCommodity(def.kind);
  let result = BY_ID.get(id);
  if (!result) {
    const price = boxedPrice(def);
    result = commodity(id, `Boxed ${def.name}`, price, 1, "workman");
    COMMODITIES.push(result);
    BY_ID.set(id, result);
  }
  return result;
}

export type Recipe = Record<string, number>;

export function addRecipe(into: Recipe, recipe: Recipe, times = 1): Recipe {
  for (const [id, quantity] of Object.entries(recipe)) into[id] = (into[id] ?? 0) + quantity * times;
  return into;
}

export function recipeCost(recipe: Recipe): number {
  let total = 0;
  for (const [id, quantity] of Object.entries(recipe)) total += commodityDef(id).price * quantity;
  return total;
}

