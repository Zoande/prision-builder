import type { Agent, Tunnel } from "./agent.ts";
import { AdvancedEscapeSystem } from "./advancedEscape.ts";
import { CredentialSystem } from "./credentials.ts";
import type { EconomySystem } from "./economy.ts";
import type { EscapeOperationsSystem } from "./escapeOperations.ts";
import { FacilitySecurityGraph } from "./facilitySecurity.ts";
import { GangTerritorySystem } from "./gangTerritory.ts";
import type { LogisticsSystem } from "./logistics.ts";
import { ManagementSystem } from "./management.ts";
import { Obj, RoomType } from "./objects.ts";
import type { PrisonerSocialSystem } from "./social.ts";
import { StaffProfileSystem } from "./staffProfiles.ts";
import { VisitationSystem } from "./visitation.ts";
import type { Task2Systems } from "./task2Systems.ts";
import type { World } from "./world.ts";

/** Version-five systems are kept behind one save boundary while reusing the
 * physical items, evidence, work, combat, and gangs established by Task 2. */
export class Task3Systems {
  readonly credentials: CredentialSystem;
  readonly staff: StaffProfileSystem;
  readonly facility: FacilitySecurityGraph;
  readonly management: ManagementSystem;
  readonly territories: GangTerritorySystem;
  readonly escape: AdvancedEscapeSystem;
  readonly visitation: VisitationSystem;
  readonly warnings = new Set<string>();
  private readonly seededRooms = new Set<string>();
  private readonly materializedReports = new Set<number>();
  private readonly corruptionCooldown = new Map<string, number>();
  private refreshT = 0;
  private readonly task2: Task2Systems;
  private readonly logistics: LogisticsSystem;

  constructor(task2: Task2Systems, economy: EconomySystem, logistics: LogisticsSystem) {
    this.task2 = task2; this.logistics = logistics;
    this.credentials = new CredentialSystem(task2.items);
    this.staff = new StaffProfileSystem(task2.items, task2.market, task2.institution);
    this.facility = new FacilitySecurityGraph(task2.areas);
    this.management = new ManagementSystem(economy, task2.institution, task2.items, this.staff);
    this.territories = new GangTerritorySystem(task2.gangs, task2.areas, task2.work, task2.items,
      task2.market, task2.combat, task2.institution);
    this.escape = new AdvancedEscapeSystem(task2.items, this.credentials, this.facility, task2.institution,
      task2.combat, task2.market, task2.work, this.staff, this.management, task2.gangs, this.territories, logistics);
    this.visitation = new VisitationSystem(task2.market, task2.areas, this.facility);
  }

  installNewGame(world: World, time: number): void { this.facility.recompute(world); this.refreshFacilities(world, time); }
  rebuildWorld(world: World): void { this.facility.recompute(world); }

  tick(dt: number, time: number, world: World, agents: Agent[], social: PrisonerSocialSystem,
    operations: EscapeOperationsSystem, tunnels: readonly Tunnel[]): void {
    this.warnings.clear(); this.refreshT -= dt;
    if (this.refreshT <= 0) { this.refreshT = 4; this.refreshFacilities(world, time); }
    for (const agent of agents) {
      const profile = this.staff.ensure(agent);
      if (profile) this.credentials.ensureStaffIdentity(agent, time);
      if (agent.kind === Obj.Prisoner) agent.accessKeys = this.credentials.keyTier(agent.id, time);
    }
    this.staff.tick(dt, time, this.task2.areas, agents);
    const roadVehicles = [...this.logistics.trucks, ...this.escape.externalVehicles.values()];
    this.facility.tick(dt, time, world, agents, roadVehicles, new Set(this.task2.security.postings.keys()));
    this.management.tick(dt, time, world, agents, tunnels);
    this.territories.tick(dt, time, world, agents, social);
    this.escape.tick(dt, time, world, agents, social, operations);
    this.visitation.tick(dt, time, world, agents, (id) => {
      const agent = agents.find((candidate) => candidate.id === id);
      return this.task2.health.isUnavailable(id) || this.hasEscapeVisitorCommitment(id) ||
        (!!agent && this.isActiveEscapeExecution(agent));
    });
    this.applyCompromisedBehavior(time, world, agents);
    this.materializeReports(time);
    for (const source of [this.facility.warnings, this.management.warnings, this.territories.warnings, this.escape.warnings,
      this.visitation.warnings]) for (const warning of source) this.warnings.add(warning);
  }

