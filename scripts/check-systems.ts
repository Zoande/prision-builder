import assert from "node:assert/strict";
import { boxCommodity, ensureBoxCommodity } from "../src/sim/commodities.ts";
import { ConstructionSystem } from "../src/sim/construction.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { InfrastructureSystem } from "../src/sim/infrastructure.ts";
import { KitchenSystem } from "../src/sim/kitchen.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { OBJ_DEFS, Obj, RoomType, World } from "../src/sim/world.ts";

function setup(size = 80) {
  const world = new World(size), economy = new EconomySystem();
  const logistics = new LogisticsSystem(economy), construction = new ConstructionSystem(logistics);
  return { world, economy, logistics, construction };
}

function finishBuild(construction: ConstructionSystem, world: World, workerId: number,
  x: number, z: number, groupId: number): void {
  let guard = 0;
  while (guard++ < 8) {
    const claim = construction.claimNext(workerId, x, z, world);
    assert(claim, `construction target ${x},${z} should make progress`);
    if (claim.phase === "haul") {
      assert(construction.pickUpBundle(groupId, claim.target.id, claim.packageId, workerId, x, z));
      assert(construction.deliverBundle(groupId, claim.target.id, claim.packageId, workerId));
    } else {
      assert(construction.complete(groupId, claim.target.id, workerId, world));
      return;
    }
  }
  assert.fail(`construction target ${x},${z} did not finish`);
}

// Grants and payroll follow the current population instead of lifetime
// admissions, so escapees, deaths, and removed staff stop affecting income.
{
  const economy = new EconomySystem();
  economy.markPrisonerProcessed(); economy.markPrisonerProcessed();
  economy.setPrisonerCount(1);
  const firstHourStaff = new Map([[Obj.Guard, 1], [Obj.Doctor, 1]]);
  economy.setStaffCounts(firstHourStaff);
  assert.equal(economy.netHourly(), 12 - 8 - 14);
  economy.tick(0, firstHourStaff);
  assert.equal(economy.ledger.filter((row) => row.kind === "grant").reduce((sum, row) => sum + row.amount, 0), 12);

  economy.setPrisonerCount(0); // the only inmate escaped or died
  economy.setStaffCounts(new Map()); // both staff were removed
  assert.equal(economy.netHourly(), 0);
  economy.tick(30, new Map());
  assert.equal(economy.ledger.filter((row) => row.kind === "grant").reduce((sum, row) => sum + row.amount, 0), 12,
    "housing grants stop when no living prisoners remain");
  assert.equal(economy.ledger.filter((row) => row.kind === "wage").reduce((sum, row) => sum + row.amount, 0), -22,
    "payroll only covers staff alive at the hour boundary");

  const oldSave = economy.saveData(); delete (oldSave as Record<string, unknown>).prisonerCount;
  oldSave.processedPrisoners = 4;
  const restored = new EconomySystem(); restored.loadData(oldSave);
  assert.equal(restored.netHourly(), 48, "older saves retain their recorded prisoner count");
}

// A reservation moves cargo out of available stock. Procurement and other
// build orders must count only the remaining free cargo, exactly once.
{
  const { logistics } = setup();
  logistics.addSalvage("concrete", 2, 10, 10);
  const reserved = logistics.reserveBundle({ concrete: 1 }, "other-order");
  assert(reserved);
  assert.equal(logistics.quantity("concrete"), 1);
  assert.equal(logistics.pipelineQuantity("concrete"), 1,
    "workplace replenishment must not count construction-reserved cargo as shared stock");
  logistics.request({ concrete: 2 }, 0, false, "replenish");
  assert.equal(logistics.saveData().requests.reduce((sum, row) => sum + row.quantity, 0), 1,
    "only the single unreserved unit should be procured");
  assert(logistics.reserve({ concrete: 1 }, "second-order"),
    "the unreserved unit remains reservable while another order holds cargo");
  assert.equal(logistics.quantity("concrete"), 0);
}

