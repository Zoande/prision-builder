import type { Agent } from "./agent.ts";
import type { CombatSystem } from "./combat.ts";
import type { HealthSystem } from "./health.ts";
import { incidentCategoryForItem, type InstitutionSystem, type PunishmentOrder } from "./institution.ts";
import { itemDefV4, type ItemSystem } from "./itemSystem.ts";
import { astar, passable, roleAllowed } from "./nav.ts";
import { Obj, RoomType } from "./objects.ts";
import { aptitude, personality, skill } from "./profiles.ts";
import { HOUR_SECONDS } from "./time.ts";
import type { World } from "./world.ts";
import { accessRoleForAgent, type AccessRole, type AreaSystem } from "./areas.ts";

export type EmergencyMode = "none" | "alarm" | "lockdown" | "shakedown" | "armed-response";
export interface StaffDutyState { agentId: number; fatigue: number; onBreak: boolean; breakUntil: number; assignmentOpen: boolean; }

export class SecuritySystem {
  emergency: EmergencyMode = "none";
  readonly staff = new Map<number, StaffDutyState>();
  readonly warnings = new Set<string>();
  readonly registeredPrisoners = new Set<number>();
  readonly deploymentTargets = new Map<number, Partial<Record<AccessRole, number>>>();
  readonly postings = new Map<number, { areaId: number; role: AccessRole }>();
  private readonly claims = new Map<number, number>();
  private readonly actionTimers = new Map<number, number>();
  private readonly policyPhases = new Map<number, "approach" | "search-route" | "search" | "interview-route" | "interview" | "solitary-route">();
  private readonly dogCooldown = new Map<number, number>();
  private readonly bodyClaims = new Map<number, number>();
  private readonly casualtyClaims = new Map<number, number>();
  private lastRollCallStamp = -1;
  private seededArmouries = new Set<number>();
  private readonly emergencyIssue = new Map<number, number[]>();
  private readonly criticalResponseItems = new Set<number>();
  private rngState = 0x44a91be3;
  private deploymentTimer = 0;
  private readonly items: ItemSystem;
  private readonly institution: InstitutionSystem;
  private readonly combat: CombatSystem;
  private readonly health: HealthSystem;
  private readonly areas: AreaSystem;

  constructor(items: ItemSystem, institution: InstitutionSystem, combat: CombatSystem,
    health: HealthSystem, areas: AreaSystem) {
    this.items = items; this.institution = institution; this.combat = combat; this.health = health; this.areas = areas;
    this.items.ensureContainer({ id: "institution:evidence", name: "Evidence storage", x: 0, z: 0,
      capacity: 500, concealment: .1, bodyCapacity: 0, lockedTier: "guard", ownerId: -1, tags: ["evidence", "controlled"] });
  }

  command(mode: EmergencyMode, time: number, agents: readonly Agent[]): void {
    this.emergency = mode;
    if (mode === "shakedown") this.queueShakedown(time, agents);
  }

  private queueShakedown(time: number, agents: readonly Agent[]): void {
    for (const prisoner of agents.filter((a) => a.kind === Obj.Prisoner)) {
      if (this.institution.punishments.some((p) => p.prisonerId === prisoner.id && p.state === "queued")) continue;
      const incident = this.institution.createIncident("missing-stock", prisoner.id, -1, prisoner.x, prisoner.z, time);
      this.institution.addEvidence(incident.id, "audit", -1, prisoner.id, .3, "Full shakedown search order", time, prisoner.x, prisoner.z);
      this.institution.punishments.push({ incidentId: incident.id, prisonerId: prisoner.id, solitaryUntil: time,
        custodyUp: false, search: "person", interrogate: false, state: "queued" });
    }
  }

