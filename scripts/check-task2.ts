import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blankAgent, ESCAPE_MARGIN, REG, type Agent } from "../src/sim/agent.ts";
import { Agents } from "../src/sim/agents.ts";
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

function combatResponseLifecycleChecks(): void {
  const world = new World(32), items = new ItemSystem(), institution = new InstitutionSystem(), health = new HealthSystem();
  const combat = new CombatSystem(health, institution, items);
  const attacker = inmate(30, 10.5, 10.5), defender = inmate(31, 11.4, 10.5);
  const guards = Array.from({ length: 6 }, (_, i) => staff(40 + i, Obj.Guard, 10.5, 10.5));
  const fight = combat.start(attacker, defender, 0)!;
  institution.incidents.get(fight.incidentId)!.state = "reported";
  assert.equal(combat.guardIntervene(guards[0], fight, [attacker, defender, ...guards], 3), false,
    "a sufficient unarmed guard response should contain a two-prisoner fight");
  assert.equal(fight.state, "contained");
  assert(attacker.cuffed && defender.cuffed, "both prisoners are restrained when guards contain the fight");

  const armedA = inmate(37, 10.5, 10.5), armedB = inmate(38, 11.4, 10.5);
  for (const prisoner of [armedA, armedB]) {
    for (const slot of ["hands", "equipment"]) items.ensureContainer({ id: `agent:${prisoner.id}:${slot}`,
      name: slot, x: prisoner.x, z: prisoner.z, capacity: 8, concealment: .4, bodyCapacity: 0,
      lockedTier: "none", ownerId: prisoner.id, tags: [slot] });
    const shiv = items.create("shiv", 0); items.moveToContainer(shiv.id, `agent:${prisoner.id}:hands`, 0, prisoner.id);
  }
  const armedFight = combat.start(armedA, armedB, 10)!;
  institution.incidents.get(armedFight.incidentId)!.state = "reported";
  const loneGuard = staff(60, Obj.Guard, 10.5, 10.5);
  assert.equal(combat.guardIntervene(loneGuard, armedFight, [armedA, armedB, loneGuard], 13), true,
    "one unarmed guard must keep responding to two actively armed inmates rather than instantly restraining them");
  assert.equal(armedFight.state, "active");
  assert.equal(armedA.cuffed || armedB.cuffed, false, "headcount alone does not cuff armed attackers");

  const admitted = inmate(32, 12.5, 10.5), remaining = inmate(33, 13.4, 10.5);
  const admittedFight = combat.start(admitted, remaining, 4)!;
  institution.incidents.get(admittedFight.incidentId)!.state = "reported";
  const admittedHealth = health.ensure(admitted); admittedHealth.admitted = true; admitted.state = "inTreatment";
  const staleResponder = guards[1]; staleResponder.state = "respondingFight"; staleResponder.path = [world.idx(15, 15)];
  combat.tick(.1, 5, world, [admitted, remaining, ...guards]);
  assert.equal(admittedFight.state, "contained", "admission removes a participant from active combat");
  assert.equal(admitted.state, "inTreatment", "combat cleanup preserves medical admission state");
  assert.equal(remaining.cuffed, true, "the remaining active inmate is restrained after the opponent is admitted");
  assert.equal(staleResponder.state, "idle", "guards leave response state when their fight has ended");
  assert.equal(staleResponder.path, null, "retiring a response also clears its stale route");
  assert.equal(combat.responseFor(staleResponder), null, "retired engagements no longer create response jobs");

  const movedA = inmate(34, 5.5, 6.5), movedB = inmate(35, 6.5, 6.5), observer = staff(46, Obj.Guard, 21.5, 20.5);
  const movingFight = combat.start(movedA, movedB, 10)!;
  institution.incidents.get(movingFight.incidentId)!.state = "reported";
  movedA.x = 20.5; movedA.z = 20.5; movedB.x = 22.5; movedB.z = 20.5;
  movingFight.participants.forEach((participant) => { participant.nextAction = 100; });
  combat.tick(.1, 11, world, [movedA, movedB, observer]);
  assert.equal(movingFight.x, 21.5, "response location follows the live participants");
  assert.equal(movingFight.z, 20.5);
  assert.equal(combat.responseFor(observer), movingFight, "guards select the engagement at its updated location");
}

