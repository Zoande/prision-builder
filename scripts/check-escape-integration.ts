import assert from "node:assert/strict";
import { Agents } from "../src/sim/agents.ts";
import { blankAgent, K_OPEN, REG } from "../src/sim/agent.ts";
import { ConstructionSystem } from "../src/sim/construction.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { IntakeSystem } from "../src/sim/intake.ts";
import { ItemSystem } from "../src/sim/itemSystem.ts";
import { KitchenSystem } from "../src/sim/kitchen.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { freshPrisonerMind, generatePrisonerProfile } from "../src/sim/profiles.ts";
import { Task2Systems } from "../src/sim/task2Systems.ts";
import { Task3Systems } from "../src/sim/task3Systems.ts";
import { advanceSimulation } from "../src/sim/simulation.ts";
import { Obj, World } from "../src/sim/world.ts";

const world = new World(64), agents = new Agents(), economy = new EconomySystem();
const logistics = new LogisticsSystem(economy), construction = new ConstructionSystem(logistics);
const kitchen = new KitchenSystem(logistics), intake = new IntakeSystem(economy);
const task2 = new Task2Systems(world.size, economy, logistics), task3 = new Task3Systems(task2, economy, logistics);
task2.installNewGame(world); task2.rebuildWorld(world); task3.installNewGame(world, 0);
agents.construction = construction; agents.kitchen = kitchen; agents.task2 = task2; agents.task3 = task3;
task2.social = agents.social; task2.escapeOperations = agents.escapeOperations;
agents.regime.fill(REG.Free);

assert(world.setFence(4, 20, 1));
for (let x = 0; x <= 5; x++) assert(world.setFloor(x, 20, 1));
const prisoner = blankAgent(Obj.Prisoner);
prisoner.id = 1; prisoner.x = 3.5; prisoner.z = 20.5; prisoner.decideT = 0;
prisoner.cuffed = false;
prisoner.profile = generatePrisonerProfile(1, 101); prisoner.mind = freshPrisonerMind(prisoner.profile);
prisoner.compliant = false; prisoner.escapeDesire = .98; prisoner.escapeFeasibility = .95;
prisoner.desire = .98; prisoner.needs.food = .95; prisoner.needs.sleep = .95;
prisoner.known = new Map();
for (let tile = 0; tile < world.size * world.size; tile++) {
  const x = tile % world.size, z = Math.floor(tile / world.size);
  if (world.objKind[tile] !== Obj.Fence) prisoner.known.set(tile, K_OPEN);
}
agents.agents.push(prisoner); task2.ensureAgent(prisoner, 0);

// This is a physical tool in the live Task 2 inventory model. The complete
// plan must acquire, stage, and consume it through the shared escape executor.
const cutter = task2.items.create("cutter", 0, { ownerId: -1 });
task2.items.moveToWorld(cutter.id, 4, 20, 0);
prisoner.plan = { method: "cut", breaches: [world.idx(4, 20)], exitTile: world.idx(5, 20), needed: 1,
  stage: "prepare", legI: 0, toiletIdx: -1, watchdog: 90 };
const operation = agents.escapeOperations.adoptSoloPlan(prisoner, prisoner.plan, 0);
let time = 0;
for (let tick = 0; tick < 1800; tick++) {
  time = advanceSimulation({ world, agents, economy, logistics, construction, kitchen, intake, task2, task3 }, time, .1);
  if (agents.escapedCount > 0 || prisoner.state === "caughtAtGatehouse") break;
}
const scheme = task3.escape.schemes.get(operation.advancedSchemeId);
assert(scheme, "live operation should become an advanced preparation scheme");
assert(scheme.nodes.some((node) => node.action === "legacy-execute" && ["active", "complete"].includes(node.state)),
  `physical breach executor should launch after preparation; blocker=${scheme.blocker}; ${scheme.nodes.map((node) => `${node.action}:${node.state}:${node.blocker}`).join(" | ")}`);
assert.equal(world.objKind[world.idx(4, 20)], Obj.CutFence,
  "the staged physical cutter should let the inmate breach the fence");
assert.equal(agents.escapedCount, 1, "the prisoner should complete the physical exit");
assert.equal(task2.items.items.get(cutter.id)?.locationKind, "destroyed", "the real cutter record should be consumed with the breach");

console.log("live advanced escape acquisition, physical breach, and item-consumption scenario passed");
