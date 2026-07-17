import type { Agent } from "./agent.ts";
import type { EconomySystem } from "./economy.ts";
import type { HealthSystem } from "./health.ts";
import { ItemSystem, itemDefV4, type ItemInstance } from "./itemSystem.ts";
import { astar, passable, roleAllowed } from "./nav.ts";
import type { LogisticsSystem } from "./logistics.ts";
import { Obj, RoomType } from "./objects.ts";
import { skill } from "./profiles.ts";
import { HOUR_SECONDS } from "./time.ts";
import type { Room, World } from "./world.ts";

export type Supervision = "none" | "periodic" | "constant";
export type JobRisk = "low" | "standard" | "skilled";

export interface JobDef {
  id: string; name: string; roomTypes: number[]; stations: number[]; areaJob: boolean;
  risk: JobRisk; toolIds: string[]; outputId: string; seconds: number; inputValue: number;
  diversionIds: string[];
}

export interface Workplace {
  roomId: number; jobId: string; capacity: number; supervision: Supervision;
  assigned: number[]; active: number[]; completed: number; outputContainer: string;
  stockContainer: string; lastSupervisedAt: number; blocked: string;
}

export const JOB_DEFS: JobDef[] = [
  job("laundry", "Laundry", [RoomType.Laundry], [Obj.Washer, Obj.Dryer, Obj.IroningTable], false, "standard", ["needle"], "laundry-bundle", 32, 8, ["cloth", "needle"]),
  job("library", "Library sorting", [RoomType.Library], [Obj.ReadingDesk], false, "low", [], "book", 38, 5, ["paper", "book"]),
  job("mail", "Mail room", [RoomType.MailRoom], [Obj.MailSorter], false, "standard", [], "sorted-mail", 34, 6, ["mail-letter", "cash-5", "drugs", "phone"]),
  job("greenhouse", "Greenhouse", [RoomType.Greenhouse], [Obj.GreenhousePlanter, Obj.PottingBench], true, "standard", ["trowel", "pruning-shears"], "produce-crate", 36, 14, ["trowel", "pruning-shears", "fertilizer"]),
  job("kitchen", "Kitchen", [RoomType.Kitchen], [Obj.Cooker], false, "standard", ["kitchen-knife"], "frozen-meal", 34, 8, ["kitchen-knife", "sugar", "yeast"]),
  job("canteen", "Canteen", [RoomType.Canteen], [Obj.ServingTable, Obj.Sink], false, "low", [], "spoon", 40, 4, ["spoon"]),
  job("janitorial", "Janitorial", [RoomType.Janitorial], [Obj.JanitorCart], true, "standard", ["chemical"], "laundry-bundle", 40, 7, ["chemical"]),
  job("grounds", "Groundskeeping", [RoomType.Yard], [], true, "standard", ["shovel", "pruning-shears"], "produce-crate", 44, 10, ["shovel", "rope", "pruning-shears"]),
  job("recycling", "Recycling", [RoomType.Recycling], [Obj.RecyclingSorter], false, "standard", ["file"], "recycled-goods", 42, 16, ["metal-scrap", "wire", "hacksaw-blade"]),
  job("woodshop", "Woodshop", [RoomType.Woodshop], [Obj.WoodWorkbench], false, "skilled", ["hammer"], "wood-goods", 48, 28, ["hammer", "wood-scrap", "club"]),
  job("metalshop", "Metalshop", [RoomType.Metalshop], [Obj.MetalWorkbench], false, "skilled", ["file", "hacksaw-blade"], "metal-goods", 52, 40, ["file", "hacksaw-blade", "cutter", "metal-scrap"]),
  job("tailoring", "Tailoring", [RoomType.Tailoring], [Obj.SewingMachine], false, "skilled", ["needle"], "tailored-goods", 45, 22, ["needle", "cloth", "staff-uniform"]),
  job("maintenance", "Maintenance", [RoomType.Maintenance], [Obj.MaintenanceBench], true, "skilled", ["screwdriver"], "recycled-goods", 46, 20, ["screwdriver", "wire", "staff-key"]),
  job("shop", "Prison shop", [RoomType.Shop], [Obj.ShopCounter], false, "standard", [], "shop-soap", 36, 8, ["cash-5", "cash-10", "shop-snack"]),
  job("printing", "Printing / Bookbinding", [RoomType.PrintShop], [Obj.PrintPress], false, "skilled", [], "printed-goods", 44, 20, ["paper", "ink", "book"]),
  job("logistics", "Delivery / Exports", [RoomType.Delivery, RoomType.Exports], [Obj.LoadingPallet], true, "standard", [], "recycled-goods", 46, 14, ["mail-letter", "phone", "drugs"]),
];