function combatResponseSimulationChecks(): void {
  const world = new World(28), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics), sim = new Agents();
  const roomTiles = new Set<number>();
  for (let x = 2; x <= 7; x++) for (let z = 2; z <= 7; z++) {
    const tile = world.idx(x, z); roomTiles.add(tile); world.roomId[tile] = 1;
  }
  world.rooms.set(1, { id: 1, type: RoomType.Cell, access: 0, tiles: roomTiles, valid: true, ambience: 0, guards: 0 });
  world.placePiece(3, 3, Obj.Bed, 0);
  task2.installNewGame(world); sim.task2 = task2; sim.regime.fill(1);
  world.rooms.get(1)!.valid = true;
  const fighters = [inmate(50, 14.5, 14.5), inmate(51, 15.4, 14.5)];
  const guards = Array.from({ length: 6 }, (_, i) => staff(60 + i, Obj.Guard, 4.5 + (i % 3) * 2, 12.5 + ((i / 3) | 0) * 2));
  sim.agents.push(...fighters, ...guards);
  const fight = task2.combat.start(fighters[0], fighters[1], 0)!;
  task2.institution.incidents.get(fight.incidentId)!.state = "reported";
  let time = 0;
  for (let tick = 0; tick < 600 && fight.state === "active"; tick++) {
    time += .1;
    task2.tick(.1, time, world, sim.agents, false, false);
    sim.update(.1, world, false, 12, time);
  }
  assert.equal(fight.state, "contained", "six unarmed guards physically contain the inmate fight");
  assert(fighters.every((fighter) => fighter.cuffed), "the resolved fight leaves both inmates restrained");
  assert(guards.some((guard) => Math.hypot(guard.x - fighters[0].x, guard.z - fighters[0].z) <= 2.5),
    "at least one guard follows the moving fighters to a usable response distance");
  assert(guards.some((guard) => guard.state !== "respondingFight"), "responders leave fight duty after containment");

  const arrival = inmate(52, 9.5, 9.5); arrival.cuffed = true; arrival.state = "cuffed";
  sim.agents.push(arrival); task2.ensureAgent(arrival, time);
  let assignedIntake = false;
  for (let tick = 0; tick < 30 && !assignedIntake; tick++) {
    time += .1;
    task2.tick(.1, time, world, sim.agents, false, false);
    sim.update(.1, world, false, 12, time);
    assignedIntake = guards.some((guard) => guard.state === "intakeGo" || guard.state === "intakeEscort");
  }
  assert(assignedIntake, "a guard released from fight response returns to ordinary intake duty");
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
  assert(items.itemsIn(`agent:${worker.id}:hands`).some((item) => item.defId === "hammer"), "active worker should hold the controlled tool");
  logistics.cancelSource(`work:${roomId}`);
  work.refresh(world, 80);
  assert.deepEqual(logistics.saveData().requests.filter((row) => row.commodity === "hammer").map((row) => row.quantity), [1],
    "a tool issued to a worker counts toward workplace stock, leaving only the second station's tool to order");
  const confiscated = items.itemsIn(`agent:${worker.id}:hands`).find((item) => item.defId === "hammer")!;
  items.moveToContainer(confiscated.id, `agent:${worker.id}:pockets`, 80, -1, true);
  const replacement = items.create("hammer", 80);
  items.moveToContainer(replacement.id, place.stockContainer, 80);
  place.blocked = "";
  work.updateWorker(worker, 1, 80, world);
  assert(items.itemsIn(`agent:${worker.id}:hands`).some((item) => item.id === replacement.id),
    "a worker must replace an issued tool after confiscation instead of working against a stale lease");
  work.unassign(worker.id);
  assert(items.itemsIn(`agent:${worker.id}:pockets`).some((item) => item.id === confiscated.id),
    "unassign must not return a confiscated tool to controlled stock");
  assert(items.itemsIn(place.stockContainer).some((item) => item.defId === "hammer"), "unassign returns controlled tools to the original workplace");
  assert.equal(items.itemsIn(`agent:${worker.id}:hands`).some((item) => item.defId === "hammer"), false, "unassign must not strand a job tool in worker hands");
  assert.equal(work.assign(worker.id, roomId), true, "a worker may be assigned again after returning their tool");
  work.updateWorker(worker, 1, 80, world);
  world.rooms.delete(roomId);
  work.refresh(world, 81);
  assert(items.itemsIn(place.stockContainer).some((item) => item.defId === "hammer"), "removing a workplace returns tools before clearing assignments");
  assert.equal(work.assignments.has(worker.id), false, "workers cannot retain assignments to demolished workplaces");
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
  patient.needs.food = .12; patient.needs.sleep = .12;
  health.applyInjury(patient, "cut", "left-leg", .7, 50, -1);
  const casualtyJob = health.treatmentJobs.find((job) => job.patientId === patient.id)!;
  let emergencyDuringTransportTested = false;
  for (let n = 50; n < 120 && !health.state(patient.id)!.admitted; n++) {
    security.updateStaff(guard, 1, n, world, [guard, patient]);
    if (casualtyJob.transportGuardId === guard.id && !emergencyDuringTransportTested) {
      security.command("lockdown", n + .1, [guard, patient]);
      security.updateStaff(guard, .1, n + .1, world, [guard, patient]);
      assert.equal(casualtyJob.transportGuardId, guard.id, "an emergency does not steal an active medical escort");
      security.command("none", n + .2, [guard, patient]);
      emergencyDuringTransportTested = true;
    }
  }
  assert.equal(emergencyDuringTransportTested, true, "the casualty transport acquired its physical guard owner");
  assert.equal(health.state(patient.id)!.admitted, true, "guard should physically admit a casualty before treatment");
  const foodAtAdmission = patient.needs.food;
  for (let n = 0; n < 12; n++) health.tick(.5, 120 + n * .5, world, [guard, patient], items);
  assert(patient.needs.sleep > .12, "valid infirmary bedrest restores sleep while ordinary prisoner upkeep is paused");
  assert.equal(patient.needs.food, foodAtAdmission, "bedrest does not disguise hunger without a consumed meal");
  const doctor = staff(92, Obj.Doctor, 18.5, 8.5), blockedTile = world.idx(19, 8);
  world.setWall(19, 8, 1);
  assert.equal(world.objKind[blockedTile], Obj.Wall);
  items.create("bandage", 120);
  let treated = false;
  for (let n = 0; n < 120 && health.state(patient.id)!.admitted; n++) {
    const before = { x: doctor.x, z: doctor.z };
    health.updateDoctor(doctor, .5, world, [guard, patient, doctor], items);
    const crossedBlockedRow = (before.x - 19.5) * (doctor.x - 19.5) <= 0 &&
      Math.abs(before.z - 8.5) < .01 && Math.abs(doctor.z - 8.5) < .01;
    assert.equal(crossedBlockedRow, false, "a doctor must route around a wall instead of walking through it");
    if (health.state(patient.id)!.injuries.every((injury) => injury.treated)) treated = true;
  }
  assert(treated, "doctor should reach the admitted patient and treat the physical injury");
  assert.equal(health.state(patient.id)!.admitted, false, "medical treatment releases the bed and patient");
  assert.equal(health.isUnavailable(patient.id), false, "discharge returns a living patient to ordinary behavior");
  const routine = new Agents(); routine.task2 = new Task2Systems(world.size, economy, logistics);
  routine.agents.push(patient); routine.regime.fill(REG.Free); patient.decideT = 0;
  const canteenTiles = new Set<number>();
  for (let x = 26; x < 33; x++) for (let z = 5; z < 12; z++) {
    const tile = world.idx(x, z); canteenTiles.add(tile); world.roomId[tile] = 3;
  }
  world.rooms.set(3, { id: 3, type: RoomType.Canteen, access: 0, tiles: canteenTiles, valid: true, ambience: 0, guards: 0 });
  assert(world.placePiece(29, 8, Obj.ServingTable, 0));
  routine.servingStock.set(world.idx(29, 8), 3);
  const foodAtDischarge = patient.needs.food;
  routine.update(.1, world, false, 12, 151);
  assert(patient.needs.food < foodAtDischarge, "ordinary prisoner needs resume after medical discharge");
  assert(["toUse", "toQueue"].includes(patient.state) && patient.interact === world.idx(29, 8),
    "a discharged hungry patient resumes the real canteen food route");
  assert(doctor.x !== 18.5 || doctor.z !== 8.5, "doctor physically walks along an accessible route to the patient");
  const secondPatient = inmate(93, 12.5, 8.5); secondPatient.needs.sleep = .2;
  health.applyInjury(secondPatient, "cut", "left-leg", .7, 130);
  const transportJob = health.treatmentJobs.find((job) => job.patientId === secondPatient.id)!;
  const lostEscort = staff(94, Obj.Guard, 12, 8.5), replacementEscort = staff(95, Obj.Guard, 10.5, 8.5);
  assert(security.updateStaff(lostEscort, .1, 130, world, [patient, doctor, secondPatient, lostEscort]));
  assert.equal(secondPatient.state, "beingTransported");
  assert.equal(transportJob.transportGuardId, lostEscort.id);
  health.tick(.1, 131, world, [patient, doctor, secondPatient, replacementEscort], items); // escort guard was removed
  assert.equal(transportJob.state, "waiting", "a removed escort leaves the casualty job available to another guard");
  assert.equal(transportJob.transportGuardId, undefined);
  assert.notEqual(secondPatient.state, "beingTransported", "patients cannot remain tied to a missing escort");
  let reclaimed = false;
  for (let n = 0; n < 120 && !health.state(secondPatient.id)!.admitted; n++) {
    security.updateStaff(replacementEscort, .1, 132 + n * .1, world, [patient, doctor, secondPatient, replacementEscort]);
    if (transportJob.transportGuardId === replacementEscort.id) reclaimed = true;
  }
  assert(reclaimed, "a second living guard reclaims the casualty after the original escort is removed");
  assert.equal(health.state(secondPatient.id)!.admitted, true, "the reassigned escort completes physical admission");
  const sleepAtAdmission = secondPatient.needs.sleep;
  world.rooms.get(2)!.valid = false;
  health.tick(.1, 150, world, [patient, doctor, secondPatient, replacementEscort], items);
  assert.equal(secondPatient.needs.sleep, sleepAtAdmission, "an invalid or closed Infirmary bed does not provide bedrest");
  assert.equal(health.state(secondPatient.id)!.admitted, false, "closing the Infirmary releases an unusable treatment bed");
  assert.equal(health.state(secondPatient.id)!.treatmentBed, -1);
  assert.equal(transportJob.state, "waiting", "casualty remains eligible for transfer to another valid Infirmary");
  world.rooms.get(2)!.valid = true;
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

