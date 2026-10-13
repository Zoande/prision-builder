import assert from "node:assert/strict";
import { Agents } from "../src/sim/agents.ts";
import { blankAgent, K_FENCE, K_OPEN, REG, type Agent, type EscapePlan } from "../src/sim/agent.ts";
import { ConstructionSystem } from "../src/sim/construction.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { IntakeSystem } from "../src/sim/intake.ts";
import { ItemSystem } from "../src/sim/itemSystem.ts";
import { KitchenSystem } from "../src/sim/kitchen.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { followPath } from "../src/sim/move.ts";
import { freshPrisonerMind, generatePrisonerProfile } from "../src/sim/profiles.ts";
import { Task2Systems } from "../src/sim/task2Systems.ts";
import { Task3Systems } from "../src/sim/task3Systems.ts";
import { advanceSimulation } from "../src/sim/simulation.ts";
import { Obj, RoomType, World } from "../src/sim/world.ts";

const SIZE = 400;
function addRoom(world: World, id: number, type: number, x: number, z: number, w = 8, h = 8): void {
  const tiles = new Set<number>();
  for (let tz = z; tz < z + h; tz++) for (let tx = x; tx < x + w; tx++) {
    const tile = world.idx(tx, tz); tiles.add(tile); world.roomId[tile] = id;
  }
  world.rooms.set(id, { id, type, access: 0, tiles, valid: true, ambience: 0, guards: 0 });
}

