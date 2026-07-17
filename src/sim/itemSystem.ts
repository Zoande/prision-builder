export type ItemLegality = "legal" | "controlled" | "contraband";
export type ItemSize = "tiny" | "small" | "large" | "body";
export type ItemLocationKind = "world" | "container" | "package" | "destroyed";

export interface WeaponProfile {
  damage: "blunt" | "cut" | "puncture" | "gunshot" | "bite" | "irritant" | "shock";
  power: number;
  reach: number;
  speed: number;
  intimidation: number;
  disarmDifficulty: number;
  noise: number;
  targetBias?: "head" | "torso" | "arms" | "legs";
  ammunition?: string;
}

export interface ItemDefV4 {
  id: string;
  name: string;
  size: ItemSize;
  legality: ItemLegality;
  concealment: number;
  baseValue: number;
  controlled: boolean;
  stackView: boolean;
  weapon?: WeaponProfile;
  tags: string[];
}

export interface ItemHistoryEntry {
  time: number;
  action: string;
  actorId: number;
  location: string;
}

export interface ItemInstance {
  id: number;
  defId: string;
  condition: number;
  quality: number;
  locationKind: ItemLocationKind;
  x: number;
  z: number;
  containerId: string;
  packageId: number;
  ownerId: number;
  issuedTo: number;
  hidden: boolean;
  dirty: boolean;
  denomination: number;
  contents: number[];
  createdAt: number;
  history: ItemHistoryEntry[];
}

export interface ContainerDef {
  id: string;
  name: string;
  x: number;
  z: number;
  capacity: number;
  concealment: number;
  bodyCapacity: number;
  lockedTier: "none" | "staff" | "guard";
  ownerId: number;
  itemIds: number[];
  tags: string[];
}

export interface ControlledDiscrepancy {
  defId: string;
  itemId: number;
  issuedTo: number;
  lastLocation: string;
}

const WEAPON = (damage: WeaponProfile["damage"], power: number, reach: number, speed: number,
  intimidation: number, disarmDifficulty: number, noise = .2): WeaponProfile =>
  ({ damage, power, reach, speed, intimidation, disarmDifficulty, noise });