  setDeployment(areaId: number, role: AccessRole, count: number): void {
    const row = this.deploymentTargets.get(areaId) ?? {}; row[role] = Math.max(0, Math.min(99, count | 0));
    this.deploymentTargets.set(areaId, row); this.deploymentTimer = 0;
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[], rollCall: boolean): void {
    this.warnings.clear();
    for (const order of this.institution.punishments) if (order.state === "complete" && order.solitaryRoomId !== undefined && !order.released) {
      const room = world.rooms.get(order.solitaryRoomId); if (room) for (const door of world.roomJailDoors(room)) world.jailClosed[door] = 0;
      const prisoner = agents.find((a) => a.id === order.prisonerId); if (prisoner) { prisoner.cuffed = false; prisoner.state = "idle"; }
      order.released = true;
    }
    for (const agent of agents) {
      if (agent.kind === Obj.Prisoner) this.registeredPrisoners.add(agent.id);
      else if (agent.kind !== Obj.SecurityDog) {
        let duty = this.staff.get(agent.id);
        if (!duty) { duty = { agentId: agent.id, fatigue: 0, onBreak: false, breakUntil: 0, assignmentOpen: false }; this.staff.set(agent.id, duty); }
        const urgent = this.emergency !== "none" || this.combat.responseFor(agent) !== null;
        if (urgent) { duty.onBreak = false; duty.assignmentOpen = false; }
        else if (duty.onBreak) duty.fatigue = Math.max(0, duty.fatigue - dt / 90);
        else duty.fatigue = Math.min(1, duty.fatigue + dt / 900);
        if (duty.fatigue >= .82 && !urgent) { duty.onBreak = true; duty.assignmentOpen = true; }
      }
    }
    this.syncArmouries(world, time);
    this.deploymentTimer -= dt; if (this.deploymentTimer <= 0) { this.deploymentTimer = 5; this.updateDeployments(agents); }
    this.discoverBodies(time, agents);
    this.cctvObserve(time, world, agents);
    this.updateDogs(dt, time, world, agents);
    if (rollCall) this.rollCall(time, agents);
    const missingCritical = this.items.controlledDiscrepancies().filter((d) => ["guard-key", "radio", "service-pistol", "pistol-magazine", "sniper-rifle", "rifle-magazine"].includes(d.defId));
    if (missingCritical.length) {
      this.warnings.add(`${missingCritical.length} critical security item${missingCritical.length === 1 ? " is" : "s are"} unaccounted for`);
      const newLoss = missingCritical.filter((d) => !this.criticalResponseItems.has(d.itemId));
      if (newLoss.length) {
        for (const loss of newLoss) this.criticalResponseItems.add(loss.itemId);
        this.queueShakedown(time, agents);
        if (newLoss.some((d) => ["service-pistol", "sniper-rifle", "pistol-magazine", "rifle-magazine"].includes(d.defId))) this.emergency = "armed-response";
        else if (newLoss.some((d) => d.defId === "guard-key")) this.emergency = "lockdown";
        else if (this.emergency === "none") this.emergency = "alarm";
      }
    }
    if (this.emergency !== "none") this.warnings.add(`Emergency active: ${this.emergency.replace(/-/g, " ")}`);
    if (agents.some((a) => a.kind === Obj.SecurityDog) && ![...world.rooms.values()].some((r) => r.valid && r.type === RoomType.Kennel)) this.warnings.add("Security dogs need a valid Kennel");
  }

  updateStaff(agent: Agent, dt: number, time: number, world: World, agents: readonly Agent[]): boolean {
    const duty = this.staff.get(agent.id);
    const securityRole = [Obj.Guard, Obj.ArmedGuard, Obj.Investigator, Obj.DogHandler].includes(agent.kind as never);
    if (securityRole && this.updateCasualtyResponse(agent, dt, world, agents)) return true;
    if (securityRole && this.updateBodyResponse(agent, dt, world, agents)) return true;
    if (securityRole && this.updatePolicyAction(agent, dt, time, world, agents)) return true;
    if (this.combat.responseFor(agent)) return false;
    if (agent.kind === Obj.Guard && this.updateEmergencyEquipment(agent, dt, time, world)) return true;
    if (duty?.onBreak && this.emergency === "none") {
      const room = [...world.rooms.values()].find((r) => r.valid && r.type === RoomType.StaffRoom);
      if (!room) { this.warnings.add("Fatigued staff have no valid Staff Room"); return false; }
      const target = [...room.tiles].find((i) => passable(world, i, true)) ?? [...room.tiles][0];
      if (!this.moveToward(agent, target, dt, world, true)) { agent.state = "staffBreak"; agent.amp = 0; }
      if (duty.fatigue <= .28) { duty.onBreak = false; duty.assignmentOpen = false; }
      return true;
    }
    if (this.emergency !== "none") {
      if (agent.kind === Obj.ArmedGuard) { agent.state = "armedResponse"; agent.amp = 0; }
      return false;
    }
    const posting = this.postings.get(agent.id), area = posting && this.areas.areas.get(posting.areaId);
    if (!posting || !area) return false;
    const target = [...area.tiles].find((i) => passable(world, i, true)) ?? -1;
    if (target >= 0 && this.moveToward(agent, target, dt, world, true)) { agent.state = "toDeployment"; return true; }
    agent.state = "deployed"; agent.amp = 0; return true;
  }

