import type { Agent } from "./agent.ts";
import { Obj } from "./objects.ts";
import { itemDefV4 } from "./itemSystem.ts";

export type EvidenceThreshold = "suspected" | "probable" | "confirmed";
export type IncidentCategory = "unauthorized" | "refusal" | "theft" | "extortion" | "missing-stock" |
  "tool" | "radio" | "substance" | "weapon" | "firearm" | "assault-inmate" | "assault-staff" |
  "homicide" | "body-concealment" | "gang" | "escape" | "tunnel" | "sabotage" | "mail" | "missing-person";
export type ForceLevel = "order" | "restraint" | "baton" | "spray" | "taser" | "dog" | "riot" | "less-lethal" | "lethal";

export function incidentCategoryForItem(defId: string): IncidentCategory {
  const def = itemDefV4(defId);
  if (defId === "radio") return "radio";
  if (def.tags.includes("firearm") || def.tags.includes("ammunition")) return "firearm";
  if (def.tags.includes("substance") || def.tags.includes("drug")) return "substance";
  if (def.tags.some((tag) => ["cut-tool", "dig-tool", "escape-tool", "work-tool", "key"].includes(tag))) return "tool";
  if (def.weapon || def.tags.includes("weapon")) return "weapon";
  return "missing-stock";
}

export interface Evidence {
  id: number;
  incidentId: number;
  sourceType: "guard" | "camera" | "dog" | "search" | "audit" | "medical" | "roll-call" | "informant" | "mail" | "witness";
  sourceId: number;
  subjectId: number;
  itemId: number;
  x: number;
  z: number;
  time: number;
  confidence: number;
  summary: string;
  alternative: string;
  shared: boolean;
}

export interface Incident {
  id: number;
  category: IncidentCategory;
  itemDefId: string;
  aggressorId: number;
  victimId: number;
  x: number;
  z: number;
  time: number;
  state: "unreported" | "reported" | "responding" | "resolved";
  evidenceIds: number[];
  caseId: number;
}

export interface IntelligenceCase {
  id: number;
  title: string;
  incidentIds: number[];
  subjectIds: number[];
  evidenceIds: number[];
  confidence: number;
  explanation: string[];
  alternatives: string[];
  status: "open" | "watching" | "actioned" | "resolved";
  createdAt: number;
}

export interface PolicyRule {
  category: IncidentCategory;
  itemDefId: string;
  threshold: EvidenceThreshold;
  force: ForceLevel;
  confiscate: boolean;
  medicalCheck: boolean;
  search: "none" | "person" | "cell" | "workplace" | "targeted" | "full";
  interrogate: boolean;
  solitaryHours: number;
  custodyUp: boolean;
  protectiveOffer: boolean;
}

export interface PunishmentOrder {
  incidentId: number;
  prisonerId: number;
  solitaryUntil: number;
  custodyUp: boolean;
  search: PolicyRule["search"];
  interrogate: boolean;
  state: "queued" | "active" | "complete" | "cancelled";
  solitaryRoomId?: number;
  released?: boolean;
}

const DEFAULT_RULES: PolicyRule[] = [
  rule("unauthorized", "probable", "order", "none", 0),
  rule("refusal", "confirmed", "restraint", "none", 0),
  rule("theft", "probable", "restraint", "cell", 4),
  rule("extortion", "probable", "restraint", "targeted", 12, true),
  rule("missing-stock", "suspected", "order", "targeted", 0),
  rule("tool", "probable", "restraint", "cell", 8, true),
  rule("radio", "probable", "restraint", "targeted", 8, true),
  rule("substance", "confirmed", "restraint", "cell", 6, true, false, true),
  rule("weapon", "probable", "taser", "targeted", 24, true, true),
  rule("firearm", "suspected", "lethal", "full", 72, true, true),
  rule("assault-inmate", "confirmed", "taser", "person", 12, false, true),
  rule("assault-staff", "probable", "riot", "targeted", 24, true, true),
  rule("homicide", "probable", "lethal", "full", 72, true, true),
  rule("body-concealment", "probable", "riot", "full", 72, true, true),
  rule("gang", "probable", "restraint", "targeted", 12, true),
  rule("escape", "probable", "less-lethal", "targeted", 48, true, true),
  rule("tunnel", "probable", "restraint", "full", 48, true, true),
  rule("sabotage", "confirmed", "restraint", "workplace", 12, true),
  rule("mail", "confirmed", "restraint", "cell", 4, true),
  rule("missing-person", "suspected", "riot", "full", 0),
];