export const ITEM_DEFS_V4: ItemDefV4[] = [
  { id: "spoon", name: "Spoon", size: "tiny", legality: "controlled", concealment: .82, baseValue: 2, controlled: true, stackView: true, tags: ["utensil", "dig-tool"], weapon: WEAPON("puncture", .08, .45, 1.1, .02, .15, .05) },
  { id: "tray", name: "Meal tray", size: "large", legality: "legal", concealment: .05, baseValue: 18, controlled: true, stackView: true, tags: ["utensil", "shield"] },
  { id: "book", name: "Book", size: "large", legality: "legal", concealment: .15, baseValue: 10, controlled: true, stackView: true, tags: ["library", "hide-small"] },
  { id: "frozen-meal", name: "Frozen meal", size: "small", legality: "legal", concealment: .2, baseValue: 5, controlled: false, stackView: true, tags: ["food"] },
  { id: "staff-key", name: "Staff key", size: "tiny", legality: "contraband", concealment: .88, baseValue: 150, controlled: true, stackView: false, tags: ["key", "staff-access"] },
  { id: "guard-key", name: "Guard key", size: "tiny", legality: "contraband", concealment: .88, baseValue: 300, controlled: true, stackView: false, tags: ["key", "guard-access"] },
  { id: "radio", name: "Guard radio", size: "small", legality: "contraband", concealment: .55, baseValue: 250, controlled: true, stackView: false, tags: ["radio", "security"] },
  { id: "staff-uniform", name: "Staff uniform", size: "large", legality: "contraband", concealment: .18, baseValue: 180, controlled: true, stackView: false, tags: ["uniform", "disguise"] },
  { id: "prisoner-uniform", name: "Prisoner uniform", size: "large", legality: "legal", concealment: .12, baseValue: 80, controlled: true, stackView: false, tags: ["uniform", "laundry"] },
  { id: "bedding", name: "Bedding set", size: "large", legality: "legal", concealment: .08, baseValue: 45, controlled: true, stackView: false, tags: ["bedding", "laundry", "cloth"] },
  { id: "cutter", name: "Bolt cutters", size: "large", legality: "contraband", concealment: .15, baseValue: 160, controlled: true, stackView: false, tags: ["cut-tool", "work-tool"], weapon: WEAPON("blunt", .28, 1.0, .65, .32, .65, .28) },
  { id: "file", name: "Metal file", size: "small", legality: "contraband", concealment: .65, baseValue: 35, controlled: true, stackView: false, tags: ["cut-tool", "work-tool"], weapon: WEAPON("puncture", .22, .55, .9, .2, .3, .08) },
  { id: "hacksaw-blade", name: "Hacksaw blade", size: "small", legality: "contraband", concealment: .76, baseValue: 45, controlled: true, stackView: false, tags: ["cut-tool", "work-tool"], weapon: WEAPON("cut", .28, .55, .85, .28, .22, .08) },
  { id: "trowel", name: "Garden trowel", size: "small", legality: "controlled", concealment: .52, baseValue: 25, controlled: true, stackView: false, tags: ["dig-tool", "garden"], weapon: WEAPON("puncture", .30, .65, .8, .3, .35, .12) },
  { id: "shovel", name: "Shovel", size: "large", legality: "controlled", concealment: .08, baseValue: 60, controlled: true, stackView: false, tags: ["dig-tool", "garden"], weapon: WEAPON("blunt", .48, 1.4, .58, .5, .7, .35) },
  { id: "pruning-shears", name: "Pruning shears", size: "small", legality: "controlled", concealment: .55, baseValue: 45, controlled: true, stackView: false, tags: ["cut-tool", "garden"], weapon: WEAPON("cut", .38, .65, .82, .4, .38, .12) },
  { id: "kitchen-knife", name: "Kitchen knife", size: "small", legality: "contraband", concealment: .62, baseValue: 55, controlled: true, stackView: false, tags: ["knife", "kitchen"], weapon: WEAPON("cut", .58, .72, 1.0, .65, .35, .14) },
  { id: "shiv", name: "Improvised shiv", size: "tiny", legality: "contraband", concealment: .9, baseValue: 80, controlled: false, stackView: false, tags: ["crafted", "weapon"], weapon: WEAPON("puncture", .54, .48, 1.15, .68, .18, .06) },
  { id: "club", name: "Improvised club", size: "large", legality: "contraband", concealment: .12, baseValue: 45, controlled: false, stackView: false, tags: ["crafted", "weapon"], weapon: WEAPON("blunt", .46, 1.1, .72, .48, .55, .25) },
  { id: "baton", name: "Baton", size: "small", legality: "contraband", concealment: .42, baseValue: 120, controlled: true, stackView: false, tags: ["security", "weapon"], weapon: WEAPON("blunt", .42, .92, .95, .6, .7, .2) },
  { id: "taser", name: "Taser", size: "small", legality: "contraband", concealment: .48, baseValue: 450, controlled: true, stackView: false, tags: ["security", "weapon"], weapon: WEAPON("shock", .36, 2.5, .75, .7, .6, .45) },
  { id: "pepper-spray", name: "Pepper spray", size: "tiny", legality: "contraband", concealment: .7, baseValue: 80, controlled: true, stackView: false, tags: ["security", "weapon"], weapon: WEAPON("irritant", .18, 2.2, 1.05, .5, .35, .25) },
  { id: "restraints", name: "Restraints", size: "small", legality: "contraband", concealment: .55, baseValue: 55, controlled: true, stackView: false, tags: ["security", "restraint"] },
  { id: "body-armor", name: "Body armor", size: "large", legality: "contraband", concealment: .02, baseValue: 500, controlled: true, stackView: false, tags: ["security", "armor"] },
  { id: "riot-gear", name: "Riot gear", size: "large", legality: "contraband", concealment: .01, baseValue: 700, controlled: true, stackView: false, tags: ["security", "armor", "riot"] },
  { id: "less-lethal-launcher", name: "Less-lethal launcher", size: "large", legality: "contraband", concealment: .04, baseValue: 650, controlled: true, stackView: false, tags: ["security", "weapon"], weapon: WEAPON("blunt", .46, 20, .5, .88, .82, .9) },
  { id: "service-pistol", name: "Service pistol", size: "small", legality: "contraband", concealment: .48, baseValue: 800, controlled: true, stackView: false, tags: ["firearm", "security"], weapon: { ...WEAPON("gunshot", .82, 18, .72, 1, .78, 1), ammunition: "pistol-magazine" } },
  { id: "sniper-rifle", name: "Sniper rifle", size: "large", legality: "contraband", concealment: .02, baseValue: 1500, controlled: true, stackView: false, tags: ["firearm", "security"], weapon: { ...WEAPON("gunshot", .98, 60, .38, 1, .9, 1), ammunition: "rifle-magazine" } },
  { id: "pistol-magazine", name: "Pistol magazine", size: "small", legality: "contraband", concealment: .65, baseValue: 120, controlled: true, stackView: false, tags: ["ammunition"] },
  { id: "rifle-magazine", name: "Rifle magazine", size: "small", legality: "contraband", concealment: .58, baseValue: 180, controlled: true, stackView: false, tags: ["ammunition"] },
  { id: "cash-1", name: "$1 note", size: "tiny", legality: "legal", concealment: .97, baseValue: 1, controlled: false, stackView: true, tags: ["cash"] },
  { id: "cash-5", name: "$5 note", size: "tiny", legality: "legal", concealment: .97, baseValue: 5, controlled: false, stackView: true, tags: ["cash"] },
  { id: "cash-10", name: "$10 note", size: "tiny", legality: "legal", concealment: .97, baseValue: 10, controlled: false, stackView: true, tags: ["cash"] },
  { id: "cash-20", name: "$20 note", size: "tiny", legality: "legal", concealment: .97, baseValue: 20, controlled: false, stackView: true, tags: ["cash"] },
  { id: "cash-bag", name: "Sealed cash bag", size: "large", legality: "controlled", concealment: .12, baseValue: 5, controlled: true, stackView: false, tags: ["cash-container", "security"] },
  { id: "tobacco", name: "Tobacco", size: "tiny", legality: "contraband", concealment: .9, baseValue: 12, controlled: false, stackView: true, tags: ["substance", "tobacco"] },
  { id: "alcohol", name: "Hooch", size: "small", legality: "contraband", concealment: .62, baseValue: 22, controlled: false, stackView: true, tags: ["substance", "alcohol"] },
  { id: "drugs", name: "Illicit drugs", size: "tiny", legality: "contraband", concealment: .94, baseValue: 55, controlled: false, stackView: true, tags: ["substance", "drug"] },
  { id: "phone", name: "Mobile phone", size: "small", legality: "contraband", concealment: .72, baseValue: 240, controlled: false, stackView: false, tags: ["communication"] },
  { id: "bandage", name: "Bandage", size: "tiny", legality: "controlled", concealment: .82, baseValue: 8, controlled: true, stackView: true, tags: ["medical"] },
  { id: "medicine", name: "Medicine", size: "tiny", legality: "controlled", concealment: .9, baseValue: 16, controlled: true, stackView: true, tags: ["medical", "drug"] },
  { id: "splint", name: "Splint", size: "small", legality: "controlled", concealment: .35, baseValue: 20, controlled: true, stackView: true, tags: ["medical"] },
  { id: "overdose-kit", name: "Overdose kit", size: "small", legality: "controlled", concealment: .5, baseValue: 60, controlled: true, stackView: true, tags: ["medical"] },
  { id: "cloth", name: "Cloth", size: "small", legality: "legal", concealment: .55, baseValue: 6, controlled: false, stackView: true, tags: ["component", "laundry"] },
  { id: "metal-scrap", name: "Metal scrap", size: "small", legality: "controlled", concealment: .48, baseValue: 8, controlled: true, stackView: true, tags: ["component", "metal"] },
  { id: "wood-scrap", name: "Wood scrap", size: "small", legality: "controlled", concealment: .35, baseValue: 5, controlled: true, stackView: true, tags: ["component", "wood"] },
  { id: "wire", name: "Wire", size: "tiny", legality: "controlled", concealment: .83, baseValue: 7, controlled: true, stackView: true, tags: ["component", "metal"] },
  { id: "paper", name: "Paper", size: "small", legality: "legal", concealment: .62, baseValue: 2, controlled: false, stackView: true, tags: ["component", "printing"] },
  { id: "mail-letter", name: "Sealed letter", size: "small", legality: "legal", concealment: .68, baseValue: 1, controlled: false, stackView: false, tags: ["mail", "container"] },
  { id: "needle", name: "Sewing needle", size: "tiny", legality: "controlled", concealment: .94, baseValue: 6, controlled: true, stackView: false, tags: ["work-tool", "tailoring"], weapon: WEAPON("puncture", .19, .3, 1.2, .15, .08, .02) },
  { id: "hammer", name: "Workshop hammer", size: "small", legality: "controlled", concealment: .38, baseValue: 38, controlled: true, stackView: false, tags: ["work-tool", "wood"], weapon: WEAPON("blunt", .5, .72, .72, .52, .5, .3) },
  { id: "screwdriver", name: "Screwdriver", size: "small", legality: "controlled", concealment: .74, baseValue: 25, controlled: true, stackView: false, tags: ["work-tool", "maintenance"], weapon: WEAPON("puncture", .36, .58, .95, .38, .26, .08) },
  { id: "rope", name: "Rope", size: "large", legality: "controlled", concealment: .2, baseValue: 28, controlled: true, stackView: false, tags: ["escape-tool", "grounds"] },
  { id: "chemical", name: "Cleaning chemical", size: "small", legality: "controlled", concealment: .48, baseValue: 14, controlled: true, stackView: true, tags: ["janitorial", "substance"] },
  { id: "fertilizer", name: "Fertilizer", size: "small", legality: "controlled", concealment: .4, baseValue: 12, controlled: true, stackView: true, tags: ["greenhouse", "component"] },
  { id: "sugar", name: "Sugar packet", size: "tiny", legality: "legal", concealment: .86, baseValue: 3, controlled: false, stackView: true, tags: ["kitchen", "hooch-component"] },
  { id: "yeast", name: "Yeast packet", size: "tiny", legality: "controlled", concealment: .88, baseValue: 4, controlled: true, stackView: true, tags: ["kitchen", "hooch-component"] },
  { id: "ink", name: "Printing ink", size: "small", legality: "controlled", concealment: .55, baseValue: 9, controlled: true, stackView: true, tags: ["printing", "component"] },
  { id: "produce-crate", name: "Produce crate", size: "large", legality: "legal", concealment: .05, baseValue: 40, controlled: false, stackView: false, tags: ["contract-output", "greenhouse"] },
  { id: "laundry-bundle", name: "Clean laundry bundle", size: "large", legality: "legal", concealment: .08, baseValue: 32, controlled: false, stackView: false, tags: ["service-output", "laundry"] },
  { id: "sorted-mail", name: "Sorted mail sack", size: "large", legality: "legal", concealment: .22, baseValue: 28, controlled: false, stackView: false, tags: ["service-output", "mail"] },
  { id: "recycled-goods", name: "Recycled goods", size: "large", legality: "legal", concealment: .08, baseValue: 45, controlled: false, stackView: false, tags: ["contract-output", "recycling"] },
  { id: "wood-goods", name: "Wooden contract goods", size: "large", legality: "legal", concealment: .04, baseValue: 85, controlled: false, stackView: false, tags: ["contract-output", "wood"] },
  { id: "metal-goods", name: "Metal contract goods", size: "large", legality: "legal", concealment: .04, baseValue: 120, controlled: false, stackView: false, tags: ["contract-output", "metal"] },
  { id: "tailored-goods", name: "Tailored contract goods", size: "large", legality: "legal", concealment: .1, baseValue: 70, controlled: false, stackView: false, tags: ["contract-output", "tailoring"] },
  { id: "printed-goods", name: "Printed contract goods", size: "large", legality: "legal", concealment: .1, baseValue: 65, controlled: false, stackView: false, tags: ["contract-output", "printing"] },
  { id: "shop-soap", name: "Soap", size: "small", legality: "legal", concealment: .55, baseValue: 3, controlled: false, stackView: true, tags: ["shop", "hygiene"] },
  { id: "shop-snack", name: "Snack", size: "small", legality: "legal", concealment: .65, baseValue: 4, controlled: false, stackView: true, tags: ["shop", "food"] },
  { id: "shop-drink", name: "Coffee / tea", size: "small", legality: "legal", concealment: .55, baseValue: 3, controlled: false, stackView: true, tags: ["shop", "comfort"] },
  { id: "shop-stationery", name: "Stationery", size: "small", legality: "legal", concealment: .7, baseValue: 2, controlled: false, stackView: true, tags: ["shop", "mail"] },
  { id: "shop-envelope", name: "Stamped envelope", size: "small", legality: "legal", concealment: .75, baseValue: 3, controlled: false, stackView: true, tags: ["shop", "mail"] },
  { id: "shop-magazine", name: "Magazine", size: "large", legality: "legal", concealment: .2, baseValue: 5, controlled: false, stackView: true, tags: ["shop", "recreation"] },
  { id: "shop-cards", name: "Playing cards", size: "small", legality: "legal", concealment: .65, baseValue: 6, controlled: false, stackView: true, tags: ["shop", "recreation"] },
  { id: "shop-toiletries", name: "Toiletries", size: "small", legality: "legal", concealment: .5, baseValue: 5, controlled: false, stackView: true, tags: ["shop", "hygiene"] },
];