  saveData() { return { emergency: this.emergency, staff: [...this.staff.values()].map((s) => ({ ...s })),
    registeredPrisoners: [...this.registeredPrisoners], claims: [...this.claims], actionTimers: [...this.actionTimers], policyPhases: [...this.policyPhases],
    dogCooldown: [...this.dogCooldown], lastRollCallStamp: this.lastRollCallStamp,
    bodyClaims: [...this.bodyClaims], casualtyClaims: [...this.casualtyClaims], deploymentTargets: [...this.deploymentTargets], postings: [...this.postings],
    seededArmouries: [...this.seededArmouries], emergencyIssue: [...this.emergencyIssue],
    criticalResponseItems: [...this.criticalResponseItems], rngState: this.rngState }; }
  loadData(data: Partial<ReturnType<SecuritySystem["saveData"]>>): void {
    this.emergency = data.emergency ?? "none"; this.staff.clear(); for (const s of data.staff ?? []) this.staff.set(s.agentId, { ...s });
    this.registeredPrisoners.clear(); for (const id of data.registeredPrisoners ?? []) this.registeredPrisoners.add(id);
    this.claims.clear(); for (const [a, o] of data.claims ?? []) this.claims.set(a, o);
    this.actionTimers.clear(); for (const [a, t] of data.actionTimers ?? []) this.actionTimers.set(a, t);
    this.policyPhases.clear(); for (const [incident, phase] of data.policyPhases ?? []) this.policyPhases.set(incident, phase);
    this.dogCooldown.clear(); for (const [a, t] of data.dogCooldown ?? []) this.dogCooldown.set(a, t);
    this.bodyClaims.clear(); for (const [body, guard] of data.bodyClaims ?? []) this.bodyClaims.set(body, guard);
    this.casualtyClaims.clear(); for (const [patient, guard] of data.casualtyClaims ?? []) this.casualtyClaims.set(patient, guard);
    this.deploymentTargets.clear(); for (const [area, row] of data.deploymentTargets ?? []) this.deploymentTargets.set(area, { ...row });
    this.postings.clear(); for (const [agent, row] of data.postings ?? []) this.postings.set(agent, { ...row });
    this.lastRollCallStamp = data.lastRollCallStamp ?? -1; this.seededArmouries = new Set(data.seededArmouries ?? []);
    this.emergencyIssue.clear(); for (const [agent, ids] of data.emergencyIssue ?? []) this.emergencyIssue.set(agent, [...ids]);
    this.criticalResponseItems.clear(); for (const id of data.criticalResponseItems ?? []) this.criticalResponseItems.add(id);
    this.rngState = data.rngState ?? 0x44a91be3;
  }

  private updateDeployments(agents: readonly Agent[]): void {
    for (const [agentId, posting] of [...this.postings]) {
      const agent = agents.find((a) => a.id === agentId), target = this.deploymentTargets.get(posting.areaId)?.[posting.role] ?? 0;
      if (!agent || target <= 0 || !this.matchesRole(agent, posting.role) || !this.areas.areas.has(posting.areaId)) this.postings.delete(agentId);
    }
    for (const [areaId, row] of this.deploymentTargets) for (const [role, wantedRaw] of Object.entries(row) as [AccessRole, number][]) {
      const wanted = wantedRaw ?? 0;
      let present = [...this.postings].filter(([id, p]) => p.areaId === areaId && p.role === role &&
        !this.staff.get(id)?.assignmentOpen).length;
      const available = agents.filter((a) => a.kind !== Obj.Prisoner && a.kind !== Obj.SecurityDog && this.matchesRole(a, role) &&
        !this.postings.has(a.id) && !this.staff.get(a.id)?.assignmentOpen).sort((a, b) => a.id - b.id);
      while (present < wanted && available.length) { const agent = available.shift()!; this.postings.set(agent.id, { areaId, role }); present++; }
      if (present < wanted) this.warnings.add(`${role} deployment in area ${areaId} is short by ${wanted - present}`);
      if (present > wanted) {
        const extra = [...this.postings].filter(([, p]) => p.areaId === areaId && p.role === role).slice(wanted);
        for (const [id] of extra) this.postings.delete(id);
      }
    }
  }

  private matchesRole(agent: Agent, role: AccessRole): boolean {
    if (role === "staff") return agent.kind !== Obj.Prisoner && agent.kind !== Obj.SecurityDog;
    if (role === "guard") return agent.kind === Obj.Guard;
    if (role === "armed-guard") return agent.kind === Obj.ArmedGuard;
    if (role === "investigator") return agent.kind === Obj.Investigator;
    if (role === "dog-handler") return agent.kind === Obj.DogHandler;
    if (role === "doctor") return agent.kind === Obj.Doctor;
    if (role === "cook") return agent.kind === Obj.Cook;
    if (role === "workman") return agent.kind === Obj.Workman;
    return false;
  }