function createFixture(id: number, plan: EscapePlan, mode: "tunnel" | "perimeter" | "credential" | "vehicle" | "visitation" | "outside-assistance") {
  const world = new World(SIZE), agents = new Agents(), economy = new EconomySystem();
  const logistics = new LogisticsSystem(economy), construction = new ConstructionSystem(logistics);
  const kitchen = new KitchenSystem(logistics), intake = new IntakeSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics), task3 = new Task3Systems(task2, economy, logistics);
  task2.installNewGame(world); task2.rebuildWorld(world); task3.installNewGame(world, 0);
  agents.construction = construction; agents.kitchen = kitchen; agents.task2 = task2; agents.task3 = task3;
  task2.social = agents.social; task2.escapeOperations = agents.escapeOperations;
  agents.regime.fill(1);
  const credentials = mode === "credential", roadRoute = credentials || mode === "visitation" || mode === "vehicle";
  addRoom(world, 1, RoomType.Cell, credentials ? 350 : mode === "visitation" || mode === "vehicle" ? 340 : 18, credentials ? 378 : mode === "visitation" || mode === "vehicle" ? 362 : 18, 4, 4);
  addRoom(world, 2, RoomType.Security, credentials ? 342 : mode === "visitation" || mode === "vehicle" ? 344 : 22, credentials ? 370 : mode === "visitation" || mode === "vehicle" ? 362 : 18, 4, 4);
  addRoom(world, 3, RoomType.RecordsOffice, credentials ? 352 : mode === "visitation" ? 300 : mode === "vehicle" ? 350 : 26, credentials ? 378 : mode === "visitation" ? 330 : mode === "vehicle" ? 362 : 17);
  addRoom(world, 4, RoomType.Laundry, credentials ? 354 : mode === "visitation" ? 310 : mode === "vehicle" ? 358 : 39, credentials ? 378 : mode === "visitation" ? 330 : mode === "vehicle" ? 362 : 17);
  if (mode === "vehicle") addRoom(world, 5, RoomType.Delivery, 364, 372, 6, 6);
  else addRoom(world, 5, RoomType.Delivery, 364, 366);
  addRoom(world, 6, RoomType.Visitation, mode === "visitation" ? 350 : 346, 366);
  addRoom(world, 7, RoomType.MailRoom, roadRoute ? 340 : 30, roadRoute ? 370 : 29);
  addRoom(world, 8, RoomType.Infirmary, 330, 360);
  if (mode === "visitation") {
    assert(world.placePiece(350, 366, Obj.VisitTable, 0), "visitation room has a real visit table");
    assert(world.placePiece(353, 366, Obj.VisitorSearchDesk, 0), "visitation room has visitor screening");
  }
  if (mode === "vehicle") {
    for (let z = 372; z <= 377; z++) world.setFence(370, z, 1);
    for (let x = 363; x <= 370; x++) { world.setFence(x, 371, 1); world.setFence(x, 378, 1); }
    world.setFenceGate(370, 375, false);
    assert(world.placePiece(367, 374, Obj.LoadingPallet, 0), "delivery yard has an operational loading pallet");
    for (let z = 0; z < world.size; z++) for (let x = 372; x <= 377; x++) world.setInfrastructureFloor(x, z, 5);
    addRoom(world, 9, RoomType.Canteen, 350, 350);
    assert(world.placePiece(352, 352, Obj.Table, 0), "vehicle fixture includes a usable dining table");
    assert(world.placePiece(354, 352, Obj.ServingTable, 0), "vehicle fixture includes a stocked meal counter");
    assert(world.placePiece(352, 355, Obj.Bench2, 0), "canteen has seating");
  }
  if (roadRoute) assert(world.placePiece(340, 370, Obj.MailSorter, 0), "outside contact room has a mail sorter");
  else if (mode === "outside-assistance") assert(world.placePiece(30, 29, Obj.MailSorter, 0), "outside contact room has a mail sorter");
  if (roadRoute) assert(world.placePiece(370, 380, Obj.Gatehouse, 0), "road escape test has a real gatehouse");
  for (const room of world.rooms.values()) room.access = 1;
  task2.rebuildWorld(world);
  if (roadRoute) task3.rebuildWorld(world);
  // This route harness models a minimum-custody open interior; preserve
  // physical walls and closed furniture while letting the prisoner reach
  // rooms whose access is explicitly set to prisoners above.
  world.task2RoleAccess = null; world.task2Access = null;
  const prisoner = blankAgent(Obj.Prisoner);
  const startX = credentials ? 351.5 : mode === "visitation" ? 346.5 : mode === "vehicle" ? 352.5 : 20.5;
  const startZ = credentials ? 379.5 : mode === "visitation" || mode === "vehicle" ? 366.5 : 20.5;
  prisoner.id = id; prisoner.x = startX; prisoner.z = startZ; prisoner.cuffed = false; prisoner.compliant = false;
  prisoner.cellRoom = 1; prisoner.bedIdx = Math.floor(startZ) * SIZE + Math.floor(startX) + 1;
  prisoner.profile = generatePrisonerProfile(id, 0x71e500 + id); prisoner.mind = freshPrisonerMind(prisoner.profile);
  for (const key of Object.keys(prisoner.profile.aptitudes) as (keyof typeof prisoner.profile.aptitudes)[]) prisoner.profile.aptitudes[key] = 10;
  for (const skill of Object.values(prisoner.profile.skills)) skill.level = 10;
  if (credentials || mode === "visitation" || mode === "vehicle") {
    prisoner.profile.aptitudes.intelligence = 2;
    prisoner.profile.aptitudes.creativity = 2;
    prisoner.profile.skills.leadership.level = 2;
  }
  prisoner.desire = 1; prisoner.escapeDesire = .99; prisoner.escapeFeasibility = .99; prisoner.needs.food = .95; prisoner.needs.sleep = .95;
  prisoner.plan = { ...plan, breaches: [...plan.breaches], stage: "prepare", legI: 0, watchdog: 120 };
  prisoner.known = new Map();
  for (let tile = 0; tile < world.size * world.size; tile++) prisoner.known.set(tile, K_OPEN);
  agents.agents.push(prisoner); task2.ensureAgent(prisoner, 0);
  const operation = agents.escapeOperations.adoptSoloPlan(prisoner, prisoner.plan, 0);
  operation.rallyTile = plan.method === "dig" ? plan.breaches[0] : world.idx(Math.floor(prisoner.x), Math.floor(prisoner.z));
  const scheme = task3.escape.createSchemeForOperation(operation, [prisoner], world, agents.social, mode, 0);
  if (mode === "vehicle") agents.servingStock.set(world.idx(354, 352), 20);
  return { world, agents, economy, logistics, construction, kitchen, intake, task2, task3, prisoner, operation, scheme };
}

function addItem(f: ReturnType<typeof createFixture>, defId: string, x: number, z: number): number {
  const item = f.task2.items.create(defId, 0, { ownerId: -1, quality: .9 });
  f.task2.items.moveToWorld(item.id, x, z, 0); return item.id;
}

