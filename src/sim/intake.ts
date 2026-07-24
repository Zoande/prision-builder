import { dayOf, hourOf } from "./time.ts";
import type { Agents } from "./agents.ts";
import { EconomySystem } from "./economy.ts";
import { Obj, RoomType, World, type Room } from "./world.ts";
import { astar, passable } from "./nav.ts";

export interface IntakeVehicle {
  id: number;
  arrivals: number;
  remaining: number;
  state: "arriving" | "waiting" | "processing" | "departing";
  x: number;
  z: number;
  timer: number;
  warning: string;
}

export class IntakeSystem {
  readonly vehicles: IntakeVehicle[] = [];
  readonly warnings = new Set<string>();
  private nextVehicleId = 1;
  private lastScheduledDay = -1;
  private rngState = 0x52f7a31d;

  readonly economy: EconomySystem;
  constructor(economy: EconomySystem) { this.economy = economy; }

  get queuedArrivals(): number {
    return this.vehicles.reduce((sum, vehicle) => sum + vehicle.remaining, 0);
  }

  tick(dt: number, worldTime: number, world: World, agents: Agents): void {
    this.warnings.clear();
    const day = dayOf(worldTime);
    const reception = [...world.rooms.values()].find((r) => r.type === RoomType.Reception && r.valid) ?? null;
    if (day >= 2 && Math.floor(hourOf(worldTime)) === 8 && day !== this.lastScheduledDay &&
        reception && world.prisonerCapacity() - agents.prisonerCount() - this.queuedArrivals > 0) {
      this.lastScheduledDay = day;
      this.schedule(world, agents);
    }
    for (const vehicle of this.vehicles) {
      vehicle.timer -= dt;
      if (vehicle.state === "arriving" && vehicle.timer <= 0) vehicle.state = "waiting";
      if (vehicle.state === "waiting") {
        const issue = this.receptionIssue(world, reception);
        if (issue) {
          vehicle.warning = issue;
          this.warnings.add(issue);
          continue;
        }
        if (this.receptionOccupancy(reception!, agents, world) >= this.receptionCapacity(reception!)) {
          vehicle.warning = "Prisoner transport is waiting: Reception is full";
          this.warnings.add(vehicle.warning);
          continue;
        }
        vehicle.warning = "";
        vehicle.state = "processing";
        vehicle.timer = 3;
      } else if (vehicle.state === "processing" && vehicle.timer <= 0) {
        const spawn = reception ? this.freeReceptionTile(reception, world) : -1;
        if (spawn < 0) {
          vehicle.state = "waiting";
          vehicle.warning = "Prisoner transport is waiting: Reception is full";
          continue;
        }
        const x = spawn % world.size, z = (spawn / world.size) | 0;
        if (!world.setPerson(x, z, Obj.Prisoner, 0)) {
          vehicle.state = "waiting";
          continue;
        }
        const before = agents.nextId;
        agents.sync(world);
        const prisoner = agents.agents.find((a) => a.id >= before && a.kind === Obj.Prisoner);
        if (prisoner) {
          prisoner.cuffed = true;
          prisoner.state = "cuffed";
          this.economy.markPrisonerProcessed();
        }
        vehicle.remaining--;
        vehicle.timer = 3;
        if (vehicle.remaining <= 0) { vehicle.state = "departing"; vehicle.timer = 6; }
      }
      if (vehicle.state === "departing") vehicle.z += dt * 20;
    }
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      if (this.vehicles[i].state === "departing" && this.vehicles[i].timer <= 0) this.vehicles.splice(i, 1);
    }
  }

  private schedule(world: World, agents: Agents): void {
    const free = Math.max(0, world.prisonerCapacity() - agents.prisonerCount() - this.queuedArrivals);
    if (free <= 0) return;
    const p = Math.max(0.08, Math.min(0.8, 0.08 + (free / 35) * 0.72));
    let arrivals = 1;
    for (let i = 0; i < 14; i++) if (this.random() < p) arrivals++;
    arrivals = Math.min(arrivals, free);
    this.vehicles.push({
      id: this.nextVehicleId++, arrivals, remaining: arrivals, state: "arriving",
      x: 374.5, z: -8, timer: 8, warning: "",
    });
  }

  private receptionIssue(world: World, reception: Room | null): string {
    if (!reception) return "Prisoner transport is waiting: Reception is missing or invalid";
    if (!this.receptionReachable(world, reception)) return "Prisoner transport is waiting: Reception is unreachable from the road";
    return "";
  }

  private receptionReachable(world: World, reception: Room): boolean {
    const target = reception.tiles.values().next().value;
    if (target === undefined) return false;
    for (let z = 0; z < world.size; z += 10) {
      const start = world.idx(371, z);
      if (astar(world.size, start, target, (i) => passable(world, i, true), 50_000, (from, to) => world.canNavigateEdge(from, to))) return true;
    }
    return false;
  }

  private receptionCapacity(room: Room): number { return Math.max(1, Math.floor(room.tiles.size / 4)); }

  private receptionOccupancy(room: Room, agents: Agents, world: World): number {
    let count = 0;
    for (const ag of agents.agents) {
      if (ag.kind !== Obj.Prisoner || !ag.cuffed) continue;
      const x = Math.floor(ag.x), z = Math.floor(ag.z);
      if (world.inBounds(x, z) && room.tiles.has(world.idx(x, z))) count++;
    }
    return count;
  }

  private freeReceptionTile(room: Room, world: World): number {
    for (const tile of room.tiles) if (world.objKind[tile] === Obj.None) return tile;
    return -1;
  }

  private random(): number {
    let x = this.rngState | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0x1_0000_0000;
  }

  sampleArrivalCount(freeBeds: number): number {
    if (freeBeds <= 0) return 0;
    const p = Math.max(0.08, Math.min(0.8, 0.08 + (Math.max(0, freeBeds) / 35) * 0.72));
    let arrivals = 1;
    for (let i = 0; i < 14; i++) if (this.random() < p) arrivals++;
    return Math.min(arrivals, Math.max(0, freeBeds));
  }

  forecast(worldTime: number, world: World, agents: Agents): { day: number; capacity: number; ready: boolean } {
    const capacity = Math.max(0, world.prisonerCapacity() - agents.prisonerCount() - this.queuedArrivals);
    const ready = capacity > 0 && [...world.rooms.values()].some((room) => room.type === RoomType.Reception && room.valid);
    return { day: Math.max(2, dayOf(worldTime) + (hourOf(worldTime) >= 8 ? 1 : 0)), capacity, ready };
  }

  saveData() {
    return {
      vehicles: this.vehicles, nextVehicleId: this.nextVehicleId,
      lastScheduledDay: this.lastScheduledDay, rngState: this.rngState,
    };
  }

  loadData(data: Partial<ReturnType<IntakeSystem["saveData"]>>): void {
    this.vehicles.length = 0; this.vehicles.push(...(data.vehicles ?? []).map((v) => ({ ...v })));
    this.nextVehicleId = data.nextVehicleId ?? 1;
    this.lastScheduledDay = data.lastScheduledDay ?? -1;
    this.rngState = data.rngState ?? 0x52f7a31d;
  }
}
