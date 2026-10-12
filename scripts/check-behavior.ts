// Live-agent behavior checks for construction hauling and prisoner needs.
// Run with Node 24 so the sim's native TypeScript imports work directly.
import assert from "node:assert/strict";
import { Agents } from "../src/sim/agents.ts";
import { blankAgent, REG } from "../src/sim/agent.ts";
import { AreaSystem } from "../src/sim/areas.ts";
import { CombatSystem } from "../src/sim/combat.ts";
import { ConstructionSystem } from "../src/sim/construction.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { HealthSystem } from "../src/sim/health.ts";
import { InstitutionSystem } from "../src/sim/institution.ts";
import { ItemSystem } from "../src/sim/itemSystem.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { KitchenSystem } from "../src/sim/kitchen.ts";
import { SecuritySystem } from "../src/sim/security.ts";
import { Task2Systems } from "../src/sim/task2Systems.ts";
import { Task3Systems } from "../src/sim/task3Systems.ts";
import { Access, Obj, RoomType, World } from "../src/sim/world.ts";
import { pathAdjacent } from "../src/sim/move.ts";
import { passable } from "../src/sim/nav.ts";
import { Item, stow } from "../src/sim/items.ts";
import { finishUse, startUse } from "../src/sim/useSlots.ts";

function workman(id: number, x: number, z: number) {
  const agent = blankAgent(Obj.Workman);
  agent.id = id; agent.x = x; agent.z = z; agent.decideT = 0;
  return agent;
}

function liveBuild(cancelInTransit: boolean, blocked: boolean) {
  const world = new World(32), economy = new EconomySystem();
  const logistics = new LogisticsSystem(economy), construction = new ConstructionSystem(logistics);
  const agents = new Agents(), worker = workman(1, 3.5, 8.5);
  agents.agents.push(worker); agents.construction = construction;
  logistics.addSalvage("concrete", 2, 5, 8);
  const x = 16, z = 8;
  const group = construction.plan({ cat: "floor", mat: 1 }, [{ x, z }], 0, 0, world)!;
  assert(group, "valid floor order should be created");
  if (blocked) {
    for (let wx = 15; wx <= 17; wx++) { world.setWall(wx, 7, 1); world.setWall(wx, 9, 1); }
    world.setWall(15, 8, 1); world.setWall(17, 8, 1);
  }

  let sawPickup = false, cancelled = false;
  for (let tick = 0; tick < 1200; tick++) {
    agents.update(.1, world, false, 12, tick * .1);
    if (worker.state === "deliverBuildCargo") {
      sawPickup = true;
      if (cancelInTransit && !cancelled) { construction.cancelGroup(group.id); cancelled = true; }
    }
    if (blocked && group.targets[0].blocker === "Unreachable construction site") break;
    if (!blocked && !cancelInTransit && group.state === "complete") break;
    if (cancelled && worker.state === "idle" && worker.buildGroup < 0) break;
  }

  if (blocked) {
    assert.equal(group.targets[0].claimedBy, -1, "unreachable site must release its worker claim");
    assert.equal(group.targets[0].blocker, "Unreachable construction site");
    assert([...logistics.packages.values()].some((pkg) => pkg.commodity === "concrete" && !pkg.reservedBy),
      "failed site approach must release its material reservation");
  } else if (cancelInTransit) {
    assert(sawPickup && cancelled, "order should be cancelled while the worker carries the bundle");
    assert.equal(group.state, "cancelled");
    assert.equal(worker.buildGroup, -1, "worker must drop the cancelled assignment after the old route ends");
    assert([...logistics.packages.values()].some((pkg) => pkg.commodity === "concrete" && pkg.state === "delivery"),
      "cancelled carried bundle must return to delivery stock");
  } else {
    assert.equal(group.state, "complete", "live worker should haul, deliver, and finish a reachable target");
    assert.equal(world.floorMat[world.idx(x, z)], 1);
  }
}

function escapeOwnedPrisonerStillMetabolizes() {
  const world = new World(24), agents = new Agents(), prisoner = blankAgent(Obj.Prisoner);
  prisoner.id = 7; prisoner.x = 8.5; prisoner.z = 8.5;
  prisoner.needs.food = .6; prisoner.needs.sleep = .6; prisoner.needs.outdoors = .6;
  agents.agents.push(prisoner);
  // Mimic an active escape-owned state while leaving movement decisions out
  // of this focused regression: Task 3 handles the prisoner every tick.
  let observedActivity = -1;
  agents.regime[12] = REG.Eating;
  agents.task3 = { updatePrisoner: (agent: typeof prisoner, _dt: number, _time: number,
    _world: World, _agents: readonly typeof prisoner[], activity?: number) => {
    observedActivity = activity ?? -1; agent.state = "escape:observe"; return true;
  } } as unknown as Task3Systems;
  agents.update(1, world, false, 12, 1);
  assert.equal(prisoner.state, "escape:observe");
  assert.equal(observedActivity, REG.Eating, "the escape planner must know about scheduled meals");
  assert(prisoner.needs.food < .6, "an active escape task must not pause hunger");
  assert(prisoner.needs.sleep < .6, "an active escape task must not pause fatigue");
}

escapeOwnedPrisonerStillMetabolizes();

function urgentNeedsInterruptStaleEscapeExploration() {
  const world = new World(24), agents = new Agents(), tiles = new Set<number>();
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) tiles.add(world.idx(x, z));
  world.rooms.set(1, { id: 1, type: RoomType.Canteen, access: Access.Prisoners, tiles, valid: true, ambience: 0, guards: 0 });
  world.roomId.fill(1);
  assert(world.placePiece(8, 8, Obj.ServingTable, 0));
  assert(world.placePiece(12, 8, Obj.Table, 0));
  const prisoner = blankAgent(Obj.Prisoner);
  prisoner.id = 70; prisoner.x = 4.5; prisoner.z = 8.5; prisoner.cuffed = false;
  prisoner.needs.food = .04; prisoner.decideT = 0; prisoner.state = "exploring";
  prisoner.path = [world.idx(5, 8), world.idx(6, 8), world.idx(7, 8)]; prisoner.pathI = 0;
  prisoner.plan = { method: "climb", breaches: [world.idx(20, 20)], exitTile: world.idx(21, 20),
    needed: 1, stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 90 };
  agents.agents.push(prisoner); agents.servingStock.set(world.idx(8, 8), 2);
  agents.update(.1, world, false, 12, .1);
  assert.equal(prisoner.state, "toUse", "hunger should replace an unrelated escape exploration route with a meal route");
  assert.notDeepEqual(prisoner.path, [world.idx(5, 8), world.idx(6, 8), world.idx(7, 8)], "the old exploration route must be discarded");
  assert(Math.abs((prisoner.path?.at(-1) ?? 0) % world.size - 8) <= 1, "meal route ends beside its serving counter");
  assert.equal(prisoner.plan?.stage, "prepare", "urgent needs pause movement without discarding escape progress");

  assert(world.placePiece(8, 12, Obj.Toilet, 0));
  agents.servingStock.set(world.idx(8, 8), 0);
  const toiletBound = blankAgent(Obj.Prisoner);
  toiletBound.id = 74; toiletBound.x = 4.5; toiletBound.z = 8.5; toiletBound.cuffed = false;
  toiletBound.needs.food = .04; toiletBound.state = "toUse"; toiletBound.interact = world.idx(8, 12);
  toiletBound.path = [world.idx(5, 8), world.idx(6, 8), world.idx(7, 8)]; toiletBound.pathI = 0;
  toiletBound.plan = { method: "climb", breaches: [world.idx(20, 20)], exitTile: world.idx(21, 20),
    needed: 1, stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 90 };
  agents.agents.push(toiletBound);
  agents.update(.1, world, false, 12, .2);
  assert.equal(toiletBound.state, "toQueue", "critical hunger interrupts an unrelated toilet route and waits for a meal");
  assert.equal(toiletBound.interact, world.idx(8, 8));
}

urgentNeedsInterruptStaleEscapeExploration();

function hungryEscapePlanKeepsOrdinarySearchRoute() {
  const world = new World(24), agents = new Agents(), prisoner = blankAgent(Obj.Prisoner);
  prisoner.id = 71; prisoner.x = 5.5; prisoner.z = 6.5; prisoner.cuffed = false;
  prisoner.needs.food = .24; prisoner.needs.sleep = .8; prisoner.state = "exploring";
  prisoner.plan = { method: "climb", breaches: [world.idx(20, 20)], exitTile: world.idx(21, 20),
    needed: 1, stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 90 };
  agents.agents.push(prisoner);

  // The first urgency edge discards the stale plan route. The ordinary AI
  // then picks an exploration/search path because no meal is available.
  agents.updatePrisoner(prisoner, .1, world, false);
  prisoner.state = "exploring";
  prisoner.path = [world.idx(6, 6), world.idx(7, 6), world.idx(8, 6)]; prisoner.pathI = 0;
  const x0 = prisoner.x;
  agents.update(.5, world, false, 12, .5);
  assert(prisoner.needs.food < .3, "the prisoner should still be hungry while searching");
  assert(prisoner.x > x0, "the ordinary search route should advance while hunger remains unresolved");
  assert.equal(prisoner.state, "exploring", "the needs handoff must not repeatedly cancel ordinary exploration");
  assert.equal(prisoner.plan?.stage, "prepare", "yielding needs keeps escape-plan progress");
}

