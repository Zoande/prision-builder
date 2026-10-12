import { dayOf } from "./time.ts";
import { LogisticsSystem, type CargoPackage } from "./logistics.ts";
import { Obj, SHELF_KINDS, World } from "./world.ts";
import type { ItemSystem } from "./itemSystem.ts";

export interface KitchenSave {
  frozenMeals: number;
  cleanTrays: number;
  cleanSpoons: number;
  dirtyTrays: number;
  dirtySpoons: number;
  books: number;
  preparedSettings: number;
  borrowedBooks?: number;
  eatingSettings?: number;
  anonymousMealSetClaims?: number;
  mealSetClaims?: number[];
  spoonWashClaims?: [number, number][];
  knownFreezers: number[];
  knownServing: number[];
  knownShelves: number[];
  lastReconcileDay: number;
  cutleryLossReportedDay: number;
  washClaims: [number, number][];
}

export interface CookHaul {
  packageId: number;
  destination: number;
}

export class KitchenSystem {
  physicalItems: ItemSystem | null = null;
  frozenMeals = 0;
  cleanTrays = 0;
  cleanSpoons = 0;
  dirtyTrays = 0;
  dirtySpoons = 0;
  books = 0;
  borrowedBooks = 0;
  preparedSettings = 0;
  eatingSettings = 0;
  private readonly knownFreezers = new Set<number>();
  private readonly knownServing = new Set<number>();
  private readonly knownShelves = new Map<number, number>();
  private readonly washClaims = new Map<number, number>();
  private readonly spoonWashClaims = new Map<number, number>();
  private readonly mealSetClaims = new Set<number>();
  private anonymousMealSetClaims = 0;
  private lastReconcileDay = -1;
  private cutleryLossReportedDay = -1;
  private sinkCapacity = 0;
  readonly warnings = new Set<string>();

  readonly logistics: LogisticsSystem;
  constructor(logistics: LogisticsSystem) { this.logistics = logistics; }

  get freezerCapacity(): number { return this.knownFreezers.size * 48; }
  get placeSettingTarget(): number { return this.knownServing.size * 6; }
  get bookTarget(): number {
    let target = 0;
    for (const kind of this.knownShelves.values()) {
      if (kind === Obj.Bookshelf) target += 8;
      else if (kind === Obj.BookshelfLarge) target += 16;
      else if (kind === Obj.BookshelfTall) target += 24;
    }
    return target;
  }

  tick(worldTime: number, world: World): void {
    this.warnings.clear();
    this.discoverObjects(world);
    const day = dayOf(worldTime);
    // Restock in useful batches rather than ordering a one-meal truck after
    // every cook. At an empty kitchen the request still fills the full target;
    // ongoing replenishment waits until one quarter of a store is missing.
    const batchDeficit = (target: number, stock: number, incoming: number): number => {
      const missing = Math.max(0, target - stock - incoming);
      const minimumBatch = Math.min(target, Math.max(3, Math.ceil(target * .25)));
      return missing >= minimumBatch ? missing : 0;
    };
    this.logistics.request({
      "frozen-meal": batchDeficit(this.freezerCapacity, this.frozenMeals, this.kitchenPipeline("frozen-meal")),
      tray: batchDeficit(this.placeSettingTarget, this.totalTrays(), this.kitchenPipeline("tray")),
      spoon: batchDeficit(this.placeSettingTarget, this.totalSpoons(), this.kitchenPipeline("spoon")),
      book: batchDeficit(this.bookTarget, this.books + this.borrowedBooks, this.kitchenPipeline("book")),
    }, worldTime, true, "kitchen:restock");
    if (this.freezerCapacity === 0 && this.knownServing.size > 0) this.warnings.add("Food shortage: no freezer");
    if (this.frozenMeals <= 0 && this.knownServing.size > 0) this.warnings.add("Food shortage: no frozen meals");
    if (this.cleanTrays <= 0 && this.knownServing.size > 0) this.warnings.add("Meal service needs clean trays");
    if (this.cleanSpoons <= 0 && this.knownServing.size > 0) this.warnings.add("Meal service needs clean spoons");
    if ((this.dirtyTrays > 0 || this.dirtySpoons > 0) && world.tilesOfKind(Obj.Sink).length === 0) this.warnings.add("Dirty place settings need a sink");
    const missingSpoons = Math.max(0, this.placeSettingTarget - this.totalSpoons());
    if (missingSpoons >= Math.max(3, Math.ceil(this.placeSettingTarget * 0.15))) {
      this.warnings.add("Cutlery losses");
      if (day !== this.cutleryLossReportedDay) {
        this.cutleryLossReportedDay = day;
        this.logistics.economy.post(worldTime, "loss", 0, `${missingSpoons} institutional spoons missing`, true);
      }
    }
  }

