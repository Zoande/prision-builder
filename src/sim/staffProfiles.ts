import type { Agent } from "./agent.ts";
import type { AreaSystem } from "./areas.ts";
import type { InstitutionSystem } from "./institution.ts";
import type { ItemSystem } from "./itemSystem.ts";
import type { MarketSystem } from "./market.ts";
import { Obj } from "./objects.ts";

export type CorruptionAction = "warn-audit" | "skip-count" | "ignore-access" | "leak-schedule" |
  "alter-manifest" | "disable-device" | "misfile-evidence" | "leave-tool" | "approve-visitor";

export interface StaffProfile {
  agentId: number;
  firstName: string;
  lastName: string;
  experience: number;
  vigilance: number;
  integrity: number;
  nerve: number;
  familiarity: Record<number, number>;
  compromisedBy: number;
  compromiseKind: "" | "bribe" | "blackmail";
  compromisedUntil: number;
  permittedActions: CorruptionAction[];
  received: number;
  exposure: number;
  lastWarningAt: number;
}

const FIRST = ["Adrian", "Bernard", "Caleb", "Darius", "Elias", "Frank", "Gavin", "Hector", "Isaac", "Jonah", "Leon", "Marcus", "Nolan", "Owen", "Peter", "Quentin", "Rafael", "Simon", "Tobias", "Victor"];
const LAST = ["Archer", "Bennett", "Cole", "Dawson", "Ellis", "Foster", "Grant", "Hayes", "Irwin", "Keller", "Morris", "Nash", "Ortiz", "Price", "Reed", "Shaw", "Turner", "Vance", "Webb", "Young"];
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Staff corruption is persistent, personal, and evidence-producing. A bribe
 * buys a narrow behavior for a limited time; it never flips an employee into
 * an omnipotent accomplice. */
export class StaffProfileSystem {
  readonly profiles = new Map<number, StaffProfile>();
  private readonly items: ItemSystem;
  private readonly market: MarketSystem;
  private readonly institution: InstitutionSystem;

  constructor(items: ItemSystem, market: MarketSystem, institution: InstitutionSystem) {
    this.items = items; this.market = market; this.institution = institution;
  }

  ensure(agent: Agent): StaffProfile | null {
    if (agent.kind === Obj.Prisoner || agent.kind === Obj.SecurityDog) return null;
    let profile = this.profiles.get(agent.id);
    if (profile) return profile;
    let state = (agent.id * 0x9e3779b1 + agent.kind * 0x85ebca6b) >>> 0;
    const rnd = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
    profile = {
      agentId: agent.id, firstName: FIRST[(rnd() * FIRST.length) | 0], lastName: LAST[(rnd() * LAST.length) | 0],
      experience: .2 + rnd() * .75, vigilance: .25 + rnd() * .7, integrity: .28 + rnd() * .7,
      nerve: .2 + rnd() * .75, familiarity: {}, compromisedBy: -1, compromiseKind: "",
      compromisedUntil: -1, permittedActions: [], received: 0, exposure: 0, lastWarningAt: -1,
    };
    this.profiles.set(agent.id, profile);
    return profile;
  }

  tick(dt: number, time: number, areas: AreaSystem, agents: readonly Agent[]): void {
    const living = new Set(agents.map((agent) => agent.id));
    for (const agent of agents) {
      const profile = this.ensure(agent); if (!profile) continue;
      const tile = Math.floor(agent.z) * areas.areaAt.length ** .5 + Math.floor(agent.x);
      const areaId = Number.isFinite(tile) && tile >= 0 && tile < areas.areaAt.length ? areas.areaAt[tile] : 0;
      if (areaId > 0) profile.familiarity[areaId] = clamp((profile.familiarity[areaId] ?? 0) + dt * .0025);
      if (profile.compromisedUntil < time) {
        profile.compromisedBy = -1; profile.compromiseKind = ""; profile.permittedActions.length = 0;
      }
      profile.exposure = Math.max(0, profile.exposure - dt * .00004);
    }
    for (const id of [...this.profiles.keys()]) if (!living.has(id)) this.profiles.delete(id);
  }

