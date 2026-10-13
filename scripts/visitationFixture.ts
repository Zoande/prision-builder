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
import { HOUR_SECONDS } from "../src/sim/time.ts";

const WORLD_TIME = 8 * HOUR_SECONDS + 28;

function prisoner(id: number, x: number, z: number): Agent {
  const agent = blankAgent(Obj.Prisoner); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false;
  agent.profile = generatePrisonerProfile(id, 0x8090 + id); agent.mind = freshPrisonerMind(agent.profile);
  agent.needs.food = .8; agent.needs.sleep = .8; agent.needs.hygiene = .8; agent.needs.bladder = .8;
  agent.needs.family = .1; agent.compliant = true;
  return agent;
}

function guard(id: number, x: number, z: number): Agent {
  const agent = blankAgent(Obj.Guard); agent.id = id; agent.x = x; agent.z = z; agent.cuffed = false;
  return agent;
}

/** A v6 save imported into a genuinely fresh browser, with a normal family contact. */
export function createVisitationSave(startInRoom = false, useScreenOnly = false) {
  const world = new World(500), agents = new Agents(), economy = new EconomySystem();
  const logistics = new LogisticsSystem(economy), construction = new ConstructionSystem(logistics);
  const kitchen = new KitchenSystem(logistics), intake = new IntakeSystem(economy);
  const task2 = new Task2Systems(world.size, economy, logistics), task3 = new Task3Systems(task2, economy, logistics);
  const infrastructure = new InfrastructureSystem(world);
  infrastructure.installNewGame();
  // Make a genuinely enclosed room so World.loadData's room reconstruction
  // keeps it across the browser reload. The public Door is the visitor route.
  for (let x = 347; x <= 360; x++) {
    world.setWall(x, 86, 1); world.setWall(x, 101, 1);
  }
  for (let z = 87; z <= 100; z++) {
    world.setWall(347, z, 1); world.setWall(360, z, 1);
  }
  world.setDoor(352, 86);
  world.recomputeRooms();
  const visitationRoom = world.startRoomPaint(348, 87, RoomType.Visitation);
  if (visitationRoom <= 0) throw new Error("Could not create an enclosed visitation room");
  for (let z = 87; z <= 100; z++) for (let x = 348; x <= 359; x++) world.paintRoomInto(x, z, visitationRoom);
  world.endRoomPaint(visitationRoom);
  if (!world.placePiece(351, 92, useScreenOnly ? Obj.VisitScreen : Obj.VisitTable, 0) || !world.placePiece(354, 92, Obj.VisitorSearchDesk, 0) ||
      !world.placePiece(370, 100, Obj.Gatehouse, 0)) throw new Error("Could not build the visitation test site");
  task2.installNewGame(world); task2.rebuildWorld(world); task3.installNewGame(world, WORLD_TIME);
  agents.regime.fill(REG.Work);
  agents.construction = construction; agents.kitchen = kitchen; agents.task2 = task2; agents.task3 = task3;
  task2.social = agents.social; task2.escapeOperations = agents.escapeOperations;
  for (const policy of task2.areas.access.values()) {
    policy.roles.prisoner = true; policy.custody.minimum = true;
  }
  const resident = prisoner(8801, 351.5, 93.5), gateGuard = guard(8802, 370.9, 101.5),
    screenGuard = guard(8803, 348.5, 95.5);
  for (const agent of [resident, gateGuard, screenGuard]) { agents.agents.push(agent); task2.ensureAgent(agent, WORLD_TIME); }
  task2.market.contacts.set(resident.id, [{ id: 9001, prisonerId: resident.id, name: "Jordan", relation: "family", trust: .8, resources: .8 }]);
  const simulation = { world, agents, economy, logistics, construction, kitchen, intake, task2, task3 };
  let worldTime = WORLD_TIME;
  for (let tick = 0; tick < 2400 && task3.visitation.status().state !== "toScreening"; tick++) {
    worldTime = advanceSimulation(simulation, worldTime, .1);
  }
  if (task3.visitation.status().state !== "toScreening") {
    throw new Error(`Could not start a real browser-fixture visit: ${JSON.stringify(task3.visitation.status())}`);
  }
  if (startInRoom) {
    for (let tick = 0; tick < 2400 && !["waitingPrisoner", "contact"].includes(task3.visitation.status().state); tick++) {
      worldTime = advanceSimulation(simulation, worldTime, .1);
    }
    if (!["waitingPrisoner", "contact"].includes(task3.visitation.status().state)) {
      throw new Error(`Could not reach an in-room family visit for the browser screenshot: ${JSON.stringify(task3.visitation.status())}`);
    }
    for (let tick = 0; tick < 500 && task3.visitation.status().state !== "contact" && task3.visitation.visitsCompleted < 1; tick++) {
      worldTime = advanceSimulation(simulation, worldTime, .1);
    }
  }
  return {
    version: 6,
    savedAt: new Date(0).toISOString(),
    worldTime,
    view: { target: [358, 0, 98] as [number, number, number], yaw: 0, pitch: .62, distance: 48 },
    world: world.saveData(), agents: agents.saveData(), infrastructure: infrastructure.saveData(),
    economy: economy.saveData(), logistics: logistics.saveData(), construction: construction.saveData(),
    kitchen: kitchen.saveData(), intake: intake.saveData(), task2: task2.saveData(), task3: task3.saveData(),
  };
}
