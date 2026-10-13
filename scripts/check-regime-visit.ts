import assert from "node:assert/strict";
import { Agents } from "../src/sim/agents.ts";
import { blankAgent, REG, type Agent } from "../src/sim/agent.ts";
import { ConstructionSystem } from "../src/sim/construction.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { IntakeSystem } from "../src/sim/intake.ts";
import { InfrastructureSystem } from "../src/sim/infrastructure.ts";
import { KitchenSystem } from "../src/sim/kitchen.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { Obj, RoomType, World } from "../src/sim/world.ts";
import { freshPrisonerMind, generatePrisonerProfile } from "../src/sim/profiles.ts";
import { Task2Systems } from "../src/sim/task2Systems.ts";
import { Task3Systems } from "../src/sim/task3Systems.ts";
import { advanceSimulation } from "../src/sim/simulation.ts";
import { PersonInstanceStager } from "../src/sim/renderData.ts";
import { VisitationSystem } from "../src/sim/visitation.ts";
import { HOUR_SECONDS } from "../src/sim/time.ts";

function addRoom(world: World, id: number, type: number, x0: number, z0: number, w: number, h: number): void {
  const tiles = new Set<number>();
  for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) {
    const tile = world.idx(x, z); tiles.add(tile); world.roomId[tile] = id;
  }
  world.rooms.set(id, { id, type, access: 0, tiles, valid: true, ambience: 0, guards: 0 });
}

function prisoner(id: number, x: number, z: number): Agent {
  const agent = blankAgent(Obj.Prisoner); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false;
  agent.profile = generatePrisonerProfile(id, 0x8090 + id); agent.mind = freshPrisonerMind(agent.profile);
  agent.escapeDesire = .9; agent.escapeFeasibility = .8; agent.desire = .9;
  agent.needs.food = .8; agent.needs.sleep = .8; agent.needs.hygiene = .8; agent.needs.bladder = .8;
  return agent;
}

function guard(id: number, x: number, z: number): Agent {
  const agent = blankAgent(Obj.Guard); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false;
  return agent;
}

const world = new World(400), agents = new Agents(), economy = new EconomySystem();
const logistics = new LogisticsSystem(economy), construction = new ConstructionSystem(logistics);
const kitchen = new KitchenSystem(logistics), intake = new IntakeSystem(economy);
const task2 = new Task2Systems(world.size, economy, logistics), task3 = new Task3Systems(task2, economy, logistics);
new InfrastructureSystem(world).installNewGame();
addRoom(world, 29, RoomType.Visitation, 350, 90, 8, 8);
assert(world.placePiece(351, 92, Obj.VisitScreen, 0));
assert(world.placePiece(354, 92, Obj.VisitorSearchDesk, 0));
assert(world.placePiece(370, 100, Obj.Gatehouse, 0));
task2.installNewGame(world); task2.rebuildWorld(world); task3.installNewGame(world, 0);
agents.regime.fill(REG.Work);
agents.construction = construction; agents.kitchen = kitchen; agents.task2 = task2; agents.task3 = task3;
task2.social = agents.social; task2.escapeOperations = agents.escapeOperations;

for (const policy of task2.areas.access.values()) {
  policy.roles.prisoner = true; policy.custody.minimum = true;
}
const resident = prisoner(8801, 347.5, 94.5), gateGuard = guard(8802, 370.9, 101.5),
  screenGuard = guard(8803, 348.5, 95.5), reliefGuard = guard(8804, 350.5, 95.5);
resident.needs.family = .1;
resident.compliant = true;
const group = [resident, gateGuard, screenGuard, reliefGuard];
for (const agent of group) { agents.agents.push(agent); task2.ensureAgent(agent, 0); }
task2.market.contacts.set(resident.id, [{ id: 9001, prisonerId: resident.id, name: "Jordan", relation: "family", trust: .8, resources: .8 }]);

resident.plan = { method: "cut", breaches: [world.idx(10, 10)], exitTile: world.idx(10, 9), needed: 1,
  stage: "execute", legI: 0, toiletIdx: -1, watchdog: 90 };
