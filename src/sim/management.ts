import type { Agent, Tunnel } from "./agent.ts";
import type { EconomySystem } from "./economy.ts";
import type { InstitutionSystem } from "./institution.ts";
import type { ItemSystem } from "./itemSystem.ts";
import { followPath } from "./move.ts";
import { astar, passable } from "./nav.ts";
import { Obj, RoomType, type World } from "./world.ts";
import type { StaffProfileSystem } from "./staffProfiles.ts";
import { HOUR_SECONDS } from "./time.ts";

export type ManagerKind = "chief" | "foreman" | "accountant";
export type ControlProcedureId = "spoon-count" | "tray-count" | "key-signout" | "tool-count" |
  "shipment-manifest" | "till-reconcile" | "floor-survey" | "dual-evidence";
export interface ControlProcedure {
  id: ControlProcedureId;
  activeUntil: number;
  activatedAt: number;
  laborMultiplier: number;
  detectionBonus: number;
  triggeredByReport: number;
}
export interface ManagerAssignment { managerId: number; kind: ManagerKind; roomId: number; deskTile: number; }
export interface ManagerReport {
  id: number;
  manager: ManagerKind;
  title: string;
  summary: string;
  recommendation: string;
  confidence: number;
  createdAt: number;
  expiresAt: number;
  areaId: number;
  tile: number;
  evidenceIds: number[];
  metric: number;
  acknowledged: boolean;
}
export interface StructuralAnomaly { tile: number; severity: number; sourceNetworkId: number; inspected: boolean; createdAt: number; }

const MANAGER_KINDS = new Map<number, ManagerKind>([[Obj.ChiefOfficer, "chief"], [Obj.Foreman, "foreman"], [Obj.Accountant, "accountant"]]);
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Executives do analysis work over records that physically exist. Their
 * reports are delayed, fallible summaries; raw ground truth never appears. */
export class ManagementSystem {
  readonly assignments = new Map<number, ManagerAssignment>();
  readonly reports = new Map<number, ManagerReport>();
  readonly procedures = new Map<ControlProcedureId, ControlProcedure>();
  readonly anomalies = new Map<number, StructuralAnomaly>();
  readonly warnings = new Set<string>();
  private nextReportId = 1;
  private analysisT = 2;
  private anomalyT = 4;
  private readonly inspectedReports = new Set<string>();
  private readonly economy: EconomySystem;
  private readonly institution: InstitutionSystem;
  private readonly items: ItemSystem;
  private readonly staff: StaffProfileSystem;

  constructor(economy: EconomySystem, institution: InstitutionSystem, items: ItemSystem, staff: StaffProfileSystem) {
    this.economy = economy; this.institution = institution; this.items = items; this.staff = staff;
  }

  canHire(kind: number, agents: readonly Agent[]): boolean {
    return !MANAGER_KINDS.has(kind) || !agents.some((agent) => agent.kind === kind);
  }

  managerKind(agent: Agent): ManagerKind | null { return MANAGER_KINDS.get(agent.kind) ?? null; }

  tick(dt: number, time: number, world: World, agents: readonly Agent[], tunnels: readonly Tunnel[]): void {
    this.warnings.clear(); this.refreshAssignments(world, agents);
    for (const procedure of this.procedures.values()) if (procedure.activeUntil <= time) this.procedures.delete(procedure.id);
    this.anomalyT -= dt;
    if (this.anomalyT <= 0) { this.anomalyT = 8; this.updateAnomalies(time, world, tunnels); }
    this.analysisT -= dt;
    if (this.analysisT <= 0) {
      this.analysisT = 8;
      this.chiefAnalysis(time, agents);
      this.accountantAnalysis(time);
      this.foremanAnalysis(time, world);
    }
    for (const kind of MANAGER_KINDS.values()) if (![...this.assignments.values()].some((row) => row.kind === kind)) {
      const label = kind === "chief" ? "Chief Officer" : kind === "foreman" ? "Foreman" : "Accountant";
      if (agents.some((agent) => this.managerKind(agent) === kind)) this.warnings.add(`${label} has no unclaimed valid Management Office`);
    }
  }

