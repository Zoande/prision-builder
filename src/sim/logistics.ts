import { HOUR_SECONDS, hourOf } from "./time.ts";
import { commodityDef, type HandlerRole, type Recipe } from "./commodities.ts";
import { EconomySystem } from "./economy.ts";
import { Obj, RoomType, World, type Room } from "./world.ts";

export type CargoState = "ordered" | "in-transit" | "delivery" | "reserved" | "carried" | "site" | "exports";

export interface CargoPackage {
  id: number;
  commodity: string;
  quantity: number;
  state: CargoState;
  x: number;
  z: number;
  reservedBy: string | null;
  truckId: number;
}

interface PurchaseRequest {
  id: number;
  commodity: string;
  quantity: number;
  createdAt: number;
  mandatory: boolean;
  source: string;
}

interface PurchaseDemand {
  source: string;
  commodity: string;
  quantity: number;
  createdAt: number;
  mandatory: boolean;
}

export interface Truck {
  id: number;
  kind: "inbound" | "export" | "intake";
  state: "queued" | "arriving" | "unloading" | "departing" | "blocked";
  packageIds: number[];
  externalItemIds: number[];
  x: number;
  z: number;
  timer: number;
  warning: string;
}

export interface ExternalExport { itemId: number; value: number; label: string; }

export interface StockLine {
  commodity: string;
  available: number;
  inTransit: number;
  reserved: number;
}

const CONSOLIDATE_TIME = HOUR_SECONDS / 4;
const TRUCK_CAPACITY = 12;
const PALLET_CAPACITY = 8;

export class LogisticsSystem {
  readonly packages = new Map<number, CargoPackage>();
  readonly trucks: Truck[] = [];
  readonly externalExports = new Map<number, ExternalExport>();
  private readonly collectedExternal: number[] = [];
  private readonly requests: PurchaseRequest[] = [];
  private readonly demands = new Map<string, PurchaseDemand>();
  private nextPackageId = 1;
  private nextRequestId = 1;
  private nextTruckId = 1;
  private lastExportDay = -1;
  readonly warnings = new Set<string>();

  readonly economy: EconomySystem;
  constructor(economy: EconomySystem) { this.economy = economy; }

  quantity(commodity: string, states: CargoState[] = ["delivery", "site"]): number {
    let total = 0;
    for (const pkg of this.packages.values()) {
      if (pkg.commodity === commodity && !pkg.reservedBy && states.includes(pkg.state)) total += pkg.quantity;
    }
    return total;
  }

  reserved(commodity: string): number {
    let total = 0;
    for (const pkg of this.packages.values()) {
      if (pkg.commodity === commodity && pkg.reservedBy) total += pkg.quantity;
    }
    return total;
  }

  incoming(commodity: string): number {
    let total = 0;
    for (const pkg of this.packages.values()) {
      if (pkg.commodity === commodity && (pkg.state === "ordered" || pkg.state === "in-transit")) total += pkg.quantity;
    }
    for (const req of this.requests) if (req.commodity === commodity) total += req.quantity;
    return total;
  }

  pipelineQuantity(commodity: string): number {
    let total = 0;
    for (const pkg of this.packages.values()) if (pkg.commodity === commodity && !pkg.reservedBy && pkg.state !== "exports") total += pkg.quantity;
    for (const req of this.requests) if (req.commodity === commodity) total += req.quantity;
    return total;
  }

  request(recipe: Recipe, createdAt: number, mandatory: boolean, source: string): void {
    const prior = new Map([...this.demands].filter(([, demand]) => demand.source === source));
    for (const key of [...this.demands.keys()]) if (this.demands.get(key)?.source === source) this.demands.delete(key);
    for (const [commodity, quantity] of Object.entries(recipe)) if (quantity > 0) {
      const key = `${source}::${commodity}`;
      // Periodic producers refresh their target every simulation tick. Keep a
      // continuous demand's original age so this refresh cannot indefinitely
      // reset truck consolidation; a returned demand starts a new window.
      this.demands.set(key, { source, commodity, quantity, createdAt: prior.get(key)?.createdAt ?? createdAt, mandatory });
    }
    this.rebuildRequests();
  }