hungryEscapePlanKeepsOrdinarySearchRoute();

function legacyEscapePlanYieldsToScheduledShowers() {
  const world = new World(24), agents = new Agents(), tiles = new Set<number>();
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) tiles.add(world.idx(x, z));
  assert(world.placePiece(8, 8, Obj.Shower, 0));
  world.roomId.fill(1);
  world.rooms.set(1, { id: 1, type: RoomType.ShowerRoom, access: Access.Prisoners,
    tiles, valid: true, ambience: 0, guards: 0 });
  const prisoner = blankAgent(Obj.Prisoner);
  prisoner.id = 72; prisoner.x = 5.5; prisoner.z = 8.5; prisoner.compliant = false; prisoner.cuffed = false;
  prisoner.needs.hygiene = .04; prisoner.decideT = 0;
  prisoner.plan = { method: "climb", breaches: [world.idx(20, 20)], exitTile: world.idx(21, 20),
    needed: 1, stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 90 };
  agents.agents.push(prisoner);
  agents.update(.1, world, false, 6, .1);
  assert.equal(agents.curActivity, REG.Shower);
  assert.equal(prisoner.state, "toUse", "a noncompliant legacy plan must yield to its prisoner's scheduled shower need");
  assert.equal(prisoner.interact, world.idx(8, 8));
  assert.equal(prisoner.plan?.stage, "prepare", "yielding preserves the legacy escape plan");
}

legacyEscapePlanYieldsToScheduledShowers();

function kitchenOwnershipSurvivesAgentAndKitchenReload() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  assert(world.placePiece(6, 6, Obj.Cooker, 0));
  assert(world.placePiece(9, 6, Obj.ServingTable, 0));
  assert(world.placePiece(12, 6, Obj.Table, 0));
  const agents = new Agents(), kitchen = new KitchenSystem(logistics);
  agents.kitchen = kitchen;
  const cook = blankAgent(Obj.Cook); cook.id = 55; cook.state = "cooking";
  cook.cookerIdx = world.idx(6, 6); cook.timer = 4;
  agents.agents.push(cook); agents.claimedCookers.set(cook.cookerIdx, cook.id);
  kitchen.frozenMeals = kitchen.cleanTrays = kitchen.cleanSpoons = 1;
  assert(kitchen.reserveMealSet(cook.id));

  const interruptedDiners = [56, 57].map((id) => {
    const diner = blankAgent(Obj.Prisoner); diner.id = id;
    diner.state = "using"; diner.useIdx = world.idx(12, 6);
    agents.agents.push(diner); return diner;
  });
  agents.mealTables.add(world.idx(12, 6));
  agents.mealTableMeals.set(world.idx(12, 6), interruptedDiners.length);
  agents.mealUseClaims.set(interruptedDiners[0]!.id, world.idx(12, 6));
  agents.mealUseClaims.set(interruptedDiners[1]!.id, world.idx(12, 6));
  agents.useClaims.set(world.idx(12, 6), new Set(interruptedDiners.map((diner) => diner.id)));
  kitchen.eatingSettings = interruptedDiners.length;

  const agentSave = agents.saveData(), kitchenSave = kitchen.saveData();
  const restoredAgents = new Agents(), restoredKitchen = new KitchenSystem(logistics);
  restoredAgents.loadData(agentSave);
  restoredKitchen.loadData(kitchenSave);
  restoredAgents.kitchen = restoredKitchen;

  const restoredCook = restoredAgents.agents.find((agent) => agent.id === cook.id)!;
  assert.equal(restoredCook.state, "cooking", "an in-progress cook should resume after reload");
  assert(restoredKitchen.hasMealSetClaim(cook.id), "the cook's reservation owner should survive reload");
  assert.equal(restoredKitchen.preparedSettings, 1);
  restoredAgents.removeAgent(restoredCook);
  assert.equal(restoredKitchen.preparedSettings, 0);
  assert.equal(restoredKitchen.frozenMeals, 1);
  assert.equal(restoredKitchen.cleanTrays, 1);
  assert.equal(restoredKitchen.cleanSpoons, 1);

  const diners = interruptedDiners.map((agent) => restoredAgents.agents.find((row) => row.id === agent.id)!);
  assert(diners.every((diner) => diner.state === "idle"), "reload releases transient use claims");
  assert(restoredAgents.mealTables.has(world.idx(12, 6)), "an interrupted table meal remains available");
  assert.equal(restoredAgents.mealTableMeals.get(world.idx(12, 6)), 2,
    "a table retains the number of interrupted diners, not just a visual yes/no flag");
  assert.equal(restoredAgents.mealTableAvailable.get(world.idx(12, 6)), 2,
    "each interrupted diner makes one meal available for reuse after reload");
  assert.equal(restoredKitchen.eatingSettings, 2, "both leftovers still own eating settings");
  for (const diner of diners) {
    diner.interact = world.idx(12, 6);
    startUse(restoredAgents, diner, world);
    assert.equal(diner.useIdx, world.idx(12, 6));
    finishUse(restoredAgents, diner, world);
  }
  assert.equal(restoredAgents.mealTables.has(world.idx(12, 6)), false);
  assert.equal(restoredKitchen.eatingSettings, 0);
  assert.equal(restoredKitchen.dirtyTrays, 2);

  assert(world.placePiece(14, 6, Obj.Table, 0));
  const sharedLeftover = world.idx(14, 6), first = diners[0]!, second = diners[1]!;
  restoredAgents.mealTables.add(sharedLeftover);
  restoredAgents.mealTableMeals.set(sharedLeftover, 1);
  restoredAgents.mealTableAvailable.set(sharedLeftover, 1);
  restoredKitchen.eatingSettings = 1;
  first.interact = sharedLeftover; second.interact = sharedLeftover;
  startUse(restoredAgents, first, world);
  startUse(restoredAgents, second, world);
  assert.equal(first.useIdx, sharedLeftover);
  assert.equal(second.useIdx, -1, "one leftover cannot be claimed by two diners");
  assert.equal(restoredAgents.mealTableAvailable.get(sharedLeftover), undefined);
  finishUse(restoredAgents, first, world);
  assert.equal(restoredKitchen.eatingSettings, 0);
  assert.equal(restoredKitchen.dirtyTrays, 3);

  const interrupted = blankAgent(Obj.Prisoner), table = world.idx(12, 6); interrupted.id = 58;
  interrupted.state = "using"; interrupted.useIdx = table; interrupted.cuffed = false;
  restoredAgents.agents.push(interrupted);
  restoredAgents.useClaims.set(table, new Set([interrupted.id]));
  restoredAgents.mealTables.add(table);
  restoredAgents.mealTableMeals.set(table, 1);
  restoredAgents.mealUseClaims.set(interrupted.id, table);
  restoredKitchen.eatingSettings = 1;
  world.erase(12, 6);
  restoredAgents.update(.1, world, false, 12, 1);
  assert.equal(interrupted.state, "idle", "erasing a table ends its active meal cleanly");
  assert.equal(restoredAgents.mealTables.has(table), false);
  assert.equal(restoredKitchen.eatingSettings, 0);
  assert.equal(restoredKitchen.dirtyTrays, 4);
}

kitchenOwnershipSurvivesAgentAndKitchenReload();

liveBuild(false, false);
liveBuild(false, true);
liveBuild(true, false);

function postedWorkmanCompletesOrder() {
  const world = new World(32), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const construction = new ConstructionSystem(logistics), task2 = new Task2Systems(world.size, economy, logistics);
  const agents = new Agents(), worker = workman(31, 8.5, 8.5);
  task2.installNewGame(world); task2.areas.recompute(world);
  agents.agents.push(worker); agents.task2 = task2; agents.construction = construction; task2.ensureAgent(worker, 0);
  const area = task2.areas.areaAt[world.idx(8, 8)];
  task2.security.postings.set(worker.id, { areaId: area, role: "workman" });
  task2.security.deploymentTargets.set(area, { workman: 1 });
  logistics.addSalvage("concrete", 2, 8, 8);
  const group = construction.plan({ cat: "floor", mat: 1 }, [{ x: 12, z: 8 }], 0, 0, world)!;
  for (let tick = 0; tick < 1200 && group.state !== "complete"; tick++) {
    const time = (tick + 1) * .1;
    task2.tick(.1, time, world, agents.agents, false, false);
    agents.update(.1, world, false, 12, time);
  }
  assert.equal(group.state, "complete", "a productive deployment must not interrupt construction at its post");
  assert.equal(world.floorMat[world.idx(12, 8)], 1);
}