// Pending purchases belong to aggregate construction demand. A later order
// cannot be starved by an earlier order's request, and cancelling the earlier
// order keeps the later order's purchase alive.
{
  const { world, logistics, construction } = setup(40);
  const earlier = construction.plan({ cat: "floor", mat: 1 }, [{ x: 8, z: 8 }], 0, 0, world)!;
  const later = construction.plan({ cat: "floor", mat: 1 }, [{ x: 9, z: 8 }], 0, 1, world)!;
  assert(earlier && later);
  const requested = () => logistics.saveData().requests
    .filter((row) => row.source === "construction:orders")
    .reduce((sum, row) => sum + row.quantity, 0);
  assert.equal(requested(), 2, "both active targets must be covered by procurement");
  assert(construction.cancelGroup(earlier.id));
  assert.equal(requested(), 1, "cancelling one target preserves procurement for the other");
}

// Independent services retain their own demand. Cancelling one source removes
// only its share of a combined shipment request and survives save restoration.
{
  const { logistics } = setup();
  logistics.request({ paper: 4 }, 0, false, "records-office");
  logistics.request({ paper: 6 }, 1, false, "workshop");
  const pending = () => logistics.saveData().requests.filter((row) => row.commodity === "paper");
  assert.equal(pending().reduce((sum, row) => sum + row.quantity, 0), 10);
  logistics.cancelSource("records-office");
  assert.equal(pending().reduce((sum, row) => sum + row.quantity, 0), 6);
  const restored = setup().logistics;
  restored.loadData(JSON.parse(JSON.stringify(logistics.saveData())));
  assert.deepEqual(restored.saveData().demands, logistics.saveData().demands);
  assert.equal(pending()[0]?.source, "workshop");
}

// Once a request is converted into a shipment, its source snapshot is retired.
// A later replacement order must not resurrect the original setup quantity.
{
  const { logistics, economy, world } = setup(500);
  new InfrastructureSystem(world).installNewGame();
  economy.cash = 100_000;
  logistics.request({ tray: 6 }, 0, true, "serving-table:42");
  logistics.tick(.1, 8, world);
  assert.equal(logistics.saveData().demands.length, 0,
    "dispatched setup demand should retire while physical cargo represents the order");
  const shipment = [...logistics.packages.values()].reduce((sum, pkg) => sum + pkg.quantity, 0);
  assert.equal(shipment, 6);
  // Simulate the kitchen accepting the shipment into its own inventory.
  for (const id of [...logistics.packages.keys()]) logistics.packages.delete(id);
  logistics.request({ tray: 2 }, 20, true, "tray-replacement");
  logistics.tick(.1, 28, world);
  assert.equal([...logistics.packages.values()].reduce((sum, pkg) => sum + pkg.quantity, 0), 2,
    "replacement demand must buy only its deficit, not repeat the retired table setup order");
}