function run(f: ReturnType<typeof createFixture>, maxTicks: number, debug = false): number {
  let time = 0;
  for (let tick = 0; tick < maxTicks; tick++) {
    time = advanceSimulation(f, time, .1);
    if (debug && tick % 100 === 0) console.log("trace", time.toFixed(0), f.prisoner.state, f.prisoner.x.toFixed(1), f.prisoner.z.toFixed(1),
      `desire=${f.prisoner.escapeDesire.toFixed(2)} food=${f.prisoner.needs.food.toFixed(2)} sleep=${f.prisoner.needs.sleep.toFixed(2)} underground=${f.prisoner.underground} tunnel=${f.prisoner.tunnel?.believed ?? -1} path=${JSON.stringify(f.prisoner.path?.slice(0, 4))} inventory=${JSON.stringify(f.prisoner.inv)}`,
      f.scheme.nodes.filter((node) => !["planned", "available"].includes(node.state)).map((node) => `${node.action}:${node.state}:${node.progress.toFixed(2)}:${node.blocker}`).join(","),
      f.operation.acquisition?.itemIds, f.task2.items.itemsIn(f.scheme.cacheContainer).map((item) => item.id));
    if (f.agents.escapedCount || f.prisoner.state === "caughtAtGatehouse" || f.prisoner.cuffed) return time;
  }
  return time;
}

function describe(f: ReturnType<typeof createFixture>): string {
  return `agent=${f.prisoner.state}@${f.prisoner.x.toFixed(1)},${f.prisoner.z.toFixed(1)} path=${f.prisoner.path?.length ?? 0}/${f.prisoner.pathI} ` +
    `desire=${f.prisoner.escapeDesire.toFixed(2)} food=${f.prisoner.needs.food.toFixed(2)} sleep=${f.prisoner.needs.sleep.toFixed(2)} toilet=${f.world.objKind[f.prisoner.plan?.toiletIdx ?? -1]} ` +
    `op=${JSON.stringify(f.operation.acquisition)} adv=${f.operation.advancedReady} plan=${JSON.stringify(f.prisoner.plan)} ` +
    `cache=${JSON.stringify(f.task2.items.itemsIn(f.scheme.cacheContainer).map((item) => [item.id, item.defId]))} ` +
    `carried=${JSON.stringify(["hands", "pockets", "worn", "equipment"].flatMap((place) => f.task2.items.itemsIn(`agent:${f.prisoner.id}:${place}`).map((item) => [item.id, item.defId, item.containerId])))} ` +
    `visitation=${JSON.stringify([...f.world.rooms.values()].filter((r) => r.type === RoomType.Visitation).map((r) => [r.id, [...r.tiles][0]]))} visitors=${JSON.stringify([...f.task2.items.items.values()].filter((item) => ["civilian-clothes", "visitor-pass"].includes(item.defId)).map((item) => [item.id, item.defId, item.locationKind, item.x, item.z, item.containerId]))} ` +
    `external=${JSON.stringify([...f.task3.escape.externalVehicles.values()].map((vehicle) => [vehicle.id, vehicle.kind, vehicle.state, vehicle.x, vehicle.z, vehicle.passengerIds]))} ` +
    `trucks=${JSON.stringify(f.logistics.trucks.map((truck) => [truck.id, truck.state, truck.x, truck.z, truck.timer]))} ` +
    `physical=${JSON.stringify([...f.task2.items.items.values()].filter((item) => item.defId === "spoon").map((item) => [item.id, item.locationKind, item.containerId, item.x, item.z]))} ` +
    f.scheme.nodes.map((node) => `${node.id}${node.action}[${node.dependencies.join(",")}]:${node.state}:${node.progress.toFixed(2)}@${node.targetTile}${node.blocker ? `(${node.blocker})` : ""}`).join(" | ");
}