postedWorkmanCompletesOrder();

function prisonerMealCycle() {
  const world = new World(24), agents = new Agents();
  const tiles = new Set<number>();
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) tiles.add(world.idx(x, z));
  world.rooms.set(1, { id: 1, type: RoomType.Canteen, access: Access.Prisoners, tiles, valid: true, ambience: 0, guards: 0 });
  world.roomId.fill(1);
  assert(world.placePiece(8, 8, Obj.ServingTable, 0));
  assert(world.placePiece(12, 8, Obj.Table, 0));
  const prisoner = blankAgent(Obj.Prisoner);
  prisoner.id = 20; prisoner.x = 4.5; prisoner.z = 8.5; prisoner.cuffed = false;
  prisoner.needs.food = .04; prisoner.decideT = 0;
  agents.agents.push(prisoner); agents.servingStock.set(world.idx(8, 8), 4);
  for (let tick = 0; tick < 2400; tick++) {
    agents.update(.1, world, false, 12, tick * .1);
    assert(Number.isFinite(prisoner.x) && Number.isFinite(prisoner.z), "prisoner position stays finite");
    for (const need of Object.values(prisoner.needs)) assert(need >= 0 && need <= 1, "needs stay in [0, 1]");
    if (prisoner.needs.food > .75 && prisoner.state === "idle" && prisoner.inv.hands.length === 0) break;
  }
  assert(prisoner.needs.food > .75, "a stocked counter and reachable table should resolve hunger");
  assert(![...agents.useClaims.values()].some((users) => users.has(prisoner.id)), "finished meal releases the prisoner's use slot");

  const cellWorld = new World(20), cellAgents = new Agents();
  const cellTiles = new Set<number>();
  for (let z = 3; z <= 8; z++) for (let x = 3; x <= 8; x++) {
    const tile = cellWorld.idx(x, z); cellTiles.add(tile); cellWorld.roomId[tile] = 7;
  }
  cellWorld.rooms.set(7, { id: 7, type: RoomType.Cell, access: Access.Prisoners,
    tiles: cellTiles, valid: true, ambience: 0, guards: 0 });
  assert(cellWorld.placePiece(5, 5, Obj.Bed, 0));
  const sleeper = blankAgent(Obj.Prisoner);
  sleeper.id = 21; sleeper.x = 4.5; sleeper.z = 5.5; sleeper.cuffed = false;
  sleeper.cellRoom = 7; sleeper.bedIdx = cellWorld.idx(5, 5); sleeper.needs.sleep = .05;
  sleeper.compliant = true; sleeper.decideT = 0;
  cellAgents.agents.push(sleeper);
  cellAgents.regime.fill(REG.Sleep);
  for (let tick = 0; tick < 1800 && (sleeper.needs.sleep < .8 || sleeper.state === "using"); tick++) {
    cellAgents.update(.1, cellWorld, true, 22, tick * .1);
    sleeper.compliant = true;
  }
  assert(sleeper.needs.sleep > .8, "sleep regime gets a prisoner onto his assigned bunk");
  assert(![...cellAgents.useClaims.values()].some((users) => users.has(sleeper.id)), "sleeping prisoner releases the bunk on waking");
}

prisonerMealCycle();

function emptyMealCounterDoesNotTrapPrisoner() {
  const world = new World(24), agents = new Agents();
  const tiles = new Set<number>();
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) tiles.add(world.idx(x, z));
  world.rooms.set(1, { id: 1, type: RoomType.Canteen, access: Access.Prisoners, tiles, valid: true, ambience: 0, guards: 0 });
  world.roomId.fill(1);
  assert(world.placePiece(8, 8, Obj.ServingTable, 0));
  const prisoner = blankAgent(Obj.Prisoner);
  prisoner.id = 22; prisoner.x = 6.5; prisoner.z = 8.5; prisoner.cuffed = false; prisoner.needs.food = .04; prisoner.needs.sleep = .05;
  prisoner.decideT = 0; agents.agents.push(prisoner);
  for (let tick = 0; tick < 500; tick++) agents.update(.1, world, false, 12, tick * .1);
  assert.notEqual(prisoner.state, "queueing", "an empty counter should release its queue after a short wait");
  assert(prisoner.needs.sleep > .2 || prisoner.state === "sleepFloor" || prisoner.state === "exploring",
    "a stalled meal queue should let sleep or other needs make progress");
}

emptyMealCounterDoesNotTrapPrisoner();

function guardChase() {
  const world = new World(24), agents = new Agents();
  const prisoner = blankAgent(Obj.Prisoner), guard = blankAgent(Obj.Guard);
  prisoner.id = 30; prisoner.x = 10.5; prisoner.z = 10.5; prisoner.cuffed = false;
  prisoner.state = "climbing"; prisoner.plan = {
    method: "climb", breaches: [world.idx(10, 10)], exitTile: world.idx(10, 9), needed: 1,
    stage: "execute", legI: 0, toiletIdx: -1, watchdog: 30,
  };
  guard.id = 31; guard.x = 13.5; guard.z = 10.5; guard.heading = Math.PI; guard.decideT = 0;
  agents.agents.push(prisoner, guard);
  for (let tick = 0; tick < 120 && agents.caughtCount === 0; tick++) agents.updateGuard(guard, .1, world);
  assert.equal(agents.caughtCount, 1, "a nearby guard spots, reaches, and captures an exposed climber");
  assert.equal(prisoner.timesCaught, 1);
  assert.equal(prisoner.state, "escorted");
  assert.equal(guard.state, "escorting");
}

guardChase();

function restrainedResidentReturnsToOwnedBedInFullPrison() {
  const world = new World(24), agents = new Agents();
  const tiles = new Set<number>();
  for (let z = 5; z <= 12; z++) for (let x = 5; x <= 12; x++) {
    world.setFloor(x, z, 1); const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = 1;
  }
  world.placePiece(6, 6, Obj.Bed); world.placePiece(6, 9, Obj.Bed);
  world.rooms.set(1, { id: 1, type: RoomType.Dorm, access: Access.Prisoners, tiles, valid: true, ambience: 0, guards: 0 });
  const waitingArrival = blankAgent(Obj.Prisoner); waitingArrival.id = 3; waitingArrival.x = 3.5; waitingArrival.z = 13.5;
  const resident = blankAgent(Obj.Prisoner); resident.id = 1; resident.x = 3.5; resident.z = 10.5;
  resident.cellRoom = 1; resident.bedIdx = world.idx(6, 6); resident.cuffed = true; resident.state = "cuffed";
  const roommate = blankAgent(Obj.Prisoner); roommate.id = 2; roommate.x = 7.5; roommate.z = 9.5;
  roommate.cellRoom = 1; roommate.bedIdx = world.idx(6, 9); roommate.cuffed = false;
  const guard = blankAgent(Obj.Guard); guard.id = 4; guard.x = 4.5; guard.z = 10.5; guard.decideT = 0;
  // The arrival is first in iteration order but cannot claim either bed.
  agents.agents.push(waitingArrival, resident, roommate, guard);
  agents.claimedBeds.set(resident.bedIdx, resident.id); agents.claimedBeds.set(roommate.bedIdx, roommate.id);
  for (let tick = 0; tick < 400 && resident.cuffed; tick++) agents.updateGuard(guard, .1, world);
  assert.equal(resident.cuffed, false, "a restrained resident returns to his own bed even when there is no spare capacity");
  assert.equal(resident.bedIdx, world.idx(6, 6), "returning home preserves the original housing assignment");
  assert.equal(agents.claimedBeds.size, 2, "an escort never duplicates a resident's bed claim");
  assert.equal(waitingArrival.cuffed, true, "a genuinely unassigned arrival still waits for capacity");
  assert.equal(agents.intakeBedClaims.size, 0, "the completed return releases its temporary reservation");
}

restrainedResidentReturnsToOwnedBedInFullPrison();