  private updatePolicyAction(officer: Agent, dt: number, time: number, world: World, agents: readonly Agent[]): boolean {
    let order = [...this.institution.punishments].find((o) => this.claims.get(o.incidentId) === officer.id && o.state === "queued");
    if (!order) {
      order = this.institution.punishments.find((o) => o.state === "queued" && !this.claims.has(o.incidentId) &&
        (!o.interrogate || officer.kind === Obj.Investigator));
      if (!order) return false;
      this.claims.set(order.incidentId, officer.id);
    }
    const prisoner = agents.find((a) => a.id === order!.prisonerId);
    if (!prisoner || this.health.state(prisoner.id)?.alive === false) { order.state = "cancelled"; this.finishPolicy(order.incidentId, officer); return false; }
    let phase = this.policyPhases.get(order.incidentId) ?? "approach";
    if (phase === "approach") {
      const target = world.idx(Math.floor(prisoner.x), Math.floor(prisoner.z));
      if (Math.hypot(officer.x - prisoner.x, officer.z - prisoner.z) > 1.5) {
        this.moveToward(officer, target, dt, world, true); officer.state = "policyResponse"; return true;
      }
      prisoner.cuffed = true; prisoner.path = null;
      phase = order.search === "person" || order.search === "none" ? (order.search === "none" ? (order.interrogate ? "interview-route" : "solitary-route") : "search") : "search-route";
      this.policyPhases.set(order.incidentId, phase); this.actionTimers.delete(officer.id);
    }
    if (phase === "search-route") {
      const target = this.searchTarget(prisoner, order, world);
      if (target < 0) { this.warnings.add(`${order.search} search for inmate ${prisoner.id} has no valid destination`); return true; }
      if (this.escortToward(officer, prisoner, target, dt, world)) { officer.state = "escortingToSearch"; return true; }
      phase = "search"; this.policyPhases.set(order.incidentId, phase); this.actionTimers.delete(officer.id);
    }
    if (phase === "search") {
      officer.state = "searching"; officer.amp = .35;
      const remaining = (this.actionTimers.get(officer.id) ?? (order.search === "full" ? 18 : 7)) - dt;
      this.actionTimers.set(officer.id, remaining); if (remaining > 0) return true;
      this.searchPrisoner(officer, prisoner, order, time, world); this.actionTimers.delete(officer.id);
      phase = order.interrogate ? "interview-route" : "solitary-route"; this.policyPhases.set(order.incidentId, phase);
    }
    if (phase === "interview-route") {
      const room = [...world.rooms.values()].find((r) => r.valid && r.type === RoomType.Interview);
      const target = room ? ([...room.tiles].find((i) => world.objKind[i] === Obj.InterviewTable) ?? [...room.tiles][0]) : -1;
      if (target < 0) { this.warnings.add(`Interview for inmate ${prisoner.id} is waiting for a valid Interview Room`); return true; }
      if (this.escortToward(officer, prisoner, target, dt, world)) { officer.state = "escortingToInterview"; return true; }
      phase = "interview"; this.policyPhases.set(order.incidentId, phase); this.actionTimers.delete(officer.id);
    }
    if (phase === "interview") {
      officer.state = "interrogating"; officer.amp = .35;
      const remaining = (this.actionTimers.get(officer.id) ?? 20) - dt;
      this.actionTimers.set(officer.id, remaining); if (remaining > 0) return true;
      this.interrogate(officer, prisoner, order, time); this.actionTimers.delete(officer.id);
      phase = "solitary-route"; this.policyPhases.set(order.incidentId, phase);
    }
    const rule = this.institution.ruleFor(this.institution.incidents.get(order.incidentId)?.category ?? "unauthorized",
      this.institution.incidents.get(order.incidentId)?.itemDefId ?? "");
    if (phase === "solitary-route" && rule.solitaryHours > 0) {
      const occupied = new Set(this.institution.punishments.filter((row) => row.state === "active" && row.solitaryRoomId !== undefined).map((row) => row.solitaryRoomId));
      const room = [...world.rooms.values()].find((r) => r.valid && r.type === RoomType.Solitary && !occupied.has(r.id));
      const target = room ? ([...room.tiles].find((i) => world.objKind[i] === Obj.Bed) ?? [...room.tiles][0]) : -1;
      if (!room || target < 0) { this.warnings.add(`Solitary order for inmate ${prisoner.id} is waiting for a free Solitary Cell`); return true; }
      if (this.escortToward(officer, prisoner, target, dt, world)) { officer.state = "escortingToSolitary"; return true; }
      order.solitaryRoomId = room.id; order.solitaryUntil = time + rule.solitaryHours * HOUR_SECONDS; order.state = "active";
      prisoner.state = "solitary"; prisoner.cuffed = false; prisoner.path = null;
      for (const door of world.roomJailDoors(room)) world.jailClosed[door] = 1;
    } else if (phase === "solitary-route") {
      order.state = "complete"; prisoner.state = "idle"; prisoner.cuffed = false;
    }
    if (order.custodyUp && prisoner.profile) {
      const levels = ["minimum", "medium", "maximum", "supermax"] as const;
      const at = levels.indexOf(prisoner.profile.custody as typeof levels[number]);
      prisoner.profile.custody = levels[Math.min(levels.length - 1, Math.max(0, at + 1))];
    }
    this.finishPolicy(order.incidentId, officer); return true;
  }