function rule(category: IncidentCategory, threshold: EvidenceThreshold, force: ForceLevel,
  search: PolicyRule["search"], solitaryHours: number, interrogate = false,
  custodyUp = false, medicalCheck = false): PolicyRule {
  return { category, itemDefId: "", threshold, force, confiscate: category !== "missing-person", medicalCheck,
    search, interrogate, solitaryHours, custodyUp, protectiveOffer: false };
}

export class InstitutionSystem {
  readonly incidents = new Map<number, Incident>();
  readonly evidence = new Map<number, Evidence>();
  readonly cases = new Map<number, IntelligenceCase>();
  readonly rules: PolicyRule[] = DEFAULT_RULES.map((r) => ({ ...r }));
  readonly punishments: PunishmentOrder[] = [];
  readonly pendingReports: number[] = [];
  readonly informants = new Map<number, { reliability: number; exposed: number; protective: boolean }>();
  private nextIncidentId = 1;
  private nextEvidenceId = 1;
  private nextCaseId = 1;

  createIncident(category: IncidentCategory, aggressorId: number, victimId: number,
    x: number, z: number, time: number, itemDefId = ""): Incident {
    const id = this.nextIncidentId++;
    const incident: Incident = { id, category, itemDefId, aggressorId, victimId, x, z, time, state: "unreported", evidenceIds: [], caseId: -1 };
    this.incidents.set(id, incident);
    return incident;
  }

  addEvidence(incidentId: number, sourceType: Evidence["sourceType"], sourceId: number,
    subjectId: number, confidence: number, summary: string, time: number, x: number, z: number,
    itemId = -1, alternative = "Observation may have an innocent explanation"): Evidence {
    const incident = this.incidents.get(incidentId);
    if (!incident) throw new Error(`Unknown incident ${incidentId}`);
    const id = this.nextEvidenceId++;
    const row: Evidence = { id, incidentId, sourceType, sourceId, subjectId, itemId, x, z, time,
      confidence: Math.max(0, Math.min(1, confidence)), summary, alternative, shared: false };
    this.evidence.set(id, row); incident.evidenceIds.push(id);
    if (sourceType === "guard" && confidence >= .75) { row.shared = true; incident.state = "reported"; this.openCase(incident); }
    else this.pendingReports.push(id);
    return row;
  }

  shareRoutineReports(time: number): void {
    for (const id of this.pendingReports.splice(0)) {
      const row = this.evidence.get(id); if (!row) continue;
      row.shared = true;
      const incident = this.incidents.get(row.incidentId);
      if (incident) { incident.state = "reported"; this.openCase(incident); }
    }
    this.evaluatePolicies(time);
  }

  ruleFor(category: IncidentCategory, itemDefId = ""): PolicyRule {
    return this.rules.find((r) => r.category === category && r.itemDefId === itemDefId)
      ?? this.rules.find((r) => r.category === category && !r.itemDefId)
      ?? rule(category, "confirmed", "restraint", "none", 0);
  }

  setItemOverride(category: IncidentCategory, itemDefId: string, patch: Partial<PolicyRule>): void {
    let row = this.rules.find((r) => r.category === category && r.itemDefId === itemDefId);
    if (!row) { row = { ...this.ruleFor(category), itemDefId }; this.rules.push(row); }
    Object.assign(row, patch, { category, itemDefId });
  }

  confidenceFor(incident: Incident): number {
    let miss = 1;
    for (const id of incident.evidenceIds) {
      const e = this.evidence.get(id);
      if (e?.shared) miss *= 1 - e.confidence;
    }
    return 1 - miss;
  }

  tick(worldTime: number, agents: readonly Agent[]): void {
    if (Math.floor(worldTime * 2) % 30 === 0 && this.pendingReports.length) this.shareRoutineReports(worldTime);
    for (const order of this.punishments) {
      if (order.state === "cancelled" || order.state === "complete") continue;
      const p = agents.find((a) => a.id === order.prisonerId);
      if (!p) { order.state = "cancelled"; continue; }
      if (order.state === "active" && order.solitaryUntil > worldTime) { p.state = "solitary"; p.path = null; }
      else if (order.state === "active") { order.state = "complete"; p.state = "idle"; }
    }
  }

  recruitInformant(agentId: number, reliability: number, protective = false): void {
    this.informants.set(agentId, { reliability: Math.max(.05, Math.min(.98, reliability)), exposed: 0, protective });
  }

  knownAssessment(agentId: number): { cases: number; confidence: number; summaries: string[] } {
    const rows = [...this.cases.values()].filter((c) => c.subjectIds.includes(agentId) && c.status !== "resolved");
    return { cases: rows.length, confidence: rows.reduce((m, c) => Math.max(m, c.confidence), 0), summaries: rows.flatMap((c) => c.explanation) };
  }