  reserveMealSet(cookId?: number): boolean {
    if (cookId !== undefined && this.mealSetClaims.has(cookId)) return true;
    if (this.frozenMeals <= 0 || this.cleanTrays <= 0 || this.cleanSpoons <= 0) return false;
    this.frozenMeals--; this.cleanTrays--; this.cleanSpoons--;
    this.preparedSettings++;
    if (cookId === undefined) this.anonymousMealSetClaims++;
    else this.mealSetClaims.add(cookId);
    this.movePhysical("tray", "institution:kitchen-clean", "institution:kitchen-in-use", 1);
    this.movePhysical("spoon", "institution:kitchen-clean", "institution:kitchen-in-use", 1);
    const frozen = this.physicalItems?.itemsIn("institution:kitchen-clean").find((i) => i.defId === "frozen-meal");
    if (frozen) this.physicalItems!.destroy(frozen.id, 0, -1, "meal-cooked");
    return true;
  }

  hasMealSetClaim(cookId: number): boolean { return this.mealSetClaims.has(cookId); }

  releaseMealSet(cookId?: number): void {
    if (cookId !== undefined) {
      if (!this.mealSetClaims.delete(cookId)) return;
    } else if (this.anonymousMealSetClaims > 0) this.anonymousMealSetClaims--;
    this.frozenMeals++; this.cleanTrays++; this.cleanSpoons++; this.preparedSettings = Math.max(0, this.preparedSettings - 1);
    this.movePhysical("tray", "institution:kitchen-in-use", "institution:kitchen-clean", 1);
    this.movePhysical("spoon", "institution:kitchen-in-use", "institution:kitchen-clean", 1);
  }

  /** Keep a setting counted as in use after the cook delivers it to a serving table. */
  commitMealSet(cookId: number): void { this.mealSetClaims.delete(cookId); }

  mealTaken(): void {
    if (this.preparedSettings <= 0) return;
    this.preparedSettings--;
    this.eatingSettings++;
  }

  finishMeal(spoonStolen: boolean, prisonerId = -1): boolean {
    this.eatingSettings = Math.max(0, this.eatingSettings - 1);
    this.dirtyTrays++;
    if (!spoonStolen) this.dirtySpoons++;
    this.movePhysical("tray", "institution:kitchen-in-use", "institution:kitchen-dirty", 1);
    const spoon = this.physicalItems?.itemsIn("institution:kitchen-in-use").find((i) => i.defId === "spoon");
    if (spoonStolen && spoon && prisonerId >= 0) {
      this.physicalItems!.moveToContainer(spoon.id, `agent:${prisonerId}:pockets`, 0, prisonerId, true);
      return true;
    }
    if (spoon) this.physicalItems!.moveToContainer(spoon.id, "institution:kitchen-dirty", 0);
    return false;
  }

  claimWash(cookId: number): number {
    if (this.washClaims.has(cookId) || this.spoonWashClaims.has(cookId))
      return Math.max(this.washClaims.get(cookId) ?? 0, this.spoonWashClaims.get(cookId) ?? 0);
    const occupiedTrays = [...this.washClaims.values()].reduce((sum, amount) => sum + amount, 0);
    const occupiedSpoons = [...this.spoonWashClaims.values()].reduce((sum, amount) => sum + amount, 0);
    const trays = Math.min(3, this.dirtyTrays, Math.max(0, this.sinkCapacity - occupiedTrays));
    const spoons = Math.min(3, this.dirtySpoons, Math.max(0, this.sinkCapacity - occupiedSpoons));
    if (trays <= 0 && spoons <= 0) return 0;
    this.dirtyTrays -= trays; this.dirtySpoons -= spoons;
    if (trays > 0) this.washClaims.set(cookId, trays);
    if (spoons > 0) this.spoonWashClaims.set(cookId, spoons);
    return Math.max(trays, spoons);
  }

  hasWashClaim(cookId: number): boolean { return this.washClaims.has(cookId) || this.spoonWashClaims.has(cookId); }

  finishWash(cookId: number): number {
    const trays = this.washClaims.get(cookId) ?? 0;
    const spoons = this.spoonWashClaims.get(cookId) ?? 0;
    this.washClaims.delete(cookId);
    this.spoonWashClaims.delete(cookId);
    this.cleanTrays += trays; this.cleanSpoons += spoons;
    this.movePhysical("tray", "institution:kitchen-dirty", "institution:kitchen-clean", trays);
    this.movePhysical("spoon", "institution:kitchen-dirty", "institution:kitchen-clean", spoons);
    return Math.max(trays, spoons);
  }

