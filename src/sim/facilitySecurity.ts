import type { Agent } from "./agent.ts";
import type { AreaSystem } from "./areas.ts";
import { followPath } from "./move.ts";
import { astar, passable } from "./nav.ts";
import { Obj, RoomType, type World } from "./world.ts";

export type SecurityRing = "interior" | "compound" | "service" | "perimeter" | "exterior";
export interface GatehousePost {
  pieceId: number;
  anchor: number;
  guardId: number;
  inspection: "none" | "spot" | "standard" | "full";
  open: boolean;
  inspectedTrucks: number[];
  inspectionProgress: Record<number, number>;
  warning: string;
}
export interface UtilityCircuit {
  id: number;
  roomId: number;
  online: boolean;
  backup: boolean;
  sabotagedBy: number;
  disabledUntil: number;
  evidence: number;
}
export interface RoadVehicleState { id: number; state: "queued" | "arriving" | "unloading" | "departing" | "blocked"; x: number; z: number; timer: number; warning: string; }

/** Topological security state shared by planners, credentials, road traffic,
 * and management reports. Rings describe consequences, never invisible walls. */
export class FacilitySecurityGraph {
  readonly rings = new Map<number, SecurityRing>();
  readonly gatehouses = new Map<number, GatehousePost>();
  readonly circuits = new Map<number, UtilityCircuit>();
  readonly warnings = new Set<string>();
  private nextCircuitId = 1;
  private refreshT = 0;
  private readonly areas: AreaSystem;

  constructor(areas: AreaSystem) { this.areas = areas; }

  recompute(world: World): void {
    this.rings.clear();
    for (const area of this.areas.areas.values()) {
      const rooms = [...area.roomIds].map((id) => world.rooms.get(id)).filter((room) => room?.valid);
      const bordersExterior = this.areas.portals.some((portal) => (portal.a === area.id && this.areas.areas.get(portal.b)?.exterior) ||
        (portal.b === area.id && this.areas.areas.get(portal.a)?.exterior));
      let ring: SecurityRing = area.exterior ? "exterior" : bordersExterior ? "perimeter" : "compound";
      if (!area.exterior && rooms.some((room) => room && [RoomType.Delivery, RoomType.Exports, RoomType.Reception, RoomType.Visitation].includes(room.type as never))) ring = "service";
      if (!area.exterior && rooms.some((room) => room && [RoomType.Cell, RoomType.Dorm, RoomType.Solitary, RoomType.Armoury, RoomType.EvidenceRoom].includes(room.type as never))) ring = "interior";
      this.rings.set(area.id, ring);
    }
    this.refreshGatehouses(world);
    this.refreshCircuits(world);
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[], trucks: readonly RoadVehicleState[], unavailableGuards: ReadonlySet<number> = new Set()): void {
    this.warnings.clear(); this.refreshT -= dt;
    if (this.refreshT <= 0) { this.refreshT = 3; this.recompute(world); this.assignGateGuards(agents, unavailableGuards); }
    for (const circuit of this.circuits.values()) if (!circuit.online && circuit.disabledUntil <= time) {
      circuit.online = true; circuit.sabotagedBy = -1; circuit.evidence = Math.max(circuit.evidence, .35);
    }
    for (const gate of this.gatehouses.values()) {
      const guard = agents.find((agent) => agent.id === gate.guardId && agent.kind === Obj.Guard);
      gate.open = !!guard;
      gate.warning = guard ? "" : "Gatehouse is unmanned";
      if (!guard) this.warnings.add("A Gatehouse is unmanned; vehicles are leaving unchecked");
      this.inspectTraffic(gate, guard ?? null, trucks, dt);
    }
  }

  updateGuard(agent: Agent, dt: number, world: World, urgentResponse: boolean): boolean {
    if (agent.kind !== Obj.Guard || urgentResponse) return false;
    const gate = [...this.gatehouses.values()].find((row) => row.guardId === agent.id);
    if (!gate) return false;
    const piece = world.pieces.get(gate.pieceId); if (!piece) return false;
    const targetX = piece.x + .9, targetZ = piece.z + 1.5;
    if (Math.hypot(agent.x - targetX, agent.z - targetZ) > .7) {
      if (!agent.path) {
        const start = world.idx(Math.floor(agent.x), Math.floor(agent.z));
        const goal = world.idx(piece.x + 1, piece.z + 1);
        const path = astar(world.size, start, goal, (i) => passable(world, i, true, 2), 30000,
          (from, to) => world.canNavigateEdge(from, to));
        if (path) { agent.path = path; agent.pathI = 0; }
      }
      agent.state = "toGatehouse";
      if (agent.path) followPath(agent, dt, world, true);
    } else {
      agent.state = "manningGatehouse"; agent.path = null; agent.amp = Math.max(0, agent.amp - dt * 4);
      agent.heading = Math.PI / 2;
    }
    return true;
  }

  ringAt(tile: number): SecurityRing { return this.rings.get(this.areas.areaAt[tile]) ?? "exterior"; }
  areaIdAt(tile: number): number { return this.areas.areaAt[tile] ?? 0; }
  areaRing(areaId: number): SecurityRing { return this.rings.get(areaId) ?? "exterior"; }

  setInspection(pieceId: number, inspection: GatehousePost["inspection"]): void {
    const row = this.gatehouses.get(pieceId); if (row) row.inspection = inspection;
  }