const JOB_INPUTS: Record<string, Record<string, number>> = {
  laundry: { cloth: 1 }, greenhouse: { fertilizer: 1 }, janitorial: { chemical: 1 },
  grounds: { fertilizer: 1 }, recycling: { "metal-scrap": 1 }, woodshop: { "wood-scrap": 2 },
  metalshop: { "metal-scrap": 2 }, tailoring: { cloth: 2 }, maintenance: { wire: 1 },
  printing: { paper: 2, ink: 1 },
};

function job(id: string, name: string, roomTypes: number[], stations: number[], areaJob: boolean,
  risk: JobRisk, toolIds: string[], outputId: string, seconds: number, inputValue: number,
  diversionIds: string[]): JobDef {
  return { id, name, roomTypes, stations, areaJob, risk, toolIds, outputId, seconds, inputValue, diversionIds };
}

export class WorkSystem {
  readonly workplaces = new Map<number, Workplace>();
  readonly assignments = new Map<number, number>();
  readonly warnings = new Set<string>();
  private readonly taskProgress = new Map<number, number>();
  private readonly activeTools = new Map<number, number>();
  private readonly haulClaims = new Map<number, number>();
  private readonly hauls = new Map<number, { itemId: number; phase: "pickup" | "dropoff" }>();
  private readonly inputClaims = new Map<number, number>();
  private readonly inputHauls = new Map<number, { packageId: number; roomId: number; phase: "pickup" | "dropoff" }>();
  private readonly paidHours = new Set<string>();
  private lastExportDay = -1;
  private rngState = 0x67f23a91;
  private readonly items: ItemSystem;
  private readonly economy: EconomySystem;
  private readonly logistics: LogisticsSystem;

  constructor(items: ItemSystem, economy: EconomySystem, logistics: LogisticsSystem) {
    this.items = items; this.economy = economy; this.logistics = logistics;
  }

  refresh(world: World, time: number): void {
    const valid = new Set<number>();
    for (const room of world.rooms.values()) {
      if (!room.valid) continue;
      const def = JOB_DEFS.find((j) => j.roomTypes.includes(room.type));
      if (!def) continue;
      valid.add(room.id);
      let workplace = this.workplaces.get(room.id);
      if (!workplace) {
        const center = roomCenter(room, world.size);
        const stockContainer = `work:${room.id}:stock`, outputContainer = `work:${room.id}:output`;
        this.items.ensureContainer({ id: stockContainer, name: `${def.name} controlled stock`, x: center.x, z: center.z,
          capacity: 64, concealment: .25, bodyCapacity: 0, lockedTier: "staff", ownerId: -1, tags: ["work", "controlled"] });
        this.items.ensureContainer({ id: outputContainer, name: `${def.name} output`, x: center.x, z: center.z,
          capacity: 64, concealment: .1, bodyCapacity: 0, lockedTier: "none", ownerId: -1, tags: ["work", "output"] });
        workplace = { roomId: room.id, jobId: def.id, capacity: 0, supervision: "periodic", assigned: [], active: [],
          completed: 0, outputContainer, stockContainer, lastSupervisedAt: time, blocked: "" };
        this.workplaces.set(room.id, workplace);
      }
      workplace.capacity = this.capacity(room, def, world);
      this.requestStock(workplace, def, time);
      workplace.assigned = [...this.assignments].filter(([, r]) => r === room.id).map(([id]) => id).sort((a, b) => a - b);
    }
    for (const roomId of [...this.workplaces.keys()]) if (!valid.has(roomId)) this.workplaces.delete(roomId);
    for (const [agentId, roomId] of [...this.assignments]) if (!valid.has(roomId)) this.assignments.delete(agentId);
  }

  assign(agentId: number, roomId: number): boolean {
    const workplace = this.workplaces.get(roomId);
    if (!workplace || workplace.assigned.length >= workplace.capacity) return false;
    this.assignments.set(agentId, roomId);
    workplace.assigned = [...new Set([...workplace.assigned, agentId])];
    return true;
  }

