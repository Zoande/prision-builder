import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankAgent, ESCAPE_MARGIN, type Agent } from "../src/sim/agent.ts";
import { AreaSystem } from "../src/sim/areas.ts";
import { CombatSystem } from "../src/sim/combat.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { EscapeOperationsSystem } from "../src/sim/escapeOperations.ts";
import { GangSystem } from "../src/sim/gangs.ts";
import { HealthSystem, BODY_REGIONS } from "../src/sim/health.ts";
import { InstitutionSystem } from "../src/sim/institution.ts";
import { ItemSystem } from "../src/sim/itemSystem.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { MarketSystem } from "../src/sim/market.ts";
import { passable } from "../src/sim/nav.ts";
import { Obj, RoomType } from "../src/sim/objects.ts";
import { freshPrisonerMind, generatePrisonerProfile } from "../src/sim/profiles.ts";
import { SecuritySystem } from "../src/sim/security.ts";
import { PrisonerSocialSystem } from "../src/sim/social.ts";
import { Task2Systems } from "../src/sim/task2Systems.ts";
import { WorkSystem } from "../src/sim/work.ts";
import { World } from "../src/sim/world.ts";

function inmate(id: number, x = 4.5, z = 4.5): Agent {
  const agent = blankAgent(Obj.Prisoner); agent.id = id; agent.x = x; agent.z = z;
  agent.profile = generatePrisonerProfile(id, 0xabc000 + id);
  agent.mind = freshPrisonerMind(agent.profile); agent.cuffed = false;
  return agent;
}

function staff(id: number, kind = Obj.Guard, x = 3.5, z = 3.5): Agent {
  const agent = blankAgent(kind); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false; return agent;
}

function itemAndSaveChecks(): void {
  const items = new ItemSystem();
  items.ensureContainer({ id: "agent:1:pockets", name: "pockets", x: 1, z: 1, capacity: 8,
    concealment: .8, bodyCapacity: 0, lockedTier: "none", ownerId: 1, tags: ["personal"] });
  const key = items.create("guard-key", 2, { issuedTo: 9 });
  assert(items.moveToContainer(key.id, "agent:1:pockets", 3, 1, true));
  assert.equal(items.itemsIn("agent:1:pockets")[0].id, key.id);
  assert.equal(items.controlledDiscrepancies()[0].itemId, key.id);
  assert(key.history.some((row) => row.action === "hidden"));
  const restored = new ItemSystem(); restored.loadData(JSON.parse(JSON.stringify(items.saveData())));
  assert.deepEqual(restored.saveData(), items.saveData());
}

function areaAndDoorChecks(): void {
  const world = new World(24);
  for (let x = 5; x <= 13; x++) { world.setWall(x, 5, 1); world.setWall(x, 13, 1); }
  for (let z = 5; z <= 13; z++) { world.setWall(5, z, 1); world.setWall(13, z, 1); }
  world.setDoor(9, 13, "staff");
  const areas = new AreaSystem(world.size); areas.recompute(world);
  const inside = world.idx(9, 9), insideId = areas.areaAt[inside];
  assert(insideId > 0); assert.equal(areas.areas.get(insideId)?.exterior, false);
  const portal = areas.portals.find((row) => row.tile === world.idx(9, 13));
  assert.equal(portal?.lockTier, "staff");
  assert.equal(passable(world, world.idx(9, 13), false, 0), false);
  assert.equal(passable(world, world.idx(9, 13), false, 1), true);
  const idBefore = areas.areaAt[inside]; world.setFloor(8, 8, 1); areas.recompute(world);
  assert.equal(areas.areaAt[inside], idBefore, "stable area id should survive non-topology edits");
  const policy = areas.access.get(idBefore)!; policy.roles.prisoner = true; policy.custody.minimum = true; policy.mixed = false;
  assert(areas.admitCustody(idBefore, "minimum")); assert.equal(areas.admitCustody(idBefore, "maximum"), false);
  assert.equal(areas.isExteriorTile(world.idx(0, 0)), true);
  assert.equal(ESCAPE_MARGIN, 1);
}