function physicalDig(): void {
  const rally = 20 * SIZE + 20, toilet = 20 * SIZE + 21, exit = 20 * SIZE + 24;
  const plan: EscapePlan = { method: "dig", breaches: [rally], exitTile: exit, needed: 1, stage: "prepare", legI: 0, toiletIdx: toilet, watchdog: 120 };
  const f = createFixture(2001, plan, "tunnel");
  f.world.setFloor(21, 20, 1);
  f.world.placePiece(21, 20, Obj.Toilet, 0);
  f.world.setFloor(20, 21, 1); f.world.placePiece(20, 21, Obj.Bed, 0);
  f.prisoner.bedIdx = 20 * SIZE + 21;
  f.prisoner.objMem!.set(Obj.Toilet, new Set([toilet]));
  const spoons = Array.from({ length: 7 }, () => addItem(f, "spoon", 20, 20));
  const time = run(f, 4000);
  assert(f.scheme.nodes.filter((node) => node.action === "acquire-item").length >= 7, "tunnel plan acquires enough individual spoons for the real dig distance");
  const spentSpoons = spoons.filter((id) => f.task2.items.items.get(id)?.locationKind === "destroyed").length;
  assert.equal((f.operation.acquisition?.itemIds?.length ?? 0) + spentSpoons, 7,
    `the bridge accounts for every separate spoon; ${describe(f)}`);
  assert(f.agents.tunnels.some((tunnel) => tunnel.believed >= 1), `inmate digs a physical tunnel through the toilet; ${describe(f)}`);
  assert(spentSpoons >= 6, "digging consumes a distinct physical spoon for each tile");
  assert(f.agents.escapedCount === 1 || f.prisoner.underground || f.prisoner.state === "outside" || f.prisoner.state === "fleeing",
    `the dig route reaches its real tunnel exit or is still in the tunnel at ${time}s; state=${f.prisoner.state}; ${describe(f)}`);
}

function multiBreachUsesTwoCutters(): void {
  const first = 30 * SIZE + 26, second = 30 * SIZE + 29;
  const plan: EscapePlan = { method: "cut", breaches: [first, second], exitTile: 30 * SIZE + 32, needed: 2, stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 120 };
  const f = createFixture(2002, plan, "perimeter");
  assert(f.world.setFence(26, 30, 1)); assert(f.world.setFence(29, 30, 1));
  f.prisoner.known!.set(first, K_FENCE); f.prisoner.known!.set(second, K_FENCE);
  const cutters = [addItem(f, "cutter", 20, 20), addItem(f, "cutter", 20, 20)];
  const time = run(f, 12000);
  assert(f.scheme.nodes.filter((node) => node.action === "acquire-item").length >= 2, "plan acquires two separate cutters for two barriers");
  assert(f.world.objKind[first] === Obj.CutFence && f.world.objKind[second] === Obj.CutFence,
    `legacy execution physically cuts both fences; state=${f.prisoner.state}; ${describe(f)}`);
  assert.equal(cutters.filter((id) => f.task2.items.items.get(id)?.locationKind === "destroyed").length, 2,
    "each breach consumes a different physical cutter record");
  assert(f.agents.escapedCount === 1, `the inmate should leave after both physical cuts at ${time}s`);
}

function credentialWalkoutUsesPhysicalDocumentsAndDisguise(): void {
  const rally = 379 * SIZE + 351;
  const plan: EscapePlan = { method: "cut", breaches: [rally], exitTile: 20 * SIZE + 24, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 120 };
  const f = createFixture(2004, plan, "credential");
  const schedule = addItem(f, "copied-schedule", 352, 378);
  const uniform = addItem(f, "staff-uniform", 355, 378);
  const paper = addItem(f, "paper", 352, 379), ink = addItem(f, "ink", 353, 379);
  const blank = addItem(f, "key-blank", 352, 380), scrap = addItem(f, "metal-scrap", 353, 380);
  const time = run(f, 4000);
  const node = (action: string) => f.scheme.nodes.find((row) => row.action === action);
  assert.equal(node("steal-record")?.state, "complete", `the plan steals a real copied schedule; ${describe(f)}`);
  assert.equal(node("forge-pass")?.state, "complete", `the schedule and physical paper/ink produce a forged pass; ${describe(f)}`);
  assert.equal(node("copy-key")?.state, "complete", `physical key blank and scrap produce a duplicate staff key; ${describe(f)}`);
  assert.equal(node("acquire-item")?.state, "complete", `the uniform is acquired from the laundry; ${describe(f)}`);
  assert.equal(f.task2.items.items.get(schedule)?.containerId, f.scheme.cacheContainer, "the stolen schedule remains a physically staged reference");
  assert.equal(f.task2.items.items.get(uniform)?.containerId, `agent:${f.prisoner.id}:pockets`, "the inmate retrieves the physically staged uniform before presenting credentials");
  assert.equal(f.task2.items.items.get(paper)?.locationKind, "destroyed");
  assert.equal(f.task2.items.items.get(ink)?.locationKind, "destroyed");
  assert.equal(f.task2.items.items.get(blank)?.locationKind, "destroyed");
  assert.equal(f.task2.items.items.get(scrap)?.locationKind, "destroyed");
  assert(f.agents.escapedCount === 1, `a prepared credential presentation leaves through the staff route at ${time}s; ${describe(f)}`);
}