  unassign(agentId: number): void {
    const roomId = this.assignments.get(agentId); this.assignments.delete(agentId);
    const workplace = roomId === undefined ? null : this.workplaces.get(roomId);
    if (workplace) workplace.assigned = workplace.assigned.filter((id) => id !== agentId);
    this.returnTool(agentId, 0);
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[], health: HealthSystem, workActive: boolean): void {
    this.warnings.clear(); this.refresh(world, time);
    const hourStamp = Math.floor(time / HOUR_SECONDS);
    for (const workplace of this.workplaces.values()) {
      workplace.active = workplace.assigned.filter((id) => agents.some((a) => a.id === id && a.state === "working"));
      const supervisors = agents.filter((a) => [Obj.Guard, Obj.ArmedGuard].includes(a.kind as never) && world.roomId[world.idx(Math.floor(a.x), Math.floor(a.z))] === workplace.roomId).length;
      if (supervisors > 0) workplace.lastSupervisedAt = time;
      workplace.blocked = workplace.supervision === "constant" && supervisors === 0 ? "Constant guard supervision is absent" : "";
      if (workplace.blocked && workplace.assigned.length) this.warnings.add(`${this.def(workplace).name} is waiting for supervision`);
    }
    if (!workActive) {
      for (const agentId of [...this.activeTools.keys()]) this.returnTool(agentId, time);
      return;
    }
    const day = Math.floor(time / (HOUR_SECONDS * 24));
    const hour = (time / HOUR_SECONDS) % 24;
    if (hour >= 16 && day !== this.lastExportDay) this.lastExportDay = day;
    for (const itemId of this.logistics.takeCollectedExternal()) this.items.destroy(itemId, time, -1, "contract-export");
    for (const [agentId, roomId] of this.assignments) {
      const agent = agents.find((a) => a.id === agentId), workplace = this.workplaces.get(roomId);
      if (!agent || !workplace || health.isUnavailable(agentId)) continue;
      const key = `${hourStamp}:${agentId}`;
      if (!this.paidHours.has(key)) {
        this.paidHours.add(key);
        const amount = this.def(workplace).risk === "low" ? 1 : this.def(workplace).risk === "standard" ? 2 : 4;
        this.pay(agentId, amount, time);
      }
    }
    if (this.paidHours.size > 10000) {
      const cutoff = hourStamp - 48;
      for (const key of this.paidHours) if (Number(key.split(":")[0]) < cutoff) this.paidHours.delete(key);
    }
    void dt;
  }

  updateWorker(agent: Agent, dt: number, time: number, world: World): boolean {
    const roomId = this.assignments.get(agent.id), workplace = roomId === undefined ? null : this.workplaces.get(roomId);
    if (!workplace) return false;
    const room = world.rooms.get(workplace.roomId), def = this.def(workplace);
    if (!room?.valid) return false;
    if (workplace.blocked) { agent.state = "workWaiting"; agent.amp = 0; return true; }
    const target = this.stationTile(room, def, world);
    const here = world.idx(Math.floor(agent.x), Math.floor(agent.z));
    if (world.roomId[here] !== room.id || Math.hypot(agent.x - (target % world.size + .5), agent.z - (((target / world.size) | 0) + .5)) > 2.2) {
      if (!agent.path) {
        const start = here;
        const custody = agent.protectiveCustody ? "protective" : agent.profile?.custody ?? "minimum";
        agent.path = astar(world.size, start, target, (i) => passable(world, i, false, agent.accessKeys) &&
          roleAllowed(world, i, "worker", custody), 20000,
          (a, b) => world.canNavigateEdge(a, b));
        agent.pathI = 0;
      }
      if (agent.path && agent.pathI < agent.path.length) {
        const next = agent.path[agent.pathI], nx = next % world.size + .5, nz = ((next / world.size) | 0) + .5;
        const d = Math.hypot(nx - agent.x, nz - agent.z);
        if (d < .12) agent.pathI++;
        else { agent.x += (nx - agent.x) / d * Math.min(d, dt * 2 * agent.speedMul); agent.z += (nz - agent.z) / d * Math.min(d, dt * 2 * agent.speedMul); }
        agent.state = "toWork"; agent.amp = 1; return true;
      }
      agent.state = "workUnreachable"; workplace.blocked = "Assigned worker cannot reach the workplace"; return true;
    }
    agent.path = null; agent.state = "working"; agent.amp = .55;
    if (!this.claimTool(agent, workplace, def, time)) { agent.state = "workMissingTool"; agent.amp = 0; return true; }
    if (!this.hasInputs(workplace, def)) { workplace.blocked = "Physical production inputs are awaiting delivery"; agent.state = "workMissingInputs"; agent.amp = 0; return true; }
    const manipulation = 1;
    const skillBonus = 1 + (skill(agent.profile, def.risk === "skilled" ? "construction" : "smuggling") * .035);
    const progress = (this.taskProgress.get(agent.id) ?? 0) + dt * manipulation * skillBonus;
    if (progress < def.seconds) { this.taskProgress.set(agent.id, progress); return true; }
    this.taskProgress.set(agent.id, progress - def.seconds);
    this.consumeInputs(workplace, def, time, agent.id);
    const output = this.items.create(def.outputId, time, { ownerId: -1 });
    this.items.moveToContainer(output.id, workplace.outputContainer, time, agent.id);
    workplace.completed++;
    this.maybeDivert(agent, workplace, def, time);
    return true;
  }

