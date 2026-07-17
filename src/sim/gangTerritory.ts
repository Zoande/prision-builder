import type { Agent } from "./agent.ts";
import type { AreaSystem } from "./areas.ts";
import type { CombatSystem } from "./combat.ts";
import type { GangSystem } from "./gangs.ts";
import type { InstitutionSystem } from "./institution.ts";
import type { ItemSystem } from "./itemSystem.ts";
import type { MarketSystem } from "./market.ts";
import { Obj } from "./objects.ts";
import { aptitude, personality, skill } from "./profiles.ts";
import type { PrisonerSocialSystem } from "./social.ts";
import type { WorkSystem } from "./work.ts";
import type { World } from "./world.ts";
import { HOUR_SECONDS } from "./time.ts";

export type TerritoryState = "unclaimed" | "influenced" | "controlled" | "contested" | "suppressed";
export type GangRole = "leader" | "lieutenant" | "enforcer" | "quartermaster" | "recruiter" | "lookout" | "runner" | "specialist";
export type RacketType = "protection" | "shop" | "mail" | "substances" | "gambling" | "tools" | "uniforms" | "documents" | "external";
export type GangRelationKind = "neutral" | "rivalry" | "truce" | "trade" | "alliance" | "blood-feud";

export interface TerritoryInfluence {
  areaId: number;
  influence: Record<number, number>;
  controllerId: number;
  state: TerritoryState;
  contestedBy: number;
  suppression: number;
  changedAt: number;
}
export interface GangRoleAssignment { gangId: number; agentId: number; role: GangRole; assignedAt: number; }
export interface GangRacket { id: number; gangId: number; type: RacketType; areaId: number; operatorId: number; heat: number; profit: number; active: boolean; }
export interface GangRelation { a: number; b: number; kind: GangRelationKind; tension: number; trust: number; since: number; }

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

/** Territory is rolling social influence over structural areas. It modifies
 * privacy, trade, and conflict but never creates invisible movement barriers. */
export class GangTerritorySystem {
  readonly territories = new Map<number, TerritoryInfluence>();
  readonly roles = new Map<number, GangRoleAssignment>();
  readonly rackets = new Map<number, GangRacket>();
  readonly relations = new Map<string, GangRelation>();
  readonly warnings = new Set<string>();
  private nextRacketId = 1;
  private scanT = 0;
  private racketT = 0;
  private diplomacyT = 0;
  private lastRevenueHour = -1;
  private rngState = 0x46a923bd;
  private readonly gangs: GangSystem;
  private readonly areas: AreaSystem;
  private readonly work: WorkSystem;
  private readonly items: ItemSystem;
  private readonly market: MarketSystem;
  private readonly combat: CombatSystem;
  private readonly institution: InstitutionSystem;

  constructor(gangs: GangSystem, areas: AreaSystem, work: WorkSystem, items: ItemSystem, market: MarketSystem,
    combat: CombatSystem, institution: InstitutionSystem) {
    this.gangs = gangs; this.areas = areas; this.work = work; this.items = items; this.market = market;
    this.combat = combat; this.institution = institution;
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[], social: PrisonerSocialSystem): void {
    this.warnings.clear(); this.scanT -= dt; this.racketT -= dt; this.diplomacyT -= dt;
    if (this.scanT <= 0) { this.scanT = 4; this.updateInfluence(dt * 4, time, world, agents); this.assignRoles(time, agents); }
    if (this.racketT <= 0) { this.racketT = 9; this.updateRackets(time, agents); this.applyConflicts(time, agents); }
    if (this.diplomacyT <= 0) { this.diplomacyT = HOUR_SECONDS * 3; this.updateDiplomacy(time, social); }
    const hour = Math.floor(time / HOUR_SECONDS);
    if (hour !== this.lastRevenueHour) { this.lastRevenueHour = hour; this.collectRacketRevenue(time, agents); }
    const contested = this.knownTerritories(this.institution).filter((row) => row.state === "contested").length;
    if (contested) this.warnings.add(`${contested} structural area${contested === 1 ? " is" : "s are"} under contested gang influence`);
  }