  private finishPolicy(incidentId: number, officer: Agent): void {
    this.claims.delete(incidentId); this.policyPhases.delete(incidentId); this.actionTimers.delete(officer.id);
    officer.state = "idle"; officer.path = null;
  }

  private escortToward(officer: Agent, prisoner: Agent, target: number, dt: number, world: World): boolean {
    const moving = this.moveToward(officer, target, dt, world, true);
    prisoner.path = null; prisoner.x = officer.x - Math.cos(officer.heading) * .65; prisoner.z = officer.z - Math.sin(officer.heading) * .65;
    prisoner.state = "policyEscort"; prisoner.cuffed = true; return moving;
  }

  private searchTarget(prisoner: Agent, order: PunishmentOrder, world: World): number {
    if (["cell", "targeted", "full"].includes(order.search) && prisoner.bedIdx >= 0) return prisoner.bedIdx;
    if (order.search === "workplace") {
      const roomId = [...this.areas.areas.values()].find((area) => area.tiles.has(world.idx(Math.floor(prisoner.x), Math.floor(prisoner.z))))?.roomIds.values().next().value;
      const room = roomId ? world.rooms.get(roomId) : null; if (room) return [...room.tiles][0];
    }
    return world.idx(Math.floor(prisoner.x), Math.floor(prisoner.z));
  }

  private discoverBodies(time: number, agents: readonly Agent[]): void {
    for (const body of this.health.bodies.values()) {
      if (body.removed || body.discovered) continue;
      const witness = agents.find((a) => [Obj.Guard, Obj.ArmedGuard, Obj.Investigator, Obj.DogHandler].includes(a.kind as never) &&
        Math.hypot(a.x - body.x, a.z - body.z) < (body.hiddenIn ? 2 + body.odor * 5 : 8));
      if (!witness) continue;
      this.health.discoverBody(body.agentId);
      const incident = this.institution.createIncident("homicide", -1, body.agentId, body.x, body.z, time);
      this.institution.addEvidence(incident.id, "medical", witness.id, -1, .98, `Staff discovered the body of agent ${body.agentId}`, time, body.x, body.z, -1,
        "Cause and responsibility are not yet established");
    }
  }

  private updateBodyResponse(guard: Agent, dt: number, world: World, agents: readonly Agent[]): boolean {
    let body = [...this.health.bodies.values()].find((b) => this.bodyClaims.get(b.agentId) === guard.id && !b.removed && b.morgueSlab < 0);
    if (!body) {
      body = [...this.health.bodies.values()].find((b) => b.discovered && !b.removed && b.morgueSlab < 0 && !this.bodyClaims.has(b.agentId));
      if (!body) return false; this.bodyClaims.set(body.agentId, guard.id);
    }
    const corpse = agents.find((a) => a.id === body!.agentId);
    if (Math.hypot(guard.x - body.x, guard.z - body.z) > 1.2 && guard.state !== "movingBody") {
      const target = world.idx(Math.floor(body.x), Math.floor(body.z)); this.moveToward(guard, target, dt, world, true); guard.state = "toBody"; return true;
    }
    const slab = world.tilesOfKind(Obj.MorgueSlab).find((tile) => world.roomTypeAt(tile) === RoomType.Morgue &&
      ![...this.health.bodies.values()].some((b) => b.agentId !== body!.agentId && b.morgueSlab === tile));
    if (slab === undefined) { this.warnings.add("A discovered body is waiting for a valid free Morgue slab"); guard.state = "bodyWaiting"; return true; }
    guard.state = "movingBody";
    body.x = guard.x; body.z = guard.z; if (corpse) { corpse.x = guard.x; corpse.z = guard.z; }
    if (this.moveToward(guard, slab, dt * .7, world, true)) return true;
    body.morgueSlab = slab; body.x = slab % world.size + .5; body.z = ((slab / world.size) | 0) + .5;
    if (corpse) { corpse.x = body.x; corpse.z = body.z; corpse.state = "morgue"; }
    this.bodyClaims.delete(body.agentId); guard.state = "idle"; return true;
  }