  cancelSource(source: string): void {
    for (const key of [...this.demands.keys()]) if (this.demands.get(key)?.source === source) this.demands.delete(key);
    this.rebuildRequests();
  }

  /** Reserve exact units. Partial packages are split so unrelated orders do not
   *  steal one another's stock. */
  reserve(recipe: Recipe, owner: string): boolean {
    for (const [commodity, amount] of Object.entries(recipe)) {
      // quantity() excludes every package with an owner reservation, including
      // packages already staged at a construction site.
      if (this.quantity(commodity) < amount) return false;
    }
    for (const [commodity, amount] of Object.entries(recipe)) {
      let left = amount;
      for (const pkg of [...this.packages.values()]) {
        if (left <= 0) break;
        if (pkg.commodity !== commodity || pkg.reservedBy || (pkg.state !== "delivery" && pkg.state !== "site")) continue;
        if (pkg.quantity > left) {
          const split: CargoPackage = {
            ...pkg, id: this.nextPackageId++, quantity: left, reservedBy: owner, state: "reserved",
          };
          pkg.quantity -= left;
          this.packages.set(split.id, split);
          left = 0;
        } else {
          pkg.reservedBy = owner;
          pkg.state = "reserved";
          left -= pkg.quantity;
        }
      }
    }
    return true;
  }

  reserveBundle(recipe: Recipe, owner: string, near?: { x: number; z: number }): CargoPackage | null {
    for (const [commodity, amount] of Object.entries(recipe)) {
      if (amount <= 0) continue;
      const candidates = [...this.packages.values()].filter((candidate) =>
        candidate.commodity === commodity && !candidate.reservedBy &&
        (candidate.state === "delivery" || candidate.state === "site"));
      if (near) candidates.sort((a, b) =>
        Math.abs(a.x - near.x) + Math.abs(a.z - near.z) - Math.abs(b.x - near.x) - Math.abs(b.z - near.z) || a.id - b.id);
      const pkg = candidates[0];
      if (!pkg) continue;
      const take = Math.min(amount, commodityDef(commodity).packageSize, pkg.quantity);
      if (take < pkg.quantity) {
        pkg.quantity -= take;
        const split: CargoPackage = { ...pkg, id: this.nextPackageId++, quantity: take, reservedBy: owner, state: "reserved" };
        this.packages.set(split.id, split);
        return split;
      }
      pkg.reservedBy = owner; pkg.state = "reserved";
      return pkg;
    }
    return null;
  }

  carry(packageId: number, owner: string, x: number, z: number): boolean {
    const pkg = this.packages.get(packageId);
    if (!pkg || pkg.reservedBy !== owner) return false;
    pkg.state = "carried"; pkg.x = x; pkg.z = z;
    return true;
  }

  placeAtSite(packageId: number, owner: string, x: number, z: number): CargoPackage | null {
    const pkg = this.packages.get(packageId);
    if (!pkg || pkg.reservedBy !== owner) return null;
    pkg.state = "site"; pkg.x = x; pkg.z = z;
    return pkg;
  }

  /** Keep a target's exact recipe reserved and leave the rest of a physically
   * delivered bulk package available for nearby work. */
  retainAtSite(packageId: number, owner: string, quantity: number): CargoPackage | null {
    const pkg = this.packages.get(packageId);
    if (!pkg || pkg.reservedBy !== owner || pkg.state !== "site" || quantity <= 0) return null;
    const retained = Math.min(quantity, pkg.quantity);
    if (pkg.quantity > retained) {
      const remainder: CargoPackage = { ...pkg, id: this.nextPackageId++, quantity: pkg.quantity - retained, reservedBy: null };
      this.packages.set(remainder.id, remainder);
      pkg.quantity = retained;
    }
    return pkg;
  }