resident.state = "escape:observe";
task3.tick(.1, 0, world, group, agents.social, agents.escapeOperations, []);
assert.equal(task3.visitation.status().state, "idle", "ordinary family visits do not book an inmate who is executing an escape");
task3.visitation.loadData({}); // The active-execution scheduling probe has no visitor session.
resident.plan.stage = "prepare";
resident.state = "idle";

const publicArea = task2.areas.areaAt[world.idx(1, 1)], publicPolicy = task2.areas.access.get(publicArea)!;
const visitorPermission = publicPolicy.roles.visitor;
publicPolicy.roles.visitor = false;
const blockedAccessVisit = new VisitationSystem(task2.market, task2.areas, task3.facility);
blockedAccessVisit.tick(.1, 0, world, group, (id) => task2.health.isUnavailable(id));
blockedAccessVisit.tick(.1, .2, world, group, (id) => task2.health.isUnavailable(id));
assert.equal(blockedAccessVisit.status().state, "idle", "a deliberately closed visitor route does not start a misleading appointment");
assert(blockedAccessVisit.status().warnings.some((warning) => warning.includes("Review Area Access along the route")),
  "closed visitor access gives a persistent, actionable Area Access warning");
publicPolicy.roles.visitor = visitorPermission;
assert(world.erase(354, 92), "the test can temporarily remove the required screening desk");
const missingVisitObjects = new VisitationSystem(task2.market, task2.areas, task3.facility);
missingVisitObjects.tick(.1, 0, world, group, (id) => task2.health.isUnavailable(id));
assert(missingVisitObjects.status().warnings.some((warning) => warning.includes("Visit Table or Visit Screen")),
  "missing visitation furniture warning lists both supported rendezvous choices");
assert(world.placePiece(354, 92, Obj.VisitorSearchDesk, 0), "the test restores the screening desk");

resident.plan = { method: "cut", breaches: [world.idx(10, 10)], exitTile: world.idx(10, 9), needed: 1,
  stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 90 };
const operation = agents.escapeOperations.adoptSoloPlan(resident, resident.plan, 0);
const scheme = task3.escape.createSchemeForOperation(operation, [resident], world, agents.social, "perimeter", 0);
agents.escapeOperations.operations.delete(operation.id);
resident.escapeOperationId = -1;

task3.visitation.tick(.1, 0, world, group, (id) => task2.health.isUnavailable(id));
assert.equal(task3.visitation.status().state, "waitingGate", "visit enters bounded public-gate waiting state");
assert(task3.visitation.hasAppointment(resident.id), "the waiting visit temporarily owns its resident appointment");
task3.visitation.tick(HOUR_SECONDS * 3 + 1, HOUR_SECONDS * 3 + 1, world,
  group.filter((agent) => agent.id !== gateGuard.id), (id) => task2.health.isUnavailable(id));
assert.equal(task3.visitation.status().state, "leaving", "visitor departs after a bounded wait when the public entrance has no guard");
assert(!task3.visitation.hasAppointment(resident.id), "cancelling a gate wait releases the resident's background plan");
assert.equal(resident.plan?.stage, "prepare", "a failed gate appointment leaves the resident's background plan available");
assert.equal(task3.escape.schemeForAgent(resident.id)?.id, scheme.id, "the failed appointment preserves the background escape scheme");
assert(task3.visitation.status().warnings.some((warning) => warning.includes("Check the Gatehouse guard")),
  "unattended-entrance warning names the actionable guard dependency");