  saveData() {
    return {
      incidents: [...this.incidents.values()].map((i) => ({ ...i, evidenceIds: [...i.evidenceIds] })),
      evidence: [...this.evidence.values()].map((e) => ({ ...e })),
      cases: [...this.cases.values()].map((c) => ({ ...c, incidentIds: [...c.incidentIds], subjectIds: [...c.subjectIds], evidenceIds: [...c.evidenceIds], explanation: [...c.explanation], alternatives: [...c.alternatives] })),
      rules: this.rules.map((r) => ({ ...r })), punishments: this.punishments.map((p) => ({ ...p })),
      pendingReports: [...this.pendingReports], informants: [...this.informants],
      nextIncidentId: this.nextIncidentId, nextEvidenceId: this.nextEvidenceId, nextCaseId: this.nextCaseId,
    };
  }

  loadData(data: Partial<ReturnType<InstitutionSystem["saveData"]>>): void {
    this.incidents.clear(); for (const i of data.incidents ?? []) this.incidents.set(i.id, { ...i, evidenceIds: [...i.evidenceIds] });
    this.evidence.clear(); for (const e of data.evidence ?? []) this.evidence.set(e.id, { ...e });
    this.cases.clear(); for (const c of data.cases ?? []) this.cases.set(c.id, { ...c, incidentIds: [...c.incidentIds], subjectIds: [...c.subjectIds], evidenceIds: [...c.evidenceIds], explanation: [...c.explanation], alternatives: [...c.alternatives] });
    this.rules.length = 0; this.rules.push(...(data.rules ?? DEFAULT_RULES).map((r) => ({ ...r })));
    this.punishments.length = 0; this.punishments.push(...(data.punishments ?? []).map((p) => ({ ...p })));
    this.pendingReports.length = 0; this.pendingReports.push(...(data.pendingReports ?? []));
    this.informants.clear(); for (const [id, row] of data.informants ?? []) this.informants.set(id, { ...row });
    this.nextIncidentId = data.nextIncidentId ?? 1; this.nextEvidenceId = data.nextEvidenceId ?? 1; this.nextCaseId = data.nextCaseId ?? 1;
  }

  private openCase(incident: Incident): void {
    if (incident.caseId >= 0) {
      const c = this.cases.get(incident.caseId); if (c) {
        c.confidence = this.confidenceFor(incident);
        for (const evidenceId of incident.evidenceIds) {
          const evidence = this.evidence.get(evidenceId); if (!evidence?.shared || c.evidenceIds.includes(evidenceId)) continue;
          c.evidenceIds.push(evidenceId); c.explanation.push(evidence.summary); c.alternatives.push(evidence.alternative);
        }
      }
      return;
    }
    const id = this.nextCaseId++;
    const evidence = incident.evidenceIds.map((e) => this.evidence.get(e)).filter((e): e is Evidence => !!e && e.shared);
    const subjects = [...new Set([incident.aggressorId, incident.victimId].filter((x) => x >= 0))];
    const c: IntelligenceCase = {
      id, title: this.titleFor(incident), incidentIds: [incident.id], subjectIds: subjects,
      evidenceIds: evidence.map((e) => e.id), confidence: this.confidenceFor(incident),
      explanation: evidence.map((e) => e.summary), alternatives: evidence.map((e) => e.alternative),
      status: "open", createdAt: incident.time,
    };
    this.cases.set(id, c); incident.caseId = id;
  }

  private evaluatePolicies(time: number): void {
    for (const incident of this.incidents.values()) {
      if (incident.state !== "reported" || incident.aggressorId < 0) continue;
      const rule = this.ruleFor(incident.category, incident.itemDefId), confidence = this.confidenceFor(incident);
      const threshold = rule.threshold === "suspected" ? .25 : rule.threshold === "probable" ? .6 : .9;
      if (confidence < threshold || this.punishments.some((p) => p.incidentId === incident.id)) continue;
      this.punishments.push({ incidentId: incident.id, prisonerId: incident.aggressorId,
        solitaryUntil: time + rule.solitaryHours * 30, custodyUp: rule.custodyUp,
        search: rule.search, interrogate: rule.interrogate, state: "queued" });
      incident.state = "responding";
      const c = this.cases.get(incident.caseId); if (c) c.status = "actioned";
    }
  }

  private titleFor(incident: Incident): string {
    const names: Partial<Record<IncidentCategory, string>> = {
      "missing-stock": "Controlled stock discrepancy", "missing-person": "Missing person",
      "assault-inmate": "Inmate assault", "assault-staff": "Staff assault",
      "body-concealment": "Concealed body", firearm: "Firearm incident",
    };
    return names[incident.category] ?? incident.category.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

export function isStaff(agent: Agent): boolean { return agent.kind !== Obj.Prisoner && agent.kind !== Obj.SecurityDog; }