function healthCombatPolicyChecks(): void {
  const world = new World(32), items = new ItemSystem(), institution = new InstitutionSystem(), health = new HealthSystem();
  const combat = new CombatSystem(health, institution, items), a = inmate(1, 10.5, 10.5), b = inmate(2, 11.4, 10.5);
  for (const agent of [a, b]) for (const suffix of ["hands", "pockets", "worn", "equipment"])
    items.ensureContainer({ id: `agent:${agent.id}:${suffix}`, name: suffix, x: agent.x, z: agent.z, capacity: 12,
      concealment: .5, bodyCapacity: 0, lockedTier: "none", ownerId: agent.id, tags: [suffix] });
  const knife = items.create("kitchen-knife", 0, { ownerId: a.id }); items.moveToContainer(knife.id, `agent:${a.id}:hands`, 0, a.id);
  assert(combat.start(a, b, 0));
  for (let n = 1; n <= 120 && health.ensure(b).injuries.length === 0; n++) combat.tick(.1, n * .1, world, [a, b]);
  assert(health.ensure(a).injuries.length + health.ensure(b).injuries.length > 0, "physical combat should eventually produce an injury");
  assert(health.treatmentJobs.length > 0);
  const regionPatient = inmate(3);
  for (const region of BODY_REGIONS) health.applyInjury(regionPatient, "blunt", region, .05, 1);
  assert.deepEqual(new Set(health.state(3)!.injuries.map((injury) => injury.region)), new Set(BODY_REGIONS));
  const fatal = inmate(4); health.applyInjury(fatal, "gunshot", "chest", 1, 0);
  for (let n = 0; n < 400 && health.state(4)!.alive; n++) health.tick(1, n, world, [fatal], items);
  assert.equal(health.state(4)!.alive, false); assert(health.bodies.has(4));
  institution.setItemOverride("tool", "spoon", { threshold: "suspected", search: "cell", solitaryHours: 5 });
  const incident = institution.createIncident("tool", 2, -1, 1, 1, 0, "spoon");
  institution.addEvidence(incident.id, "search", 10, 2, .7, "Spoon found", 0, 1, 1);
  institution.shareRoutineReports(1);
  assert(institution.punishments.some((order) => order.prisonerId === 2 && order.search === "cell"));
  const roundTrip = new HealthSystem(); roundTrip.loadData(JSON.parse(JSON.stringify(health.saveData())));
  assert.equal(roundTrip.bodies.size, health.bodies.size);
}

function workCashGangEscapeChecks(): void {
  const economy = new EconomySystem(), logistics = new LogisticsSystem(economy), items = new ItemSystem();
  const health = new HealthSystem(), institution = new InstitutionSystem(), work = new WorkSystem(items, economy, logistics);
  const world = new World(36), worker = inmate(20, 8.5, 8.5);
  for (const suffix of ["hands", "pockets", "worn", "equipment"])
    items.ensureContainer({ id: `agent:${worker.id}:${suffix}`, name: suffix, x: worker.x, z: worker.z, capacity: 20,
      concealment: .5, bodyCapacity: 0, lockedTier: "none", ownerId: worker.id, tags: [suffix] });
  world.placePiece(10, 10, Obj.WoodWorkbench, 0);
  const roomId = 1, tiles = new Set<number>();
  for (let x = 7; x <= 14; x++) for (let z = 7; z <= 14; z++) { const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = roomId; }
  world.rooms.set(roomId, { id: roomId, type: RoomType.Woodshop, access: 1, tiles, valid: true, ambience: 0, guards: 0 });
  work.refresh(world, 0); const place = work.workplaces.get(roomId)!; assert(place); assert(work.assign(worker.id, roomId));
  for (const defId of ["hammer", "wood-scrap", "wood-scrap"]) {
    const item = items.create(defId, 0); items.moveToContainer(item.id, place.stockContainer, 0);
  }
  for (let n = 0; n < 80; n++) work.updateWorker(worker, 1, n, world);
  assert(items.itemsIn(place.outputContainer).some((item) => item.defId === "wood-goods"));
  assert.equal(items.itemsIn(place.stockContainer).filter((item) => item.defId === "wood-scrap").length, 0);
  const market = new MarketSystem(items, health, institution, economy, work), other = inmate(21, 8.7, 8.5);
  for (const suffix of ["hands", "pockets", "worn", "equipment"])
    items.ensureContainer({ id: `agent:${other.id}:${suffix}`, name: suffix, x: other.x, z: other.z, capacity: 20,
      concealment: .5, bodyCapacity: 0, lockedTier: "none", ownerId: other.id, tags: [suffix] });
  for (let n = 0; n < 10; n++) { const note = items.create("cash-1", 0, { ownerId: worker.id }); items.moveToContainer(note.id, `agent:${worker.id}:pockets`, 0); }
  const before = market.cash(worker.id) + market.cash(other.id), paid = market.transferBetween(worker.id, other.id, 4, 1);
  assert.equal(paid, 4); assert.equal(market.cash(worker.id) + market.cash(other.id), before);
  const social = new PrisonerSocialSystem(); social.cliques.set(1, { id: 1, members: [20, 21, 22], cohesion: .9 });
  const third = inmate(22, 8.9, 8.5); const combat = new CombatSystem(health, institution, items);
  const gangs = new GangSystem(items, market, combat, health, institution);
  gangs.tick(7, 0, [worker, other, third], social); gangs.tick(7, 30 * 48 + 1, [worker, other, third], social);
  assert.equal([...gangs.gangs.values()].filter((gang) => gang.state === "active").length, 1);
  const operations = new EscapeOperationsSystem();
  const op = operations.adoptSoloPlan(worker, { method: "climb", breaches: [5], exitTile: 0, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 0 }, 0);
  assert(op.acquisition); assert.equal(["staff-key", "guard-key", "staff-uniform", "rope", "radio", "service-pistol"].includes(op.acquisition!.asset), true);
  assert.equal(op.distraction.planned, false);
}