function staffBreakRetargets() {
  const world = new World(24), items = new ItemSystem(), institution = new InstitutionSystem(), health = new HealthSystem();
  const combat = new CombatSystem(health, institution, items), areas = new AreaSystem(world.size);
  const security = new SecuritySystem(items, institution, combat, health, areas);
  const staffTiles = new Set<number>([world.idx(5, 12)]);
  for (let z = 12; z <= 16; z++) for (let x = 4; x <= 8; x++) {
    const tile = world.idx(x, z); staffTiles.add(tile); world.roomId[tile] = 3;
  }
  world.roomId[world.idx(5, 12)] = 3;
  world.rooms.set(3, { id: 3, type: RoomType.StaffRoom, access: Access.Staff,
    tiles: staffTiles, valid: true, ambience: 0, guards: 0 });
  const worker = workman(40, 5.5, 5.5);
  worker.path = [world.idx(10, 5), world.idx(11, 5)]; worker.pathI = 0; worker.state = "toBuild";
  security.staff.set(worker.id, { agentId: worker.id, fatigue: .9, onBreak: true, breakUntil: 0, assignmentOpen: true });
  assert(security.updateStaff(worker, .1, 0, world, [worker]));
  assert(security.updateStaff(worker, .1, .1, world, [worker]));
  assert(worker.z > 5.5, "a staff break should replace a worker's previous construction route with the Staff Room route");
  assert.equal(worker.x, 5.5, "the stale eastbound construction route should not keep advancing");
}

staffBreakRetargets();

function staffBreaksAreStaggeredByRole() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics); task2.installNewGame(world);
  const cooks = Array.from({ length: 3 }, (_, i) => {
    const cook = blankAgent(Obj.Cook); cook.id = 80 + i; cook.x = 5.5 + i; cook.z = 5.5; return cook;
  });
  const guards = Array.from({ length: 6 }, (_, i) => {
    const guard = blankAgent(Obj.Guard); guard.id = 90 + i; guard.x = 5.5 + i; guard.z = 6.5; return guard;
  });
  const staff = [...cooks, ...guards];
  task2.security.tick(.1, .1, world, staff, false);
  for (const agent of staff) task2.security.staff.get(agent.id)!.fatigue = .9;
  task2.security.tick(.1, .2, world, staff, false);
  assert.equal(cooks.filter((agent) => task2.security.staff.get(agent.id)?.onBreak).length, 1,
    "only one of three cooks may leave service on fatigue break at a time");
  assert.equal(guards.filter((agent) => task2.security.staff.get(agent.id)?.onBreak).length, 2,
    "a guard roster may rotate two of six off duty while preserving coverage");
}

staffBreaksAreStaggeredByRole();

function constructionResumesAfterDuty(interruptDuringHaul: boolean) {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const construction = new ConstructionSystem(logistics), agents = new Agents();
  const task2 = new Task2Systems(world.size, economy, logistics); task2.installNewGame(world);
  const staffTiles = new Set<number>([world.idx(5, 12)]);
  for (let z = 12; z <= 16; z++) for (let x = 4; x <= 8; x++) staffTiles.add(world.idx(x, z));
  for (const tile of staffTiles) world.roomId[tile] = 3;
  world.rooms.set(3, { id: 3, type: RoomType.StaffRoom, access: Access.Staff,
    tiles: staffTiles, valid: true, ambience: 0, guards: 0 });
  const worker = workman(50, interruptDuringHaul ? 5.5 : 9.5, interruptDuringHaul ? 5.5 : 8.5);
  agents.agents.push(worker); agents.construction = construction; agents.task2 = task2;
  task2.ensureAgent(worker, 0);
  logistics.addSalvage("concrete", 2, 5, 5);
  const group = construction.plan({ cat: "floor", mat: 1 }, [{ x: 10, z: 8 }], 0, 0, world)!;
  const claim = construction.claimNext(worker.id, worker.x, worker.z, world, 0)!;
  assert(claim);
  worker.buildGroup = group.id; worker.buildTarget = claim.target.id; worker.interact = claim.packageId;
  if (interruptDuringHaul) {
    assert.equal(claim.phase, "haul");
    assert(construction.pickUpBundle(group.id, claim.target.id, claim.packageId, worker.id, worker.x, worker.z));
    assert(pathAdjacent(worker, world, world.idx(claim.target.x, claim.target.z), (i) => passable(world, i, true)));
    worker.state = "deliverBuildCargo";
  } else {
    assert.equal(claim.phase, "haul");
    assert(construction.pickUpBundle(group.id, claim.target.id, claim.packageId, worker.id, worker.x, worker.z));
    assert(construction.deliverBundle(group.id, claim.target.id, claim.packageId, worker.id));
    const build = construction.claimNext(worker.id, worker.x, worker.z, world, 0)!;
    assert.equal(build.phase, "work");
    worker.buildGroup = group.id; worker.buildTarget = build.target.id; worker.timer = build.target.workSeconds * .75;
    build.target.progress = .25; worker.state = "constructing";
  }
  task2.security.staff.set(worker.id, { agentId: worker.id, fatigue: .82, onBreak: true, breakUntil: 0, assignmentOpen: true });
  let sawBreak = false, sawCargoFollowBreak = false, simTime = 0, pausedTimer = -1, resumedAtSite = false, minimumResumeProgress = 1;
  for (let tick = 0; tick < 1800 && group.state !== "complete"; tick++) {
    simTime += .1;
    task2.tick(.1, simTime, world, agents.agents, false, false);
    agents.update(.1, world, false, 12, simTime);
    if (worker.state === "staffBreak") { sawBreak = true; if (pausedTimer < 0) pausedTimer = worker.timer; }
    if (!interruptDuringHaul && sawBreak && worker.state === "constructing") {
      resumedAtSite = true;
      assert(Math.abs(worker.x - claim.target.x) + Math.abs(worker.z - claim.target.z) < 1.6,
        "a paused builder must walk back to the active site before resuming work");
      assert(worker.timer <= pausedTimer + 1e-6, "resuming should preserve the remaining work time");
      minimumResumeProgress = Math.min(minimumResumeProgress, claim.target.progress);
    }
    if (interruptDuringHaul && worker.state === "staffBreak") {
      worker.interact = 999999; // break duties may overwrite this legacy scratch field
      const carried = [...logistics.packages.values()].find((pkg) => pkg.reservedBy === `build:${group.id}:${claim.target.id}`);
      if (carried?.state === "carried") {
        assert(Math.hypot(carried.x - worker.x, carried.z - worker.z) < .01,
          "a construction bundle should stay with its worker through a break route");
        sawCargoFollowBreak = true;
      }
    }
  }
  assert(sawBreak, "real simulation ticks should route fatigued staff to the Staff Room");
  assert.equal(group.state, "complete", "worker resumes the same construction claim after a staff break");
  if (!interruptDuringHaul) {
    assert(resumedAtSite, "the interrupted build should resume after the break");
    assert(minimumResumeProgress >= .25, "construction progress should not rewind on resumption");
  }
  if (interruptDuringHaul) assert(sawCargoFollowBreak, "the carried bundle should remain attached during staff break movement");
  assert.equal(world.floorMat[world.idx(10, 8)], 1);
}

constructionResumesAfterDuty(false);
constructionResumesAfterDuty(true);

function blockedCargoBackoffRecovers() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const kitchen = new KitchenSystem(logistics), agents = new Agents(), worker = workman(60, 4.5, 6.5);
  agents.agents.push(worker); agents.kitchen = kitchen;
  assert(world.placePiece(3, 10, Obj.Bookshelf, 0));
  kitchen.tick(0, world); // establish the library's capacity before salvaged stock arrives
  for (let z = 0; z < world.size; z++) world.setWall(8, z, 1);
  logistics.addSalvage("book", 1, 12, 6);
  const book = [...logistics.packages.values()][0]; book.state = "delivery";
  let time = 0;
  for (let tick = 0; tick < 50; tick++) { time += .1; agents.update(.1, world, false, 12, time); }
  assert.equal(book.reservedBy, null, "an unreachable book package should be released instead of held forever");
  assert.equal(worker.state, "idle", "an unreachable route should settle the workman into a backoff state");
  world.erase(8, 6); // a newly opened route should make the same package reachable
  for (let tick = 0; tick < 400; tick++) { time += .1; agents.update(.1, world, false, 12, time); }
  assert(book.state === "carried" || book.reservedBy !== null || kitchen.books > 0,
    "the blocked cargo should be retried after the route becomes available");
  assert(["toBookCargo", "deliverBookCargo", "idle"].includes(worker.state), "recovered book delivery stays in the normal workman flow");
}

blockedCargoBackoffRecovers();