function solitaryBacklogReleasesCustodyChecks(): void {
  const world = new World(40), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics), prisoner = inmate(301, 10.5, 8.5);
  const officer = staff(302, Obj.Guard, 10.5, 8.5);
  task2.installNewGame(world); task2.ensureAgent(prisoner, 0); task2.ensureAgent(officer, 0);
  const addSolitary = (id: number, x: number) => {
    const tiles = new Set<number>();
    for (let tx = x; tx < x + 5; tx++) for (let z = 6; z < 11; z++) {
      const tile = world.idx(tx, z); tiles.add(tile); world.roomId[tile] = id;
    }
    world.rooms.set(id, { id, type: RoomType.Solitary, access: 0, tiles, valid: true, ambience: 0, guards: 0 });
    world.placePiece(x + 1, 7, Obj.Bed, 0);
    world.placePiece(x, 8, Obj.JailDoor, 0);
  };
  addSolitary(10, 6); addSolitary(11, 14);
  for (const [id, roomId] of [[900, 10], [901, 11]]) task2.institution.punishments.push({ incidentId: id,
    prisonerId: id + 1000, solitaryUntil: 10000, custodyUp: false, search: "none", interrogate: false,
    state: "active", solitaryRoomId: roomId });
  const incident = task2.institution.createIncident("assault-inmate", prisoner.id, -1, prisoner.x, prisoner.z, 0);
  task2.institution.punishments.push({ incidentId: incident.id, prisonerId: prisoner.id, solitaryUntil: 0,
    custodyUp: true, search: "none", interrogate: false, state: "queued" });

  task2.security.updateStaff(officer, .1, 1, world, [prisoner, officer]);
  const order = task2.institution.punishments.find((row) => row.incidentId === incident.id)!;
  assert.equal(order.state, "queued", "a full solitary block leaves the case queued");
  assert(order.retryAt! > 1, "the queued order retries after capacity may turn over");
  assert.equal(prisoner.cuffed, false, "a prisoner is not left restrained while waiting for a solitary bed");
  assert.equal(prisoner.state, "idle");
  assert.equal(task2.security.updateStaff(officer, .1, 2, world, [prisoner, officer]), false,
    "a deferred order releases its officer until retry time");

  for (let i = 0; i < 2; i++) {
    const duplicate = task2.institution.createIncident("assault-inmate", prisoner.id, -1, prisoner.x, prisoner.z, 2 + i);
    task2.institution.addEvidence(duplicate.id, "witness", 99, prisoner.id, .95,
      "A second reported assault", 2 + i, prisoner.x, prisoner.z);
  }
  task2.institution.shareRoutineReports(4);
  assert.equal(task2.institution.punishments.filter((row) => row.prisonerId === prisoner.id &&
    !["cancelled", "complete"].includes(row.state)).length, 1,
  "new incidents coalesce while one discipline order for the prisoner is still open");

  task2.institution.punishments.find((row) => row.incidentId === 900)!.state = "complete";
  for (let tick = 1; tick <= 200 && prisoner.state !== "policyEscort"; tick++)
    task2.security.updateStaff(officer, .1, order.retryAt! + tick * .1, world, [prisoner, officer]);
  assert.equal(prisoner.cuffed, true, "the pending sentence resumes once a solitary room is free");
  assert.equal(prisoner.state, "policyEscort", "the resumed order physically retakes the prisoner for solitary transfer");
}