  /** Move one physical contract output toward Exports. Existing haul state is
   * always serviced; a new claim is made only when the caller has exhausted
   * higher-priority repair/construction work. */
  updateHauler(agent: Agent, dt: number, time: number, world: World, allowClaim: boolean): boolean {
    if (this.inputHauls.has(agent.id) || (allowClaim && this.claimInputHaul(agent.id))) {
      return this.updateInputHauler(agent, dt, time, world);
    }
    let haul = this.hauls.get(agent.id);
    if (!haul && !allowClaim) return false;
    const exportsRoom = [...world.rooms.values()].find((r) => r.valid && r.type === RoomType.Exports);
    if (!exportsRoom) {
      if (allowClaim && this.contractOutputs().length) this.warnings.add("Contract output is waiting for a valid Exports room");
      return false;
    }
    const pallet = [...exportsRoom.tiles].find((i) => world.objKind[i] === Obj.LoadingPallet);
    if (pallet === undefined) { this.warnings.add("Contract output is waiting for an Exports loading pallet"); return false; }
    const center = { x: pallet % world.size + .5, z: ((pallet / world.size) | 0) + .5 };
    const exportContainer = this.items.ensureContainer({ id: "institution:work-exports", name: "Prison industry exports",
      x: center.x, z: center.z, capacity: 96, concealment: .05, bodyCapacity: 0, lockedTier: "staff",
      ownerId: -1, tags: ["exports", "work"] });
    if (!haul) {
      const item = this.contractOutputs().find((i) => !this.haulClaims.has(i.id));
      if (!item) return false;
      haul = { itemId: item.id, phase: "pickup" }; this.hauls.set(agent.id, haul); this.haulClaims.set(item.id, agent.id);
    }
    const item = this.items.items.get(haul.itemId);
    if (!item || item.locationKind === "destroyed") { this.clearHaul(agent.id, haul.itemId); return false; }
    const targetX = haul.phase === "pickup" ? item.x : exportContainer.x;
    const targetZ = haul.phase === "pickup" ? item.z : exportContainer.z;
    if (Math.hypot(agent.x - targetX, agent.z - targetZ) > 1.4) {
      if (!agent.path) {
        const start = world.idx(Math.floor(agent.x), Math.floor(agent.z));
        const target = world.idx(Math.max(0, Math.min(world.size - 1, Math.floor(targetX))), Math.max(0, Math.min(world.size - 1, Math.floor(targetZ))));
        agent.path = astar(world.size, start, target, (i) => passable(world, i, true, agent.accessKeys) && roleAllowed(world, i, "workman"),
          30000, (a, b) => world.canNavigateEdge(a, b)); agent.pathI = 0;
      }
      if (!agent.path || agent.pathI >= agent.path.length) { this.warnings.add("A contract output cannot reach Exports"); this.clearHaul(agent.id, haul.itemId); return false; }
      const next = agent.path[agent.pathI], nx = next % world.size + .5, nz = ((next / world.size) | 0) + .5;
      const d = Math.hypot(nx - agent.x, nz - agent.z);
      if (d < .12) agent.pathI++; else { agent.x += (nx - agent.x) / d * Math.min(d, dt * 2.2 * agent.speedMul); agent.z += (nz - agent.z) / d * Math.min(d, dt * 2.2 * agent.speedMul); }
      agent.state = haul.phase === "pickup" ? "toWorkExport" : "carryingWorkExport"; agent.amp = 1; return true;
    }
    agent.path = null;
    if (haul.phase === "pickup") {
      if (!this.items.moveToContainer(item.id, `agent:${agent.id}:hands`, time, agent.id)) { this.clearHaul(agent.id, item.id); return false; }
      haul.phase = "dropoff"; agent.state = "carryingWorkExport"; return true;
    }
    if (!this.items.moveToContainer(item.id, exportContainer.id, time, agent.id)) {
      this.warnings.add("Exports loading pallet storage is full"); return true;
    }
    const workplace = [...this.workplaces.values()].find((w) => item.history.some((h) => h.location === w.outputContainer));
    const jobDef = workplace ? this.def(workplace) : null;
    const value = jobDef ? Math.round((2.75 * jobDef.inputValue + 10 * (jobDef.seconds / HOUR_SECONDS)) / 5) * 5 : itemDefV4(item.defId).baseValue;
    this.logistics.registerExternalExport(item.id, Math.max(value, itemDefV4(item.defId).baseValue), itemDefV4(item.defId).name);
    this.clearHaul(agent.id, item.id); agent.state = "idle"; return true;
  }

