import assert from "node:assert/strict";
import { blankAgent, type Agent } from "../src/sim/agent.ts";
import type { EscapeExitMode, PlanAction } from "../src/sim/advancedEscape.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { EscapeOperationsSystem } from "../src/sim/escapeOperations.ts";
import { InfrastructureSystem } from "../src/sim/infrastructure.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { Obj, RoomType } from "../src/sim/objects.ts";
import { freshPrisonerMind, generatePrisonerProfile } from "../src/sim/profiles.ts";
import { SAVE_VERSION, isSaveV6 } from "../src/sim/saveVersion.ts";
import { PrisonerSocialSystem } from "../src/sim/social.ts";
import { Task2Systems } from "../src/sim/task2Systems.ts";
import { Task3Systems } from "../src/sim/task3Systems.ts";
import { World } from "../src/sim/world.ts";

function inmate(id: number, x = 40.5, z = 40.5): Agent {
  const agent = blankAgent(Obj.Prisoner); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false;
  agent.profile = generatePrisonerProfile(id, 0x51a000 + id); agent.mind = freshPrisonerMind(agent.profile);
  agent.profile.aptitudes.intelligence = 10; agent.profile.aptitudes.creativity = 9;
  agent.profile.skills.leadership.level = 8; agent.profile.skills.deception.level = 8;
  agent.profile.skills.smuggling.level = 8; agent.profile.skills.toolcraft.level = 8;
  return agent;
}

function staff(id: number, kind: number, x = 45.5, z = 40.5): Agent {
  const agent = blankAgent(kind); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false; return agent;
}

function addRoom(world: World, id: number, type: number, x0: number, z0: number, w = 6, h = 6): void {
  const tiles = new Set<number>();
  for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) {
    const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = id;
  }
  world.rooms.set(id, { id, type, access: 0, tiles, valid: true, ambience: 0, guards: 0 });
}

function setup() {
  const world = new World(400), economy = new EconomySystem(), logistics = new LogisticsSystem(economy);
  const infrastructure = new InfrastructureSystem(world); infrastructure.installNewGame();
  const task2 = new Task2Systems(world.size, economy, logistics); task2.installNewGame(world);
  const task3 = new Task3Systems(task2, economy, logistics);
  addRoom(world, 20, RoomType.RecordsOffice, 30, 30); world.placePiece(31, 31, Obj.RecordsDesk, 0); world.placePiece(34, 31, Obj.RecordsCabinet, 0);
  addRoom(world, 21, RoomType.Utilities, 50, 30); world.placePiece(51, 31, Obj.ElectricalPanel, 0); world.placePiece(53, 31, Obj.SecurityRack, 0);
  addRoom(world, 22, RoomType.Visitation, 70, 30); world.placePiece(71, 31, Obj.VisitTable, 0); world.placePiece(73, 31, Obj.VisitScreen, 0); world.placePiece(75, 31, Obj.VisitorSearchDesk, 0);
  addRoom(world, 23, RoomType.Infirmary, 90, 30); world.placePiece(91, 31, Obj.MedicalBed, 0); world.placePiece(94, 31, Obj.MedicineCabinet, 0);
  addRoom(world, 24, RoomType.Laundry, 110, 30); world.placePiece(111, 31, Obj.Washer, 0); world.placePiece(113, 31, Obj.Dryer, 0); world.placePiece(115, 31, Obj.IroningTable, 0);
  addRoom(world, 25, RoomType.MailRoom, 130, 30); world.placePiece(131, 31, Obj.MailSorter, 0);
  addRoom(world, 26, RoomType.ManagementOffice, 150, 30); world.placePiece(151, 31, Obj.ExecutiveDesk, 0); world.placePiece(154, 31, Obj.FilingCabinet, 0); world.placePiece(155, 32, Obj.ManagementTerminal, 0); world.placePiece(151, 34, Obj.Chair, 0);
  addRoom(world, 27, RoomType.ManagementOffice, 170, 30); world.placePiece(171, 31, Obj.ExecutiveDesk, 0); world.placePiece(174, 31, Obj.FilingCabinet, 0); world.placePiece(175, 32, Obj.ManagementTerminal, 0); world.placePiece(171, 34, Obj.Chair, 0);
  addRoom(world, 28, RoomType.ManagementOffice, 190, 30); world.placePiece(191, 31, Obj.ExecutiveDesk, 0); world.placePiece(194, 31, Obj.FilingCabinet, 0); world.placePiece(195, 32, Obj.ManagementTerminal, 0); world.placePiece(191, 34, Obj.Chair, 0);
  task2.rebuildWorld(world); task3.installNewGame(world, 0);
  return { world, economy, logistics, task2, task3 };
}