  releaseWash(cookId: number): void {
    const trays = this.washClaims.get(cookId) ?? 0;
    const spoons = this.spoonWashClaims.get(cookId) ?? 0;
    this.washClaims.delete(cookId);
    this.spoonWashClaims.delete(cookId);
    this.dirtyTrays += trays; this.dirtySpoons += spoons;
  }

  claimHaul(cookId: number, world: World, preferredCommodities?: readonly string[]): CookHaul | null {
    const preference = preferredCommodities && new Map(preferredCommodities.map((commodity, index) => [commodity, index]));
    const packages = this.logistics.packagesForHandler("cook")
      .filter((pkg) => !preference || preference.has(pkg.commodity))
      .sort((a, b) => (preference?.get(a.commodity) ?? 0) - (preference?.get(b.commodity) ?? 0) || a.id - b.id);
    for (const pkg of packages) {
      if (pkg.state !== "delivery" || pkg.reservedBy) continue;
      const destination = this.destination(pkg, world);
      if (destination < 0) continue;
      pkg.reservedBy = `cook:${cookId}`;
      return { packageId: pkg.id, destination };
    }
    return null;
  }

  pickUp(packageId: number, cookId: number): boolean {
    const pkg = this.logistics.packages.get(packageId);
    if (!pkg || pkg.reservedBy !== `cook:${cookId}`) return false;
    pkg.state = "carried";
    return true;
  }

  moveCarried(packageId: number, x: number, z: number): void {
    const pkg = this.logistics.packages.get(packageId);
    if (pkg?.state === "carried") { pkg.x = x; pkg.z = z; }
  }

  deliver(packageId: number, cookId: number): boolean {
    const pkg = this.logistics.packages.get(packageId);
    if (!pkg || pkg.reservedBy !== `cook:${cookId}`) return false;
    if (pkg.commodity === "frozen-meal") this.frozenMeals = Math.min(this.freezerCapacity, this.frozenMeals + pkg.quantity);
    else if (pkg.commodity === "tray") this.cleanTrays += pkg.quantity;
    else if (pkg.commodity === "spoon") this.cleanSpoons += pkg.quantity;
    else return false;
    if (this.physicalItems) for (const id of this.physicalItems.createMany(pkg.commodity, pkg.quantity, 0))
      this.physicalItems.moveToContainer(id, "institution:kitchen-clean", 0, cookId);
    this.logistics.packages.delete(pkg.id);
    return true;
  }

  borrowBook(): boolean {
    if (this.books <= 0) return false;
    this.books--;
    this.borrowedBooks++;
    return true;
  }

  returnBook(): void {
    if (this.borrowedBooks <= 0) return;
    this.borrowedBooks--;
    this.books = Math.min(Math.max(0, this.bookTarget - this.borrowedBooks), this.books + 1);
  }

  acceptBookPackage(pkg: CargoPackage): boolean {
    if (pkg.commodity !== "book") return false;
    const accepted = Math.min(pkg.quantity, Math.max(0, this.bookTarget - this.books - this.borrowedBooks));
    this.books += accepted;
    if (this.physicalItems) for (const id of this.physicalItems.createMany("book", accepted, 0))
      this.physicalItems.moveToContainer(id, "institution:library-stock", 0);
    // Keep excess stock in the export pipeline instead of leaving it reserved
    // in a workman's hands after the shelf fills during a haul.
    if (accepted < pkg.quantity) {
      pkg.quantity -= accepted;
      pkg.reservedBy = null;
      this.logistics.moveToExports(pkg.id, pkg.x, pkg.z);
    } else this.logistics.packages.delete(pkg.id);
    return true;
  }

  totalTrays(): number { return this.cleanTrays + this.dirtyTrays + this.preparedSettings + this.eatingSettings + [...this.washClaims.values()].reduce((a, b) => a + b, 0); }
  totalSpoons(): number { return this.cleanSpoons + this.dirtySpoons + this.preparedSettings + this.eatingSettings + [...this.spoonWashClaims.values()].reduce((a, b) => a + b, 0); }

  private discoverObjects(world: World): void {
    this.sinkCapacity = new Set(world.tilesOfKind(Obj.Sink).map((i) => world.anchorOf(i))).size * 12;
    const freezers = new Set(world.tilesOfKind(Obj.Freezer).map((i) => world.anchorOf(i)));
    this.knownFreezers.clear(); for (const anchor of freezers) this.knownFreezers.add(anchor);
    const serving = new Set(world.tilesOfKind(Obj.ServingTable).map((i) => world.anchorOf(i)));
    this.knownServing.clear(); for (const anchor of serving) this.knownServing.add(anchor);
    const shelves = new Map<number, number>();
    for (const kind of SHELF_KINDS) for (const i of world.tilesOfKind(kind)) {
      const anchor = world.anchorOf(i);
      shelves.set(anchor, kind);
    }
    this.knownShelves.clear(); for (const [anchor, kind] of shelves) this.knownShelves.set(anchor, kind);
  }