  saveData() { return { workplaces: [...this.workplaces.values()].map((w) => ({ ...w, assigned: [...w.assigned], active: [] })),
    assignments: [...this.assignments], taskProgress: [...this.taskProgress], activeTools: [...this.activeTools],
    haulClaims: [...this.haulClaims], hauls: [...this.hauls], inputClaims: [...this.inputClaims], inputHauls: [...this.inputHauls],
    paidHours: [...this.paidHours], lastExportDay: this.lastExportDay, rngState: this.rngState }; }
  loadData(data: Partial<ReturnType<WorkSystem["saveData"]>>): void {
    this.workplaces.clear(); for (const w of data.workplaces ?? []) this.workplaces.set(w.roomId, { ...w, assigned: [...w.assigned], active: [] });
    this.assignments.clear(); for (const [a, r] of data.assignments ?? []) this.assignments.set(a, r);
    this.taskProgress.clear(); for (const [a, p] of data.taskProgress ?? []) this.taskProgress.set(a, p);
    this.activeTools.clear(); for (const [a, i] of data.activeTools ?? []) this.activeTools.set(a, i);
    this.haulClaims.clear(); for (const [item, agent] of data.haulClaims ?? []) this.haulClaims.set(item, agent);
    this.hauls.clear(); for (const [agent, haul] of data.hauls ?? []) this.hauls.set(agent, { ...haul });
    this.inputClaims.clear(); for (const [pkg, agent] of data.inputClaims ?? []) this.inputClaims.set(pkg, agent);
    this.inputHauls.clear(); for (const [agent, haul] of data.inputHauls ?? []) this.inputHauls.set(agent, { ...haul });
    this.paidHours.clear(); for (const k of data.paidHours ?? []) this.paidHours.add(k);
    this.lastExportDay = data.lastExportDay ?? -1;
    this.rngState = data.rngState ?? 0x67f23a91;
  }