  gateInspectionComplete(truckId: number): boolean {
    const relevant = [...this.gatehouses.values()].filter((gate) => gate.inspection !== "none");
    return relevant.length === 0 || relevant.every((gate) => gate.inspectedTrucks.includes(truckId) || !gate.open);
  }

  sabotageCircuit(roomId: number, actorId: number, time: number, duration: number): boolean {
    const circuit = [...this.circuits.values()].find((row) => row.roomId === roomId);
    if (!circuit || !circuit.online) return false;
    circuit.online = false; circuit.sabotagedBy = actorId; circuit.disabledUntil = time + Math.max(5, duration);
    circuit.evidence = Math.min(1, circuit.evidence + .45); return true;
  }

  securityDevicesOnline(): boolean { return this.circuits.size === 0 || [...this.circuits.values()].some((row) => row.online || row.backup); }

  saveData() { return {
    rings: [...this.rings], gatehouses: [...this.gatehouses.values()].map((row) => ({ ...row, inspectedTrucks: [...row.inspectedTrucks], inspectionProgress: { ...row.inspectionProgress } })),
    circuits: [...this.circuits.values()].map((row) => ({ ...row })), nextCircuitId: this.nextCircuitId,
  }; }
  loadData(data: Partial<ReturnType<FacilitySecurityGraph["saveData"]>>, world: World): void {
    this.rings.clear(); for (const [id, ring] of data.rings ?? []) this.rings.set(id, ring);
    this.gatehouses.clear(); for (const row of data.gatehouses ?? []) this.gatehouses.set(row.pieceId, { ...row, inspectedTrucks: [...row.inspectedTrucks], inspectionProgress: { ...row.inspectionProgress } });
    this.circuits.clear(); for (const row of data.circuits ?? []) this.circuits.set(row.id, { ...row });
    this.nextCircuitId = data.nextCircuitId ?? 1; this.recompute(world);
  }

  private refreshGatehouses(world: World): void {
    const present = new Set<number>();
    for (const piece of world.piecesOfKind(Obj.Gatehouse)) {
      present.add(piece.id);
      if (!this.gatehouses.has(piece.id)) this.gatehouses.set(piece.id, {
        pieceId: piece.id, anchor: world.idx(piece.x, piece.z), guardId: -1, inspection: "standard",
        open: false, inspectedTrucks: [], inspectionProgress: {}, warning: "Gatehouse is unmanned",
      });
    }
    for (const id of [...this.gatehouses.keys()]) if (!present.has(id)) this.gatehouses.delete(id);
  }

  private refreshCircuits(world: World): void {
    const rooms = [...world.rooms.values()].filter((room) => room.valid && room.type === RoomType.Utilities);
    const roomIds = new Set(rooms.map((room) => room.id));
    for (const room of rooms) if (![...this.circuits.values()].some((row) => row.roomId === room.id)) {
      const id = this.nextCircuitId++;
      this.circuits.set(id, { id, roomId: room.id, online: true, backup: true, sabotagedBy: -1, disabledUntil: -1, evidence: 0 });
    }
    for (const [id, row] of this.circuits) if (!roomIds.has(row.roomId)) this.circuits.delete(id);
  }

  private assignGateGuards(agents: readonly Agent[], unavailable: ReadonlySet<number>): void {
    for (const gate of this.gatehouses.values()) if (unavailable.has(gate.guardId)) gate.guardId = -1;
    const claimed = new Set([...this.gatehouses.values()].map((row) => row.guardId).filter((id) => id >= 0));
    for (const gate of this.gatehouses.values()) {
      if (agents.some((agent) => agent.id === gate.guardId && agent.kind === Obj.Guard)) continue;
      const guard = agents.filter((agent) => agent.kind === Obj.Guard && !claimed.has(agent.id) && !unavailable.has(agent.id) && agent.routeId < 0 && agent.postRoom < 0)
        .sort((a, b) => Math.abs(a.z - Math.floor(gate.anchor / this.areas.areaAt.length ** .5)) - Math.abs(b.z - Math.floor(gate.anchor / this.areas.areaAt.length ** .5)) || a.id - b.id)[0];
      gate.guardId = guard?.id ?? -1; if (guard) claimed.add(guard.id);
    }
  }

  private inspectTraffic(gate: GatehousePost, guard: Agent | null, trucks: readonly RoadVehicleState[], dt: number): void {
    const gateZ = Math.floor(gate.anchor / this.areas.areaAt.length ** .5) + 1.5;
    for (const truck of trucks) {
      if (truck.state !== "departing" || truck.z < gateZ - 5 || gate.inspectedTrucks.includes(truck.id)) continue;
      if (!guard || gate.inspection === "none") { gate.inspectedTrucks.push(truck.id); continue; }
      truck.z = gateZ - 1.5;
      const need = gate.inspection === "spot" ? 2 : gate.inspection === "standard" ? 5 : 10;
      gate.inspectionProgress[truck.id] = (gate.inspectionProgress[truck.id] ?? 0) + dt;
      truck.timer = Math.max(truck.timer, .4);
      truck.warning = `Gatehouse ${gate.inspection} inspection`;
      if (gate.inspectionProgress[truck.id] >= need) {
        gate.inspectedTrucks.push(truck.id); delete gate.inspectionProgress[truck.id]; truck.warning = "";
      }
    }
  }
}