  territory(areaId: number): TerritoryInfluence | null { return this.territories.get(areaId) ?? null; }
  roleOf(agentId: number): GangRole | null { return this.roles.get(agentId)?.role ?? null; }
  privacyBonus(gangId: number, areaId: number): number {
    const row = this.territories.get(areaId); if (!row) return 0;
    return row.controllerId === gangId ? .22 * (row.influence[gangId] ?? 0) : row.state === "contested" ? -.12 : 0;
  }
  relation(a: number, b: number): GangRelation | null { return this.relations.get(pairKey(a, b)) ?? null; }

  knownTerritories(institution: InstitutionSystem): TerritoryInfluence[] {
    const knownGangSubjects = new Set([...institution.cases.values()].filter((c) => c.status !== "resolved")
      .flatMap((c) => c.incidentIds.map((id) => institution.incidents.get(id)).filter((i) => i?.category === "gang").map((i) => i!.aggressorId)));
    const knownGangIds = new Set([...this.gangs.gangs.values()].filter((gang) => gang.members.some((m) => knownGangSubjects.has(m.agentId))).map((g) => g.id));
    return [...this.territories.values()].filter((row) => knownGangIds.has(row.controllerId) || knownGangIds.has(row.contestedBy));
  }

  saveData() { return {
    territories: [...this.territories.values()].map((row) => ({ ...row, influence: { ...row.influence } })),
    roles: [...this.roles.values()].map((row) => ({ ...row })), rackets: [...this.rackets.values()].map((row) => ({ ...row })),
    relations: [...this.relations.values()].map((row) => ({ ...row })), nextRacketId: this.nextRacketId,
    scanT: this.scanT, racketT: this.racketT, diplomacyT: this.diplomacyT, lastRevenueHour: this.lastRevenueHour, rngState: this.rngState,
  }; }
  loadData(data: Partial<ReturnType<GangTerritorySystem["saveData"]>>): void {
    this.territories.clear(); for (const row of data.territories ?? []) this.territories.set(row.areaId, { ...row, influence: { ...row.influence } });
    this.roles.clear(); for (const row of data.roles ?? []) this.roles.set(row.agentId, { ...row });
    this.rackets.clear(); for (const row of data.rackets ?? []) this.rackets.set(row.id, { ...row });
    this.relations.clear(); for (const row of data.relations ?? []) this.relations.set(pairKey(row.a, row.b), { ...row });
    this.nextRacketId = data.nextRacketId ?? 1; this.scanT = data.scanT ?? 0; this.racketT = data.racketT ?? 0;
    this.diplomacyT = data.diplomacyT ?? 0; this.lastRevenueHour = data.lastRevenueHour ?? -1; this.rngState = data.rngState ?? 0x46a923bd;
  }

  private updateInfluence(dt: number, time: number, world: World, agents: readonly Agent[]): void {
    for (const area of this.areas.areas.values()) {
      let row = this.territories.get(area.id);
      if (!row) this.territories.set(area.id, row = { areaId: area.id, influence: {}, controllerId: -1, state: "unclaimed", contestedBy: -1, suppression: 0, changedAt: time });
      for (const id of Object.keys(row.influence)) row.influence[Number(id)] = Math.max(0, row.influence[Number(id)] - dt * (.002 + row.suppression * .003));
      const occupants = agents.filter((agent) => agent.kind === Obj.Prisoner && this.areas.areaAt[world.idx(Math.floor(agent.x), Math.floor(agent.z))] === area.id);
      for (const occupant of occupants) {
        const gang = this.gangs.gangFor(occupant.id); if (!gang) continue;
        const member = gang.members.find((m) => m.agentId === occupant.id)!;
        const role = this.roles.get(occupant.id)?.role;
        const weight = .0025 + member.loyalty * .002 + (role === "enforcer" || role === "leader" ? .0015 : 0);
        row.influence[gang.id] = clamp((row.influence[gang.id] ?? 0) + dt * weight);
      }
      const guards = agents.filter((agent) => [Obj.Guard, Obj.ArmedGuard, Obj.DogHandler].includes(agent.kind as never) && this.areas.areaAt[world.idx(Math.floor(agent.x), Math.floor(agent.z))] === area.id).length;
      row.suppression = clamp(row.suppression * .96 + Math.min(.5, guards * .04));
      const ranking = Object.entries(row.influence).map(([id, value]) => ({ id: Number(id), value })).sort((a, b) => b.value - a.value || a.id - b.id);
      const first = ranking[0], second = ranking[1]; const old = `${row.controllerId}:${row.state}:${row.contestedBy}`;
      if (!first || first.value < .18) { row.controllerId = -1; row.contestedBy = -1; row.state = row.suppression > .55 ? "suppressed" : "unclaimed"; }
      else if (second && second.value > .24 && first.value - second.value < .14) { row.controllerId = first.id; row.contestedBy = second.id; row.state = "contested"; }
      else if (first.value >= .58 && (!row.controllerId || row.controllerId === first.id || first.value >= .7)) { row.controllerId = first.id; row.contestedBy = -1; row.state = row.suppression > .62 ? "suppressed" : "controlled"; }
      else { row.controllerId = first.id; row.contestedBy = -1; row.state = "influenced"; }
      if (old !== `${row.controllerId}:${row.state}:${row.contestedBy}`) row.changedAt = time;
    }
  }