const DEF_BY_ID = new Map(ITEM_DEFS_V4.map((d) => [d.id, d]));

export function itemDefV4(id: string): ItemDefV4 {
  const def = DEF_BY_ID.get(id);
  if (!def) throw new Error(`Unknown physical item definition: ${id}`);
  return def;
}

export class ItemSystem {
  readonly items = new Map<number, ItemInstance>();
  readonly containers = new Map<string, ContainerDef>();
  private nextItemId = 1;

  create(defId: string, time: number, options: Partial<ItemInstance> = {}): ItemInstance {
    const def = itemDefV4(defId);
    const id = this.nextItemId++;
    const item: ItemInstance = {
      id, defId, condition: 1, quality: 1, locationKind: "world",
      x: 0, z: 0, containerId: "", packageId: -1, ownerId: -1,
      issuedTo: -1, hidden: false, dirty: false,
      denomination: def.tags.includes("cash") ? def.baseValue : 0,
      contents: [], createdAt: time, history: [], ...options,
    };
    this.items.set(id, item);
    this.record(item, time, "created", -1, this.locationName(item));
    if (item.locationKind === "container" && item.containerId) this.attach(item, item.containerId);
    return item;
  }

  createMany(defId: string, count: number, time: number, options: Partial<ItemInstance> = {}): number[] {
    const result: number[] = [];
    for (let i = 0; i < count; i++) result.push(this.create(defId, time, options).id);
    return result;
  }