  updateManager(agent: Agent, dt: number, world: World): boolean {
    const kind = this.managerKind(agent); if (!kind) return false;
    const assignment = this.assignments.get(agent.id);
    if (!assignment) { agent.state = "waitingForOffice"; agent.path = null; agent.amp = 0; return true; }
    let target = assignment.deskTile;
    if (kind === "foreman") {
      const anomaly = [...this.anomalies.values()].filter((row) => !row.inspected)
        .sort((a, b) => b.severity - a.severity || a.tile - b.tile)[0];
      if (anomaly) target = anomaly.tile;
    }
    const tx = target % world.size, tz = Math.floor(target / world.size);
    if (Math.hypot(agent.x - (tx + .5), agent.z - (tz + .5)) > 1.15) {
      if (!agent.path) {
        const start = world.idx(Math.floor(agent.x), Math.floor(agent.z));
        const path = astar(world.size, start, target, (i) => passable(world, i, true, 2), 30000,
          (from, to) => world.canNavigateEdge(from, to));
        if (path) { agent.path = path; agent.pathI = 0; }
      }
      agent.state = kind === "foreman" && target !== assignment.deskTile ? "inspectingStructure" : "toManagementOffice";
      if (agent.path) followPath(agent, dt, world, true);
      return true;
    }
    agent.path = null; agent.amp = Math.max(0, agent.amp - dt * 4);
    if (kind === "foreman" && target !== assignment.deskTile) {
      const anomaly = this.anomalies.get(target);
      if (anomaly) anomaly.inspected = true;
      agent.state = "surveyingFloor";
    } else agent.state = kind === "chief" ? "reviewingIntelligence" : kind === "accountant" ? "reconcilingAccounts" : "reviewingWorks";
    return true;
  }

  procedureManager(id: ControlProcedureId): ManagerKind {
    if (["tool-count", "floor-survey"].includes(id)) return "foreman";
    if (["key-signout", "dual-evidence"].includes(id)) return "chief";
    return "accountant";
  }

  canActivateProcedure(id: ControlProcedureId): boolean {
    const required = this.procedureManager(id);
    return [...this.assignments.values()].some((assignment) => assignment.kind === required);
  }

  activateProcedure(id: ControlProcedureId, time: number, hours = 24, reportId = -1): boolean {
    if (!this.canActivateProcedure(id)) { this.warnings.add(`${this.procedureManager(id)} management is required to run ${id}`); return false; }
    const labor: Record<ControlProcedureId, number> = {
      "spoon-count": .76, "tray-count": .82, "key-signout": .9, "tool-count": .84,
      "shipment-manifest": .86, "till-reconcile": .88, "floor-survey": .8, "dual-evidence": .86,
    };
    const detection: Record<ControlProcedureId, number> = {
      "spoon-count": .55, "tray-count": .45, "key-signout": .7, "tool-count": .65,
      "shipment-manifest": .6, "till-reconcile": .65, "floor-survey": .62, "dual-evidence": .72,
    };
    this.procedures.set(id, { id, activeUntil: time + Math.max(1, hours) * HOUR_SECONDS,
      activatedAt: time, laborMultiplier: labor[id], detectionBonus: detection[id], triggeredByReport: reportId });
    return true;
  }

  deactivateProcedure(id: ControlProcedureId): void { this.procedures.delete(id); }
  procedure(id: ControlProcedureId, time: number): ControlProcedure | null {
    const row = this.procedures.get(id); return row && row.activeUntil > time ? row : null;
  }

  staffEfficiency(agent: Agent, time: number): number {
    if (agent.kind === Obj.Cook) {
      const profile = this.staff.profiles.get(agent.id);
      if (this.procedure("spoon-count", time)) {
        if (profile && profile.compromisedBy >= 0 && this.staff.permits(agent.id, profile.compromisedBy, "skip-count", time)) {
          this.staff.warn(agent.id, profile.compromisedBy, time); return 1;
        }
        return .76;
      }
      if (this.procedure("tray-count", time)) return .82;
    }
    if (agent.kind === Obj.Workman && this.procedure("tool-count", time)) return .84;
    return 1;
  }