function visitationRequiresLiveArrivalAndPhysicalPresentation(): void {
  const rally = 366 * SIZE + 346;
  const plan: EscapePlan = { method: "cut", breaches: [rally], exitTile: 366 * SIZE + 350, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 120 };
  const f = createFixture(2005, plan, "visitation");
  f.task2.market.contacts.set(f.prisoner.id, [{ id: 9001, prisonerId: f.prisoner.id, name: "Morgan Visitor",
    relation: "family", trust: .99, resources: .99 }]);
  f.prisoner.needs.family = .1;
  f.prisoner.profile!.aptitudes.intelligence = 2;
  f.prisoner.profile!.aptitudes.creativity = 2;
  f.prisoner.profile!.skills.leadership.level = 2;
  const familyNeedBeforeVisit = f.prisoner.needs.family;
  let time = 0, previousFamilyNeed = f.prisoner.needs.family, sawVisitorPassComplete = false, observedContactReward = false;
  for (let tick = 0; tick < 2400; tick++) {
    time = advanceSimulation(f, time, .1);
    const visitorPassComplete = f.scheme.nodes.some((node) => node.action === "acquire-item" && node.itemDefId === "visitor-pass" && node.state === "complete");
    if (!sawVisitorPassComplete && visitorPassComplete) {
      assert(f.prisoner.needs.family >= previousFamilyNeed + .4,
        `the family need rises at the completed, arrived visitor handoff: previous=${previousFamilyNeed} now=${f.prisoner.needs.family}`);
      observedContactReward = true;
    }
    sawVisitorPassComplete ||= visitorPassComplete;
    previousFamilyNeed = f.prisoner.needs.family;
    if (f.agents.escapedCount || f.prisoner.state === "caughtAtGatehouse" || f.prisoner.cuffed) break;
  }
  const visitor = [...f.task3.escape.commitments.values()].find((row) => row.type === "visitor");
  assert(visitor, `the inmate arranges outside visitation; ${describe(f)}`);
  assert.equal(visitor.state, "fulfilled", "the visitor vehicle arrives and completes unloading");
  const van = f.task3.escape.externalVehicles.get(visitor.vehicleId);
  assert(van, "the arrival is represented by a live external vehicle");
  assert(van.passengerIds.includes(f.prisoner.id) || f.agents.escapedCount === 1,
    `the inmate physically presents the visitor pass and boards the arrived vehicle at ${time}s; ${describe(f)}`);
  assert(f.agents.escapedCount === 1, `visitor vehicle clears the gate with the inmate aboard at ${time}s`);
  assert(f.scheme.nodes.some((node) => node.action === "acquire-item" && node.itemDefId === "civilian-clothes" && node.state === "complete"));
  assert(f.scheme.nodes.some((node) => node.action === "acquire-item" && node.itemDefId === "visitor-pass" && node.state === "complete"));
  assert(observedContactReward, "family benefit is earned at the arrived visitor handoff that completes the physical contact task");
  assert(f.prisoner.needs.family > familyNeedBeforeVisit + .25,
    `meeting a live family visitor improves the inmate's family need after ordinary time decay; before=${familyNeedBeforeVisit} after=${f.prisoner.needs.family}`);
}