task3.visitation.loadData({}); // The bounded-wait probe is complete; the full run starts from a clean schedule.
resident.state = "escape:observe";
let time = 0, sawScreening = false, sawReliefScreening = false, sawWalkingOrVisiting = false;
let sawDefiantEscortAttempt = false, persistedLiveVisit = false, blockedAndRestoredRoute = false, removedScreeningGuard = false;
for (let tick = 0; tick < 18_000 && task3.visitation.visitsCompleted === 0; tick++) {
  time = advanceSimulation({ world, agents, economy, logistics, construction, kitchen, intake, task2, task3 }, time, .1);
  if (task3.isLegitimateVisitParticipant(resident)) resident.compliant = false;
  const status = task3.visitationStatus();
  sawScreening ||= status.visitors.some((visitor) => visitor.state === "waitingScreen" || visitor.state === "contact") ||
    screenGuard.state === "screeningVisitor" || reliefGuard.state === "screeningVisitor";
  sawWalkingOrVisiting ||= resident.state === "walkingToVisit" || resident.state === "visiting";
  sawDefiantEscortAttempt ||= resident.escortedBy >= 0 || group.some((agent) => agent.kind === Obj.Guard &&
    ["regimeGo", "regimeEscort"].includes(agent.state) && agent.interact === resident.id);

  if (!persistedLiveVisit && status.visitors.length) {
    const batch = new PersonInstanceStager().stage(group, status.visitors);
    assert.equal(batch.prisoners.count, 1 + status.visitors.length, "visitor is included in the rendered civilian instances");
    const visitorColor = batch.prisoners.data.subarray(19, 19 + 19);
    assert([...visitorColor.subarray(15, 18)].every((channel, index) => Math.abs(channel - [.2, .65, .68][index]!) < .001),
      "visitor has a distinct teal render color");
    const checkpoint = task3.saveData();
    task3.loadData(checkpoint, world);
    const restoredStatus = task3.visitationStatus();
    assert.equal(restoredStatus.visitors.length, status.visitors.length, "active visitor survives task save/reload");
    assert.equal(restoredStatus.prisonerId, resident.id, "active visit remains assigned to the same resident");
    persistedLiveVisit = true;
  }

  const visitor = task3.visitation.visitors[0];
  if (!blockedAndRestoredRoute && visitor?.state === "toScreening" && visitor.pathI < visitor.path.length - 1) {
    const blockedTile = visitor.path.slice(visitor.pathI + 1).find((tile) => world.objKind[tile] === Obj.None && world.infrastructure[tile] === 0);
    assert.notEqual(blockedTile, undefined, "visitor route has an open tile that can be temporarily blocked");
    const bx = blockedTile % world.size, bz = Math.floor(blockedTile / world.size);
    assert(world.setWall(bx, bz, 1), "test can temporarily close an open visitor route tile");
    let sawBlockedRouteWarning = false;
    for (let wait = 0; wait < 400 && !sawBlockedRouteWarning; wait++) {
      time = advanceSimulation({ world, agents, economy, logistics, construction, kitchen, intake, task2, task3 }, time, .1);
      sawBlockedRouteWarning = [...task3.warnings].some((warning) => warning.includes("visitor's route was blocked"));
    }
    assert(sawBlockedRouteWarning,
      `blocked path is surfaced as an operational warning: ${[...task3.warnings].join(" | ")}`);
    assert(world.erase(bx, bz), "test can reopen the route tile");
    blockedAndRestoredRoute = true;
  }

  if (!removedScreeningGuard && screenGuard.state === "screeningVisitor") {
    screenGuard.state = "dead";
    removedScreeningGuard = true;
  }
  sawReliefScreening ||= reliefGuard.state === "screeningVisitor";
}

assert(sawScreening, `an assigned guard physically screens the arriving visitor; state=${screenGuard.state}, warnings=${[...task3.warnings].join(" | ")}`);
assert(sawWalkingOrVisiting, `resident joins the lawful visit during Work; state=${resident.state}`);
assert.equal(task3.visitation.visitsCompleted, 1, `the physical visit completes in the real simulation, time=${time}, state=${resident.state}, family=${resident.needs.family}, visitor=${JSON.stringify(task3.visitation.visitors)}, session=${JSON.stringify(task3.visitation.saveData())}, guard=${screenGuard.state}, warnings=${[...task3.warnings].join(" | ")}`);
assert.equal(sawDefiantEscortAttempt, false, "regime enforcement does not repeatedly escort a legitimate visit participant away");
assert(persistedLiveVisit, "active visitor render data and session survive save/reload");
assert(blockedAndRestoredRoute, "a blocked visitor route is reported and recovers after the route reopens");
assert(removedScreeningGuard && sawReliefScreening, "screening reassigns to a relief guard when the assigned guard is lost");
assert(resident.needs.family > .5, "only completed physical contact restores family need");
assert.equal(resident.plan?.stage, "prepare", "the resident's background escape plan survives a legitimate visit");
assert.equal(task3.escape.schemeForAgent(resident.id)?.id, scheme.id, "the background escape scheme remains present after the visit");
console.log("real-simulation family visit, non-Free regime, guards, and background-plan pause passed");