  release(owner: string): void {
    for (const pkg of this.packages.values()) {
      if (pkg.reservedBy !== owner) continue;
      pkg.reservedBy = null;
      if (pkg.state !== "site" && pkg.state !== "exports") pkg.state = "delivery";
    }
  }

  returnToStock(owner: string): void {
    for (const pkg of this.packages.values()) {
      if (pkg.reservedBy !== owner) continue;
      pkg.reservedBy = null;
      pkg.state = "delivery";
    }
  }

  consume(owner: string): void {
    for (const pkg of [...this.packages.values()]) {
      if (pkg.reservedBy === owner) this.packages.delete(pkg.id);
    }
  }

  addSalvage(commodity: string, quantity: number, x: number, z: number): void {
    if (quantity <= 0) return;
    const pkgSize = commodityDef(commodity).packageSize;
    let left = quantity;
    while (left > 0) {
      const take = Math.min(pkgSize, left);
      const id = this.nextPackageId++;
      this.packages.set(id, {
        id, commodity, quantity: take, state: "site", x, z, reservedBy: null, truckId: -1,
      });
      left -= take;
    }
  }

  moveToExports(packageId: number, x: number, z: number): boolean {
    const pkg = this.packages.get(packageId);
    if (!pkg || pkg.reservedBy) return false;
    pkg.state = "exports";
    pkg.x = x; pkg.z = z;
    return true;
  }

  registerExternalExport(itemId: number, value: number, label: string): void {
    if (!this.externalExports.has(itemId)) this.externalExports.set(itemId, { itemId, value: Math.max(0, value), label });
  }

  takeCollectedExternal(): number[] { return this.collectedExternal.splice(0); }

  packagesForHandler(role: HandlerRole): CargoPackage[] {
    return [...this.packages.values()].filter((p) => commodityDef(p.commodity).handler === role);
  }

  tick(dt: number, worldTime: number, world: World): void {
    this.warnings.clear();
    this.dispatchPurchases(worldTime);
    const yards = this.selectedRooms(world, RoomType.Delivery);
    const yard = yards.sort((a, b) => this.freePalletSlots(world, b) - this.freePalletSlots(world, a))[0] ?? null;
    const slots = yard ? this.freePalletSlots(world, yard) : 0;
    if (!yard) this.warnings.add("No valid Delivery Yard");

    let availableSlots = slots;
    for (const truck of this.trucks) {
      truck.timer -= dt;
      if (truck.state === "queued") {
        const ahead = this.trucks.some((t) => t.id < truck.id && t.state !== "departing");
        if (!ahead) { truck.state = "arriving"; truck.timer = 6; }
      } else if (truck.state === "arriving" && truck.timer <= 0) {
        truck.state = "unloading"; truck.timer = 0;
      } else if (truck.state === "unloading" && truck.timer <= 0) {
        if (!yard) {
          truck.state = "blocked"; truck.warning = "Waiting for a valid Delivery Yard";
        } else if (truck.packageIds.length > 0 && availableSlots <= 0) {
          truck.state = "blocked"; truck.warning = "Delivery pallets are full";
          this.warnings.add("Delivery pallets are full");
        } else if (truck.packageIds.length > 0) {
          const packageId = truck.packageIds.shift()!;
          const pkg = this.packages.get(packageId)!;
          const anchor = this.palletAnchor(world, yard);
          pkg.state = "delivery"; pkg.truckId = -1;
          pkg.x = anchor % world.size; pkg.z = (anchor / world.size) | 0;
          availableSlots--; truck.timer = 0.8;
        } else {
          this.loadExports(truck, world, yard);
          truck.state = "departing"; truck.timer = 6;
        }
      } else if (truck.state === "blocked") {
        if (yard && (truck.packageIds.length === 0 || availableSlots > 0)) {
          truck.state = "unloading"; truck.warning = ""; truck.timer = 0;
        } else this.warnings.add(truck.warning || "Inbound truck is blocked");
      }
      if (truck.state === "arriving" || truck.state === "departing") {
        truck.z += dt * 64;
        if (truck.state === "arriving") truck.z = Math.min(375, truck.z);
      }
    }
    for (let i = this.trucks.length - 1; i >= 0; i--) {
      const truck = this.trucks[i];
      if (truck.state !== "departing" || truck.timer > 0) continue;
      this.creditExports(truck, worldTime);
      this.trucks.splice(i, 1);
    }

    const day = Math.floor(worldTime / (HOUR_SECONDS * 24));
    if (Math.floor(hourOf(worldTime)) === 16 && this.lastExportDay !== day && this.exportQuantity() > 0 && !this.trucks.some((t) => t.kind === "inbound")) {
      this.lastExportDay = day;
      this.economy.post(worldTime, "fee", -25, "Export collection truck", true);
      this.trucks.push({
        id: this.nextTruckId++, kind: "export", state: "queued", packageIds: [],
        externalItemIds: [],
        x: 374.5, z: -8, timer: 0, warning: "",
      });
    }
  }

