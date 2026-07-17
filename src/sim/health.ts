import { POSE_LIE_FLOOR, POSE_STAND, type Agent } from "./agent.ts";
import { Obj, RoomType } from "./objects.ts";
import type { ItemSystem } from "./itemSystem.ts";
import type { World } from "./world.ts";

export type BodyRegion = "head" | "chest" | "abdomen" | "left-arm" | "right-arm" |
  "left-hand" | "right-hand" | "left-leg" | "right-leg" | "left-foot" | "right-foot";
export type InjuryType = "blunt" | "cut" | "puncture" | "gunshot" | "bite" |
  "irritant" | "shock" | "fracture" | "brain-trauma" | "overdose";

export const BODY_REGIONS: BodyRegion[] = [
  "head", "chest", "abdomen", "left-arm", "right-arm", "left-hand", "right-hand",
  "left-leg", "right-leg", "left-foot", "right-foot",
];

export interface Injury {
  id: number;
  type: InjuryType;
  region: BodyRegion;
  severity: number;
  bleeding: number;
  pain: number;
  infection: number;
  treated: boolean;
  permanentRisk: number;
  causeAgentId: number;
  causeItemId: number;
  time: number;
}

export interface PersistentCondition {
  id: string;
  name: string;
  region: BodyRegion;
  mobility: number;
  manipulation: number;
  perception: number;
  memory: number;
  emotionalRegulation: number;
  recovery: number;
  permanent: boolean;
}

export interface HealthState {
  agentId: number;
  blood: number;
  consciousness: number;
  breathing: number;
  pain: number;
  infection: number;
  intoxication: number;
  overdose: number;
  mobility: number;
  manipulation: number;
  alive: boolean;
  stabilized: boolean;
  admitted: boolean;
  treatmentBed: number;
  injuries: Injury[];
  conditions: PersistentCondition[];
  lastDamageTime: number;
}

export interface BodyRecord {
  agentId: number;
  x: number;
  z: number;
  deathTime: number;
  discovered: boolean;
  hiddenIn: string;
  bloodEvidence: number;
  odor: number;
  morgueSlab: number;
  removed: boolean;
}