  private updateCasualtyResponse(guard: Agent, dt: number, world: World, agents: readonly Agent[]): boolean {
    let job = this.health.treatmentJobs.find((row) => row.state === "waiting" && this.casualtyClaims.get(row.patientId) === guard.id);
    if (!job) {
      job = this.health.treatmentJobs.filter((row) => row.state === "waiting" && !this.casualtyClaims.has(row.patientId))
        .sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
      if (!job) return false; this.casualtyClaims.set(job.patientId, guard.id);
    }
    const patient = agents.find((a) => a.id === job!.patientId), h = patient && this.health.state(patient.id);
    if (!patient || !h?.alive) { this.casualtyClaims.delete(job.patientId); job.state = "stable"; return false; }
    const bed = this.health.availableMedicalBed(world, patient.id);
    if (bed < 0) { this.warnings.add("A casualty is waiting for a free Infirmary medical bed"); guard.state = "casualtyWaiting"; return true; }
    if (guard.state !== "movingCasualty" && Math.hypot(guard.x - patient.x, guard.z - patient.z) > 1.25) {
      const target = world.idx(Math.floor(patient.x), Math.floor(patient.z)); this.moveToward(guard, target, dt, world, true);
      guard.state = "toCasualty"; return true;
    }
    guard.state = "movingCasualty"; patient.state = "beingTransported"; patient.path = null;
    patient.x = guard.x; patient.z = guard.z; patient.pose = 4;
    if (this.moveToward(guard, bed, dt * .68, world, true)) return true;
    patient.x = bed % world.size + .5; patient.z = ((bed / world.size) | 0) + .5;
    this.health.admit(patient, bed); this.casualtyClaims.delete(patient.id); guard.state = "idle"; return true;
  }

  private searchPrisoner(officer: Agent, prisoner: Agent, order: PunishmentOrder, time: number, world: World): void {
    const incident = this.institution.incidents.get(order.incidentId); if (!incident) return;
    const perception = officer.kind === Obj.Investigator ? .98 : .78;
    const containers = new Set<string>();
    if (["person", "targeted", "full"].includes(order.search)) for (const suffix of ["hands", "pockets", "worn"]) containers.add(`agent:${prisoner.id}:${suffix}`);
    if (["cell", "targeted", "full"].includes(order.search)) for (const container of this.items.containers.values()) {
      if (!container.tags.includes("hiding-place")) continue;
      const tile = world.inBounds(Math.floor(container.x), Math.floor(container.z)) ? world.idx(Math.floor(container.x), Math.floor(container.z)) : -1;
      if (tile >= 0 && world.roomId[tile] === prisoner.cellRoom) containers.add(container.id);
    }
    if (["workplace", "full"].includes(order.search)) for (const container of this.items.containers.values())
      if (container.tags.includes("work") && Math.hypot(container.x - prisoner.x, container.z - prisoner.z) < 8) containers.add(container.id);
    for (const containerId of containers) for (const item of [...this.items.itemsIn(containerId)]) {
      const def = itemDefV4(item.defId), findChance = perception * (1 - (item.hidden ? 1 : 0) * def.concealment * .55);
      if (def.legality === "legal" || this.random() > findChance) continue;
      const category = incidentCategoryForItem(item.defId), foundRule = this.institution.ruleFor(category, item.defId);
      if (foundRule.confiscate) this.items.moveToContainer(item.id, "institution:evidence", time, officer.id);
      if (foundRule.medicalCheck) this.health.requestMedicalCheck(prisoner);
      const found = this.institution.createIncident(category, prisoner.id, -1,
        prisoner.x, prisoner.z, time, item.defId);
      this.institution.addEvidence(found.id, "search", officer.id, prisoner.id, .98,
        `${def.name} ${foundRule.confiscate ? "seized" : "documented"} during ${order.search} search`, time, prisoner.x, prisoner.z, item.id,
        "Possession may not establish how the item was obtained");
    }
  }

  private interrogate(officer: Agent, prisoner: Agent, order: PunishmentOrder, time: number): void {
    const incident = this.institution.incidents.get(order.incidentId); if (!incident || !prisoner.profile) return;
    const pressure = 5 + (officer.kind === Obj.Investigator ? 3 : 0) + this.random() * 4;
    const resistance = prisoner.profile.aptitudes.willpower + skill(prisoner.profile, "deception") * .6 +
      Math.max(0, personality(prisoner.profile, "defiance")) * 2;
    if (pressure >= resistance) {
      this.institution.addEvidence(incident.id, "witness", prisoner.id, prisoner.id, .78,
        `Interview produced a materially consistent admission`, time, prisoner.x, prisoner.z, -1,
        "The statement may be incomplete or motivated by promised leniency");
      if (personality(prisoner.profile, "loyalty") < 0 && this.random() < .25) this.institution.recruitInformant(prisoner.id, .45 + aptitude(prisoner.profile, "memory") * .04);
      if (this.institution.ruleFor(incident.category, incident.itemDefId).protectiveOffer && this.institution.informants.has(prisoner.id)) prisoner.protectiveCustody = true;
    } else {
      this.institution.addEvidence(incident.id, "witness", prisoner.id, prisoner.id, .28,
        `Interview produced a plausible denial`, time, prisoner.x, prisoner.z, -1,
        "A skilled or determined subject may be concealing relevant knowledge");
    }
  }