  private assignRoles(time: number, agents: readonly Agent[]): void {
    for (const gang of this.gangs.gangs.values()) {
      if (gang.state !== "active") continue;
      const members = gang.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a);
      const ranked = (score: (a: Agent) => number) => [...members].sort((a, b) => score(b) - score(a) || a.id - b.id);
      const assigned = new Map<number, GangRole>(); assigned.set(gang.leaderId, "leader");
      const pick = (role: GangRole, score: (a: Agent) => number, count = 1) => {
        for (const a of ranked(score)) if (!assigned.has(a.id) && count-- > 0) assigned.set(a.id, role);
      };
      pick("lieutenant", (a) => aptitude(a.profile, "charisma") + skill(a.profile, "leadership") + personality(a.profile, "loyalty") * 3, Math.max(1, Math.floor(members.length / 8)));
      pick("enforcer", (a) => aptitude(a.profile, "strength") + skill(a.profile, "fighting") + personality(a.profile, "aggression") * 3, Math.max(1, Math.floor(members.length / 7)));
      pick("quartermaster", (a) => skill(a.profile, "smuggling") + aptitude(a.profile, "memory") + personality(a.profile, "conscientiousness") * 2);
      pick("recruiter", (a) => aptitude(a.profile, "charisma") + skill(a.profile, "leadership") + personality(a.profile, "sociability") * 2);
      pick("lookout", (a) => aptitude(a.profile, "perception") + skill(a.profile, "stealth") + aptitude(a.profile, "reflexes"));
      for (const a of members) if (!assigned.has(a.id)) assigned.set(a.id, skill(a.profile, "toolcraft") + skill(a.profile, "digging") > 7 ? "specialist" : "runner");
      for (const [agentId, role] of assigned) {
        const old = this.roles.get(agentId); this.roles.set(agentId, { gangId: gang.id, agentId, role, assignedAt: old?.role === role ? old.assignedAt : time });
      }
    }
  }

  private updateRackets(time: number, agents: readonly Agent[]): void {
    for (const gang of this.gangs.gangs.values()) {
      if (gang.state !== "active") continue;
      const controlled = [...this.territories.values()].filter((row) => row.controllerId === gang.id && ["controlled", "influenced"].includes(row.state));
      const operators = gang.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a);
      for (const territory of controlled) {
        if ([...this.rackets.values()].some((r) => r.gangId === gang.id && r.areaId === territory.areaId && r.active)) continue;
        const operator = operators.find((a) => ["quartermaster", "runner", "specialist"].includes(this.roleOf(a.id) ?? "")); if (!operator) continue;
        const workRoom = [...this.work.workplaces.values()].find((w) => this.areas.areas.get(territory.areaId)?.roomIds.has(w.roomId));
        const type: RacketType = workRoom?.jobId === "mail" ? "mail" : workRoom?.jobId === "shop" ? "shop" :
          workRoom?.jobId === "tailoring" ? "uniforms" : workRoom?.jobId === "printing" || workRoom?.jobId === "records" ? "documents" :
          workRoom && ["metalshop", "maintenance", "greenhouse", "construction"].includes(workRoom.jobId) ? "tools" : "protection";
        const id = this.nextRacketId++; this.rackets.set(id, { id, gangId: gang.id, type, areaId: territory.areaId, operatorId: operator.id, heat: 0, profit: 0, active: true });
      }
    }
    void time;
  }

  private collectRacketRevenue(time: number, agents: readonly Agent[]): void {
    for (const racket of this.rackets.values()) {
      if (!racket.active) continue; const gang = this.gangs.gangs.get(racket.gangId); if (!gang) continue;
      const operator = agents.find((a) => a.id === racket.operatorId); if (!operator) { racket.active = false; continue; }
      if (racket.type === "protection" || racket.type === "gambling") {
        const victim = agents.find((a) => a.kind === Obj.Prisoner && !this.gangs.sameGang(a.id, operator.id) && Math.hypot(a.x - operator.x, a.z - operator.z) < 4);
        if (victim) { const paid = this.market.collectTo(victim.id, gang.treasuryContainer, 1, time); racket.profit += paid; racket.heat = clamp(racket.heat + (paid ? .01 : .03)); }
      } else {
        const workplace = [...this.work.workplaces.values()].find((w) => w.assigned.includes(operator.id));
        const item = workplace && this.items.itemsIn(workplace.outputContainer)[0];
        if (item && this.items.moveToContainer(item.id, gang.treasuryContainer, time, operator.id, true)) {
          racket.profit += Math.max(1, item.denomination || 5); racket.heat = clamp(racket.heat + .025);
        }
      }
      if (racket.heat > .62 && this.random() < .08) {
        const incident = this.institution.createIncident("gang", operator.id, -1, operator.x, operator.z, time);
        this.institution.addEvidence(incident.id, "audit", -1, operator.id, .45 + racket.heat * .35,
          `Repeated stock and payment patterns indicate a possible ${racket.type} racket`, time, operator.x, operator.z, -1,
          "The pattern may reflect ordinary informal trade or workplace shrinkage");
      }
    }
  }

  private applyConflicts(time: number, agents: readonly Agent[]): void {
    for (const territory of this.territories.values()) {
      if (territory.state !== "contested" || territory.controllerId < 0 || territory.contestedBy < 0) continue;
      const relation = this.ensureRelation(territory.controllerId, territory.contestedBy, time); relation.tension = clamp(relation.tension + .025);
      if (relation.kind === "truce" || relation.kind === "alliance" || this.random() > .05 + relation.tension * .08) continue;
      const aGang = this.gangs.gangs.get(territory.controllerId), bGang = this.gangs.gangs.get(territory.contestedBy); if (!aGang || !bGang) continue;
      const a = aGang.members.map((m) => agents.find((x) => x.id === m.agentId)).find((x): x is Agent => !!x && this.areas.areaAt[Math.floor(x.z) * this.areas.areaAt.length ** .5 + Math.floor(x.x)] === territory.areaId);
      const b = bGang.members.map((m) => agents.find((x) => x.id === m.agentId)).find((x): x is Agent => !!x && !!a && Math.hypot(x.x - a.x, x.z - a.z) < 2.5);
      if (a && b && !this.combat.isBusy(a.id) && !this.combat.isBusy(b.id)) this.combat.start(a, b, time);
    }
  }

  private updateDiplomacy(time: number, social: PrisonerSocialSystem): void {
    const active = [...this.gangs.gangs.values()].filter((g) => g.state === "active");
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j], relation = this.ensureRelation(a.id, b.id, time);
      const leaderBond = social.bond(a.leaderId, b.leaderId, false);
      relation.trust = clamp(relation.trust * .95 + (leaderBond?.trust ?? 0) * .05);
      if (relation.tension > .78) relation.kind = "blood-feud";
      else if (relation.tension > .38) relation.kind = "rivalry";
      else if (relation.trust > .68) relation.kind = "alliance";
      else if (relation.trust > .46) relation.kind = "trade";
      else if (relation.kind === "blood-feud" && relation.tension < .25) relation.kind = "truce";
      relation.tension = clamp(relation.tension - .02);
    }
  }

  private ensureRelation(a: number, b: number, time: number): GangRelation {
    const key = pairKey(a, b); let row = this.relations.get(key);
    if (!row) { row = { a: Math.min(a, b), b: Math.max(a, b), kind: "neutral", tension: 0, trust: .1, since: time }; this.relations.set(key, row); }
    return row;
  }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}