function saveAndGatehouseChecks(): void {
  assert.equal(SAVE_VERSION, 6);
  for (const version of [1, 2, 3, 4, 5]) assert.equal(isSaveV6({ version, world: {}, agents: {}, task2: {}, task3: {} }), false);
  assert.equal(isSaveV6({ version: 6, world: {}, agents: {}, task2: {}, task3: {} }), true);
  const { world, task3 } = setup();
  assert.equal(world.placePiece(100, 100, Obj.Gatehouse, 0), false, "Gatehouse must not be placeable away from the road");
  assert.equal(world.placePiece(370, 100, Obj.Gatehouse, 1), false, "Gatehouse orientation is fixed");
  assert.equal(world.placePiece(370, 100, Obj.Gatehouse, 0), true, "Gatehouse may span immutable road infrastructure");
  assert.equal(world.isInfrastructure(374, 101), true); assert.equal(world.erase(374, 101), false, "road remains immutable under the Gatehouse");
  assert.equal(world.removePieceAt(374, 101), true, "workman demolition can remove the road structure");
  assert.equal(world.isInfrastructure(374, 101), true, "demolition leaves the immutable road intact");
  assert.equal(world.placePiece(370, 100, Obj.Gatehouse, 0), true);
  task3.rebuildWorld(world); task3.facility.setInspection(world.piecesOfKind(Obj.Gatehouse)[0].id, "full");
  assert.equal([...task3.facility.gatehouses.values()][0].inspection, "full");
}

function managementCredentialAndCorruptionChecks(): void {
  const { world, task2, task3 } = setup();
  const prisoner = inmate(1), guard = staff(2, Obj.Guard), cook = staff(3, Obj.Cook);
  const chief = staff(4, Obj.ChiefOfficer), foreman = staff(5, Obj.Foreman), accountant = staff(6, Obj.Accountant);
  const agents = [prisoner, guard, cook, chief, foreman, accountant];
  for (const agent of agents) task2.ensureAgent(agent, 0);
  task3.tick(.1, 1, world, agents, new PrisonerSocialSystem(), new EscapeOperationsSystem(), []);
  assert.equal(task3.canHire(Obj.ChiefOfficer, agents), false); assert.equal(task3.canHire(Obj.Foreman, agents), false); assert.equal(task3.canHire(Obj.Accountant, agents), false);
  assert.equal(task3.management.assignments.size, 3, "each unique manager should claim one office");
  assert(task3.credentials.carried(guard.id, 1).some((credential) => credential.kind === "staff-id"));
  for (let n = 0; n < 5; n++) { const note = task2.items.create("cash-20", 1, { ownerId: prisoner.id }); task2.items.moveToContainer(note.id, `agent:${prisoner.id}:pockets`, 1); }
  assert(task3.staff.attemptCompromise(prisoner, cook, 2, 80, "skip-count"));
  task3.management.activateProcedure("spoon-count", 2, 24);
  assert.equal(task3.staffEfficiency(cook, 3), 1, "compromised cook bypasses count instead of losing throughput");
  assert.equal(task3.mayTakeSpoon(prisoner.id, 3), false, "the beneficiary heeds the cook's warning");
  const saved = JSON.parse(JSON.stringify(task3.saveData()));
  const economy2 = new EconomySystem(), logistics2 = new LogisticsSystem(economy2), task22 = new Task2Systems(world.size, economy2, logistics2), restored = new Task3Systems(task22, economy2, logistics2);
  task22.loadData(JSON.parse(JSON.stringify(task2.saveData())), world); restored.loadData(saved, world);
  assert.equal(restored.staff.profiles.size, task3.staff.profiles.size); assert.equal(restored.credentials.credentials.size, task3.credentials.credentials.size);
  assert.equal(restored.management.procedures.size, 1);
}