function outsideDigUsesArrivedDiggerAndRealSpoons(): void {
  const rally = 20 * SIZE + 20, toilet = 20 * SIZE + 21;
  const plan: EscapePlan = { method: "dig", breaches: [rally], exitTile: 20 * SIZE + 24, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: toilet, watchdog: 120 };
  const f = createFixture(2006, plan, "outside-assistance");
  f.world.setFloor(21, 20, 1); f.world.placePiece(21, 20, Obj.Toilet, 0);
  f.world.setFloor(20, 21, 1); f.world.placePiece(20, 21, Obj.Bed, 0);
  f.prisoner.bedIdx = 20 * SIZE + 21;
  f.prisoner.objMem!.set(Obj.Toilet, new Set([toilet]));
  f.task2.market.contacts.set(f.prisoner.id, [{ id: 9002, prisonerId: f.prisoner.id, name: "Morgan Digger",
    relation: "criminal", trust: .99, resources: .99 }]);
  const spoons = Array.from({ length: 7 }, () => addItem(f, "spoon", 20, 20));
  const time = run(f, 3000);
  const commitment = [...f.task3.escape.commitments.values()].find((row) => row.type === "outside-digger");
  assert(commitment, `the digger arranges an outside contact; ${describe(f)}`);
  assert.equal(commitment.state, "fulfilled", "the outside vehicle arrives and the excavation contact is fulfilled");
  assert.equal(f.scheme.nodes.find((node) => node.action === "outside-dig")?.state, "complete",
    `the internal tunnel waits for the real outside commitment; ${describe(f)}`);
  const spentSpoons = spoons.filter((id) => f.task2.items.items.get(id)?.locationKind === "destroyed").length;
  assert(spentSpoons >= 4, "outside assistance still requires distinct physical spoons to dig inside");
  assert(f.agents.escapedCount === 1 || f.prisoner.underground || f.prisoner.state === "outside" || f.prisoner.state === "fleeing",
    `outside assistance connects to actual tunnel execution by ${time}s; ${describe(f)}`);
}

function vehicleRouteIsInspectedAtTheRoadGate(): void {
  const rally = 366 * SIZE + 352;
  const plan: EscapePlan = { method: "cut", breaches: [rally], exitTile: 366 * SIZE + 356, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 120 };
  const f = createFixture(2007, plan, "vehicle");
  const manifest = addItem(f, "delivery-manifest", 352, 366);
  f.task2.market.contacts.set(f.prisoner.id, [{ id: 9003, prisonerId: f.prisoner.id, name: "Morgan Driver",
    relation: "friend", trust: .99, resources: .99 }]);
  // Ask Logistics for a normal shipment and let its purchase dispatch create
  // the truck and physical cargo. Move that live arrival to its unloading
  // window so the scheme races a real load instead of a fabricated vehicle.
  f.logistics.request({ "frozen-meal": 1 }, 0, true, "escape-vehicle-test");
  f.logistics.tick(0, 900, f.world);
  const truck = f.logistics.trucks.find((row) => row.kind === "inbound");
  assert(truck && truck.packageIds.length > 0, "the logistics purchase creates an inbound truck carrying cargo");
  truck.state = "unloading"; truck.x = 365.5; truck.z = 374.5; truck.timer = 700;
  const guard = blankAgent(Obj.Guard); guard.id = 9004; guard.x = 370.9; guard.z = 381.5;
  f.agents.agents.push(guard); f.task2.ensureAgent(guard, 0);
  const gate = f.world.piecesOfKind(Obj.Gatehouse)[0];
  f.task3.facility.setInspection(gate.id, "full");
  f.prisoner.profile!.aptitudes.intelligence = 2;
  f.prisoner.profile!.aptitudes.creativity = 2;
  f.prisoner.profile!.skills.leadership.level = 2;
  f.prisoner.profile!.skills.stealth.level = 0;
  f.prisoner.profile!.skills.smuggling.level = 0;
  const time = run(f, 10000);
  const commitment = [...f.task3.escape.commitments.values()].find((row) => row.type === "driver");
  assert(commitment && commitment.state === "fulfilled", `a real driver confirms an outgoing load; ${describe(f)}`);
  assert.equal(f.scheme.nodes.find((node) => node.action === "steal-record")?.state, "complete",
    `the inmate steals a physical delivery manifest; ${describe(f)}`);
  assert.equal(f.scheme.nodes.find((node) => node.action === "steal-record")?.sourceItemId, manifest,
    "the plan records the exact physical manifest it stole");
  assert(f.task2.items.items.has(manifest), "the physical manifest remains accounted for after the inspection outcome");
  assert.equal(f.scheme.nodes.find((node) => node.action === "hide-in-vehicle")?.state, "complete",
    `the inmate boards an actual outgoing truck; ${describe(f)}`);
  assert.equal(f.task3.facility.gatehouses.get(gate.id)?.inspection, "full");
  assert(f.prisoner.state === "caughtAtGatehouse" || f.prisoner.cuffed || f.agents.escapedCount === 1,
    `the Gatehouse resolves the concealed passenger by ${time}s; ${describe(f)}`);
  assert(f.prisoner.cuffed && f.scheme.state === "failed",
    `a low-skill disguise is intercepted during full staffed inspection; ${describe(f)}`);
}

