import { strict as assert } from "node:assert";
import { catalogSnapshot } from "../src/editor.ts";
import { ConstructionSystem } from "../src/sim/construction.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { InfrastructureSystem, ROAD_X0, ROAD_X1 } from "../src/sim/infrastructure.ts";
import { IntakeSystem } from "../src/sim/intake.ts";
import { KitchenSystem } from "../src/sim/kitchen.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { OBJ_DEFS, ROOM_DEFS, Obj, RoomType, World } from "../src/sim/world.ts";

function systems(size = 500) {
  const world = new World(size);
  const economy = new EconomySystem();
  const logistics = new LogisticsSystem(economy);
  const construction = new ConstructionSystem(logistics);
  return { world, economy, logistics, construction };
}

// Fixed infrastructure and starter yard.
{
  const { world } = systems();
  new InfrastructureSystem(world).installNewGame();
  for (let z = 0; z < world.size; z += 37) for (let x = ROAD_X0; x <= ROAD_X1; x++) {
    assert.equal(world.infrastructure[world.idx(x, z)], 1);
    assert.equal(world.erase(x, z), false);
    assert.equal(world.setFloor(x, z, 1), false);
  }
  const yards = [...world.rooms.values()].filter((r) => r.type === RoomType.Delivery && r.valid);
  assert.equal(yards.length, 1, "new games have one valid starter Delivery Yard");
}

// Orders reserve layers, remain nonfunctional, cancel as a group, and mutate
// World only when a workman completes the target.
{
  const { world, logistics, construction } = systems(80);
  logistics.addSalvage("concrete", 20, 1, 1);
  const group = construction.plan({ cat: "floor", mat: 1 }, [{ x: 10, z: 10 }, { x: 11, z: 10 }], 0, 1, world)!;
  assert.equal(world.floorMat[world.idx(10, 10)], 0);
  const haul = construction.claimNext(7, 9, 10, world)!;
  assert.equal(haul.phase, "haul");
  construction.pickUpBundle(haul.group.id, haul.target.id, haul.packageId, 7, 1, 1);
  construction.deliverBundle(haul.group.id, haul.target.id, haul.packageId, 7);
  const claim = construction.claimNext(7, 9, 10, world)!;
  assert.equal(claim.phase, "work");
  assert.equal(construction.complete(claim.group.id, claim.target.id, 7, world), true);
  assert.equal(world.floorMat[world.idx(claim.target.x, claim.target.z)], 1);
  assert.equal(construction.cancelGroup(group.id), true);
  assert.equal(group.targets.filter((t) => t.completed).length, 1);
  assert.equal(group.targets.filter((t) => !t.completed).length, 1);
}

// Catalog sections are namespaced, complete, and expose every room prerequisite.
{
  const catalog = catalogSnapshot();
  assert.equal(new Set(catalog.map((entry) => `${entry.section}:${entry.label}`)).size, catalog.length);
  for (const def of OBJ_DEFS.filter((row) => row.palette && row.place !== "person")) {
    assert.equal(catalog.filter((entry) => entry.label === def.palette!.label).length, 1, `${def.palette!.label} appears exactly once`);
  }
  for (const room of ROOM_DEFS) assert.equal(catalog.filter((entry) => entry.tool.cat === "room" && entry.tool.mat === room.type).length, 1);
  assert.ok(catalog.some((entry) => entry.section === "objects:logistics" && entry.label === "Loading Pallet"));
}

// Conflicts are rejected, blocked old work does not starve newer work, removed
// workers release claims, and reconciliation accepts an already-desired result.
{
  const { world, logistics, construction } = systems(50);
  world.setWall(5, 5, 1);
  assert.equal(construction.plan({ cat: "wall", mat: 1 }, [{ x: 5, z: 5 }], 0, 0, world), null);
  assert.equal(construction.lastIssue?.code, "already-built");
  world.placePiece(7, 7, Obj.Bed, 0);
  assert.equal(construction.plan({ cat: "wall", mat: 1 }, [{ x: 7, z: 7 }], 0, 0, world), null);
  assert.equal(construction.lastIssue?.code, "occupied");

  logistics.addSalvage("concrete", 20, 1, 1);
  const old = construction.plan({ cat: "floor", mat: 1 }, [{ x: 10, z: 10 }], 0, 1, world)!;
  const newer = construction.plan({ cat: "floor", mat: 1 }, [{ x: 11, z: 10 }], 0, 2, world)!;
  const first = construction.claimNext(40, 9, 10, world)!;
  assert.equal(first.group.id, old.id);
  construction.releaseClaim(first.group.id, first.target.id, 40, "Unreachable construction site");
  const second = construction.claimNext(40, 9, 10, world)!;
  assert.equal(second.group.id, newer.id);
  construction.releaseWorker(40);
  assert.equal(second.target.claimedBy, -1);

  const wall = construction.plan({ cat: "wall", mat: 1 }, [{ x: 15, z: 15 }], 0, 3, world)!;
  world.setWall(15, 15, 1);
  construction.reconcile(world, new Set());
  assert.equal(wall.targets[0].completed, true);
}

