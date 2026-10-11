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