  saveData() { return {
    assignments: [...this.assignments.values()].map((row) => ({ ...row })), reports: [...this.reports.values()].map((row) => ({ ...row, evidenceIds: [...row.evidenceIds] })),
    procedures: [...this.procedures.values()].map((row) => ({ ...row })), anomalies: [...this.anomalies.values()].map((row) => ({ ...row })),
    nextReportId: this.nextReportId, analysisT: this.analysisT, anomalyT: this.anomalyT, inspectedReports: [...this.inspectedReports],
  }; }
  loadData(data: Partial<ReturnType<ManagementSystem["saveData"]>>): void {
    this.assignments.clear(); for (const row of data.assignments ?? []) this.assignments.set(row.managerId, { ...row });
    this.reports.clear(); for (const row of data.reports ?? []) this.reports.set(row.id, { ...row, evidenceIds: [...row.evidenceIds] });
    this.procedures.clear(); for (const row of data.procedures ?? []) this.procedures.set(row.id, { ...row });
    this.anomalies.clear(); for (const row of data.anomalies ?? []) this.anomalies.set(row.tile, { ...row });
    this.nextReportId = data.nextReportId ?? 1; this.analysisT = data.analysisT ?? 2; this.anomalyT = data.anomalyT ?? 4;
    this.inspectedReports.clear(); for (const key of data.inspectedReports ?? []) this.inspectedReports.add(key);
  }

  private refreshAssignments(world: World, agents: readonly Agent[]): void {
    const managers = agents.filter((agent) => MANAGER_KINDS.has(agent.kind)).sort((a, b) => a.id - b.id);
    const validRooms = [...world.rooms.values()].filter((room) => room.valid && room.type === RoomType.ManagementOffice).sort((a, b) => a.id - b.id);
    const claimedRooms = new Set<number>();
    for (const manager of managers) {
      const old = this.assignments.get(manager.id);
      if (old && validRooms.some((room) => room.id === old.roomId) && !claimedRooms.has(old.roomId)) { claimedRooms.add(old.roomId); continue; }
      const room = validRooms.find((candidate) => !claimedRooms.has(candidate.id));
      if (!room) { this.assignments.delete(manager.id); continue; }
      const deskTile = [...room.tiles].find((tile) => world.objKind[tile] === Obj.ExecutiveDesk) ?? [...room.tiles][0];
      const kind = MANAGER_KINDS.get(manager.kind)!;
      this.assignments.set(manager.id, { managerId: manager.id, kind, roomId: room.id, deskTile }); claimedRooms.add(room.id);
    }
    const live = new Set(managers.map((manager) => manager.id));
    for (const id of [...this.assignments.keys()]) if (!live.has(id)) this.assignments.delete(id);
  }

  private updateAnomalies(time: number, world: World, tunnels: readonly Tunnel[]): void {
    for (const tunnel of tunnels) {
      if (tunnel.surfHole >= 0 || tunnel.actualX < 0 || tunnel.actualZ < 0) continue;
      const x = Math.max(0, Math.min(world.size - 1, Math.floor(tunnel.actualX)));
      const z = Math.max(0, Math.min(world.size - 1, Math.floor(tunnel.actualZ)));
      const tile = world.idx(x, z);
      if (!world.floorMat[tile]) continue;
      const severity = clamp(.12 + tunnel.believed / Math.max(8, tunnel.goal) * .38 + (world.floorMat[tile] === 4 ? -.08 : .08), .05, .85);
      const row = this.anomalies.get(tile);
      if (row) row.severity = Math.max(row.severity, severity);
      else this.anomalies.set(tile, { tile, severity, sourceNetworkId: tunnel.networkId, inspected: false, createdAt: time });
    }
  }