// Room validation reports every missing object instead of only the first.
{
  const world = new World(30);
  for (let x = 4; x <= 10; x++) { world.setWall(x, 4, 1); world.setWall(x, 10, 1); }
  for (let z = 5; z < 10; z++) { world.setWall(4, z, 1); world.setWall(10, z, 1); }
  world.recomputeRooms();
  const roomId = world.startRoomPaint(5, 5, RoomType.Kitchen);
  for (let z = 5; z < 10; z++) for (let x = 5; x < 10; x++) world.paintRoomInto(x, z, roomId);
  world.endRoomPaint(roomId);
  const room = world.rooms.get(roomId)!;
  const issues = world.roomIssues(room);
  assert.deepEqual(issues.filter((issue) => issue.code === "missing-object").map((issue) => issue.message),
    ["Needs a cooker.", "Needs a freezer.", "Needs a sink."]);
}

// Bulk salvage uses a fractional accumulator: two one-unit floor demolitions
// recover exactly one unit, never two rounded-up units.
{
  const { world, logistics, construction } = systems(30);
  world.setFloor(5, 5, 1); world.setFloor(6, 5, 1);
  for (const x of [5, 6]) {
    const group = construction.planDemolition(x, 5, x, world)!;
    const claim = construction.claimNext(20 + x, x, 4, world)!;
    assert.equal(claim.group.id, group.id);
    construction.complete(group.id, claim.target.id, 20 + x, world);
  }
  assert.equal(logistics.quantity("concrete"), 1);
}

// Mandatory procurement can enter debt, trucks cap cargo at twelve packages,
// and packages physically unload into the starter yard.
{
  const { world, economy, logistics } = systems();
  new InfrastructureSystem(world).installNewGame();
  economy.cash = 0;
  logistics.request({ spoon: 300 }, 0, true, "test-replacement");
  logistics.tick(0.1, 8, world);
  assert.ok(economy.cash < 0);
  assert.ok(logistics.trucks.length >= 2);
  assert.ok(logistics.trucks.every((t) => t.packageIds.length <= 12));
  for (let i = 0; i < 300; i++) logistics.tick(0.1, 8 + i * 0.1, world);
  assert.ok(logistics.quantity("spoon", ["delivery"]) > 0);
}

// Kitchen durable-stock lifecycle.
{
  const { world, logistics } = systems(40);
  const kitchen = new KitchenSystem(logistics);
  world.placePiece(5, 5, Obj.Freezer, 0);
  world.placePiece(8, 5, Obj.ServingTable, 0);
  world.placePiece(10, 5, Obj.Sink, 0);
  kitchen.tick(1, world);
  kitchen.frozenMeals = 1; kitchen.cleanTrays = 1; kitchen.cleanSpoons = 1;
  assert.equal(kitchen.reserveMealSet(), true);
  kitchen.finishMeal(false);
  assert.equal(kitchen.claimWash(3), 1);
  kitchen.finishWash(3);
  assert.equal(kitchen.cleanTrays, 1); assert.equal(kitchen.cleanSpoons, 1);
}

// Seeded intake always stays in bounds and expected arrivals rise with beds.
{
  const economy = new EconomySystem();
  const intake = new IntakeSystem(economy);
  const mean = (free: number) => {
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      const n = intake.sampleArrivalCount(free);
      assert.ok(n >= 0 && n <= Math.max(0, free));
      total += n;
    }
    return total / 2000;
  };
  const at0 = mean(0), at10 = mean(10), at30 = mean(30);
  assert.equal(at0, 0);
  assert.ok(at0 < at10 && at10 < at30, `${at0}, ${at10}, ${at30}`);
}

// Save-v2 subsystem round trip and large reservation scenario.
{
  const a = systems(100);
  a.economy.cash = 12_345;
  a.logistics.addSalvage("metal", 5, 2, 2);
  for (let i = 0; i < 500; i++) {
    a.construction.plan({ cat: "floor", mat: 1 }, [{ x: i % 50, z: 20 + Math.floor(i / 50) }], 0, i, a.world);
  }
  const b = systems(100);
  b.economy.loadData(a.economy.saveData());
  b.logistics.loadData(a.logistics.saveData());
  b.construction.loadData(a.construction.saveData());
  assert.equal(b.economy.cash, 12_345);
  assert.equal(b.logistics.quantity("metal"), 5);
  assert.equal(b.construction.groups.size, 500);
}

console.log("logistics, construction, economy, kitchen, infrastructure, and intake checks passed");
