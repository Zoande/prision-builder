import type { Agent } from "./agent.ts";
import type { CombatSystem } from "./combat.ts";
import type { HealthSystem } from "./health.ts";
import type { InstitutionSystem } from "./institution.ts";
import type { ItemSystem } from "./itemSystem.ts";
import type { MarketSystem } from "./market.ts";
import { Obj } from "./objects.ts";
import { aptitude, personality, skill } from "./profiles.ts";
import type { PrisonerSocialSystem } from "./social.ts";
import { HOUR_SECONDS } from "./time.ts";

export interface GangMember { agentId: number; joinedAt: number; loyalty: number; duesMissed: number; }
export interface Gang { id: number; name: string; color: string; leaderId: number; members: GangMember[]; cohesion: number; formedAt: number; treasuryContainer: string; retaliation: { targetId: number; expiresAt: number; reason: string }[]; state: "active" | "splitting" | "dissolved"; }

const NAMES_A = ["Iron", "North", "Silent", "Black", "Ash", "Stone", "Red", "Last"];
const NAMES_B = ["Circle", "Hands", "Brothers", "Line", "Crew", "Union", "Watch", "Dogs"];
const COLORS = ["#8e4a45", "#516f8a", "#687c45", "#876d3f", "#6d557f", "#527b73"];

export class GangSystem {
  readonly gangs = new Map<number, Gang>();
  readonly candidateSince = new Map<string, number>();
  readonly warnings = new Set<string>();
  private nextGangId = 1; private scanTimer = 0; private lastDuesDay = -1; private rngState = 0x7325ca19;
  private readonly items: ItemSystem;
  private readonly market: MarketSystem;
  private readonly combat: CombatSystem;
  private readonly health: HealthSystem;
  private readonly institution: InstitutionSystem;

  constructor(items: ItemSystem, market: MarketSystem, combat: CombatSystem, health: HealthSystem,
    institution: InstitutionSystem) {
    this.items = items; this.market = market; this.combat = combat; this.health = health; this.institution = institution;
  }

  gangFor(agentId: number): Gang | null { return [...this.gangs.values()].find((g) => g.state === "active" && g.members.some((m) => m.agentId === agentId)) ?? null; }
  sameGang(a: number, b: number): boolean { const g = this.gangFor(a); return !!g && g.members.some((m) => m.agentId === b); }

  tick(dt: number, time: number, agents: readonly Agent[], social: PrisonerSocialSystem): void {
    this.warnings.clear(); this.scanTimer -= dt;
    if (this.scanTimer <= 0) { this.scanTimer = 6; this.formation(time, agents, social); this.recruit(time, agents, social); this.retaliate(time, agents); }
    this.defend(time, agents);
    const day = Math.floor(time / (HOUR_SECONDS * 24)), hour = (time / HOUR_SECONDS) % 24;
    if (hour >= 18 && day !== this.lastDuesDay) { this.lastDuesDay = day; this.collectDues(time, agents); }
    for (const gang of this.gangs.values()) {
      if (gang.state !== "active") continue;
      gang.members = gang.members.filter((m) => agents.some((a) => a.id === m.agentId && this.health.state(a.id)?.alive !== false));
      if (gang.members.length < 3) { gang.state = "dissolved"; continue; }
      if (!gang.members.some((m) => m.agentId === gang.leaderId)) gang.leaderId = this.chooseLeader(gang.members, agents);
      gang.cohesion = this.cohesion(gang, social);
      if (gang.cohesion < .16 && gang.members.length >= 6) this.split(gang, time, agents);
      gang.retaliation = gang.retaliation.filter((r) => r.expiresAt > time);
    }
    const evidencedSubjects = new Set([...this.institution.cases.values()].filter((c) => c.status !== "resolved")
      .flatMap((c) => c.incidentIds.map((id) => this.institution.incidents.get(id)).filter((incident) => incident?.category === "gang").map((incident) => incident!.aggressorId)));
    const known = [...this.gangs.values()].filter((gang) => gang.state === "active" && gang.members.some((member) => evidencedSubjects.has(member.agentId))).length;
    if (known > 0) this.warnings.add(`Staff intelligence indicates ${known} active inmate gang${known === 1 ? "" : "s"}; unidentified members remain uncertain`);
  }

