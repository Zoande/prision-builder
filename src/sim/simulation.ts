import type { Agents } from "./agents.ts";
import { REG } from "./agent.ts";
import { Obj, type World } from "./world.ts";
import { hourOf } from "./time.ts";
import type { EconomySystem } from "./economy.ts";
import type { LogisticsSystem } from "./logistics.ts";
import type { ConstructionSystem } from "./construction.ts";
import type { KitchenSystem } from "./kitchen.ts";
import type { IntakeSystem } from "./intake.ts";
import type { Task2Systems } from "./task2Systems.ts";
import type { Task3Systems } from "./task3Systems.ts";

/** The same clock and update order are used by browser play and scenario tests. */
export interface SimulationSystems {
  world: World;
  agents: Agents;
  economy: EconomySystem;
  logistics: LogisticsSystem;
  construction: ConstructionSystem;
  kitchen: KitchenSystem;
  intake: IntakeSystem;
  task2: Task2Systems;
  task3: Task3Systems;
}

export function advanceSimulation(systems: SimulationSystems, time: number, delta: number): number {
  if (!Number.isFinite(delta) || delta < 0 || !Number.isFinite(time)) throw new Error("Invalid simulation clock");
  const { world, agents, economy, logistics, construction, kitchen, intake, task2, task3 } = systems;
  const staffCounts = new Map<number, number>();
  function updatePopulation(): void {
    staffCounts.clear();
    let prisoners = 0;
    for (const agent of agents.agents) {
      if (["removed", "dead", "morgue"].includes(agent.state) || task2.health.state(agent.id)?.alive === false) continue;
      if (agent.kind === Obj.Prisoner) prisoners++;
      else staffCounts.set(agent.kind, (staffCounts.get(agent.kind) ?? 0) + 1);
    }
    economy.setStaffCounts(staffCounts);
    economy.setPrisonerCount(prisoners);
  }
  updatePopulation();
  // A paused frame must not create orders, charge wages, or advance subsystems.
  let remaining = delta;
  while (remaining > 1e-9) {
    const step = Math.min(.1, remaining);
    time += step;
    updatePopulation();
    economy.tick(time, staffCounts);
    kitchen.tick(time, world);
    const repairDemand = { metal: 0, concrete: 0 };
    for (const job of agents.repairJobs) {
      if (job.claimedBy >= 0) continue;
      if (job.kind === "fence") repairDemand.metal++;
      else repairDemand.concrete += 2;
    }
    // Clear yesterday's unfulfilled demand when the last repair is canceled or completed.
    logistics.request(repairDemand, time, false, "security-repairs");
    agents.staffPerformance = economy.performanceMultiplier;
    logistics.tick(step, time, world);
    construction.tick(step);
    intake.tick(step, time, world, agents);
    agents.roadVehicleZ = [
      ...logistics.trucks.filter((truck) => truck.state === "arriving" || truck.state === "departing").map((truck) => truck.z),
      ...intake.vehicles.filter((vehicle) => vehicle.state === "arriving" || vehicle.state === "departing").map((vehicle) => vehicle.z),
      ...[...task3.escape.externalVehicles.values()].filter((vehicle) => vehicle.state === "arriving" || vehicle.state === "departing").map((vehicle) => vehicle.z),
    ];
    const hour = hourOf(time);
    const activity = agents.regime[Math.floor(hour)];
    task2.tick(step, time, world, agents.agents, activity === REG.Work, activity === REG.RollCall);
    task3.tick(step, time, world, agents.agents, agents.social, agents.escapeOperations, agents.tunnels);
    for (const id of task3.consumeEscaped()) agents.markEscapedBySystem(id);
    agents.update(step, world, hour < 6 || hour >= 18, hour, time);
    remaining -= step;
  }
  return time;
}