function policyEscalationPreservesNewEvidenceChecks(): void {
  const institution = new InstitutionSystem();
  const first = institution.createIncident("unauthorized", 410, -1, 4.5, 4.5, 0);
  institution.addEvidence(first.id, "guard", 1, 410, .8, "Minor unauthorized movement", 0, 4.5, 4.5);
  assert.equal(institution.punishments.length, 0, "initial report is evaluated through the policy cadence");
  institution.shareRoutineReports(1);
  const base = institution.punishments.find((row) => row.incidentId === first.id)!;
  assert(base, "probable unauthorized movement creates its initial policy order");
  assert.equal(base.search, "none"); assert.equal(base.solitaryHours, 0);

  institution.setItemOverride("firearm", "", { protectiveOffer: true });
  const serious = institution.createIncident("firearm", 410, -1, 4.5, 4.5, 2);
  institution.addEvidence(serious.id, "guard", 2, 410, .9, "Firearm recovered", 2, 4.5, 4.5);
  institution.shareRoutineReports(3);
  assert.equal(institution.punishments.filter((row) => row.prisonerId === 410 && row.state === "queued").length, 1,
    "an unstarted queued order absorbs the stronger follow-up rather than stacking restraints");
  assert.equal(base.search, "full");
  assert.equal(base.solitaryHours, 72);
  assert(base.custodyUp && base.interrogate && base.protectiveOffer === true,
    "the merged order preserves stronger custody, interrogation, and protective policy obligations");
  assert(base.solitaryUntil >= 3 + 72 * 30, "the sentence expiry reflects the strongest reported incident time");

  base.state = "active";
  const followup = institution.createIncident("assault-staff", 410, 9, 4.5, 4.5, 4);
  institution.addEvidence(followup.id, "guard", 3, 410, .95, "Assaulted an officer", 4, 4.5, 4.5);
  institution.shareRoutineReports(5);
  const orders = institution.punishments.filter((row) => row.prisonerId === 410 && !["cancelled", "complete"].includes(row.state));
  assert.equal(orders.length, 2, "a distinct offense during an active sentence is preserved as a follow-up order");
  assert(orders.some((row) => row.incidentId === followup.id && row.search === "targeted" && row.solitaryHours === 24));
}