  updateStaff(agent: Agent, dt: number, time: number, world: World, urgentResponse: boolean): boolean {
    if (this.visitation.updateStaff(agent, dt, time, world, urgentResponse)) return true;
    if (this.management.updateManager(agent, dt, world)) return true;
    return this.facility.updateGuard(agent, dt, world, urgentResponse);
  }
  updatePrisoner(agent: Agent, dt: number, time: number, world: World, agents: readonly Agent[], activity?: number): boolean {
    const activeEscape = this.isActiveEscapeExecution(agent);
    if (this.visitation.updatePrisoner(agent, dt, time, world, agents, this.task2.health.isUnavailable(agent.id), activeEscape)) return true;
    if (this.visitation.hasAppointment(agent.id) && !activeEscape) {
      // While the visitor is still entering or being screened, keep the
      // resident's normal needs AI available but suspend background escape
      // movement so the resident cannot walk away from the rendezvous.
      if (agent.state.startsWith("escape:")) { agent.path = null; agent.pathI = 0; agent.state = "idle"; }
      return false;
    }
    return this.escape.updatePrisoner(agent, dt, time, world, agents, activity,
      this.task2.health.isUnavailable(agent.id));
  }
  isLegitimateVisitParticipant(agent: Agent): boolean {
    return !this.isActiveEscapeExecution(agent) && this.visitation.isParticipant(agent);
  }
  visitationStatus() { return this.visitation.status(); }
  staffEfficiency(agent: Agent, time: number): number { return this.management.staffEfficiency(agent, time); }
  mayTakeSpoon(prisonerId: number, time: number): boolean {
    if (!this.management.procedure("spoon-count", time)) return true;
    for (const profile of this.staff.profiles.values()) {
      const beneficiary = profile.compromisedBy;
      if (beneficiary < 0 || profile.lastWarningAt < time - 2 * 30 || !this.staff.permits(profile.agentId, beneficiary, "skip-count", time)) continue;
      const scheme = this.escape.schemeForAgent(beneficiary);
      const trusted = (this.task2.social?.bond(beneficiary, prisonerId, false)?.trust ?? 0) >= .65;
      if (beneficiary === prisonerId || this.task2.gangs.sameGang(beneficiary, prisonerId) || scheme?.memberIds.includes(prisonerId) || trusted) return false;
    }
    return true;
  }
  recordSpoonTaken(prisoner: Agent, time: number, agents: readonly Agent[]): void {
    const procedure = this.management.procedure("spoon-count", time); if (!procedure) return;
    const cook = agents.filter((agent) => agent.kind === Obj.Cook && Math.hypot(agent.x - prisoner.x, agent.z - prisoner.z) < 11)
      .sort((a, b) => Math.hypot(a.x - prisoner.x, a.z - prisoner.z) - Math.hypot(b.x - prisoner.x, b.z - prisoner.z))[0];
    if (!cook || this.staff.permits(cook.id, prisoner.id, "skip-count", time)) { if (cook) this.staff.warn(cook.id, prisoner.id, time); return; }
    const sample = (((prisoner.id * 2654435761) ^ (Math.floor(time) * 2246822519)) >>> 0) / 0x1_0000_0000;
    if (sample > procedure.detectionBonus) return;
    const incident = this.task2.institution.createIncident("tool", prisoner.id, -1, prisoner.x, prisoner.z, time, "spoon");
    this.task2.institution.addEvidence(incident.id, "witness", cook.id, prisoner.id, .72,
      "A cook conducting the temporary cutlery count saw this inmate retain a spoon", time, prisoner.x, prisoner.z, -1,
      "The utensil may have been left on the wrong tray during a rushed count");
  }
  canHire(kind: number, agents: readonly Agent[]): boolean { return this.management.canHire(kind, agents); }
  consumeEscaped(): number[] { return this.escape.consumeEscaped(); }