  ensureContainer(row: Omit<ContainerDef, "itemIds"> & { itemIds?: number[] }): ContainerDef {
    let container = this.containers.get(row.id);
    if (container) {
      Object.assign(container, row, { itemIds: container.itemIds });
      return container;
    }
    container = { ...row, itemIds: [...(row.itemIds ?? [])] };
    this.containers.set(container.id, container);
    return container;
  }

  moveToContainer(itemId: number, containerId: string, time: number, actorId = -1, hidden = false): boolean {
    const item = this.items.get(itemId), container = this.containers.get(containerId);
    if (!item || !container || item.locationKind === "destroyed") return false;
    if (!container.itemIds.includes(itemId) && container.itemIds.length >= container.capacity) return false;
    this.detach(item);
    item.locationKind = "container"; item.containerId = containerId; item.packageId = -1;
    item.x = container.x; item.z = container.z; item.hidden = hidden;
    this.attach(item, containerId);
    this.record(item, time, hidden ? "hidden" : "stored", actorId, containerId);
    return true;
  }

  moveToWorld(itemId: number, x: number, z: number, time: number, actorId = -1): boolean {
    const item = this.items.get(itemId);
    if (!item || item.locationKind === "destroyed") return false;
    this.detach(item);
    item.locationKind = "world"; item.containerId = ""; item.packageId = -1;
    item.x = x; item.z = z; item.hidden = false;
    this.record(item, time, "placed", actorId, `world:${x.toFixed(1)},${z.toFixed(1)}`);
    return true;
  }