// Exercise three daily kitchen procurement windows against live trucks and
// physical acceptance. Filled institutional stock must retire its original
// setup requests, rather than buying those quantities again each day.
{
  const { world, logistics, economy } = setup(500);
  new InfrastructureSystem(world).installNewGame();
  world.placePiece(100, 100, Obj.Freezer, 0);
  world.placePiece(104, 100, Obj.ServingTable, 0);
  world.placePiece(108, 100, Obj.Bookshelf, 0);
  const kitchen = new KitchenSystem(logistics);
  economy.cash = 1_000_000;
  kitchen.tick(690, world); // 23:00 on day one
  let time = 698;
  for (let i = 0; i < 3000; i++, time += .1) logistics.tick(.1, time, world);
  const cutleryHaul = kitchen.claimHaul(80, world, ["tray", "spoon"]);
  assert(cutleryHaul, "a cook may restrict hauling to the deficient cutlery classes");
  assert(["tray", "spoon"].includes(logistics.packages.get(cutleryHaul.packageId)!.commodity),
    "cutlery-only haul selection never claims a meal package");
  const mealHaul = kitchen.claimHaul(81, world, ["frozen-meal"]);
  assert(mealHaul); assert.equal(logistics.packages.get(mealHaul.packageId)!.commodity, "frozen-meal",
    "ordered commodity preferences select only the intended frozen-meal stock");
  logistics.release("cook:80"); logistics.release("cook:81");
  let cookId = 90;
  for (const pkg of [...logistics.packages.values()].filter((row) => row.state === "delivery")) {
    if (pkg.commodity === "book") { kitchen.acceptBookPackage(pkg); continue; }
    const haul = kitchen.claimHaul(cookId++, world);
    assert(haul, `delivered ${pkg.commodity} stock should be claimable by the kitchen`);
    assert(kitchen.pickUp(haul.packageId, cookId - 1));
    assert(kitchen.deliver(haul.packageId, cookId - 1));
  }
  assert.equal(kitchen.frozenMeals, 48);
  assert.equal(kitchen.totalTrays(), 6);
  assert.equal(kitchen.totalSpoons(), 6);
  assert.equal(kitchen.books, 8);
  assert.equal(logistics.saveData().demands.length, 0);
  const purchaseCount = economy.saveData().ledger.length;
  for (const day of [1, 2]) {
    const dayTime = day * 24 * 30 + 23 * 30;
    kitchen.tick(dayTime, world);
    for (let i = 0; i < 100; i++) logistics.tick(.1, dayTime + i * .1, world);
    assert.equal(logistics.saveData().demands.length, 0, `day ${day + 1} should have no outstanding kitchen demand`);
  }
  assert.equal(economy.saveData().ledger.length, purchaseCount,
    "full freezer, place settings, and bookshelf should not trigger repeat purchases over three days");
}

// A stolen spoon leaves trays washable, and a staff interruption releases only
// that cook's unfinished meal reservation. Loads in a sink remain counted as stock.
{
  const { world, logistics } = setup();
  world.placePiece(12, 12, Obj.Sink, 0);
  world.placePiece(15, 12, Obj.ServingTable, 0);
  const kitchen = new KitchenSystem(logistics);
  kitchen.frozenMeals = 2; kitchen.cleanTrays = 4; kitchen.cleanSpoons = 2; kitchen.dirtyTrays = 2;
  kitchen.tick(0, world);
  assert(kitchen.reserveMealSet(31));
  assert(kitchen.reserveMealSet(31), "reserving again for the same cook is idempotent");
  assert.equal(kitchen.preparedSettings, 1);
  kitchen.releaseMealSet(99);
  assert.equal(kitchen.preparedSettings, 1, "another cook cannot release this meal set");
  kitchen.releaseMealSet(31);
  assert.equal(kitchen.preparedSettings, 0);
  assert.equal(kitchen.cleanTrays, 4); assert.equal(kitchen.cleanSpoons, 2);

  kitchen.dirtySpoons = 0;
  assert.equal(kitchen.claimWash(32), 2, "dirty trays remain washable after both spoons were stolen");
  assert.equal(kitchen.totalTrays(), 6, "trays claimed for washing still count toward inventory");
  kitchen.tick(1, world);
  assert.equal(logistics.saveData().requests.filter((row) => row.commodity === "tray").length, 0,
    "in-wash trays must not create replacement purchases");
  kitchen.finishWash(32);
  assert.equal(kitchen.cleanTrays, 6);
  assert.equal(kitchen.totalTrays(), 6);
  assert.equal(kitchen.totalSpoons(), 2, "tray washing must not invent replacement spoons");

  assert(kitchen.reserveMealSet(33));
  kitchen.commitMealSet(33);
  kitchen.releaseMealSet(33);
  assert.equal(kitchen.preparedSettings, 1, "a delivered setting remains in-use until a prisoner takes it");
  kitchen.mealTaken();
  assert.equal(kitchen.preparedSettings, 0);
  assert.equal(kitchen.totalTrays(), 6, "a tabled meal stays in inventory while its tray is in use");
  kitchen.tick(2, world);
  assert.equal(logistics.saveData().requests.filter((row) => row.commodity === "tray").length, 0,
    "a tray at an occupied meal table must not trigger a replacement purchase");
  kitchen.finishMeal(true, 31);
  assert.equal(kitchen.totalTrays(), 6);
  assert.equal(kitchen.totalSpoons(), 1, "a stolen spoon leaves kitchen inventory after meal cleanup");

  const pending = new KitchenSystem(logistics);
  pending.frozenMeals = 2; pending.cleanTrays = 2; pending.cleanSpoons = 2; pending.dirtyTrays = 2;
  pending.tick(0, world);
  assert(pending.reserveMealSet(41));
  assert.equal(pending.claimWash(42), 2);
  const restored = new KitchenSystem(logistics);
  restored.loadData(pending.saveData());
  assert(restored.hasMealSetClaim(41), "a cooking reservation survives a save/load round trip");
  assert(restored.hasWashClaim(42), "an in-progress wash reservation survives a save/load round trip");
  assert.equal(restored.totalTrays(), pending.totalTrays(), "restored claims remain counted without changing kitchen inventory");
  restored.finishWash(42);
  assert.equal(restored.cleanTrays, 3, "the restored cook can finish its claimed tray wash");
  restored.commitMealSet(41);
  assert.equal(restored.hasMealSetClaim(41), false, "a delivered setting releases its owner claim");
  restored.releaseMealSet(41);
  assert.equal(restored.preparedSettings, 1, "a delivered setting cannot be refunded after restoration");
}