function cookCargoResumesAfterBreak() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics), kitchen = new KitchenSystem(logistics);
  const agents = new Agents(), cook = blankAgent(Obj.Cook);
  task2.installNewGame(world); agents.task2 = task2; agents.kitchen = kitchen;
  cook.id = 62; cook.x = 10.5; cook.z = 12.5; cook.state = "staffBreak"; cook.interact = 999999;
  const freezer = world.idx(13, 12); assert(world.placePiece(13, 12, Obj.Freezer, 0));
  kitchen.tick(0, world);
  const staffTiles = new Set<number>();
  for (let z = 2; z <= 5; z++) for (let x = 2; x <= 5; x++) staffTiles.add(world.idx(x, z));
  world.rooms.set(8, { id: 8, type: RoomType.StaffRoom, access: Access.Staff, tiles: staffTiles, valid: true, ambience: 0, guards: 0 });
  task2.areas.recompute(world);
  const cookArea = task2.areas.areaAt[world.idx(Math.floor(cook.x), Math.floor(cook.z))];
  task2.security.postings.set(cook.id, { areaId: cookArea, role: "cook" });
  task2.security.deploymentTargets.set(cookArea, { cook: 1 });
  logistics.addSalvage("frozen-meal", 1, cook.x, cook.z);
  const pkg = [...logistics.packages.values()][0]!;
  pkg.state = "carried"; pkg.reservedBy = `cook:${cook.id}`;
  agents.agents.push(cook);
  task2.ensureAgent(cook, 0);
  task2.security.staff.set(cook.id, { agentId: cook.id, fatigue: .9, onBreak: true, breakUntil: 0, assignmentOpen: true });

  let time = .1;
  agents.update(.1, world, false, 12, time);
  assert.equal(cook.state, "staffBreak", "the cook should remain in the break route while fatigued");
  task2.security.staff.get(cook.id)!.onBreak = false;
  for (let tick = 0; tick < 500 && logistics.packages.has(pkg.id); tick++) {
    time += .1; agents.update(.1, world, false, 12, time);
  }
  assert.equal(logistics.packages.has(pkg.id), false, "the interrupted frozen-meal delivery should resume and complete");
  assert.equal(kitchen.frozenMeals, 1);
  assert.equal(cook.state, "idle");
  assert.equal(freezer, world.idx(13, 12));
}

cookCargoResumesAfterBreak();

function cookPrioritizesMealServiceAndStarvingDiners() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  assert(world.placePiece(5, 5, Obj.Cooker, 0));
  assert(world.placePiece(9, 5, Obj.ServingTable, 0));
  assert(world.placePiece(3, 5, Obj.Freezer, 0));
  const cooker = world.idx(5, 5), servingTable = world.idx(9, 5);
  world.roomId[cooker] = 1; world.roomId[world.idx(4, 5)] = 1;
  world.roomId[servingTable] = 2; world.roomId[world.idx(8, 5)] = 2;
  world.rooms.set(1, { id: 1, type: RoomType.Kitchen, access: Access.Staff,
    tiles: new Set([cooker, world.idx(4, 5)]), valid: true, ambience: 0, guards: 0 });
  world.rooms.set(2, { id: 2, type: RoomType.Canteen, access: Access.Public,
    tiles: new Set([servingTable, world.idx(8, 5)]), valid: true, ambience: 0, guards: 0 });
  const kitchen = new KitchenSystem(logistics), agents = new Agents();
  agents.kitchen = kitchen; agents.curActivity = REG.Eating;
  kitchen.tick(0, world);
  kitchen.frozenMeals = 95; kitchen.cleanTrays = 9; kitchen.cleanSpoons = 9;
  agents.servingStock.set(servingTable, 1);
  logistics.addSalvage("frozen-meal", 1, 19, 19);
  const delivery = [...logistics.packages.values()].find((pkg) => pkg.commodity === "frozen-meal")!;
  delivery.state = "delivery";
  const cook = blankAgent(Obj.Cook); cook.id = 62; cook.x = 8.5; cook.z = 7.5;
  agents.agents.push(cook);

  agents.update(.1, world, false, 7, .1);
  assert.equal(cook.state, "toServeDuty", "a cook should man stocked food before taking routine kitchen cargo");
  assert.equal(delivery.reservedBy, null, "a full freezer does not justify an off-route meal pickup during service");

  const starvingCook = blankAgent(Obj.Cook); starvingCook.id = 63; starvingCook.x = 8.5; starvingCook.z = 7.5;
  const prisoner = blankAgent(Obj.Prisoner); prisoner.id = 64; prisoner.cuffed = false; prisoner.needs.food = .1;
  agents.agents.push(starvingCook, prisoner);
  agents.curActivity = REG.Free;
  cook.state = "idle"; cook.path = null;
  agents.servers.clear();
  agents.update(.1, world, false, 10, .2);
  assert.equal(starvingCook.state, "toServeDuty", "a stocked counter gets staffed for a starving inmate outside scheduled meal hours");
}

cookPrioritizesMealServiceAndStarvingDiners();

function kitchenRestockUsesStableBatches() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  assert(world.placePiece(4, 4, Obj.Freezer, 0));
  assert(world.placePiece(8, 4, Obj.ServingTable, 0));
  const kitchen = new KitchenSystem(logistics);
  const requests = (commodity: string) => logistics.saveData().requests.filter((row) => row.commodity === commodity);

  kitchen.tick(0, world);
  assert.equal(requests("frozen-meal").reduce((sum, row) => sum + row.quantity, 0), 48,
    "an empty freezer requests its full initial target");
  kitchen.tick(.1, world);
  assert.equal(requests("frozen-meal").length, 1);
  assert.equal(requests("frozen-meal")[0]!.quantity, 48,
    "repeated restock ticks keep one stable demand instead of multiplying requests");

  kitchen.frozenMeals = 47;
  kitchen.tick(.2, world);
  assert.equal(requests("frozen-meal").length, 0,
    "a one-meal deficit does not create an individual truck shipment");
  kitchen.frozenMeals = 36;
  kitchen.tick(.3, world);
  assert.equal(requests("frozen-meal").reduce((sum, row) => sum + row.quantity, 0), 12,
    "restock starts at a quarter-capacity deficit and requests a useful batch");

  kitchen.cleanTrays = 5; kitchen.cleanSpoons = 5;
  kitchen.tick(.4, world);
  assert.equal(requests("tray").length + requests("spoon").length, 0,
    "one missing place setting does not trigger cutlery trucks");
  kitchen.cleanTrays = 3; kitchen.cleanSpoons = 3;
  kitchen.tick(.5, world);
  assert.equal(requests("tray")[0]?.quantity, 3);
  assert.equal(requests("spoon")[0]?.quantity, 3);
}

kitchenRestockUsesStableBatches();

function cookRecyclesLowCutleryBeforeTakingASupplyRoute() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  const cooker = world.idx(5, 5), serving = world.idx(10, 5), sink = world.idx(15, 5);
  assert(world.placePiece(5, 5, Obj.Cooker, 0));
  assert(world.placePiece(10, 5, Obj.ServingTable, 0));
  assert(world.placePiece(15, 5, Obj.Sink, 0));
  world.roomId[cooker] = 1; world.roomId[world.idx(4, 5)] = 1;
  world.roomId[serving] = 2; world.roomId[world.idx(9, 5)] = 2;
  world.rooms.set(1, { id: 1, type: RoomType.Kitchen, access: Access.Staff,
    tiles: new Set([cooker, world.idx(4, 5)]), valid: true, ambience: 0, guards: 0 });
  world.rooms.set(2, { id: 2, type: RoomType.Canteen, access: Access.Public,
    tiles: new Set([serving, world.idx(9, 5)]), valid: true, ambience: 0, guards: 0 });
  const kitchen = new KitchenSystem(logistics), agents = new Agents();
  agents.kitchen = kitchen;
  kitchen.tick(0, world);
  kitchen.frozenMeals = 6; kitchen.cleanTrays = 0; kitchen.cleanSpoons = 1;
  kitchen.dirtyTrays = 2; kitchen.dirtySpoons = 2;
  logistics.addSalvage("tray", 3, 20, 20);
  const shipment = [...logistics.packages.values()].find((pkg) => pkg.commodity === "tray")!;
  shipment.state = "delivery";
  const cook = blankAgent(Obj.Cook); cook.id = 91; cook.x = 9.5; cook.z = 8.5;
  agents.agents.push(cook);
  agents.update(.1, world, false, 12, .1);
  assert.equal(cook.state, "toSink", "a nearly exhausted setting stock should be replenished from dirty items first");
  assert.equal(shipment.reservedBy, null, "washing on hand should beat a distant cutlery supply haul");
}

cookRecyclesLowCutleryBeforeTakingASupplyRoute();

