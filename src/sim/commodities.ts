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
  commodity("cloth", "Cloth", 6, 8, "workman"),
  commodity("metal-scrap", "Metal scrap", 8, 8, "workman"),
  commodity("wood-scrap", "Wood scrap", 5, 8, "workman"),
  commodity("wire", "Wire", 7, 12, "workman"),
  commodity("paper", "Paper", 2, 16, "workman"),
  commodity("ink", "Printing ink", 9, 6, "workman"),
  commodity("fertilizer", "Fertilizer", 12, 6, "workman"),
  commodity("chemical", "Cleaning chemical", 14, 6, "workman"),
  commodity("sugar", "Sugar", 3, 12, "workman"),
  commodity("yeast", "Yeast", 4, 12, "workman"),
  commodity("needle", "Sewing needle", 6, 8, "workman"),
  commodity("trowel", "Garden trowel", 25, 4, "workman"),
  commodity("pruning-shears", "Pruning shears", 45, 4, "workman"),
  commodity("kitchen-knife", "Kitchen knife", 55, 4, "workman"),
  commodity("shovel", "Shovel", 60, 3, "workman"),
  commodity("file", "Metal file", 35, 4, "workman"),
  commodity("hacksaw-blade", "Hacksaw blade", 45, 6, "workman"),
  commodity("hammer", "Workshop hammer", 38, 4, "workman"),
  commodity("screwdriver", "Screwdriver", 25, 4, "workman"),
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