  private chiefAnalysis(time: number, agents: readonly Agent[]): void {
    if (![...this.assignments.values()].some((row) => row.kind === "chief")) return;
    const open = [...this.institution.cases.values()].filter((row) => row.status !== "resolved" && row.evidenceIds.length >= 2);
    const grouped = new Map<number, typeof open>();
    for (const c of open) for (const subject of c.subjectIds) { const rows = grouped.get(subject) ?? []; rows.push(c); grouped.set(subject, rows); }
    for (const [subject, cases] of grouped) {
      if (cases.length < 2) continue; const key = `chief:${subject}:${cases.map((c) => c.id).sort().join(",")}`;
      if (this.inspectedReports.has(key)) continue; this.inspectedReports.add(key);
      const evidenceIds = [...new Set(cases.flatMap((c) => c.evidenceIds))];
      const confidence = 1 - cases.reduce((miss, c) => miss * (1 - c.confidence), 1);
      this.addReport("chief", "Correlated security activity",
        `${cases.length} evidence-backed cases may involve inmate ${subject}. The overlap suggests coordination but does not establish an escape plan.`,
        "Assign an investigator or targeted surveillance before escalating prison-wide restrictions.", confidence, time, -1, -1, evidenceIds, cases.length);
    }
    void agents;
  }

  private accountantAnalysis(time: number): void {
    if (![...this.assignments.values()].some((row) => row.kind === "accountant")) return;
    const missingSpoons = this.items.controlledDiscrepancies().filter((row) => row.defId === "spoon").length;
    const destroyed = [...this.items.items.values()].filter((item) => item.defId === "spoon" && item.locationKind === "destroyed" && item.history.some((h) => h.time >= time - HOUR_SECONDS * 24)).length;
    const metric = missingSpoons + destroyed;
    const replacementSpend = this.economy.ledger.filter((row) => row.time >= time - HOUR_SECONDS * 24 && row.kind === "purchase").reduce((sum, row) => sum - Math.min(0, row.amount), 0);
    if (metric < 3) return;
    const band = Math.floor(metric / 3), key = `accountant:spoons:${band}`;
    if (this.inspectedReports.has(key)) return; this.inspectedReports.add(key);
    this.addReport("accountant", "Cutlery replacement trend",
      `${metric} spoons are missing or were replaced in the current accounting window while institutional purchases total $${Math.round(replacementSpend)}. This is above the expected meal-loss baseline.`,
      "Temporarily require cooks to count spoons after meals. Meal throughput will fall and additional cooks may be needed.",
      clamp(.38 + metric * .055), time, -1, -1, [], metric);
  }

  private foremanAnalysis(time: number, world: World): void {
    if (![...this.assignments.values()].some((row) => row.kind === "foreman")) return;
    for (const anomaly of this.anomalies.values()) {
      if (!anomaly.inspected) continue; const key = `foreman:${anomaly.tile}:${Math.floor(anomaly.severity * 5)}`;
      if (this.inspectedReports.has(key)) continue; this.inspectedReports.add(key);
      this.addReport("foreman", "Possible subsurface void",
        `A physical inspection found settlement and vibration inconsistent with normal wear near tile ${anomaly.tile}. The exact shape and cause are unknown.`,
        "Order a temporary floor survey and targeted search before rebuilding or loading the floor.",
        clamp(.3 + anomaly.severity * .55), time, world.roomId[anomaly.tile] || -1, anomaly.tile, [], anomaly.severity);
    }
  }

  private addReport(manager: ManagerKind, title: string, summary: string, recommendation: string,
    confidence: number, time: number, areaId: number, tile: number, evidenceIds: number[], metric: number): ManagerReport {
    const id = this.nextReportId++, report: ManagerReport = { id, manager, title, summary, recommendation,
      confidence: clamp(confidence), createdAt: time, expiresAt: time + HOUR_SECONDS * 72, areaId, tile,
      evidenceIds: [...evidenceIds], metric, acknowledged: false };
    this.reports.set(id, report); return report;
  }
}