function bedlessCasualtyDoesNotMonopolizeSecurityChecks(): void {
  const world = new World(32), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics);
  const occupied = inmate(420, 12.5, 8.5), patient = inmate(421, 10.5, 8.5), guard = staff(422, Obj.Guard, 10.5, 8.5);
  const tiles = new Set<number>();
  for (let x = 16; x < 22; x++) for (let z = 6; z < 12; z++) {
    const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = 2;
  }
  world.rooms.set(2, { id: 2, type: RoomType.Infirmary, access: 0, tiles, valid: true, ambience: 0, guards: 0 });
  world.placePiece(18, 8, Obj.MedicalBed, 0);
  const bed = world.anchorOf(world.tilesOfKind(Obj.MedicalBed)[0]!);
  assert.equal(task2.health.admit(occupied, bed), true);
  assert.equal(task2.health.availableMedicalBed(world, patient.id), -1, "the one physical bed is occupied");
  task2.health.applyInjury(patient, "cut", "left-leg", .7, 0);
  const job = task2.health.treatmentJobs.find((row) => row.patientId === patient.id)!;
  task2.security.updateStaff(guard, .1, 1, world, [occupied, patient, guard]);
  assert.equal(job.transportGuardId, undefined, "a patient with no bed does not retain a guard transport claim");
  assert.notEqual(guard.state, "casualtyWaiting", "bedless response does not park a guard indefinitely");
  assert.equal(patient.state, "idle", "a conscious patient is not moved into a fictitious transport");
}