  private kitchenPipeline(commodity: string): number {
    let total = 0;
    for (const pkg of this.logistics.packages.values()) {
      if (pkg.commodity !== commodity) continue;
      if (pkg.state === "ordered" || pkg.state === "in-transit") total += pkg.quantity;
      else if ((pkg.state === "delivery" || pkg.state === "carried" || pkg.state === "reserved") &&
          (!pkg.reservedBy || pkg.reservedBy.startsWith("cook:") || (commodity === "book" && pkg.reservedBy.startsWith("workman:")))) total += pkg.quantity;
    }
    return total;
  }

  private destination(pkg: CargoPackage, world: World): number {
    if (pkg.commodity === "frozen-meal") {
      if (this.frozenMeals >= this.freezerCapacity) return -1;
      return world.tilesOfKind(Obj.Freezer)[0] ?? -1;
    }
    if (pkg.commodity === "tray" || pkg.commodity === "spoon") {
      return world.tilesOfKind(Obj.ServingTable)[0] ?? world.tilesOfKind(Obj.Sink)[0] ?? -1;
    }
    return -1;
  }

  private movePhysical(defId: string, from: string, to: string, amount: number): void {
    if (!this.physicalItems) return;
    for (const item of this.physicalItems.itemsIn(from).filter((i) => i.defId === defId).slice(0, amount))
      this.physicalItems.moveToContainer(item.id, to, 0);
  }

  saveData(): KitchenSave {
    return {
      frozenMeals: this.frozenMeals, cleanTrays: this.cleanTrays, cleanSpoons: this.cleanSpoons,
      dirtyTrays: this.dirtyTrays, dirtySpoons: this.dirtySpoons, books: this.books,
      preparedSettings: this.preparedSettings, eatingSettings: this.eatingSettings, borrowedBooks: this.borrowedBooks,
      anonymousMealSetClaims: this.anonymousMealSetClaims, mealSetClaims: [...this.mealSetClaims],
      knownFreezers: [...this.knownFreezers], knownServing: [...this.knownServing],
      knownShelves: [...this.knownShelves].flat(), lastReconcileDay: this.lastReconcileDay,
      washClaims: [...this.washClaims], spoonWashClaims: [...this.spoonWashClaims],
      cutleryLossReportedDay: this.cutleryLossReportedDay,
    };
  }

  loadData(data: Partial<KitchenSave>): void {
    this.frozenMeals = data.frozenMeals ?? 0; this.cleanTrays = data.cleanTrays ?? 0;
    this.cleanSpoons = data.cleanSpoons ?? 0; this.dirtyTrays = data.dirtyTrays ?? 0;
    this.dirtySpoons = data.dirtySpoons ?? 0; this.books = data.books ?? 0;
    this.preparedSettings = data.preparedSettings ?? 0;
    this.eatingSettings = data.eatingSettings ?? 0;
    this.borrowedBooks = data.borrowedBooks ?? 0;
    this.knownFreezers.clear(); for (const i of data.knownFreezers ?? []) this.knownFreezers.add(i);
    this.knownServing.clear(); for (const i of data.knownServing ?? []) this.knownServing.add(i);
    this.knownShelves.clear();
    const shelves = data.knownShelves ?? [];
    for (let i = 0; i + 1 < shelves.length; i += 2) this.knownShelves.set(shelves[i], shelves[i + 1]);
    this.lastReconcileDay = data.lastReconcileDay ?? -1;
    this.cutleryLossReportedDay = data.cutleryLossReportedDay ?? -1;
    this.washClaims.clear(); for (const [id, amount] of data.washClaims ?? []) this.washClaims.set(id, amount);
    this.spoonWashClaims.clear();
    if (data.spoonWashClaims === undefined) {
      // Pre-split saves stored one paired amount for trays and spoons.
      for (const [id, amount] of data.washClaims ?? []) this.spoonWashClaims.set(id, amount);
    } else for (const [id, amount] of data.spoonWashClaims) this.spoonWashClaims.set(id, amount);
    this.mealSetClaims.clear(); for (const id of data.mealSetClaims ?? []) this.mealSetClaims.add(id);
    this.anonymousMealSetClaims = data.anonymousMealSetClaims ?? 0;
  }
}