  stockLines(): StockLine[] {
    const ids = new Set<string>();
    for (const pkg of this.packages.values()) ids.add(pkg.commodity);
    for (const req of this.requests) ids.add(req.commodity);
    return [...ids].sort().map((commodity) => ({
      commodity,
      available: this.quantity(commodity),
      inTransit: this.incoming(commodity),
      reserved: this.reserved(commodity),
    }));
  }

  exportQuantity(): number {
    let result = this.externalExports.size;
    for (const pkg of this.packages.values()) if (pkg.state === "exports") result += pkg.quantity;
    return result;
  }

  expectedExportCredit(): number {
    let result = [...this.externalExports.values()].reduce((sum, row) => sum + row.value, 0);
    for (const pkg of this.packages.values()) {
      if (pkg.state === "exports") result += commodityDef(pkg.commodity).exportValue * pkg.quantity;
    }
    return result;
  }

  private dispatchPurchases(worldTime: number): void {
    const allReady = this.requests.filter((r) => worldTime - r.createdAt >= CONSOLIDATE_TIME);
    if (allReady.length === 0) return;
    // Mandatory food/replacement demand may enter debt; discretionary
    // construction never piggybacks on that authority.
    const hasMandatory = allReady.some((r) => r.mandatory);
    const ready = hasMandatory ? allReady.filter((r) => r.mandatory) : allReady;
    const mandatory = ready.some((r) => r.mandatory);
    const total = ready.reduce((sum, r) => sum + commodityDef(r.commodity).price * r.quantity, 0);
    const packageCount = ready.reduce((sum, r) => sum + Math.ceil(r.quantity / commodityDef(r.commodity).packageSize), 0);
    const truckCount = Math.ceil(packageCount / TRUCK_CAPACITY);
    const charge = total + truckCount * 50;
    if (!this.economy.post(worldTime, "purchase", -charge, `Purchased ${packageCount} package${packageCount === 1 ? "" : "s"}`, mandatory)) {
      this.warnings.add("Insufficient cash for construction purchases");
      return;
    }
    const readyIds = new Set(ready.map((r) => r.id));
    for (let i = this.requests.length - 1; i >= 0; i--) if (readyIds.has(this.requests[i].id)) this.requests.splice(i, 1);
    // A demand is a snapshot of what its source needs now, not a standing
    // stocking target. Once that snapshot has been converted to physical
    // packages, those inbound packages satisfy the other live sources. Keep
    // the snapshot around after its packages are later consumed would
    // resurrect old setup orders on the next rebuild (for example, a serving
    // table's initial cutlery order after a daily replacement request).
    for (const req of ready) this.demands.delete(`${req.source}::${req.commodity}`);
    const packageIds: number[] = [];
    for (const req of ready) {
      let left = req.quantity;
      const size = commodityDef(req.commodity).packageSize;
      while (left > 0) {
        const quantity = Math.min(size, left);
        const id = this.nextPackageId++;
        this.packages.set(id, {
          id, commodity: req.commodity, quantity, state: "in-transit",
          x: 374.5, z: -8, reservedBy: null, truckId: -1,
        });
        packageIds.push(id); left -= quantity;
      }
    }
    for (let offset = 0; offset < packageIds.length; offset += TRUCK_CAPACITY) {
      const ids = packageIds.slice(offset, offset + TRUCK_CAPACITY);
      const id = this.nextTruckId++;
      for (const packageId of ids) this.packages.get(packageId)!.truckId = id;
      this.trucks.push({
        id, kind: "inbound", state: "queued", packageIds: ids,
        externalItemIds: [],
        x: 374.5, z: -8 - this.trucks.length * 9, timer: 0, warning: "",
      });
    }
  }