function liveCookBreakAndStolenSpoonWashCycle() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  assert(world.placePiece(5, 5, Obj.Sink, 0));
  assert(world.placePiece(8, 8, Obj.Cooker, 0));
  assert(world.placePiece(12, 8, Obj.ServingTable, 0));
  const task2 = new Task2Systems(world.size, economy, logistics), kitchen = new KitchenSystem(logistics);
  task2.installNewGame(world);
  const staffTile = world.idx(12, 12);
  world.roomId[staffTile] = 3;
  world.rooms.set(3, { id: 3, type: RoomType.StaffRoom, access: Access.Staff,
    tiles: new Set([staffTile]), valid: true, ambience: 0, guards: 0 });
  const cookerTile = world.idx(8, 8), serviceTile = world.idx(12, 8);
  world.roomId[cookerTile] = 4; world.roomId[world.idx(7, 8)] = 4;
  world.roomId[serviceTile] = 5; world.roomId[world.idx(11, 8)] = 5;
  world.rooms.set(4, { id: 4, type: RoomType.Kitchen, access: Access.Staff,
    tiles: new Set([cookerTile, world.idx(7, 8)]), valid: true, ambience: 0, guards: 0 });
  world.rooms.set(5, { id: 5, type: RoomType.Canteen, access: Access.Public,
    tiles: new Set([serviceTile, world.idx(11, 8)]), valid: true, ambience: 0, guards: 0 });
  kitchen.physicalItems = task2.items;
  const agents = new Agents(); agents.task2 = task2; agents.kitchen = kitchen; agents.regime.fill(REG.Free);
  const cooks = [0, 1, 2].map((i) => {
    const cook = blankAgent(Obj.Cook); cook.id = 80 + i; cook.x = 7.5 + i; cook.z = 5.5;
    agents.agents.push(cook); task2.ensureAgent(cook, 0); return cook;
  });
  const prisoner = blankAgent(Obj.Prisoner); prisoner.id = 90; task2.ensureAgent(prisoner, 0);
  kitchen.tick(0, world);
  kitchen.frozenMeals = 1; kitchen.cleanTrays = 1; kitchen.cleanSpoons = 1;
  for (const id of task2.items.createMany("tray", 1, 0,
    { locationKind: "container", containerId: "institution:kitchen-clean" })) assert(id > 0);
  for (const id of task2.items.createMany("spoon", 1, 0,
    { locationKind: "container", containerId: "institution:kitchen-clean" })) assert(id > 0);

  const interruptedCook = cooks[0]!;
  interruptedCook.cookerIdx = cookerTile;
  agents.claimedCookers.set(cookerTile, interruptedCook.id);
  interruptedCook.state = "toCooker";
  assert(kitchen.reserveMealSet(interruptedCook.id), "the cook should reserve a meal setting before the break");
  assert.equal(kitchen.preparedSettings, 1);
  assert.equal(kitchen.finishMeal(true, prisoner.id), true, "a prisoner steals the spoon from the finished meal");
  assert.equal(kitchen.dirtyTrays, 1); assert.equal(kitchen.dirtySpoons, 0);
  task2.security.staff.set(interruptedCook.id,
    { agentId: interruptedCook.id, fatigue: .9, onBreak: true, breakUntil: 0, assignmentOpen: true });

  let time = 12 * 3600;
  assert(task2.security.updateStaff(interruptedCook, .1, time, world, agents.agents));
  agents.update(.1, world, false, 12, time += .1);
  assert.equal(interruptedCook.state, "staffBreak", "a fatigued cook is routed to the Staff Room");
  assert.equal(kitchen.preparedSettings, 0, "the break releases an undelivered meal reservation");
  assert.equal(kitchen.cleanTrays, 1, "the undelivered tray returns to kitchen stock");
  assert.equal(kitchen.cleanSpoons, 1, "the undelivered spoon returns to kitchen stock");
  assert.equal(interruptedCook.cookerIdx, -1, "a cook on break must release the stove claim");
  assert.equal(agents.claimedCookers.has(cookerTile), false, "the available stove claim must not stay pinned to a break");
  agents.update(.1, world, false, 12, time += .1);
  const replacementCook = cooks.find((candidate) => candidate !== interruptedCook && candidate.state === "toCooker");
  assert(replacementCook, "another cook should use a stove while a colleague is on break");
  assert.equal(agents.claimedCookers.get(cookerTile), replacementCook.id);
  task2.security.staff.get(interruptedCook.id)!.onBreak = false;

  for (let tick = 0; tick < 300 && kitchen.dirtyTrays > 0; tick++) {
    agents.update(.1, world, false, 12, time += .1);
  }
  assert.equal(cooks.length, 3, "all three cooks continue through the live agent update loop");
  assert.equal(kitchen.dirtyTrays, 0, "a cook washes the stolen-spoon meal's tray instead of leaving it stuck");
  assert.equal(kitchen.totalTrays(), 2, "the replacement cook reservation preserves the returned tray in the owned-setting total");
}

liveCookBreakAndStolenSpoonWashCycle();

function interruptedCasualtyTransportCanBeReclaimed() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  assert(world.placePiece(12, 12, Obj.MedicalBed, 0));
  assert(world.placePiece(14, 12, Obj.MedicalBed, 0));
  const task2 = new Task2Systems(world.size, economy, logistics);
  task2.installNewGame(world);
  const bed = world.idx(12, 12), bed2 = world.idx(14, 12), tiles = new Set<number>([bed, bed2]);
  world.roomId[bed] = 8; world.roomId[bed2] = 8;
  world.rooms.set(8, { id: 8, type: RoomType.Infirmary, access: Access.Staff,
    tiles, valid: true, ambience: 0, guards: 0 });
  const victim = blankAgent(Obj.Prisoner), firstGuard = blankAgent(Obj.Guard), nextGuard = blankAgent(Obj.Guard);
  victim.id = 100; victim.x = 5.5; victim.z = 5.5; victim.state = "incapacitated";
  firstGuard.id = 101; firstGuard.x = 5.5; firstGuard.z = 5.5;
  nextGuard.id = 102; nextGuard.x = 6.5; nextGuard.z = 5.5;
  const roster = [victim, firstGuard, nextGuard];
  for (const agent of roster) task2.ensureAgent(agent, 0);
  task2.health.requestMedicalCheck(victim);
  const job = task2.health.treatmentJobs[0]!;

  for (let z = 0; z < world.size; z++) world.setWall(9, z, 1);
  assert(task2.security.updateStaff(firstGuard, .1, 0, world, roster));
  assert.equal(victim.state, "beingTransported");
  assert.equal(job.transportGuardId, firstGuard.id);
  for (let tick = 0; tick < 60; tick++) {
    task2.security.updateStaff(firstGuard, .1, tick * .1, world, roster);
    task2.health.tick(.1, tick * .1, world, roster, task2.items);
  }
  assert.equal(job.state, "waiting", "a blocked medical route must not falsely admit the patient");
  assert.equal(task2.health.state(victim.id)!.admitted, false);
  assert(victim.x < 9, "a patient must stay on the near side of an impassable route");
  assert(task2.security.warnings.has("A staff response route is blocked"));

  for (let z = 0; z < world.size; z++) { world.erase(9, z); world.setFloor(9, z, 1); }
  for (let tick = 0; tick < 500 && job.state === "waiting"; tick++) {
    task2.security.updateStaff(firstGuard, .1, 6 + tick * .1, world, roster);
    task2.health.tick(.1, 6 + tick * .1, world, roster, task2.items);
  }
  assert.equal(job.state, "transported", "the same casualty route resumes when the wall is removed");
  assert.equal(task2.health.state(victim.id)!.admitted, true);

  const secondVictim = blankAgent(Obj.Prisoner); secondVictim.id = 103;
  secondVictim.x = 5.5; secondVictim.z = 6.5; secondVictim.state = "incapacitated";
  roster.push(secondVictim); task2.ensureAgent(secondVictim, 0); task2.health.requestMedicalCheck(secondVictim);
  const nextJob = task2.health.treatmentJobs.find((row) => row.patientId === secondVictim.id)!;
  for (let tick = 0; tick < 200 && nextJob.transportGuardId === undefined; tick++)
    task2.security.updateStaff(firstGuard, .1, 60 + tick * .1, world, roster);
  assert.equal(nextJob.transportGuardId, firstGuard.id);
  assert.equal(firstGuard.state, "toCasualty", "the guard walks to a distant casualty before carrying him");
  for (let tick = 0; tick < 1000 && secondVictim.state !== "beingTransported"; tick++)
    task2.security.updateStaff(firstGuard, .1, 80 + tick * .1, world, roster);
  assert.equal(secondVictim.state, "beingTransported", "the patient enters transport only after the guard reaches him");
  firstGuard.state = "patrol"; // a higher-priority guard duty preempts the carry
  task2.health.tick(.1, 60.1, world, roster, task2.items);
  assert.equal(secondVictim.state, "idle", "health clears the transport pose when its guard leaves the carry");
  assert.equal(nextJob.transportGuardId, undefined);

  for (let tick = 0; tick < 200 && nextJob.transportGuardId === undefined; tick++)
    task2.security.updateStaff(nextGuard, .1, 80 + tick * .1, world, roster);
  assert.equal(nextJob.transportGuardId, nextGuard.id, "another guard claims the waiting medical job");
  assert.equal(secondVictim.state, "beingTransported");
}