function vehicleRouteCanLeaveOnAPreparedLoad(): void {
  const rally = 366 * SIZE + 352;
  const plan: EscapePlan = { method: "cut", breaches: [rally], exitTile: 366 * SIZE + 356, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 120 };
  const f = createFixture(2008, plan, "vehicle");
  addItem(f, "delivery-manifest", 352, 366);
  f.task2.market.contacts.set(f.prisoner.id, [{ id: 9005, prisonerId: f.prisoner.id, name: "Morgan Driver",
    relation: "friend", trust: .99, resources: .99 }]);
  f.prisoner.profile!.skills.stealth.level = 10;
  f.prisoner.profile!.skills.smuggling.level = 10;
  f.logistics.request({ "frozen-meal": 1 }, 0, true, "escape-vehicle-success-test");
  f.logistics.tick(0, 900, f.world);
  const truck = f.logistics.trucks.find((row) => row.kind === "inbound");
  assert(truck && truck.packageIds.length > 0, "the successful route also uses a Logistics-generated cargo load");
  truck.state = "unloading"; truck.x = 365.5; truck.z = 374.5; truck.timer = 700;
  const gate = f.world.piecesOfKind(Obj.Gatehouse)[0];
  f.task3.facility.setInspection(gate.id, "none");
  const time = run(f, 10000);
  assert.equal(f.scheme.nodes.find((node) => node.action === "steal-record")?.state, "complete",
    `the driver route obtains its physical manifest; ${describe(f)}`);
  assert.equal(f.scheme.nodes.find((node) => node.action === "hide-in-vehicle")?.state, "complete",
    `the inmate hides inside the actual outbound cargo; ${describe(f)}`);
  assert.equal(f.agents.escapedCount, 1, `the prepared load leaves with its concealed passenger by ${time}s; ${describe(f)}`);
}