  /** Rebuild pending orders from source demands and physical free stock. Each
   * demand is independent, while unreserved stock and in-transit packages are
   * allocated once across all sources in stable priority order. */
  private rebuildRequests(): void {
    const previous = new Map(this.requests.map((row) => [`${row.source}::${row.commodity}`, row]));
    this.requests.length = 0;
    const commodities = [...new Set([...this.demands.values()].map((row) => row.commodity))].sort();
    for (const commodity of commodities) {
      const rows = [...this.demands.entries()].filter(([, row]) => row.commodity === commodity)
        .sort((a, b) => Number(b[1].mandatory) - Number(a[1].mandatory) || a[1].createdAt - b[1].createdAt || a[1].source.localeCompare(b[1].source));
      let free = this.quantity(commodity);
      for (const pkg of this.packages.values()) if (pkg.commodity === commodity && (pkg.state === "ordered" || pkg.state === "in-transit") && !pkg.reservedBy) free += pkg.quantity;
      for (const [key, demand] of rows) {
        const satisfied = Math.min(demand.quantity, free); free -= satisfied;
        const quantity = demand.quantity - satisfied;
        if (quantity <= 0) continue;
        const prior = previous.get(key);
        this.requests.push({ id: prior?.id ?? this.nextRequestId++, commodity, quantity,
          createdAt: prior?.createdAt ?? demand.createdAt, mandatory: demand.mandatory, source: demand.source });
      }
    }
  }

  private selectedRoom(world: World, type: number): Room | null {
    return this.selectedRooms(world, type)[0] ?? null;
  }

  private selectedRooms(world: World, type: number): Room[] {
    return [...world.rooms.values()].filter((room) => room.type === type && room.valid);
  }

  private palletAnchor(world: World, room: Room): number {
    const anchors = new Set<number>();
    for (const tile of room.tiles) if (world.objKind[tile] === Obj.LoadingPallet) anchors.add(world.anchorOf(tile));
    let best = room.tiles.values().next().value ?? 0, bestCount = Infinity;
    for (const anchor of anchors) {
      let count = 0;
      for (const pkg of this.packages.values()) {
        if (!["delivery", "reserved"].includes(pkg.state)) continue;
        if (Math.floor(pkg.x) === anchor % world.size && Math.floor(pkg.z) === ((anchor / world.size) | 0)) count++;
      }
      if (count < bestCount) { best = anchor; bestCount = count; }
    }
    return best;
  }

  private freePalletSlots(world: World, room: Room): number {
    const pallets = new Set<number>();
    for (const tile of room.tiles) if (world.objKind[tile] === Obj.LoadingPallet) pallets.add(world.anchorOf(tile));
    let occupied = 0;
    for (const pkg of this.packages.values()) if ((pkg.state === "delivery" || pkg.state === "reserved") &&
        world.inBounds(Math.floor(pkg.x), Math.floor(pkg.z)) && room.tiles.has(world.idx(Math.floor(pkg.x), Math.floor(pkg.z)))) occupied++;
    return Math.max(0, pallets.size * PALLET_CAPACITY - occupied);
  }