// Outstanding books include workman-owned cargo and temporarily borrowed
// readers. If shelves fill during a haul, the surplus package is still
// consumed so its carried reservation cannot strand an idle workman.
{
  const { world, logistics } = setup(500);
  world.placePiece(100, 100, Obj.Bookshelf, 0);
  const kitchen = new KitchenSystem(logistics);
  kitchen.borrowedBooks = 0;
  logistics.addSalvage("book", 8, 100, 100);
  const pkg = [...logistics.packages.values()][0];
  pkg.state = "carried"; pkg.reservedBy = "workman:12";
  kitchen.tick(1, world);
  assert.equal(logistics.saveData().requests.filter((row) => row.commodity === "book").length, 0,
    "workman-carried books count toward the shelf target during a restock tick");
  logistics.packages.delete(pkg.id);

  kitchen.books = 8;
  logistics.addSalvage("book", 8, 100, 100);
  const overflow = [...logistics.packages.values()].at(-1)!;
  const overflowId = overflow.id;
  overflow.state = "carried"; overflow.reservedBy = "workman:13";
  assert(kitchen.acceptBookPackage(overflow), "a delivered book package must always close its cargo reservation");
  assert.equal(kitchen.books, 8, "overflow must not exceed the shelf target");
  assert.equal(overflow.state, "exports", "an overfull shelf must release its surplus package for export");
  assert.equal(overflow.reservedBy, null, "an overfull shelf must close the workman cargo reservation");

  assert(kitchen.borrowBook());
  kitchen.tick(2, world);
  assert.equal(logistics.saveData().requests.filter((row) => row.commodity === "book").length, 0,
    "borrowed library books remain part of stock and must not trigger replacements");
  kitchen.returnBook();
  assert.equal(kitchen.books, 8);
  assert.equal(kitchen.saveData().borrowedBooks, 0);
}

// Multiple construction targets can each haul one bundle, finish, and release
// their reservations. A second reserved target must not hide usable stock.
{
  const { world, logistics, construction } = setup();
  logistics.addSalvage("concrete", 3, 8, 8);
  const firstClaim = logistics.reserveBundle({ concrete: 1 }, "unrelated-work");
  assert(firstClaim);
  const group = construction.plan({ cat: "floor", mat: 1 }, [{ x: 12, z: 12 }, { x: 13, z: 12 }], 0, 0, world)!;
  assert(group);
  finishBuild(construction, world, 40, 12, 12, group.id);
  finishBuild(construction, world, 40, 13, 12, group.id);
  assert.equal(world.floorMat[world.idx(12, 12)], 1);
  assert.equal(world.floorMat[world.idx(13, 12)], 1);
  assert.equal(group.state, "complete");
  assert.equal(logistics.quantity("concrete"), 0);
}