  moveToPackage(itemId: number, packageId: number, time: number): boolean {
    const item = this.items.get(itemId);
    if (!item || item.locationKind === "destroyed") return false;
    this.detach(item);
    item.locationKind = "package"; item.packageId = packageId; item.containerId = "";
    item.hidden = false;
    this.record(item, time, "packaged", -1, `package:${packageId}`);
    return true;
  }

  issue(itemId: number, agentId: number, time: number): boolean {
    const item = this.items.get(itemId);
    if (!item) return false;
    item.issuedTo = agentId; item.ownerId = agentId;
    this.record(item, time, "issued", agentId, this.locationName(item));
    return true;
  }

  destroy(itemId: number, time: number, actorId = -1, reason = "consumed"): boolean {
    const item = this.items.get(itemId);
    if (!item || item.locationKind === "destroyed") return false;
    this.detach(item); item.locationKind = "destroyed"; item.containerId = ""; item.packageId = -1;
    this.record(item, time, reason, actorId, "destroyed");
    return true;
  }

  itemsIn(containerId: string): ItemInstance[] {
    const container = this.containers.get(containerId);
    return container ? container.itemIds.map((id) => this.items.get(id)).filter((x): x is ItemInstance => !!x) : [];
  }

  count(defId: string, predicate: (item: ItemInstance) => boolean = () => true): number {
    let result = 0;
    for (const item of this.items.values()) if (item.defId === defId && item.locationKind !== "destroyed" && predicate(item)) result++;
    return result;
  }