function escapeAssignmentsYieldAndResume(): void {
  const plan: EscapePlan = { method: "cut", breaches: [20 * SIZE + 20], exitTile: 20 * SIZE + 24, needed: 1,
    stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 120 };
  const f = createFixture(2003, plan, "perimeter");
  const observe = f.scheme.nodes.find((node) => node.action === "observe")!;
  assert.equal(observe.state, "available");
  f.prisoner.state = "escape:observe";
  observe.state = "active"; observe.progress = .35;
  f.prisoner.needs.food = .09;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 1, f.world, f.agents.agents), false,
    "critical hunger hands control back to ordinary prisoner behavior");
  assert.equal(observe.progress, .35, "need interruption preserves observation work");

  f.prisoner.needs.food = .95; f.prisoner.escapeDesire = .1;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 2, f.world, f.agents.agents), false,
    "a satisfied low-desire inmate can resume ordinary routines");
  assert.equal(observe.progress, .35, "low motivation does not erase observation progress");

  f.prisoner.escapeDesire = .99;
  f.prisoner.needs.food = .29;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 2.25, f.world, f.agents.agents), false,
    "escape work yields before an ordinary meal becomes urgent");
  f.prisoner.needs.food = .45;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 2.4, f.world, f.agents.agents), false,
    "need recovery has hysteresis and does not hand control back too early");
  f.prisoner.needs.food = .95;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 2.5, f.world, f.agents.agents, REG.Eating), false,
    "scheduled meal time yields even when escape motivation is high");
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 2.6, f.world, f.agents.agents, REG.Shower), false,
    "scheduled shower time yields so escape planning cannot monopolize hygiene");
  assert.equal(observe.progress, .35, "scheduled activity pauses without discarding graph work");
  f.prisoner.state = "using";
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 2.75, f.world, f.agents.agents), false,
    "escape work does not interrupt an ordinary activity already in progress");
  f.prisoner.state = "escape:observe";
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3, f.world, f.agents.agents), true,
    "the escape assignment resumes when needs and motivation permit");
  assert(observe.progress >= .35, "resumed observation continues from the saved task progress");
  assert.equal(f.prisoner.state, "escape:observe", "the resumed task takes control after ordinary activity ends");

  // The legacy breach planner can own a movement path while its visible state
  // is `exploring`. Yielding only the advanced node would leave the path live,
  // so ordinary needs behavior could not choose a meal until arrival.
  f.prisoner.state = "exploring";
  f.prisoner.path = [f.world.idx(21, 20), f.world.idx(22, 20)];
  f.prisoner.pathI = 0;
  f.prisoner.needs.food = .25;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.2, f.world, f.agents.agents), false,
    "a low-need inmate yields an active legacy plan to ordinary behavior");
  assert.equal(f.prisoner.path, null, "yielding clears stale escape-owned legacy movement");
  f.prisoner.path = [f.world.idx(21, 20), f.world.idx(22, 20)]; f.prisoner.pathI = 0;
  const beforeMove = f.prisoner.x;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.3, f.world, f.agents.agents), false);
  assert(f.prisoner.path, "ordinary food-search movement survives later ticks while hunger remains");
  followPath(f.prisoner, .1, f.world, false);
  assert(f.prisoner.x > beforeMove || f.prisoner.pathI > 0,
    "the ordinary food-search route can advance instead of being restarted each tick");

  f.prisoner.needs.food = .95; f.prisoner.needs.sleep = .95;
  f.prisoner.escapeDesire = .99; f.prisoner.path = null; f.prisoner.state = "cuffed"; f.prisoner.cuffed = true;
  const beforeCustody = observe.progress;
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.4, f.world, f.agents.agents), false,
    "a cuffed prisoner cannot perform an advanced escape assignment");
  assert.equal(observe.progress, beforeCustody, "custody preserves but does not advance the assigned node");
  f.prisoner.cuffed = false; f.prisoner.escortedBy = 9000; f.prisoner.state = "escorted";
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.5, f.world, f.agents.agents), false,
    "an escorted prisoner cannot perform an advanced escape assignment");
  f.prisoner.escortedBy = -1; f.prisoner.state = "inTreatment";
  const health = f.task2.health.ensure(f.prisoner);
  f.task2.health.applyInjury(f.prisoner, "cut", "left-arm", .22, 3.5);
  assert(health.consciousness > .08 && !health.admitted, "the medical transport regression uses a conscious, non-admitted patient");
  // Medical transport itself sets the state but does not use escortedBy;
  // guard ownership lives in the health job claim.
  f.prisoner.escortedBy = -1; f.prisoner.state = "beingTransported";
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.55, f.world, f.agents.agents), false,
    "a conscious patient under medical transport cannot perform an escape task before admission");
  assert.equal(observe.progress, beforeCustody, "medical transport pauses escape progress before admission");
  health.admitted = true; f.prisoner.state = "inTreatment";
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.6, f.world, f.agents.agents), false,
    "a patient admitted to treatment cannot perform an advanced escape assignment");
  assert.equal(observe.progress, beforeCustody, "custody and treatment do not erase graph progress");
  health.admitted = false; f.prisoner.state = "idle";
  assert.equal(f.task3.updatePrisoner(f.prisoner, .1, 3.7, f.world, f.agents.agents), true,
    "the advanced assignment resumes after custody and treatment end");
}

console.log("checking physical dig, multi-breach cutter, credential, and visitation routes...");
escapeAssignmentsYieldAndResume();
physicalDig();
multiBreachUsesTwoCutters();
credentialWalkoutUsesPhysicalDocumentsAndDisguise();
visitationRequiresLiveArrivalAndPhysicalPresentation();
outsideDigUsesArrivedDiggerAndRealSpoons();
vehicleRouteIsInspectedAtTheRoadGate();
vehicleRouteCanLeaveOnAPreparedLoad();
console.log("escape needs handoff, dig, two-cut, credential, visitation, outside-assistance, and truck success/interception routes passed");
