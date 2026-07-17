import { dayOf, hourOf } from "./time.ts";
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
  preparedSettings = 0;
  private readonly knownFreezers = new Set<number>();
  private readonly knownServing = new Set<number>();
  private readonly knownShelves = new Map<number, number>();
  private readonly washClaims = new Map<number, number>();
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
    this.discoverObjects(world, worldTime);
    const day = dayOf(worldTime);
    if (Math.floor(hourOf(worldTime)) === 23 && day !== this.lastReconcileDay) {
      this.lastReconcileDay = day;
      this.logistics.request({ "frozen-meal": Math.max(0, this.freezerCapacity - this.frozenMeals) }, worldTime, true, "daily-food");
      this.logistics.request({ tray: Math.max(0, this.placeSettingTarget - this.totalTrays()) }, worldTime, true, "tray-replacement");
      this.logistics.request({ spoon: Math.max(0, this.placeSettingTarget - this.totalSpoons()) }, worldTime, true, "spoon-replacement");
      this.logistics.request({ book: Math.max(0, this.bookTarget - this.books) }, worldTime, true, "book-replacement");
    }
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

  reserveMealSet(): boolean {
    if (this.frozenMeals <= 0 || this.cleanTrays <= 0 || this.cleanSpoons <= 0) return false;
    this.frozenMeals--; this.cleanTrays--; this.cleanSpoons--;
    this.preparedSettings++;
    this.movePhysical("tray", "institution:kitchen-clean", "institution:kitchen-in-use", 1);
    this.movePhysical("spoon", "institution:kitchen-clean", "institution:kitchen-in-use", 1);
    const frozen = this.physicalItems?.itemsIn("institution:kitchen-clean").find((i) => i.defId === "frozen-meal");
    if (frozen) this.physicalItems!.destroy(frozen.id, 0, -1, "meal-cooked");
    return true;
  }

  releaseMealSet(): void {
    this.frozenMeals++; this.cleanTrays++; this.cleanSpoons++; this.preparedSettings = Math.max(0, this.preparedSettings - 1);
    this.movePhysical("tray", "institution:kitchen-in-use", "institution:kitchen-clean", 1);
    this.movePhysical("spoon", "institution:kitchen-in-use", "institution:kitchen-clean", 1);
  }

  mealTaken(): void { this.preparedSettings = Math.max(0, this.preparedSettings - 1); }

  finishMeal(spoonStolen: boolean, prisonerId = -1): boolean {
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
    if (this.washClaims.has(cookId)) return this.washClaims.get(cookId)!;
    const occupied = [...this.washClaims.values()].reduce((sum, amount) => sum + amount, 0);
    const amount = Math.min(3, this.dirtyTrays, this.dirtySpoons, Math.max(0, this.sinkCapacity - occupied));
    if (amount <= 0) return 0;
    this.dirtyTrays -= amount; this.dirtySpoons -= amount;
    this.washClaims.set(cookId, amount);
    return amount;
  }

  finishWash(cookId: number): number {
    const amount = this.washClaims.get(cookId) ?? 0;
    this.washClaims.delete(cookId);
    this.cleanTrays += amount; this.cleanSpoons += amount;
    this.movePhysical("tray", "institution:kitchen-dirty", "institution:kitchen-clean", amount);
    this.movePhysical("spoon", "institution:kitchen-dirty", "institution:kitchen-clean", amount);
    return amount;
  }

  releaseWash(cookId: number): void {
    const amount = this.washClaims.get(cookId) ?? 0;
    this.washClaims.delete(cookId);
    this.dirtyTrays += amount; this.dirtySpoons += amount;
  }

  claimHaul(cookId: number, world: World): CookHaul | null {
    for (const pkg of this.logistics.packagesForHandler("cook")) {
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
    return true;
  }

  returnBook(): void { this.books = Math.min(this.bookTarget, this.books + 1); }

  acceptBookPackage(pkg: CargoPackage): boolean {
    if (pkg.commodity !== "book" || this.bookTarget <= this.books) return false;
    this.books = Math.min(this.bookTarget, this.books + pkg.quantity);
    if (this.physicalItems) for (const id of this.physicalItems.createMany("book", pkg.quantity, 0))
      this.physicalItems.moveToContainer(id, "institution:library-stock", 0);
    this.logistics.packages.delete(pkg.id);
    return true;
  }

  totalTrays(): number { return this.cleanTrays + this.dirtyTrays + this.preparedSettings; }
  totalSpoons(): number { return this.cleanSpoons + this.dirtySpoons + this.preparedSettings; }

  private discoverObjects(world: World, worldTime: number): void {
    this.sinkCapacity = new Set(world.tilesOfKind(Obj.Sink).map((i) => world.anchorOf(i))).size * 12;
    const freezers = new Set(world.tilesOfKind(Obj.Freezer).map((i) => world.anchorOf(i)));
    this.knownFreezers.clear(); for (const anchor of freezers) this.knownFreezers.add(anchor);
    const serving = new Set(world.tilesOfKind(Obj.ServingTable).map((i) => world.anchorOf(i)));
    for (const i of world.tilesOfKind(Obj.ServingTable)) {
      const anchor = world.anchorOf(i);
      if (this.knownServing.has(anchor)) continue;
      this.logistics.request({ tray: 6, spoon: 6 }, worldTime, true, `serving-table:${anchor}`);
    }
    this.knownServing.clear(); for (const anchor of serving) this.knownServing.add(anchor);
    const shelves = new Map<number, number>();
    for (const kind of SHELF_KINDS) for (const i of world.tilesOfKind(kind)) {
      const anchor = world.anchorOf(i);
      shelves.set(anchor, kind);
      if (this.knownShelves.has(anchor)) continue;
      const capacity = kind === Obj.Bookshelf ? 8 : kind === Obj.BookshelfLarge ? 16 : 24;
      this.logistics.request({ book: capacity }, worldTime, true, `bookshelf:${anchor}`);
    }
    this.knownShelves.clear(); for (const [anchor, kind] of shelves) this.knownShelves.set(anchor, kind);
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
      preparedSettings: this.preparedSettings,
      knownFreezers: [...this.knownFreezers], knownServing: [...this.knownServing],
      knownShelves: [...this.knownShelves].flat(), lastReconcileDay: this.lastReconcileDay,
      washClaims: [...this.washClaims],
      cutleryLossReportedDay: this.cutleryLossReportedDay,
    };
  }

  loadData(data: Partial<KitchenSave>): void {
    this.frozenMeals = data.frozenMeals ?? 0; this.cleanTrays = data.cleanTrays ?? 0;
    this.cleanSpoons = data.cleanSpoons ?? 0; this.dirtyTrays = data.dirtyTrays ?? 0;
    this.dirtySpoons = data.dirtySpoons ?? 0; this.books = data.books ?? 0;
    this.preparedSettings = data.preparedSettings ?? 0;
    this.knownFreezers.clear(); for (const i of data.knownFreezers ?? []) this.knownFreezers.add(i);
    this.knownServing.clear(); for (const i of data.knownServing ?? []) this.knownServing.add(i);
    this.knownShelves.clear();
    const shelves = data.knownShelves ?? [];
    for (let i = 0; i + 1 < shelves.length; i += 2) this.knownShelves.set(shelves[i], shelves[i + 1]);
    this.lastReconcileDay = data.lastReconcileDay ?? -1;
    this.cutleryLossReportedDay = data.cutleryLossReportedDay ?? -1;
    this.washClaims.clear();
    for (const [, amount] of data.washClaims ?? []) {
      this.dirtyTrays += amount; this.dirtySpoons += amount;
    }
  }
}