  saveData() { return {
    credentials: this.credentials.saveData(), staff: this.staff.saveData(), facility: this.facility.saveData(),
    management: this.management.saveData(), territories: this.territories.saveData(), escape: this.escape.saveData(),
    visitation: this.visitation.saveData(),
    seededRooms: [...this.seededRooms], materializedReports: [...this.materializedReports],
    corruptionCooldown: [...this.corruptionCooldown], refreshT: this.refreshT,
  }; }
  loadData(data: Partial<ReturnType<Task3Systems["saveData"]>>, world: World): void {
    this.credentials.loadData(data.credentials ?? {}); this.staff.loadData(data.staff ?? {});
    this.facility.loadData(data.facility ?? {}, world); this.management.loadData(data.management ?? {});
    this.territories.loadData(data.territories ?? {}); this.escape.loadData(data.escape ?? {});
    this.visitation.loadData(data.visitation ?? {});
    this.seededRooms.clear(); for (const key of data.seededRooms ?? []) this.seededRooms.add(key);
    this.materializedReports.clear(); for (const id of data.materializedReports ?? []) this.materializedReports.add(id);
    this.corruptionCooldown.clear(); for (const [key, value] of data.corruptionCooldown ?? []) this.corruptionCooldown.set(key, value);
    this.refreshT = data.refreshT ?? 0;
  }

  private isActiveEscapeExecution(agent: Agent): boolean {
    const action = agent.state.startsWith("escape:") ? agent.state.slice("escape:".length) : "";
    const exitingAction = ["legacy-execute", "credential-walkout", "depart-vehicle", "visitation-exit", "medical-transfer", "outside-dig"];
    const scheme = this.escape.schemeForAgent(agent.id);
    // A scheme's status is aggregate across all members. Its `executing` state
    // can describe another member's work while this inmate is only observing
    // a background plan; that must not block ordinary appointments such as a
    // family visit. Physical escape actions and legacy execute/flee stages are
    // still exclusive.
    return agent.plan?.stage === "execute" || agent.plan?.stage === "flee" || exitingAction.includes(action) ||
      (!!scheme && scheme.state === "executing" && action !== "" && action !== "observe");
  }

  private hasEscapeVisitorCommitment(agentId: number): boolean {
    const scheme = this.escape.schemeForAgent(agentId);
    return !!scheme && scheme.mode === "visitation" && [...this.escape.commitments.values()].some((row) =>
      row.schemeId === scheme.id && row.type === "visitor" && row.state !== "failed");
  }

  private refreshFacilities(world: World, time: number): void {
    const stock: Record<number, string[]> = {
      [RoomType.RecordsOffice]: ["paper", "paper", "ink", "copied-schedule", "delivery-manifest", "visitor-pass", "key-blank"],
      [RoomType.Utilities]: ["electrical-parts", "electrical-parts", "wire", "radio-battery", "circuit-map", "key-blank"],
      [RoomType.Visitation]: ["visitor-pass", "visitor-package", "civilian-clothes"],
      [RoomType.ManagementOffice]: ["paper", "ink", "delivery-manifest"],
      [RoomType.ConstructionYard]: ["key-blank", "metal-scrap", "wood-scrap", "wire"],
      [RoomType.EvidenceRoom]: ["evidence-seal", "evidence-seal", "evidence-seal"],
    };
    for (const room of world.rooms.values()) {
      if (!room.valid || !stock[room.type]) continue;
      const key = `${room.type}:${room.id}`, tile = [...room.tiles][0], x = tile % world.size + .5, z = Math.floor(tile / world.size) + .5;
      const containerId = room.type === RoomType.EvidenceRoom ? "institution:evidence" : `task3:room:${room.id}:stock`;
      const container = this.task2.items.ensureContainer({ id: containerId, name: `${roomName(room.type)} controlled stock`, x, z,
        capacity: room.type === RoomType.EvidenceRoom ? 500 : 80, concealment: .35, bodyCapacity: 0,
        lockedTier: room.type === RoomType.EvidenceRoom ? "guard" : "staff", ownerId: -1,
        tags: ["task3", "controlled", roomName(room.type).toLowerCase()] });
      if (this.seededRooms.has(key)) continue; this.seededRooms.add(key);
      for (const defId of stock[room.type]) {
        const item = this.task2.items.create(defId, time); this.task2.items.moveToContainer(item.id, container.id, time);
      }
    }
    for (const piece of world.piecesOfKind(Obj.Gatehouse)) {
      const key = `gatehouse:${piece.id}`, x = piece.x + 1, z = piece.z + 1.5;
      const container = this.task2.items.ensureContainer({ id: `gatehouse:${piece.id}:keys`, name: `Gatehouse ${piece.id} key cabinet`, x, z,
        capacity: 24, concealment: .25, bodyCapacity: 0, lockedTier: "guard", ownerId: -1, tags: ["keys", "controlled", "gatehouse"] });
      if (!this.seededRooms.has(key)) { this.seededRooms.add(key); for (const defId of ["guard-key", "staff-key", "visitor-pass", "delivery-manifest"]) {
        const item = this.task2.items.create(defId, time); this.task2.items.moveToContainer(item.id, container.id, time);
      } }
    }
  }