export interface TreatmentJob {
  id: number;
  patientId: number;
  priority: number;
  claimedBy: number;
  state: "waiting" | "transported" | "treating" | "stable";
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export class HealthSystem {
  readonly states = new Map<number, HealthState>();
  readonly bodies = new Map<number, BodyRecord>();
  readonly treatmentJobs: TreatmentJob[] = [];
  readonly warnings = new Set<string>();
  private nextInjuryId = 1;
  private nextTreatmentId = 1;
  private lastHearseDay = -1;
  private rngState = 0x9127a33d;

  ensure(agent: Agent): HealthState {
    let state = this.states.get(agent.id);
    if (!state) {
      state = {
        agentId: agent.id, blood: 1, consciousness: 1, breathing: 1, pain: 0,
        infection: 0, intoxication: 0, overdose: 0, mobility: 1, manipulation: 1,
        alive: true, stabilized: true, admitted: false, treatmentBed: -1,
        injuries: [], conditions: [], lastDamageTime: -Infinity,
      };
      this.states.set(agent.id, state);
    }
    return state;
  }

  state(agentId: number): HealthState | null { return this.states.get(agentId) ?? null; }
  isUnavailable(agentId: number): boolean {
    const h = this.states.get(agentId);
    return !!h && (!h.alive || h.consciousness <= .08 || h.admitted);
  }

  requestMedicalCheck(agent: Agent): void {
    const h = this.ensure(agent);
    if (this.treatmentJobs.some((job) => job.patientId === agent.id && job.state !== "stable")) return;
    this.treatmentJobs.push({ id: this.nextTreatmentId++, patientId: agent.id,
      priority: Math.max(.08, this.triageScore(agent, h)), claimedBy: -1, state: "waiting" });
  }

  availableMedicalBed(world: World, patientId: number): number { return this.findFreeMedicalBed(world, [], patientId); }

  admit(patient: Agent, bed: number): boolean {
    const h = this.ensure(patient); if (!h.alive || bed < 0) return false;
    h.admitted = true; h.treatmentBed = bed; patient.path = null; patient.pose = POSE_LIE_FLOOR; patient.state = "inTreatment";
    const job = this.treatmentJobs.find((row) => row.patientId === patient.id && row.state === "waiting");
    if (job) job.state = "transported";
    return true;
  }

  effectiveMobility(agentId: number): number { return this.states.get(agentId)?.mobility ?? 1; }
  effectiveManipulation(agentId: number): number { return this.states.get(agentId)?.manipulation ?? 1; }

  applyInjury(agent: Agent, type: InjuryType, region: BodyRegion, severity: number,
    time: number, causeAgentId = -1, causeItemId = -1): Injury {
    const h = this.ensure(agent);
    const bleedFactor = type === "gunshot" ? .85 : type === "cut" || type === "puncture" || type === "bite" ? .45 : .08;
    const injury: Injury = {
      id: this.nextInjuryId++, type, region, severity: clamp(severity),
      bleeding: clamp(severity * bleedFactor), pain: clamp(severity * (type === "shock" ? .45 : .8)),
      infection: type === "bite" || type === "puncture" ? severity * .1 : 0,
      treated: false, permanentRisk: (region === "head" ? .35 : .1) * severity,
      causeAgentId, causeItemId, time,
    };
    h.injuries.push(injury); h.stabilized = false; h.lastDamageTime = time;
    h.pain = clamp(h.pain + injury.pain * .35);
    if (region === "head") h.consciousness = clamp(h.consciousness - severity * .5);
    if (region === "chest") h.breathing = clamp(h.breathing - severity * .35);
    this.recompute(h);
    if (severity >= .22 && !this.treatmentJobs.some((j) => j.patientId === agent.id && j.state !== "stable")) {
      this.treatmentJobs.push({ id: this.nextTreatmentId++, patientId: agent.id, priority: this.triageScore(agent, h), claimedBy: -1, state: "waiting" });
    }
    return injury;
  }

  applySubstance(agent: Agent, kind: "tobacco" | "alcohol" | "drugs", amount: number, time: number): void {
    const h = this.ensure(agent);
    if (kind === "alcohol") h.intoxication = clamp(h.intoxication + amount * .35);
    if (kind === "drugs") {
      h.intoxication = clamp(h.intoxication + amount * .5);
      h.overdose = clamp(h.overdose + amount * (.15 + this.random() * .25));
      if (h.overdose > .65) this.applyInjury(agent, "overdose", "chest", h.overdose, time);
    }
  }

  tick(dt: number, worldTime: number, world: World, agents: readonly Agent[], items: ItemSystem): void {
    this.warnings.clear();
    for (const agent of agents) {
      const h = this.ensure(agent);
      if (!h.alive) continue;
      let bleed = 0, infection = 0;
      for (const injury of h.injuries) {
        bleed += injury.bleeding * (injury.treated ? .06 : 1);
        infection += injury.infection;
        if (injury.treated) injury.severity = Math.max(0, injury.severity - dt / 1800);
      }
      h.blood = clamp(h.blood - bleed * dt / 220);
      h.infection = clamp(h.infection + infection * dt / 5000 - (h.admitted ? dt / 8000 : 0));
      h.intoxication = clamp(h.intoxication - dt / 420);
      h.overdose = clamp(h.overdose - dt / 900);
      h.consciousness = clamp(h.consciousness + (h.stabilized ? dt / 900 : 0) - (h.blood < .35 ? dt / 180 : 0) - h.overdose * dt / 300);
      if (h.blood <= .02 || h.breathing <= .02 || h.infection >= .995 || h.overdose >= .995) this.kill(agent, worldTime);
      else if (h.consciousness < .12) { agent.pose = POSE_LIE_FLOOR; agent.path = null; agent.state = "incapacitated"; }
      this.recompute(h);
    }
    for (const body of this.bodies.values()) {
      if (body.removed) continue;
      const loot = items.ensureContainer({ id: `body:${body.agentId}:loot`, name: `Body ${body.agentId}`, x: body.x, z: body.z,
        capacity: 30, concealment: body.hiddenIn ? .8 : .2, bodyCapacity: 0, lockedTier: "none", ownerId: body.agentId, tags: ["body", "lootable"] });
      loot.x = body.x; loot.z = body.z;
      for (const suffix of ["hands", "pockets", "worn", "equipment"]) for (const item of [...items.itemsIn(`agent:${body.agentId}:${suffix}`)])
        items.moveToContainer(item.id, loot.id, worldTime, -1, body.hiddenIn !== "");
      body.odor = clamp(body.odor + dt / 600);
      if (body.odor > .35 && body.hiddenIn) this.warnings.add("A concealed body is producing a detectable odor");
    }
    const day = Math.floor(worldTime / (30 * 24));
    const hour = (worldTime / 30) % 24;
    if (hour >= 6 && hour < 7 && day !== this.lastHearseDay) {
      this.lastHearseDay = day;
      for (const body of this.bodies.values()) if (body.morgueSlab >= 0 && !body.removed) {
        body.removed = true;
        const agent = agents.find((a) => a.id === body.agentId);
        if (agent) agent.state = "removed";
      }
    }
    const validInfirmary = [...world.rooms.values()].some((r) => r.valid && r.type === RoomType.Infirmary);
    if (this.treatmentJobs.some((j) => j.state === "waiting") && !validInfirmary) this.warnings.add("Casualties are waiting for a valid Infirmary");
    if (this.treatmentJobs.some((j) => j.state === "waiting") && !agents.some((a) => a.kind === Obj.Doctor)) this.warnings.add("Casualties are waiting for a Doctor");
  }

  updateDoctor(doctor: Agent, dt: number, world: World, agents: readonly Agent[], items: ItemSystem): boolean {
    let job = this.treatmentJobs.find((j) => j.claimedBy === doctor.id && j.state !== "stable");
    if (!job) {
      job = this.treatmentJobs.filter((j) => j.state === "transported" && j.claimedBy < 0)
        .sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
      if (!job) return false;
      job.claimedBy = doctor.id;
    }
    const patient = agents.find((a) => a.id === job!.patientId), h = patient && this.states.get(patient.id);
    if (!patient || !h || !h.alive) { job.state = "stable"; return false; }
    const bed = this.findFreeMedicalBed(world, agents, patient.id);
    if (bed < 0) { doctor.state = "doctorWaiting"; return true; }
    if (!h.admitted) { doctor.state = "waitingForPatientTransport"; job.claimedBy = -1; return true; }
    const dx = patient.x - doctor.x, dz = patient.z - doctor.z;
    if (Math.hypot(dx, dz) > 1.7) {
      doctor.x += Math.sign(dx) * Math.min(Math.abs(dx), dt * 2.2);
      doctor.z += Math.sign(dz) * Math.min(Math.abs(dz), dt * 2.2);
      doctor.heading = Math.atan2(dz, dx); doctor.state = "toPatient";
      return true;
    }
    doctor.state = "treating"; doctor.pose = POSE_STAND; doctor.amp = .4;
    doctor.timer -= dt;
    if (doctor.timer > 0) return true;
    doctor.timer = 8;
    const untreated = h.injuries.find((i) => !i.treated);
    if (untreated) {
      const bandage = [...items.items.values()].find((i) => i.defId === "bandage" && i.locationKind !== "destroyed");
      if (!bandage) { this.warnings.add("Treatment is blocked by missing bandages"); return true; }
      items.destroy(bandage.id, 0, doctor.id, "medical-use");
      untreated.treated = true; untreated.bleeding *= .08; untreated.infection *= .35;
      h.stabilized = h.injuries.every((i) => i.treated);
      this.maybeCondition(h, untreated);
      return true;
    }
    h.stabilized = true; h.admitted = false; h.treatmentBed = -1;
    h.consciousness = Math.max(.35, h.consciousness); patient.pose = POSE_STAND; patient.state = "idle";
    job.state = "stable"; doctor.state = "idle"; doctor.amp = 0;
    return true;
  }

  hideBody(agentId: number, containerId: string): boolean {
    const body = this.bodies.get(agentId);
    if (!body || body.removed) return false;
    body.hiddenIn = containerId;
    return true;
  }

  discoverBody(agentId: number): boolean {
    const body = this.bodies.get(agentId);
    if (!body || body.removed) return false;
    body.discovered = true; body.hiddenIn = "";
    return true;
  }

  saveData() {
    return {
      states: [...this.states.values()].map((h) => ({ ...h, injuries: h.injuries.map((i) => ({ ...i })), conditions: h.conditions.map((c) => ({ ...c })) })),
      bodies: [...this.bodies.values()].map((b) => ({ ...b })), treatmentJobs: this.treatmentJobs.map((j) => ({ ...j, claimedBy: -1 })),
      nextInjuryId: this.nextInjuryId, nextTreatmentId: this.nextTreatmentId, lastHearseDay: this.lastHearseDay, rngState: this.rngState,
    };
  }

  loadData(data: Partial<ReturnType<HealthSystem["saveData"]>>): void {
    this.states.clear(); for (const h of data.states ?? []) this.states.set(h.agentId, { ...h, injuries: h.injuries.map((i) => ({ ...i })), conditions: h.conditions.map((c) => ({ ...c })) });
    this.bodies.clear(); for (const b of data.bodies ?? []) this.bodies.set(b.agentId, { ...b });
    this.treatmentJobs.length = 0; this.treatmentJobs.push(...(data.treatmentJobs ?? []).map((j) => ({ ...j, claimedBy: -1 })));
    this.nextInjuryId = data.nextInjuryId ?? 1; this.nextTreatmentId = data.nextTreatmentId ?? 1;
    this.lastHearseDay = data.lastHearseDay ?? -1; this.rngState = data.rngState ?? 0x9127a33d;
  }

  private kill(agent: Agent, time: number): void {
    const h = this.ensure(agent); if (!h.alive) return;
    h.alive = false; h.consciousness = 0; agent.pose = POSE_LIE_FLOOR; agent.path = null; agent.state = "dead";
    this.bodies.set(agent.id, { agentId: agent.id, x: agent.x, z: agent.z, deathTime: time, discovered: false, hiddenIn: "", bloodEvidence: 1 - h.blood, odor: 0, morgueSlab: -1, removed: false });
  }

  private triageScore(agent: Agent, h: HealthState): number {
    const life = (1 - h.blood) * 3 + (1 - h.breathing) * 3 + (1 - h.consciousness) * 2 + h.overdose * 3;
    const staff = agent.kind === Obj.Prisoner ? 0 : 1;
    return life >= 3 ? 100 + life : staff * 10 + life + h.pain;
  }

  private recompute(h: HealthState): void {
    let leg = 0, arm = 0, pain = 0;
    for (const i of h.injuries) {
      pain += i.pain * (i.treated ? .35 : 1);
      if (i.region.includes("leg") || i.region.includes("foot")) leg += i.severity;
      if (i.region.includes("arm") || i.region.includes("hand")) arm += i.severity;
    }
    for (const c of h.conditions) { leg += 1 - c.mobility; arm += 1 - c.manipulation; }
    h.pain = clamp(pain / 2); h.mobility = clamp(1 - leg * .28); h.manipulation = clamp(1 - arm * .3);
  }

  private maybeCondition(h: HealthState, injury: Injury): void {
    if (injury.severity < .55 || this.random() > injury.permanentRisk) return;
    const brain = injury.region === "head";
    h.conditions.push({
      id: `${brain ? "brain" : "impairment"}:${injury.id}`,
      name: brain ? "Traumatic brain injury" : `Lasting ${injury.region} impairment`, region: injury.region,
      mobility: injury.region.includes("leg") || injury.region.includes("foot") ? .55 : 1,
      manipulation: injury.region.includes("arm") || injury.region.includes("hand") ? .55 : 1,
      perception: brain ? .75 : 1, memory: brain ? .7 : 1, emotionalRegulation: brain ? .65 : 1,
      recovery: brain ? .08 : .35, permanent: this.random() < (brain ? .7 : .35),
    });
  }

  private findFreeMedicalBed(world: World, agents: readonly Agent[], patientId: number): number {
    for (const tile of world.tilesOfKind(Obj.MedicalBed)) {
      if (world.roomTypeAt(tile) !== RoomType.Infirmary) continue;
      if (![...this.states.values()].some((h) => h.agentId !== patientId && h.admitted && h.treatmentBed === tile)) return tile;
    }
    void agents; return -1;
  }

  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}