function securityMedicalEmergencyAndTillChecks(): void {
  const world = new World(40), economy = new EconomySystem(), logistics = new LogisticsSystem(economy), items = new ItemSystem();
  const institution = new InstitutionSystem(), health = new HealthSystem(), combat = new CombatSystem(health, institution, items);
  const areas = new AreaSystem(world.size); areas.recompute(world);
  const security = new SecuritySystem(items, institution, combat, health, areas), work = new WorkSystem(items, economy, logistics);
  const market = new MarketSystem(items, health, institution, economy, work), guard = staff(90, Obj.Guard, 8.5, 8.5), patient = inmate(91, 9.5, 8.5);
  for (const agent of [guard, patient]) for (const suffix of ["hands", "pockets", "worn", "equipment"])
    items.ensureContainer({ id: `agent:${agent.id}:${suffix}`, name: suffix, x: agent.x, z: agent.z, capacity: 20,
      concealment: .5, bodyCapacity: 0, lockedTier: "none", ownerId: agent.id, tags: [suffix] });
  const addRoom = (id: number, type: number, x0: number, z0: number, w: number, h: number) => {
    const tiles = new Set<number>(); for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + h; z++) {
      const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = id;
    }
    world.rooms.set(id, { id, type, access: 0, tiles, valid: true, ambience: 0, guards: 0 }); return tiles;
  };
  addRoom(1, RoomType.Armoury, 6, 6, 6, 6); world.placePiece(7, 7, Obj.WeaponLocker, 0);
  const firearmsBefore = items.count("service-pistol") + items.count("sniper-rifle");
  security.command("armed-response", 0, [guard, patient]); security.tick(.1, 0, world, [guard, patient], false);
  for (let n = 0; n < 20; n++) security.updateStaff(guard, 1, n, world, [guard, patient]);
  assert(items.itemsIn(`agent:${guard.id}:equipment`).some((item) => ["riot-gear", "body-armor", "less-lethal-launcher", "taser", "pepper-spray"].includes(item.defId)));
  assert.equal(items.count("service-pistol") + items.count("sniper-rifle"), firearmsBefore, "Armed Response must not create firearms");
  security.command("none", 30, [guard, patient]); for (let n = 30; n < 50; n++) security.updateStaff(guard, 1, n, world, [guard, patient]);
  addRoom(2, RoomType.Infirmary, 18, 6, 7, 7); world.placePiece(20, 8, Obj.MedicalBed, 0);
  health.applyInjury(patient, "cut", "left-leg", .7, 50, -1);
  for (let n = 50; n < 120 && !health.state(patient.id)!.admitted; n++) security.updateStaff(guard, 1, n, world, [guard, patient]);
  assert.equal(health.state(patient.id)!.admitted, true, "guard should physically admit a casualty before treatment");
  const lostKey = items.create("guard-key", 120, { issuedTo: guard.id }); items.issue(lostKey.id, guard.id, 120); items.moveToWorld(lostKey.id, 30, 30, 121, patient.id);
  security.tick(.1, 122, world, [guard, patient], false);
  assert.equal(security.emergency, "lockdown");
  assert(institution.punishments.some((order) => order.search === "person"), "critical key loss should queue a shakedown");

  addRoom(3, RoomType.Shop, 4, 20, 7, 7); world.placePiece(5, 21, Obj.ShopCounter, 0); world.placePiece(6, 21, Obj.ShopShelf, 0);
  addRoom(4, RoomType.Offices, 18, 20, 6, 6); world.placePiece(19, 21, Obj.PayrollSafe, 0);
  guard.x = 5.5; guard.z = 21.5; guard.path = null; security.command("none", 0, [guard]);
  market.tick(.1, 0, world, [guard, patient]);
  const till = items.containers.get("shop:3:till")!; assert(till);
  for (let n = 0; n < 7; n++) { const note = items.create("cash-1", 0); items.moveToContainer(note.id, till.id, 0); }
  const cashBefore = economy.cash; market.tick(.1, 23 * 30, world, [guard, patient]);
  for (let n = 0; n < 80 && economy.cash === cashBefore; n++) market.updateTillGuard(guard, 1, 23 * 30 + n, world);
  assert.equal(economy.cash, cashBefore + 7); assert.equal(items.cashValue(till.id), 0);
}