  attemptCompromise(prisoner: Agent, staff: Agent, time: number, amount: number,
    action: CorruptionAction, leverage = 0): boolean {
    const profile = this.ensure(staff); if (!profile || (amount <= 0 && leverage <= 0)) return false;
    const containerId = `staff:${staff.id}:illicit`;
    this.items.ensureContainer({ id: containerId, name: `${profile.firstName} ${profile.lastName} private effects`,
      x: staff.x, z: staff.z, capacity: 20, concealment: .92, bodyCapacity: 0, lockedTier: "none",
      ownerId: staff.id, tags: ["staff", "cash", "corruption"] });
    const paid = amount > 0 ? this.market.collectTo(prisoner.id, containerId, amount, time) : 0;
    const pressure = paid / 35 + leverage * 1.4 + (1 - profile.integrity) * .9 - profile.nerve * .15;
    if (pressure < .48) {
      profile.exposure = clamp(profile.exposure + .08);
      if (profile.integrity > .68) this.reportApproach(prisoner, staff, time, paid);
      return false;
    }
    profile.compromisedBy = prisoner.id;
    profile.compromiseKind = leverage > .35 ? "blackmail" : "bribe";
    profile.compromisedUntil = Math.max(profile.compromisedUntil, time + 30 * (4 + Math.min(20, paid / 4 + leverage * 10)));
    if (!profile.permittedActions.includes(action)) profile.permittedActions.push(action);
    profile.received += paid;
    profile.exposure = clamp(profile.exposure + .06 + paid / 500);
    return true;
  }

  permits(staffId: number, beneficiaryId: number, action: CorruptionAction, time: number): boolean {
    const profile = this.profiles.get(staffId);
    return !!profile && profile.compromisedUntil >= time && profile.compromisedBy === beneficiaryId && profile.permittedActions.includes(action);
  }

  warn(staffId: number, beneficiaryId: number, time: number): boolean {
    const profile = this.profiles.get(staffId);
    if (!profile || profile.compromisedUntil < time || profile.compromisedBy !== beneficiaryId || !profile.permittedActions.includes("warn-audit")) return false;
    profile.lastWarningAt = time; profile.exposure = clamp(profile.exposure + .015); return true;
  }

  familiarity(staffId: number, areaId: number): number { return this.profiles.get(staffId)?.familiarity[areaId] ?? 0; }

  leverageAgainst(staffId: number): number {
    const profile = this.profiles.get(staffId); if (!profile) return 0;
    const sourced = [...this.institution.evidence.values()].filter((e) => e.shared && e.subjectId === staffId)
      .reduce((best, evidence) => Math.max(best, evidence.confidence), 0);
    return clamp(profile.exposure * .7 + sourced * .65);
  }

  saveData() { return { profiles: [...this.profiles.values()].map((p) => ({ ...p, familiarity: { ...p.familiarity }, permittedActions: [...p.permittedActions] })) }; }
  loadData(data: Partial<ReturnType<StaffProfileSystem["saveData"]>>): void {
    this.profiles.clear();
    for (const p of data.profiles ?? []) this.profiles.set(p.agentId, { ...p, familiarity: { ...p.familiarity }, permittedActions: [...p.permittedActions] });
  }

  private reportApproach(prisoner: Agent, staff: Agent, time: number, amount: number): void {
    const incident = this.institution.createIncident("corruption", prisoner.id, staff.id, staff.x, staff.z, time);
    this.institution.addEvidence(incident.id, "witness", staff.id, prisoner.id, .82,
      `Staff member reports an attempted ${amount > 0 ? `$${amount} bribe` : "coercive approach"}`, time, staff.x, staff.z, -1,
      "The exchange may have been misunderstood or involved a legitimate payment");
  }
}