  saveData() { return { gangs: [...this.gangs.values()].map((g) => ({ ...g, members: g.members.map((m) => ({ ...m })), retaliation: g.retaliation.map((r) => ({ ...r })) })),
    candidateSince: [...this.candidateSince], nextGangId: this.nextGangId, lastDuesDay: this.lastDuesDay, rngState: this.rngState }; }
  loadData(data: Partial<ReturnType<GangSystem["saveData"]>>): void {
    this.gangs.clear(); for (const g of data.gangs ?? []) this.gangs.set(g.id, { ...g, members: g.members.map((m) => ({ ...m })), retaliation: g.retaliation.map((r) => ({ ...r })) });
    this.candidateSince.clear(); for (const [k, t] of data.candidateSince ?? []) this.candidateSince.set(k, t);
    this.nextGangId = data.nextGangId ?? 1; this.lastDuesDay = data.lastDuesDay ?? -1; this.rngState = data.rngState ?? 0x7325ca19;
  }

  private formation(time: number, agents: readonly Agent[], social: PrisonerSocialSystem): void {
    for (const clique of social.cliques.values()) {
      const ids = clique.members.filter((id) => !this.gangFor(id) && agents.some((a) => a.id === id)).sort((a, b) => a - b);
      if (ids.length < 3 || clique.cohesion < .32) continue;
      const key = ids.join(":"); const since = this.candidateSince.get(key) ?? time; this.candidateSince.set(key, since);
      if (time - since < HOUR_SECONDS * 48) continue;
      this.createGang(ids, time, agents); this.candidateSince.delete(key);
    }
  }

  private createGang(ids: number[], time: number, agents: readonly Agent[]): Gang {
    const id = this.nextGangId++, treasuryContainer = `gang:${id}:treasury`;
    const leaderId = this.chooseLeader(ids.map((agentId) => ({ agentId, joinedAt: time, loyalty: .55, duesMissed: 0 })), agents);
    const leader = agents.find((a) => a.id === leaderId);
    this.items.ensureContainer({ id: treasuryContainer, name: `Gang ${id} treasury`, x: leader?.x ?? 0, z: leader?.z ?? 0,
      capacity: 100, concealment: .92, bodyCapacity: 0, lockedTier: "none", ownerId: leaderId, tags: ["gang", "hiding-place", "cash"] });
    const gang: Gang = { id, name: `${NAMES_A[id % NAMES_A.length]} ${NAMES_B[(id * 3) % NAMES_B.length]}`,
      color: COLORS[id % COLORS.length], leaderId, members: ids.map((agentId) => ({ agentId, joinedAt: time, loyalty: .5 + this.random() * .25, duesMissed: 0 })),
      cohesion: .5, formedAt: time, treasuryContainer, retaliation: [], state: "active" };
    this.gangs.set(id, gang); return gang;
  }

  private recruit(time: number, agents: readonly Agent[], social: PrisonerSocialSystem): void {
    for (const gang of this.gangs.values()) {
      if (gang.state !== "active") continue;
      const recruiter = agents.find((a) => a.id === gang.leaderId); if (!recruiter) continue;
      for (const bond of social.bondsFrom(recruiter.id).filter((b) => b.trust > .45 && b.affinity > .36)) {
        const candidate = agents.find((a) => a.id === bond.to); if (!candidate || candidate.kind !== Obj.Prisoner || this.gangFor(candidate.id)) continue;
        if (this.random() > .08 + Math.max(0, personality(candidate.profile, "loyalty")) * .08) continue;
        gang.members.push({ agentId: candidate.id, joinedAt: time, loyalty: .4 + bond.trust * .4, duesMissed: 0 }); break;
      }
    }
  }