interruptedCasualtyTransportCanBeReclaimed();

function intakeEscortCompletesBeforeBreak() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics), agents = new Agents();
  task2.installNewGame(world); agents.task2 = task2;
  const cellTiles = new Set<number>();
  for (let z = 6; z <= 12; z++) for (let x = 6; x <= 12; x++) {
    const tile = world.idx(x, z); cellTiles.add(tile); world.roomId[tile] = 7;
  }
  const bed = world.idx(9, 9); assert(world.placePiece(9, 9, Obj.Bed, 0));
  world.rooms.set(7, { id: 7, type: RoomType.Cell, access: Access.Prisoners, tiles: cellTiles, valid: true, ambience: 0, guards: 0 });
  const guard = blankAgent(Obj.Guard), prisoner = blankAgent(Obj.Prisoner);
  guard.id = 70; guard.x = 8.5; guard.z = 8.5; guard.aux = 7; guard.interact = 71; guard.chaseId = bed;
  prisoner.id = 71; prisoner.x = 8.5; prisoner.z = 8.5; prisoner.cuffed = true; prisoner.escortedBy = guard.id; prisoner.state = "escorted";
  assert(pathAdjacent(guard, world, bed, (i) => passable(world, i, true)));
  guard.state = "intakeEscort";
  agents.intakeBedClaims.set(bed, prisoner.id);
  agents.agents.push(prisoner, guard); task2.ensureAgent(prisoner, 0); task2.ensureAgent(guard, 0);
  task2.security.staff.set(guard.id, { agentId: guard.id, fatigue: .9, onBreak: true, breakUntil: 0, assignmentOpen: true });
  let time = 0;
  for (let tick = 0; tick < 120 && guard.state === "intakeEscort"; tick++) {
    time += .1; task2.tick(.1, time, world, agents.agents, false, false); agents.update(.1, world, false, 12, time);
  }
  assert.equal(prisoner.cuffed, false, "fatigue should not interrupt a paired intake handover");
  assert.equal(prisoner.escortedBy, -1, "completed intake releases the prisoner escort owner");
  assert.equal(prisoner.cellRoom, 7); assert.equal(prisoner.bedIdx, bed);
  assert.equal(agents.claimedBeds.get(bed), prisoner.id);

  task2.health.state(guard.id)!.alive = false; guard.state = "dead";
  prisoner.cuffed = true; prisoner.state = "escorted"; prisoner.escortedBy = guard.id;
  agents.update(.1, world, false, 12, time + .1);
  assert.equal(prisoner.escortedBy, -1, "a dead escort is released instead of leaving a dangling prisoner claim");
  assert.equal(prisoner.state, "cuffed", "a prisoner whose guard dies returns to the cuffed state");
}

intakeEscortCompletesBeforeBreak();

function regimeEscortKeepsItsPairedOwner() {
  const world = new World(24), agents = new Agents();
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  const prisoner = blankAgent(Obj.Prisoner), guard = blankAgent(Obj.Guard);
  prisoner.id = 111; prisoner.x = 4.5; prisoner.z = 4.5; prisoner.state = "escorted";
  guard.id = 112; guard.x = 2.5; guard.z = 2.5; guard.state = "regimeEscort"; guard.interact = prisoner.id;
  prisoner.escortedBy = guard.id;
  guard.path = [world.idx(3, 2), world.idx(4, 2), world.idx(5, 2)]; guard.pathI = 0;
  agents.agents.push(prisoner, guard);
  (agents as unknown as { tickPrisonerNeeds: (actor: typeof prisoner, dt: number, map: World) => void })
    .tickPrisonerNeeds(prisoner, .1, world);
  assert.equal(prisoner.escortedBy, guard.id, "per-tick needs cleanup must retain a noncuffed regime escort");
  agents.update(.1, world, false, 12, .1);
  assert.equal(prisoner.state, "escorted", "an active regime escort remains a paired movement state");
  assert.equal(prisoner.escortedBy, guard.id, "need upkeep must not clear an assigned regime escort");
}

regimeEscortKeepsItsPairedOwner();

function deathReleasesPrisonerOwnershipThroughHearse() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  const task2 = new Task2Systems(world.size, economy, logistics), kitchen = new KitchenSystem(logistics), agents = new Agents();
  task2.installNewGame(world); agents.task2 = task2; agents.kitchen = kitchen; kitchen.physicalItems = task2.items;
  const cell = world.idx(6, 6), slab = world.idx(12, 6);
  assert(world.placePiece(6, 6, Obj.Bed, 0)); assert(world.placePiece(10, 6, Obj.Bookshelf, 0));
  assert(world.placePiece(12, 6, Obj.MorgueSlab, 0));
  const cellTiles = new Set([cell]); world.roomId[cell] = 2;
  world.rooms.set(2, { id: 2, type: RoomType.Cell, access: Access.Prisoners, tiles: cellTiles, valid: true, ambience: 0, guards: 0 });
  const morgueTiles = new Set([slab]); world.roomId[slab] = 3;
  world.rooms.set(3, { id: 3, type: RoomType.Morgue, access: Access.Staff, tiles: morgueTiles, valid: true, ambience: 0, guards: 0 });

  const victim = blankAgent(Obj.Prisoner), guard = blankAgent(Obj.Guard), newcomer = blankAgent(Obj.Prisoner);
  victim.id = 110; victim.x = 5.5; victim.z = 6.5; victim.cellRoom = 2; victim.bedIdx = cell; victim.state = "idle";
  guard.id = 111; guard.x = 5.5; guard.z = 6.5;
  newcomer.id = 112;
  agents.agents.push(victim, guard); task2.ensureAgent(victim, 0); task2.ensureAgent(guard, 0);
  kitchen.tick(0, world);
  agents.claimedBeds.set(cell, victim.id); agents.intakeBedClaims.set(cell, victim.id);
  const table = world.idx(8, 6); victim.useIdx = table; agents.useClaims.set(table, new Set([victim.id]));
  kitchen.books = 1; assert(kitchen.borrowBook()); stow(victim.inv, Item.Book);
  const bookId = task2.items.createMany("book", 1, 0)[0]!;
  assert(task2.items.moveToContainer(bookId, `agent:${victim.id}:pockets`, 0));

  task2.health.state(victim.id)!.blood = .01;
  task2.health.tick(.1, 1, world, agents.agents, task2.items);
  assert.equal(victim.state, "dead"); assert(task2.health.bodies.has(victim.id));
  agents.update(.1, world, false, 12, 1.1);
  assert.equal(agents.prisonerCount(), 0, "dead prisoners do not consume population capacity");
  assert.equal(victim.bedIdx, -1); assert.equal(victim.cellRoom, -1);
  assert.equal(agents.claimedBeds.has(cell), false, "death frees the prisoner's bed claim");
  assert.equal(agents.intakeBedClaims.has(cell), false, "death clears a pending intake bed claim");
  assert.equal(agents.useClaims.has(table), false, "death releases a use-slot claim");
  assert.equal(kitchen.borrowedBooks, 0); assert.equal(kitchen.books, 1, "a dead borrower's book returns to library stock");
  assert.equal(task2.items.itemsIn("institution:library-stock").filter((item) => item.defId === "book").length, 1);
  assert.equal(task2.items.itemsIn(`body:${victim.id}:loot`).some((item) => item.defId === "book"), false,
    "the book is not orphaned in the body loot after its ownership returns to the library");
  assert.equal(agents.findFreeCell(world, newcomer)?.id, 2, "the freed cell can receive the next prisoner");

  assert(task2.health.discoverBody(victim.id));
  let time = 1.2;
  for (let tick = 0; tick < 500 && task2.health.bodies.get(victim.id)!.morgueSlab < 0; tick++) {
    time += .1; agents.update(.1, world, false, 12, time);
  }
  assert.equal(task2.health.bodies.get(victim.id)!.morgueSlab, slab, "staff carry the dead body to a Morgue slab");
  task2.health.tick(.1, 180, world, agents.agents, task2.items);
  agents.update(.1, world, false, 6, 180.1);
  assert.equal(victim.state, "removed", "the hearse removes the morgue body without reoccupying claims");
  assert.equal(agents.prisonerCount(), 0);
  assert.equal(agents.claimedBeds.size, 0); assert.equal(agents.intakeBedClaims.size, 0);
  assert.equal(agents.findFreeCell(world, newcomer)?.id, 2);
}

deathReleasesPrisonerOwnershipThroughHearse();