  private rollCall(time: number, agents: readonly Agent[]): void {
    const stamp = Math.floor(time / HOUR_SECONDS); if (stamp === this.lastRollCallStamp) return; this.lastRollCallStamp = stamp;
    for (const id of this.registeredPrisoners) {
      const prisoner = agents.find((a) => a.id === id);
      if (prisoner && !prisoner.underground && prisoner.state !== "removed") continue;
      if ([...this.institution.incidents.values()].some((i) => i.category === "missing-person" && i.aggressorId === id && i.state !== "resolved")) continue;
      const incident = this.institution.createIncident("missing-person", id, -1, prisoner?.x ?? 0, prisoner?.z ?? 0, time);
      this.institution.addEvidence(incident.id, "roll-call", -1, id, .95, `Inmate ${id} failed roll call`, time, incident.x, incident.z);
    }
  }

  private cctvObserve(time: number, world: World, agents: readonly Agent[]): void {
    const monitored = agents.some((a) => [Obj.Guard, Obj.Investigator].includes(a.kind as never) &&
      world.roomTypeAt(world.idx(Math.floor(a.x), Math.floor(a.z))) === RoomType.Security);
    if (!monitored || world.tilesOfKind(Obj.MonitorBank).length === 0) return;
    const cameras = world.tilesOfKind(Obj.CCTV);
    for (const engagement of this.combat.engagements.values()) {
      const incident = this.institution.incidents.get(engagement.incidentId);
      if (!incident || incident.evidenceIds.some((id) => this.institution.evidence.get(id)?.sourceType === "camera")) continue;
      const camera = cameras.find((tile) => Math.hypot(tile % world.size + .5 - engagement.x, ((tile / world.size) | 0) + .5 - engagement.z) <= 14);
      if (camera !== undefined) this.institution.addEvidence(incident.id, "camera", camera, incident.aggressorId, .82,
        "Monitored CCTV recorded the disturbance", time, engagement.x, engagement.z, -1,
        "The camera angle may not show who initiated contact");
    }
  }

  private updateDogs(dt: number, time: number, world: World, agents: readonly Agent[]): void {
    const validKennel = [...world.rooms.values()].some((r) => r.valid && r.type === RoomType.Kennel); if (!validKennel) return;
    for (const dog of agents.filter((a) => a.kind === Obj.SecurityDog)) {
      const engagement = this.combat.responseFor(dog); if (!engagement) continue;
      const handler = agents.find((a) => a.kind === Obj.DogHandler && Math.hypot(a.x - dog.x, a.z - dog.z) < 8);
      if (!handler) continue;
      const participant = engagement.participants.map((p) => agents.find((a) => a.id === p.agentId)).find((a): a is Agent => !!a && a.kind === Obj.Prisoner);
      if (!participant) continue;
      const d = Math.hypot(participant.x - dog.x, participant.z - dog.z);
      if (d > 1.3) { dog.x += (participant.x - dog.x) / d * Math.min(d, dt * 3.2); dog.z += (participant.z - dog.z) / d * Math.min(d, dt * 3.2); dog.state = "dogResponse"; }
      else if ((this.dogCooldown.get(dog.id) ?? 0) <= time) {
        this.health.applyInjury(participant, "bite", this.random() < .5 ? "left-leg" : "right-leg", .22 + this.random() * .16, time, dog.id);
        this.dogCooldown.set(dog.id, time + 3);
      }
    }
  }

  private syncArmouries(world: World, time: number): void {
    for (const room of world.rooms.values()) {
      if (!room.valid || room.type !== RoomType.Armoury || this.seededArmouries.has(room.id)) continue;
      this.seededArmouries.add(room.id);
      const tile = [...room.tiles][0], id = `armoury:${room.id}`;
      this.items.ensureContainer({ id, name: `Armoury ${room.id}`, x: tile % world.size + .5, z: ((tile / world.size) | 0) + .5,
        capacity: 120, concealment: .1, bodyCapacity: 0, lockedTier: "guard", ownerId: -1, tags: ["armoury", "controlled"] });
      for (const [defId, count] of [["pepper-spray", 4], ["taser", 4], ["restraints", 8], ["body-armor", 4], ["riot-gear", 4], ["less-lethal-launcher", 2]] as const)
        for (const itemId of this.items.createMany(defId, count, time)) this.items.moveToContainer(itemId, id, time);
    }
  }