  private materializeReports(time: number): void {
    for (const report of this.management.reports.values()) {
      if (this.materializedReports.has(report.id)) continue; this.materializedReports.add(report.id);
      const assignment = [...this.management.assignments.values()].find((row) => row.kind === report.manager);
      const container = assignment && this.task2.items.containers.get(`task3:room:${assignment.roomId}:stock`);
      if (!container) continue;
      const file = this.task2.items.create("records-bundle", time, { quality: report.confidence, ownerId: assignment.managerId });
      this.task2.items.moveToContainer(file.id, container.id, time, assignment.managerId);
    }
  }

  private applyCompromisedBehavior(time: number, world: World, agents: readonly Agent[]): void {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const profile of this.staff.profiles.values()) {
      if (profile.compromisedBy < 0 || profile.compromisedUntil < time) continue;
      const employee = byId.get(profile.agentId), beneficiary = byId.get(profile.compromisedBy);
      if (!employee || !beneficiary || Math.hypot(employee.x - beneficiary.x, employee.z - beneficiary.z) > 8) continue;
      for (const action of profile.permittedActions) {
        const key = `${profile.agentId}:${action}`; if ((this.corruptionCooldown.get(key) ?? -1) > time) continue;
        if (action === "leak-schedule") {
          const item = this.task2.items.create("copied-schedule", time, { ownerId: beneficiary.id, quality: .45 + profile.experience * .45 });
          this.task2.items.moveToContainer(item.id, `agent:${beneficiary.id}:pockets`, time, employee.id, true);
        } else if (action === "leave-tool") {
          const tool = [...this.task2.items.items.values()].filter((item) => item.locationKind !== "destroyed" &&
            ["file", "hacksaw-blade", "screwdriver", "key-blank", "trowel"].includes(item.defId) && Math.hypot(item.x - employee.x, item.z - employee.z) < 5)
            .sort((a, b) => a.id - b.id)[0];
          if (tool) this.task2.items.moveToContainer(tool.id, `agent:${beneficiary.id}:pockets`, time, employee.id, true);
          else continue;
        } else if (action === "misfile-evidence") {
          const evidence = this.task2.items.itemsIn("institution:evidence").sort((a, b) => a.id - b.id)[0];
          if (!evidence) continue;
          const container = this.task2.items.ensureContainer({ id: `staff:${employee.id}:illicit`, name: "Misfiled staff effects",
            x: employee.x, z: employee.z, capacity: 20, concealment: .92, bodyCapacity: 0, lockedTier: "none",
            ownerId: employee.id, tags: ["staff", "corruption"] });
          this.task2.items.moveToContainer(evidence.id, container.id, time, employee.id, true);
        } else if (action === "disable-device") {
          const roomId = world.roomId[world.idx(Math.floor(employee.x), Math.floor(employee.z))];
          if (!this.facility.sabotageCircuit(roomId, beneficiary.id, time, 20)) continue;
        } else continue;
        profile.exposure = Math.min(1, profile.exposure + .035);
        this.corruptionCooldown.set(key, time + 6 * 30);
      }
    }
  }
}

function roomName(type: number): string {
  if (type === RoomType.RecordsOffice) return "Records";
  if (type === RoomType.Utilities) return "Utilities";
  if (type === RoomType.Visitation) return "Visitation";
  if (type === RoomType.ManagementOffice) return "Management";
  if (type === RoomType.ConstructionYard) return "Construction";
  return "Evidence";
}