  cashValue(containerId: string): number {
    return this.itemsIn(containerId).reduce((sum, item) => sum + item.denomination, 0);
  }

  controlledDiscrepancies(): ControlledDiscrepancy[] {
    const result: ControlledDiscrepancy[] = [];
    for (const item of this.items.values()) {
      const def = itemDefV4(item.defId);
      if (!def.controlled || item.issuedTo < 0 || item.locationKind === "destroyed") continue;
      const expected = `agent:${item.issuedTo}:`;
      if (item.locationKind === "container" && item.containerId.startsWith(expected)) continue;
      result.push({ defId: item.defId, itemId: item.id, issuedTo: item.issuedTo, lastLocation: this.locationName(item) });
    }
    return result;
  }

  saveData() {
    return {
      nextItemId: this.nextItemId,
      items: [...this.items.values()].map((item) => ({ ...item, contents: [...item.contents], history: item.history.map((h) => ({ ...h })) })),
      containers: [...this.containers.values()].map((container) => ({ ...container, itemIds: [...container.itemIds], tags: [...container.tags] })),
    };
  }

  loadData(data: Partial<ReturnType<ItemSystem["saveData"]>>): void {
    this.items.clear(); this.containers.clear();
    this.nextItemId = data.nextItemId ?? 1;
    for (const row of data.items ?? []) this.items.set(row.id, { ...row, contents: [...row.contents], history: row.history.map((h) => ({ ...h })) });
    for (const row of data.containers ?? []) this.containers.set(row.id, { ...row, itemIds: [...row.itemIds], tags: [...row.tags] });
  }

  private attach(item: ItemInstance, containerId: string): void {
    const container = this.containers.get(containerId);
    if (container && !container.itemIds.includes(item.id)) container.itemIds.push(item.id);
  }

  private detach(item: ItemInstance): void {
    if (!item.containerId) return;
    const container = this.containers.get(item.containerId);
    if (!container) return;
    const at = container.itemIds.indexOf(item.id);
    if (at >= 0) container.itemIds.splice(at, 1);
  }

  private record(item: ItemInstance, time: number, action: string, actorId: number, location: string): void {
    item.history.push({ time, action, actorId, location });
    if (item.history.length > 24) item.history.splice(0, item.history.length - 24);
  }

  private locationName(item: ItemInstance): string {
    if (item.locationKind === "container") return item.containerId;
    if (item.locationKind === "package") return `package:${item.packageId}`;
    if (item.locationKind === "world") return `world:${item.x.toFixed(1)},${item.z.toFixed(1)}`;
    return "destroyed";
  }
}