function planGraphChecks(): void {
  const { world, task2, task3 } = setup(); const social = new PrisonerSocialSystem(), operations = new EscapeOperationsSystem();
  const required: Record<EscapeExitMode, PlanAction> = {
    perimeter: "legacy-execute", tunnel: "legacy-execute", credential: "credential-walkout", vehicle: "depart-vehicle",
    visitation: "visitation-exit", medical: "medical-transfer", "outside-assistance": "outside-dig",
  };
  let id = 100;
  for (const mode of Object.keys(required) as EscapeExitMode[]) {
    const agent = inmate(id++, 40.5 + id, 40.5); task2.ensureAgent(agent, 0); task2.market.tick(.1, 0, world, [agent]);
    const method = mode === "tunnel" || mode === "outside-assistance" ? "dig" : mode === "perimeter" ? "cut" : "climb";
    const plan = { method, breaches: [world.idx(20, 20)], exitTile: world.idx(1, 20), needed: 1,
      stage: "prepare" as const, legI: 0, toiletIdx: world.idx(20, 20), watchdog: 0 };
    const operation = operations.adoptSoloPlan(agent, plan, 0);
    const scheme = task3.escape.createSchemeForOperation(operation, [agent], world, social, mode, 10);
    assert(scheme.nodes.some((node) => node.action === required[mode]), `${mode} graph lacks its physical exit action`);
    assert(scheme.nodes.every((node) => node.dependencies.every((dep) => scheme.nodes.some((candidate) => candidate.id === dep))));
    if (["vehicle", "visitation"].includes(mode)) assert(scheme.nodes.some((node) => node.alternatives.length > 0), `${mode} should have a corruption contingency`);
    const known = task3.escape.knownNodes(agent.id, scheme.id);
    assert(known.length > 0); assert(known.length <= scheme.nodes.length);
  }
  const copy = JSON.parse(JSON.stringify(task3.escape.saveData()));
  task3.escape.loadData(copy); assert.equal(task3.escape.schemes.size, 7);
}

function scaleCheck(): void {
  const started = performance.now(), { world, task2, task3 } = setup(), social = new PrisonerSocialSystem(), operations = new EscapeOperationsSystem();
  const agents: Agent[] = [];
  for (let id = 1; id <= 500; id++) { const agent = inmate(id, 10.5 + id % 150, 80.5 + ((id / 150) | 0)); task2.ensureAgent(agent, 0); agents.push(agent); }
  for (let id = 501; id <= 600; id++) { const agent = staff(id, id % 10 === 0 ? Obj.Cook : Obj.Guard, 20.5 + id % 100, 100.5); task2.ensureAgent(agent, 0); agents.push(agent); }
  task3.tick(.1, 1, world, agents, social, operations, []);
  const data = JSON.parse(JSON.stringify(task3.saveData())); task3.loadData(data, world);
  assert.equal(task3.staff.profiles.size, 100); assert(performance.now() - started < 20_000);
}

function deterministicCheck(): void {
  const run = () => {
    const { world, task2, task3 } = setup(), social = new PrisonerSocialSystem(), operations = new EscapeOperationsSystem();
    const agents = [inmate(701, 40.5, 40.5), inmate(702, 41.5, 40.5), staff(703, Obj.Guard, 45.5, 40.5), staff(704, Obj.Cook, 46.5, 40.5)];
    for (const agent of agents) task2.ensureAgent(agent, 0);
    const op = operations.adoptSoloPlan(agents[0], { method: "climb", breaches: [world.idx(20, 20)], exitTile: world.idx(1, 20), needed: 1,
      stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 0 }, 0);
    task3.escape.createSchemeForOperation(op, agents, world, social, "vehicle", 0);
    for (let n = 1; n <= 20; n++) task3.tick(.1, n * .1, world, agents, social, operations, []);
    return JSON.stringify(task3.saveData());
  };
  assert.equal(run(), run(), "Task 3 simulation and saved RNG state must be deterministic");
}

saveAndGatehouseChecks();
managementCredentialAndCorruptionChecks();
planGraphChecks();
scaleCheck();
deterministicCheck();
console.log("Task 3 Gatehouse/management/credentials/corruption/plans/save/scale checks passed");