function policyEscortsWaitForReachableDestinations() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  const task2 = new Task2Systems(world.size, economy, logistics), agents = new Agents();
  task2.installNewGame(world); agents.task2 = task2;
  assert(world.placePiece(12, 6, Obj.Bed, 0)); assert(world.placePiece(16, 6, Obj.Bed, 0));
  const cellTiles = new Set([world.idx(12, 6)]), solitaryTiles = new Set([world.idx(16, 6)]);
  world.roomId[world.idx(12, 6)] = 4; world.roomId[world.idx(16, 6)] = 5;
  world.rooms.set(4, { id: 4, type: RoomType.Cell, access: Access.Prisoners, tiles: cellTiles, valid: true, ambience: 0, guards: 0 });
  world.rooms.set(5, { id: 5, type: RoomType.Solitary, access: Access.Prisoners, tiles: solitaryTiles, valid: true, ambience: 0, guards: 0 });
  const prisoner = blankAgent(Obj.Prisoner), officer = blankAgent(Obj.Guard);
  prisoner.id = 120; prisoner.x = 5.5; prisoner.z = 6.5; prisoner.cellRoom = 4; prisoner.bedIdx = world.idx(12, 6);
  officer.id = 121; officer.x = 5.5; officer.z = 6.5;
  agents.agents.push(prisoner, officer); task2.ensureAgent(prisoner, 0); task2.ensureAgent(officer, 0);
  agents.claimedBeds.set(prisoner.bedIdx, prisoner.id);
  for (let z = 0; z < world.size; z++) world.setWall(8, z, 1);

  const searchRule = task2.institution.ruleFor("theft");
  task2.institution.setItemOverride("theft", "", { ...searchRule, search: "cell", interrogate: false, solitaryHours: 0 });
  const searchIncident = task2.institution.createIncident("theft", prisoner.id, -1, prisoner.x, prisoner.z, 0);
  const searchOrder = { incidentId: searchIncident.id, prisonerId: prisoner.id, solitaryUntil: 0,
    custodyUp: false, search: "cell" as const, interrogate: false, state: "queued" as const };
  task2.institution.punishments.push(searchOrder);
  task2.security.updateStaff(officer, .1, 0, world, agents.agents);
  for (let tick = 0; tick < 50; tick++) task2.security.updateStaff(officer, .1, tick * .1, world, agents.agents);
  assert.equal(searchOrder.state, "queued", "an inaccessible search destination cannot advance the policy phase");
  assert.equal(officer.state, "escortingToSearch"); assert(officer.x < 8);

  for (let z = 0; z < world.size; z++) { world.erase(8, z); world.setFloor(8, z, 1); }
  for (let tick = 0; tick < 300 && searchOrder.state === "queued"; tick++)
    task2.security.updateStaff(officer, .1, 5 + tick * .1, world, agents.agents);
  assert.equal(searchOrder.state, "complete", "the search resumes and completes when the route opens");

  const solitaryRule = task2.institution.ruleFor("refusal");
  task2.institution.setItemOverride("refusal", "", { ...solitaryRule, search: "none", interrogate: false, solitaryHours: 2 });
  const nextPrisoner = blankAgent(Obj.Prisoner); nextPrisoner.id = 122; nextPrisoner.x = 5.5; nextPrisoner.z = 7.5;
  agents.agents.push(nextPrisoner); task2.ensureAgent(nextPrisoner, 0);
  officer.x = nextPrisoner.x; officer.z = nextPrisoner.z; officer.path = null; officer.state = "idle";
  const solitaryIncident = task2.institution.createIncident("refusal", nextPrisoner.id, -1, nextPrisoner.x, nextPrisoner.z, 40);
  const solitaryOrder = { incidentId: solitaryIncident.id, prisonerId: nextPrisoner.id, solitaryUntil: 0,
    custodyUp: false, search: "none" as const, interrogate: false, state: "queued" as const };
  task2.institution.punishments.push(solitaryOrder);
  for (let z = 0; z < world.size; z++) world.setWall(8, z, 1);
  for (let tick = 0; tick < 50; tick++) task2.security.updateStaff(officer, .1, 40 + tick * .1, world, agents.agents);
  assert.equal(solitaryOrder.state, "queued", "an inaccessible Solitary destination cannot activate the order");
  assert.equal(nextPrisoner.state, "policyEscort"); assert(officer.x < 8);
}

policyEscortsWaitForReachableDestinations();

function departingStaffReleaseCookAndWorkCargo() {
  const world = new World(24), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  for (let z = 0; z < world.size; z++) for (let x = 0; x < world.size; x++) world.setFloor(x, z, 1);
  const task2 = new Task2Systems(world.size, economy, logistics), kitchen = new KitchenSystem(logistics), agents = new Agents();
  task2.installNewGame(world); agents.task2 = task2; agents.kitchen = kitchen; kitchen.physicalItems = task2.items;
  assert(world.placePiece(4, 4, Obj.Freezer, 0)); assert(world.placePiece(7, 4, Obj.Cooker, 0));
  assert(world.placePiece(10, 4, Obj.ServingTable, 0)); assert(world.placePiece(12, 4, Obj.Sink, 0));
  kitchen.tick(0, world);
  kitchen.frozenMeals = 4; kitchen.cleanTrays = 4; kitchen.cleanSpoons = 4;
  task2.items.createMany("tray", 4, 0, { locationKind: "container", containerId: "institution:kitchen-clean" });
  task2.items.createMany("spoon", 4, 0, { locationKind: "container", containerId: "institution:kitchen-clean" });

  const cook = blankAgent(Obj.Cook); cook.id = 130; cook.x = 6.5; cook.z = 4.5; cook.state = "cooking"; cook.cookerIdx = world.idx(7, 4);
  const firedCook = blankAgent(Obj.Cook); firedCook.id = 131; firedCook.x = 7.5; firedCook.z = 5.5; firedCook.state = "deliverCargo";
  const workman = workmanAgent(132, 9.5, 6.5);
  const firedWorkman = workmanAgent(133, 10.5, 6.5);
  agents.agents.push(cook, firedCook, workman, firedWorkman);
  for (const agent of agents.agents) task2.ensureAgent(agent, 0);
  agents.claimedCookers.set(cook.cookerIdx, cook.id); agents.servers.set(world.idx(10, 4), firedCook.id);
  assert(kitchen.reserveMealSet(cook.id));
  task2.health.state(cook.id)!.alive = false; cook.state = "dead";
  agents.update(.1, world, false, 12, 1);
  assert.equal(kitchen.preparedSettings, 0, "death releases the cook's in-progress meal reservation");
  assert.equal(kitchen.frozenMeals, 4); assert.equal(kitchen.cleanTrays, 4); assert.equal(kitchen.cleanSpoons, 4);
  assert.equal(agents.claimedCookers.has(world.idx(7, 4)), false, "death releases the cooker assignment");

  logistics.addSalvage("frozen-meal", 1, firedCook.x, firedCook.z);
  const frozen = [...logistics.packages.values()].filter((pkg) => pkg.commodity === "frozen-meal").at(-1)!;
  frozen.reservedBy = `cook:${firedCook.id}`; frozen.state = "carried";
  logistics.addSalvage("book", 1, workman.x, workman.z);
  const book = [...logistics.packages.values()].filter((pkg) => pkg.commodity === "book").at(-1)!;
  book.reservedBy = `workman:${workman.id}`; book.state = "carried";
  logistics.addSalvage("concrete", 1, firedWorkman.x, firedWorkman.z);
  const exportPkg = [...logistics.packages.values()].filter((pkg) => pkg.commodity === "concrete").at(-1)!;
  exportPkg.reservedBy = `workman:${firedWorkman.id}`; exportPkg.state = "carried";
  agents.removeAgent(firedCook);
  task2.health.state(workman.id)!.alive = false; workman.state = "dead";
  agents.update(.1, world, false, 12, 2);
  agents.removeAgent(firedWorkman);
  assert.equal(frozen.reservedBy, null); assert.equal(frozen.state, "delivery");
  assert.equal(frozen.x, firedCook.x); assert.equal(frozen.z, firedCook.z);
  assert.equal(book.reservedBy, null); assert.equal(book.state, "delivery");
  assert.equal(book.x, workman.x); assert.equal(book.z, workman.z);
  assert.equal(exportPkg.reservedBy, null); assert.equal(exportPkg.state, "site");
  assert.equal(exportPkg.x, firedWorkman.x); assert.equal(exportPkg.z, firedWorkman.z);
  assert.equal(agents.servers.has(world.idx(10, 4)), false, "removing a cook releases serving duty");
}

function workmanAgent(id: number, x: number, z: number) {
  const agent = blankAgent(Obj.Workman); agent.id = id; agent.x = x; agent.z = z; return agent;
}

departingStaffReleaseCookAndWorkCargo();
console.log("live workman construction/cargo recovery, kitchen claim persistence, escape-task needs upkeep, cook break/theft/wash/departure recovery, prisoner needs/intake, death/morgue cleanup, policy routing, and guard chase: ok");