  /** Ordinary guards physically collect nonlethal riot equipment. Cancelling
   * the emergency makes them return only the items checked out by this system. */
  private updateEmergencyEquipment(agent: Agent, dt: number, time: number, world: World): boolean {
    const issued = this.emergencyIssue.get(agent.id) ?? [];
    if (this.emergency !== "armed-response") {
      if (!issued.length) return false;
      const armoury = [...this.items.containers.values()].filter((c) => c.tags.includes("armoury"))
        .sort((a, b) => Math.hypot(agent.x - a.x, agent.z - a.z) - Math.hypot(agent.x - b.x, agent.z - b.z))[0];
      if (!armoury) { this.warnings.add("Emergency equipment cannot be returned: no valid Armoury"); return false; }
      const target = world.idx(Math.floor(armoury.x), Math.floor(armoury.z));
      if (Math.hypot(agent.x - armoury.x, agent.z - armoury.z) > 1.5) {
        this.moveToward(agent, target, dt, world, true); agent.state = "returningRiotGear"; return true;
      }
      for (const itemId of issued) {
        this.items.moveToContainer(itemId, armoury.id, time, agent.id);
        const item = this.items.items.get(itemId); if (item) { item.issuedTo = -1; item.ownerId = -1; }
      }
      this.emergencyIssue.delete(agent.id); agent.state = "idle"; return false;
    }
    if (issued.length) return false;
    const armouries = [...this.items.containers.values()].filter((c) => c.tags.includes("armoury") &&
      this.items.itemsIn(c.id).some((i) => ["riot-gear", "body-armor", "less-lethal-launcher", "taser", "pepper-spray"].includes(i.defId)));
    const armoury = armouries.sort((a, b) => Math.hypot(agent.x - a.x, agent.z - a.z) - Math.hypot(agent.x - b.x, agent.z - b.z))[0];
    if (!armoury) { this.warnings.add("Armed Response is short of nonlethal Armoury equipment"); return false; }
    const target = world.idx(Math.floor(armoury.x), Math.floor(armoury.z));
    if (Math.hypot(agent.x - armoury.x, agent.z - armoury.z) > 1.5) {
      this.moveToward(agent, target, dt, world, true); agent.state = "collectingRiotGear"; return true;
    }
    const stock = this.items.itemsIn(armoury.id);
    const picked: number[] = [];
    const armor = stock.find((i) => i.defId === "riot-gear") ?? stock.find((i) => i.defId === "body-armor");
    const weapon = stock.find((i) => i.defId === "less-lethal-launcher") ?? stock.find((i) => i.defId === "taser") ?? stock.find((i) => i.defId === "pepper-spray");
    for (const item of [armor, weapon]) if (item && this.items.moveToContainer(item.id, `agent:${agent.id}:equipment`, time, agent.id)) {
      this.items.issue(item.id, agent.id, time); picked.push(item.id);
    }
    if (picked.length) this.emergencyIssue.set(agent.id, picked);
    else this.warnings.add(`Guard ${agent.id} could not check out emergency equipment`);
    agent.state = "riotReady"; return false;
  }

  private moveToward(agent: Agent, target: number, dt: number, world: World, staff: boolean): boolean {
    if (agent.path && agent.pathI >= agent.path.length) agent.path = null;
    const tx = target % world.size + .5, tz = ((target / world.size) | 0) + .5;
    if (Math.hypot(agent.x - tx, agent.z - tz) < .65) { agent.path = null; return false; }
    const role = accessRoleForAgent(agent);
    const open = (i: number) => passable(world, i, staff, agent.accessKeys) && roleAllowed(world, i, role);
    let navTarget = target;
    if (!open(navTarget)) {
      const x = target % world.size, z = (target / world.size) | 0;
      const adjacent = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => [x + dx, z + dz] as const)
        .filter(([nx, nz]) => world.inBounds(nx, nz)).map(([nx, nz]) => world.idx(nx, nz)).filter(open)
        .sort((a, b) => Math.hypot(a % world.size + .5 - agent.x, ((a / world.size) | 0) + .5 - agent.z) -
          Math.hypot(b % world.size + .5 - agent.x, ((b / world.size) | 0) + .5 - agent.z));
      if (!adjacent.length) return false; navTarget = adjacent[0];
    }
    const navX = navTarget % world.size + .5, navZ = ((navTarget / world.size) | 0) + .5;
    if (Math.hypot(agent.x - navX, agent.z - navZ) < .65) { agent.path = null; return false; }
    if (!agent.path) {
      const start = world.idx(Math.floor(agent.x), Math.floor(agent.z));
      agent.path = astar(world.size, start, navTarget, open, 20000, (a, b) => world.canNavigateEdge(a, b)); agent.pathI = 0;
    }
    if (!agent.path || agent.pathI >= agent.path.length) return false;
    const next = agent.path[agent.pathI], nx = next % world.size + .5, nz = ((next / world.size) | 0) + .5, d = Math.hypot(nx - agent.x, nz - agent.z);
    if (d < .12) agent.pathI++; else { agent.x += (nx - agent.x) / d * Math.min(d, dt * 2.1); agent.z += (nz - agent.z) / d * Math.min(d, dt * 2.1); }
    agent.amp = 1; return true;
  }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}