  private defend(time: number, agents: readonly Agent[]): void {
    for (const engagement of this.combat.engagements.values()) {
      if (engagement.state !== "active") continue;
      for (const participant of [...engagement.participants]) {
        const gang = this.gangFor(participant.agentId); if (!gang) continue;
        const victim = agents.find((a) => a.id === participant.agentId); if (!victim) continue;
        for (const member of gang.members) {
          if (engagement.participants.some((p) => p.agentId === member.agentId)) continue;
          const ally = agents.find((a) => a.id === member.agentId); if (!ally || this.health.isUnavailable(ally.id) || Math.hypot(ally.x - victim.x, ally.z - victim.z) > 6) continue;
          if (member.loyalty > .5 && this.random() < .035) { this.combat.join(engagement.id, ally, participant.side); break; }
        }
        for (const enemy of engagement.participants.filter((p) => p.side !== participant.side)) if (!gang.retaliation.some((r) => r.targetId === enemy.agentId))
          gang.retaliation.push({ targetId: enemy.agentId, expiresAt: time + HOUR_SECONDS * 24, reason: "attack on a gang member" });
      }
    }
  }

  private retaliate(time: number, agents: readonly Agent[]): void {
    for (const gang of this.gangs.values()) for (const retaliation of gang.retaliation) {
      const target = agents.find((a) => a.id === retaliation.targetId); if (!target || this.combat.isBusy(target.id)) continue;
      const avenger = gang.members.map((m) => agents.find((a) => a.id === m.agentId)).find((a): a is Agent => !!a && !this.combat.isBusy(a.id) && Math.hypot(a.x - target.x, a.z - target.z) < 2.4);
      if (!avenger || this.random() > .06) continue;
      const fight = this.combat.start(avenger, target, time); if (!fight) continue;
      const incident = this.institution.createIncident("gang", avenger.id, target.id, avenger.x, avenger.z, time);
      void incident; retaliation.expiresAt = time;
    }
    for (const debt of this.market.debts.values()) {
      if (debt.state !== "late") continue; const gang = this.gangFor(debt.creditorId); if (!gang) continue;
      if (!gang.retaliation.some((r) => r.targetId === debt.debtorId)) gang.retaliation.push({ targetId: debt.debtorId, expiresAt: time + HOUR_SECONDS * 12, reason: "unpaid market debt" });
    }
  }

  private collectDues(time: number, agents: readonly Agent[]): void {
    for (const gang of this.gangs.values()) if (gang.state === "active") for (const member of gang.members) {
      if (member.agentId === gang.leaderId) continue;
      const paid = this.market.collectTo(member.agentId, gang.treasuryContainer, 1, time);
      if (paid < 1) { member.duesMissed++; member.loyalty = Math.max(0, member.loyalty - .04); }
      else member.loyalty = Math.min(1, member.loyalty + .01);
    }
    void agents;
  }

  private chooseLeader(members: GangMember[], agents: readonly Agent[]): number {
    return [...members].sort((a, b) => this.leaderScore(agents.find((x) => x.id === b.agentId)) - this.leaderScore(agents.find((x) => x.id === a.agentId)) || a.agentId - b.agentId)[0]?.agentId ?? -1;
  }
  private leaderScore(a?: Agent): number { return a ? aptitude(a.profile, "charisma") + aptitude(a.profile, "willpower") * .55 + skill(a.profile, "leadership") * .8 + personality(a.profile, "dominance") * 2 : -Infinity; }
  private cohesion(gang: Gang, social: PrisonerSocialSystem): number {
    let sum = 0, count = 0; for (const a of gang.members) for (const b of gang.members) if (a.agentId !== b.agentId) { sum += social.bond(a.agentId, b.agentId, false)?.trust ?? .1; count++; }
    return Math.max(0, Math.min(1, (count ? sum / count : 0) * .7 + gang.members.reduce((s, m) => s + m.loyalty, 0) / gang.members.length * .3));
  }
  private split(gang: Gang, time: number, agents: readonly Agent[]): void {
    const leaving = gang.members.filter((_, i) => i % 2 === 1); if (leaving.length < 3) return;
    gang.members = gang.members.filter((m) => !leaving.includes(m)); gang.state = gang.members.length >= 3 ? "active" : "dissolved";
    this.createGang(leaving.map((m) => m.agentId), time, agents);
  }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}