// A planned door waits for its wall, then both targets complete in order.
{
  const { world, logistics, construction } = setup(40);
  logistics.addSalvage("concrete", 5, 4, 4);
  ensureBoxCommodity(OBJ_DEFS.find((row) => row.kind === Obj.Door)!);
  logistics.addSalvage(boxCommodity(Obj.Door), 1, 4, 4);
  const wall = construction.plan({ cat: "wall", mat: 1 }, [{ x: 8, z: 8 }], 0, 0, world)!;
  const door = construction.plan({ cat: "door", mat: 0 }, [{ x: 8, z: 8 }], 0, 1, world)!;
  assert(wall && door);
  const first = construction.claimNext(3, 7, 8, world)!;
  assert.equal(first.group.id, wall.id, "the dependent door cannot be claimed before its wall");
  if (first.phase === "haul") {
    construction.pickUpBundle(wall.id, first.target.id, first.packageId, 3, 7, 8);
    construction.deliverBundle(wall.id, first.target.id, first.packageId, 3);
  }
  const working = construction.claimNext(3, 7, 8, world)!;
  assert.equal(working.group.id, wall.id);
  assert.equal(working.phase, "work");
  assert(construction.complete(wall.id, working.target.id, 3, world));
  const next = construction.claimNext(3, 7, 8, world)!;
  assert.equal(next.group.id, door.id);
}

// Cancellation returns material already delivered to a site and demolition
// removes the full object footprint through the work order path.
{
  const { world, logistics, construction } = setup(50);
  logistics.addSalvage("concrete", 3, 5, 5);
  const group = construction.plan({ cat: "floor", mat: 1 }, [{ x: 15, z: 15 }], 0, 0, world)!;
  const haul = construction.claimNext(7, 14, 15, world)!;
  assert.equal(haul.phase, "haul");
  construction.pickUpBundle(group.id, haul.target.id, haul.packageId, 7, 14, 15);
  construction.deliverBundle(group.id, haul.target.id, haul.packageId, 7);
  assert.equal(logistics.quantity("concrete"), 2);
  assert(construction.cancelGroup(group.id));
  assert.equal(logistics.quantity("concrete"), 3, "cancelled site cargo returns to delivery stock");

  world.placePiece(20, 20, Obj.Bed, 0);
  const removal = construction.planDemolition(20, 20, 2, world)!;
  const work = construction.claimNext(8, 19, 20, world)!;
  assert.equal(work.group.id, removal.id);
  assert.equal(work.phase, "work");
  assert(construction.complete(removal.id, work.target.id, 8, world));
  assert.equal(world.objKind[world.idx(20, 20)], Obj.None);
}

// Delivery capacity is physical: full pallets block inbound cargo until an
// additional pallet or Delivery Yard is available.
{
  const { world, logistics, construction, economy } = setup(500);
  new InfrastructureSystem(world).installNewGame();
  const yard = [...world.rooms.values()].find((room) => room.valid && room.type === RoomType.Delivery)!;
  const pallet = [...yard.tiles].find((tile) => world.objKind[tile] === Obj.LoadingPallet)!;
  for (let n = 0; n < 8; n++) logistics.addSalvage("concrete", 1, pallet % world.size, Math.floor(pallet / world.size));
  for (const pkg of logistics.packages.values()) pkg.state = "delivery";
  economy.cash = 100_000;
  logistics.request({ concrete: 10 }, 0, true, "yard-capacity");
  logistics.tick(.1, 8, world);
  assert(logistics.trucks.some((truck) => truck.kind === "inbound"));
  for (let n = 0; n < 30; n++) logistics.tick(1, 8 + n, world);
  assert(logistics.trucks.some((truck) => truck.state === "blocked"), "full pallets must block delivery visibly");
  assert(logistics.warnings.has("Delivery pallets are full"));
  world.placePiece([...yard.tiles][0] % world.size, Math.floor([...yard.tiles][0] / world.size), Obj.LoadingPallet, 0);
  for (let n = 0; n < 40; n++) logistics.tick(1, 40 + n, world);
  assert(logistics.quantity("concrete", ["delivery"]) > 0, "adding pallet capacity resumes unloading");
}

console.log("integrated stock/construction/dependency/cancellation/demolition/yard checks passed");