function parallelCasualtyTransportsReserveDistinctBedsChecks(): void {
  const world = new World(40), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics);
  const patients = [inmate(430, 11.5, 8.5), inmate(431, 12.5, 8.5)];
  const guards = [staff(432, Obj.Guard, 10.5, 8.5), staff(433, Obj.Guard, 13.5, 8.5)];
  const tiles = new Set<number>();
  for (let x = 8; x < 32; x++) for (let z = 5; z < 15; z++) {
    const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = 2;
  }
  world.rooms.set(2, { id: 2, type: RoomType.Infirmary, access: 0, tiles, valid: true, ambience: 0, guards: 0 });
  const closedTiles = new Set<number>();
  for (let x = 0; x < 7; x++) for (let z = 5; z < 15; z++) {
    const tile = world.idx(x, z); closedTiles.add(tile); world.roomId[tile] = 3;
  }
  world.rooms.set(3, { id: 3, type: RoomType.Infirmary, access: 0, tiles: closedTiles, valid: false, ambience: 0, guards: 0 });
  assert(world.placePiece(2, 7, Obj.MedicalBed, 0));
  assert(world.placePiece(20, 7, Obj.MedicalBed, 0)); assert(world.placePiece(25, 7, Obj.MedicalBed, 0));
  assert.equal(task2.health.availableMedicalBed(world, patients[0]!.id), world.anchorOf(world.idx(20, 7)),
    "a closed Infirmary is skipped rather than blocking valid beds in another room");
  for (let i = 0; i < patients.length; i++) task2.health.applyInjury(patients[i]!, "cut", "left-leg", .65, i);
  const agents = [...patients, ...guards];
  task2.security.updateStaff(guards[0]!, .1, 0, world, agents);
  task2.security.updateStaff(guards[1]!, .1, .1, world, agents);
  const jobs = patients.map((patient) => task2.health.treatmentJobs.find((row) => row.patientId === patient.id)!);
  assert(jobs.every((job) => job.transportBed !== undefined), "both active escorts reserve a physical bed before moving");
  assert.notEqual(jobs[0]!.transportBed, jobs[1]!.transportBed,
    "parallel guards cannot reserve opposite footprint tiles of the same two-tile bed");
  for (let tick = 1; tick <= 600 && patients.some((patient) => task2.health.state(patient.id)!.admitted === false); tick++) {
    for (const guard of guards) task2.security.updateStaff(guard, .1, tick * .1, world, agents);
  }
  assert(patients.every((patient) => task2.health.state(patient.id)!.admitted),
    "both physically escorted casualties reach their reserved Infirmary beds");
  assert.notEqual(task2.health.state(patients[0]!.id)!.treatmentBed, task2.health.state(patients[1]!.id)!.treatmentBed,
    "admission preserves distinct bed ownership after escort claims are released");
}