  private def(workplace: Workplace): JobDef { return JOB_DEFS.find((d) => d.id === workplace.jobId)!; }
  private capacity(room: Room, def: JobDef, world: World): number {
    if (def.areaJob) return Math.max(1, Math.floor(room.tiles.size / 20));
    let count = 0; for (const tile of room.tiles) if (def.stations.includes(world.objKind[tile])) count++;
    return Math.max(1, count);
  }
  private stationTile(room: Room, def: JobDef, world: World): number {
    for (const tile of room.tiles) if (def.stations.includes(world.objKind[tile]) && passable(world, tile, false)) return tile;
    for (const tile of room.tiles) if (passable(world, tile, false)) return tile;
    return [...room.tiles][0];
  }
  private requestStock(workplace: Workplace, def: JobDef, time: number): void {
    const demand: Record<string, number> = {};
    for (const toolId of def.toolIds) {
      const target = Math.max(1, Math.min(3, workplace.capacity || 1));
      demand[toolId] = Math.max(0, target - this.items.itemsIn(workplace.stockContainer).filter((i) => i.defId === toolId).length - this.logistics.pipelineQuantity(toolId));
    }
    for (const [defId, perJob] of Object.entries(JOB_INPUTS[def.id] ?? {})) {
      const target = Math.max(4, workplace.capacity * perJob * 3);
      demand[defId] = Math.max(0, target - this.items.itemsIn(workplace.stockContainer).filter((i) => i.defId === defId).length - this.logistics.pipelineQuantity(defId));
    }
    this.logistics.request(demand, time, false, `work:${workplace.roomId}`);
  }
  private claimInputHaul(agentId: number): boolean {
    for (const workplace of [...this.workplaces.values()].sort((a, b) => a.roomId - b.roomId)) {
      const def = this.def(workplace), stock = this.items.itemsIn(workplace.stockContainer);
      const wanted = new Set<string>();
      for (const toolId of def.toolIds) if (stock.filter((i) => i.defId === toolId).length < Math.max(1, Math.min(3, workplace.capacity || 1))) wanted.add(toolId);
      for (const [defId, perJob] of Object.entries(JOB_INPUTS[def.id] ?? {})) if (stock.filter((i) => i.defId === defId).length < Math.max(4, workplace.capacity * perJob * 3)) wanted.add(defId);
      const pkg = [...this.logistics.packages.values()].filter((p) => p.state === "delivery" && !p.reservedBy && wanted.has(p.commodity) && !this.inputClaims.has(p.id))
        .sort((a, b) => a.id - b.id)[0];
      if (!pkg) continue;
      pkg.reservedBy = `work-input:${agentId}`; pkg.state = "reserved"; this.inputClaims.set(pkg.id, agentId);
      this.inputHauls.set(agentId, { packageId: pkg.id, roomId: workplace.roomId, phase: "pickup" }); return true;
    }
    return false;
  }
  private updateInputHauler(agent: Agent, dt: number, time: number, world: World): boolean {
    const haul = this.inputHauls.get(agent.id); if (!haul) return false;
    const pkg = this.logistics.packages.get(haul.packageId), workplace = this.workplaces.get(haul.roomId);
    if (!pkg || !workplace) { this.clearInputHaul(agent.id, haul.packageId); return false; }
    const stock = this.items.containers.get(workplace.stockContainer); if (!stock) { this.clearInputHaul(agent.id, haul.packageId); return false; }
    const targetX = haul.phase === "pickup" ? pkg.x : stock.x, targetZ = haul.phase === "pickup" ? pkg.z : stock.z;
    if (haul.phase === "dropoff") { pkg.x = agent.x; pkg.z = agent.z; pkg.state = "carried"; }
    if (Math.hypot(agent.x - targetX, agent.z - targetZ) > 1.4) {
      if (!agent.path) {
        const start = world.idx(Math.floor(agent.x), Math.floor(agent.z));
        const target = world.idx(Math.max(0, Math.min(world.size - 1, Math.floor(targetX))), Math.max(0, Math.min(world.size - 1, Math.floor(targetZ))));
        agent.path = astar(world.size, start, target, (i) => passable(world, i, true, agent.accessKeys) && roleAllowed(world, i, "workman"),
          30000, (a, b) => world.canNavigateEdge(a, b)); agent.pathI = 0;
      }
      if (!agent.path || agent.pathI >= agent.path.length) {
        pkg.reservedBy = null; pkg.state = "delivery"; this.warnings.add(`${pkg.commodity} cannot reach workplace ${workplace.roomId}`);
        this.clearInputHaul(agent.id, pkg.id); return false;
      }
      const next = agent.path[agent.pathI], nx = next % world.size + .5, nz = ((next / world.size) | 0) + .5, d = Math.hypot(nx - agent.x, nz - agent.z);
      if (d < .12) agent.pathI++; else { agent.x += (nx - agent.x) / d * Math.min(d, dt * 2.2 * agent.speedMul); agent.z += (nz - agent.z) / d * Math.min(d, dt * 2.2 * agent.speedMul); }
      agent.state = haul.phase === "pickup" ? "toWorkInput" : "carryingWorkInput"; agent.amp = 1; return true;
    }
    agent.path = null;
    if (haul.phase === "pickup") { haul.phase = "dropoff"; pkg.state = "carried"; agent.state = "carryingWorkInput"; return true; }
    for (let n = 0; n < pkg.quantity; n++) {
      const item = this.items.create(pkg.commodity, time); this.items.moveToContainer(item.id, workplace.stockContainer, time, agent.id);
    }
    this.logistics.packages.delete(pkg.id); this.clearInputHaul(agent.id, pkg.id); agent.state = "idle"; return true;
  }
  private claimTool(agent: Agent, workplace: Workplace, def: JobDef, time: number): boolean {
    if (this.activeTools.has(agent.id) || !def.toolIds.length) return true;
    const tool = this.items.itemsIn(workplace.stockContainer).find((i) => def.toolIds.includes(i.defId));
    if (!tool) { workplace.blocked = `Missing controlled ${def.toolIds.join("/")}`; return false; }
    if (this.items.moveToContainer(tool.id, `agent:${agent.id}:hands`, time, agent.id)) { this.activeTools.set(agent.id, tool.id); return true; }
    return false;
  }
  private returnTool(agentId: number, time: number): void {
    const itemId = this.activeTools.get(agentId); if (itemId === undefined) return;
    const workplace = this.workplaces.get(this.assignments.get(agentId) ?? -1);
    if (workplace) this.items.moveToContainer(itemId, workplace.stockContainer, time, agentId);
    this.activeTools.delete(agentId);
  }
  private hasInputs(workplace: Workplace, def: JobDef): boolean {
    const stock = this.items.itemsIn(workplace.stockContainer);
    return Object.entries(JOB_INPUTS[def.id] ?? {}).every(([defId, count]) => stock.filter((i) => i.defId === defId).length >= count);
  }
  private consumeInputs(workplace: Workplace, def: JobDef, time: number, actorId: number): void {
    const stock = this.items.itemsIn(workplace.stockContainer);
    for (const [defId, count] of Object.entries(JOB_INPUTS[def.id] ?? {}))
      for (const item of stock.filter((i) => i.defId === defId).slice(0, count)) this.items.destroy(item.id, time, actorId, "work-input");
  }
  private maybeDivert(agent: Agent, workplace: Workplace, def: JobDef, time: number): void {
    const supervision = workplace.supervision === "constant" ? .08 : workplace.supervision === "periodic" ? .45 : 1;
    const chance = supervision * (.012 + skill(agent.profile, "smuggling") * .004);
    if (this.random() >= chance || !def.diversionIds.length) return;
    const wanted = def.diversionIds[(this.random() * def.diversionIds.length) | 0];
    let item = this.items.itemsIn(workplace.stockContainer).find((i) => i.defId === wanted);
    if (!item && wanted === def.outputId) item = this.items.itemsIn(workplace.outputContainer).find((i) => i.defId === wanted);
    if (!item) item = this.items.create(wanted, time);
    this.items.moveToContainer(item.id, `agent:${agent.id}:pockets`, time, agent.id, true);
  }
  private pay(agentId: number, amount: number, time: number): void {
    const pocket = `agent:${agentId}:pockets`;
    for (let n = 0; n < amount; n++) {
      const note = this.items.create("cash-1", time, { ownerId: agentId }); this.items.moveToContainer(note.id, pocket, time, -1);
    }
    this.economy.post(time, "work-wage", -amount, "Prisoner work pay packet", true);
  }
  private contractOutputs(): ItemInstance[] {
    const rows: ItemInstance[] = [];
    for (const workplace of this.workplaces.values()) for (const item of this.items.itemsIn(workplace.outputContainer))
      if (itemDefV4(item.defId).tags.includes("contract-output")) rows.push(item);
    return rows.sort((a, b) => a.id - b.id);
  }
  private clearHaul(agentId: number, itemId: number): void { this.hauls.delete(agentId); this.haulClaims.delete(itemId); }
  private clearInputHaul(agentId: number, packageId: number): void { this.inputHauls.delete(agentId); this.inputClaims.delete(packageId); }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}

function roomCenter(room: Room, size: number): { x: number; z: number } {
  let x = 0, z = 0; for (const tile of room.tiles) { x += tile % size + .5; z += ((tile / size) | 0) + .5; }
  return { x: x / Math.max(1, room.tiles.size), z: z / Math.max(1, room.tiles.size) };
}