function task2RoundTripAndScale(): void {
  const started = performance.now(), world = new World(96), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const systems = new Task2Systems(world.size, economy, logistics); systems.installNewGame(world);
  const agents: Agent[] = [];
  for (let id = 1; id <= 500; id++) agents.push(inmate(id, 2.5 + id % 80, 2.5 + ((id / 80) | 0)));
  for (let n = 0; n < 100; n++) agents.push(staff(501 + n, n % 8 === 0 ? Obj.Doctor : Obj.Guard, 4.5 + n % 40, 20.5 + ((n / 40) | 0)));
  for (const agent of agents) systems.ensureAgent(agent, 0);
  const bulk = systems.items.ensureContainer({ id: "scale:bulk", name: "Scale stock", x: 1, z: 1, capacity: 30000,
    concealment: .1, bodyCapacity: 0, lockedTier: "staff", ownerId: -1, tags: ["scale"] });
  for (let n = 0; n < 25_000; n++) { const item = systems.items.create("paper", 0); systems.items.moveToContainer(item.id, bulk.id, 0); }
  systems.tick(.1, 1, world, agents);
  assert.equal(new Set(systems.items.items.keys()).size, systems.items.items.size);
  const saved = JSON.parse(JSON.stringify(systems.saveData()));
  const economy2 = new EconomySystem(), logistics2 = new LogisticsSystem(economy2), restored = new Task2Systems(world.size, economy2, logistics2);
  restored.loadData(saved, world);
  assert.equal(restored.items.items.size, systems.items.items.size);
  assert.equal(restored.health.states.size, systems.health.states.size);
  assert.equal(restored.areas.areaAt.length, systems.areas.areaAt.length);
  const elapsed = performance.now() - started;
  assert(elapsed < 20_000, `scale/save round-trip took ${Math.round(elapsed)}ms`);
  console.log(`Task 2 scale: 500 inmates, 100 staff, ${systems.items.items.size} unique items in ${Math.round(elapsed)}ms`);
}

function hiddenUiChecks(): void {
  const source = readFileSync("src/main.ts", "utf8"), start = source.indexOf("function updateIntelligenceUi"), end = source.indexOf("intelSearch.addEventListener", start);
  const normalUi = source.slice(start, end);
  for (const forbidden of [".aptitudes", ".personality", "escapeOperations", "task3.escape.schemes", "items.cashValue"])
    assert.equal(normalUi.includes(forbidden), false, `normal Intelligence UI leaks private field ${forbidden}`);
  const html = readFileSync("index.html", "utf8");
  assert.equal(html.includes("escape operations are fully visible"), false);
}

itemAndSaveChecks();
areaAndDoorChecks();
healthCombatPolicyChecks();
workCashGangEscapeChecks();
securityMedicalEmergencyAndTillChecks();
task2RoundTripAndScale();
hiddenUiChecks();
console.log("Task 2 items/areas/combat/health/policy/work/market/gangs/escape/save/UI checks passed");