function morgueSlotsArePhysicalAndGuardsDoNotWaitIndefinitelyChecks(): void {
  const world = new World(32), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics);
  const roomTiles = new Set<number>();
  for (let x = 7; x < 15; x++) for (let z = 7; z < 14; z++) {
    const tile = world.idx(x, z); roomTiles.add(tile); world.roomId[tile] = 2;
  }
  world.rooms.set(2, { id: 2, type: RoomType.Morgue, access: 0, tiles: roomTiles, valid: true, ambience: 0, guards: 0 });
  assert(world.placePiece(10, 10, Obj.MorgueSlab, 0));
  const slab = world.anchorOf(world.idx(10, 10));
  const onSlab = { agentId: 440, x: 10.5, z: 10.5, deathTime: 0, discovered: true, hiddenIn: "",
    bloodEvidence: 1, odor: 0, morgueSlab: slab, removed: false };
  const waiting = { agentId: 441, x: 8.5, z: 10.5, deathTime: 1, discovered: true, hiddenIn: "",
    bloodEvidence: 1, odor: 0, morgueSlab: -1, removed: false };
  task2.health.bodies.set(onSlab.agentId, onSlab); task2.health.bodies.set(waiting.agentId, waiting);
  const guards = [staff(442, Obj.Guard, 8.5, 10.5), staff(443, Obj.Guard, 8.5, 10.5)];

  assert.equal(task2.security.updateStaff(guards[0]!, .1, 100, world, guards), false,
    "a guard releases the morgue response when every physical slab is occupied");
  assert.equal(task2.security.updateStaff(guards[1]!, .1, 100, world, guards), false,
    "a second guard does not claim the other tile of the same two-wide slab");
  assert.equal(waiting.morgueSlab, -1, "two footprint tiles still provide only one physical body slot");
  assert(guards.every((guard) => guard.state !== "bodyWaiting"), "full capacity never parks guards indefinitely");

  task2.health.tick(.1, 180, world, guards, task2.items);
  assert(onSlab.removed, "the scheduled hearse clears the occupied slab at the next 06:00 pickup");
  for (let tick = 1; tick <= 400 && waiting.morgueSlab < 0; tick++) {
    task2.security.updateStaff(guards[0]!, .1, 180 + tick * .1, world, guards);
  }
  assert.equal(waiting.morgueSlab, slab, "the waiting body uses the released physical slab after hearse turnover");
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
combatResponseLifecycleChecks();
combatResponseSimulationChecks();
workCashGangEscapeChecks();
securityMedicalEmergencyAndTillChecks();
solitaryBacklogReleasesCustodyChecks();
policyEscalationPreservesNewEvidenceChecks();
bedlessCasualtyDoesNotMonopolizeSecurityChecks();
parallelCasualtyTransportsReserveDistinctBedsChecks();
morgueSlotsArePhysicalAndGuardsDoNotWaitIndefinitelyChecks();
task2RoundTripAndScale();
hiddenUiChecks();
console.log("Task 2 items/areas/combat/health/policy/work/market/gangs/escape/save/UI checks passed");