  palletUtilization(world: World): { roomId: number; used: number; capacity: number }[] {
    return this.selectedRooms(world, RoomType.Delivery).map((room) => {
      const capacity = this.freePalletSlots(world, room);
      const pallets = new Set<number>();
      for (const tile of room.tiles) if (world.objKind[tile] === Obj.LoadingPallet) pallets.add(world.anchorOf(tile));
      const total = pallets.size * PALLET_CAPACITY;
      return { roomId: room.id, used: total - capacity, capacity: total };
    });
  }

  private loadExports(truck: Truck, world: World, delivery: Room): void {
    const exports = this.selectedRoom(world, RoomType.Exports);
    if (!exports) return;
    for (const pkg of this.packages.values()) {
      if (truck.packageIds.length >= TRUCK_CAPACITY) break;
      if (pkg.state !== "exports") continue;
      pkg.state = "in-transit"; pkg.truckId = truck.id;
      truck.packageIds.push(pkg.id);
    }
    for (const row of this.externalExports.values()) {
      if (truck.packageIds.length + truck.externalItemIds.length >= TRUCK_CAPACITY) break;
      if (!truck.externalItemIds.includes(row.itemId)) truck.externalItemIds.push(row.itemId);
    }
    const anchor = this.palletAnchor(world, delivery);
    truck.x = anchor % world.size + 0.5;
  }

  private creditExports(truck: Truck, worldTime: number): void {
    let credit = 0;
    for (const id of truck.packageIds) {
      const pkg = this.packages.get(id);
      if (!pkg) continue;
      credit += commodityDef(pkg.commodity).exportValue * pkg.quantity;
      this.packages.delete(id);
    }
    for (const itemId of truck.externalItemIds) {
      const row = this.externalExports.get(itemId); if (!row) continue;
      credit += row.value; this.externalExports.delete(itemId); this.collectedExternal.push(itemId);
    }
    if (credit > 0) this.economy.post(worldTime, "export", credit, "Exported recovered goods", true);
  }

  saveData() {
    return {
      packages: [...this.packages.values()], trucks: this.trucks,
      externalExports: [...this.externalExports.values()], collectedExternal: [...this.collectedExternal],
      requests: this.requests, demands: [...this.demands.values()], nextPackageId: this.nextPackageId,
      nextRequestId: this.nextRequestId, nextTruckId: this.nextTruckId,
      lastExportDay: this.lastExportDay,
    };
  }

  loadData(data: Partial<ReturnType<LogisticsSystem["saveData"]>>): void {
    this.packages.clear();
    for (const raw of data.packages ?? []) {
      const pkg = { ...raw };
      // Staff claims are deliberately re-evaluated after loading; otherwise a
      // missing/moved worker could hold stock forever.
      if (pkg.reservedBy || pkg.state === "carried" || pkg.state === "reserved") {
        pkg.reservedBy = null;
        pkg.state = "delivery";
      }
      this.packages.set(pkg.id, pkg);
    }
    this.trucks.length = 0; this.trucks.push(...(data.trucks ?? []).map((t) => ({ ...t, packageIds: [...t.packageIds] })));
    for (const truck of this.trucks) truck.externalItemIds = [...(truck.externalItemIds ?? [])];
    this.externalExports.clear(); for (const row of data.externalExports ?? []) this.externalExports.set(row.itemId, { ...row });
    this.collectedExternal.length = 0; this.collectedExternal.push(...(data.collectedExternal ?? []));
    this.requests.length = 0; this.requests.push(...(data.requests ?? []).map((r) => ({ ...r })));
    this.demands.clear();
    if (data.demands) for (const row of data.demands) this.demands.set(`${row.source}::${row.commodity}`, { ...row });
    else for (const row of this.requests) this.demands.set(`${row.source}::${row.commodity}`, { source: row.source,
      commodity: row.commodity, quantity: row.quantity, createdAt: row.createdAt, mandatory: row.mandatory });
    this.nextPackageId = data.nextPackageId ?? 1;
    this.nextRequestId = data.nextRequestId ?? 1;
    this.nextTruckId = data.nextTruckId ?? 1;
    this.lastExportDay = data.lastExportDay ?? -1;
  }
}
