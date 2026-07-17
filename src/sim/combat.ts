import type { Agent } from "./agent.ts";
import { Obj } from "./objects.ts";
import { aptitude, personality, skill } from "./profiles.ts";
import type { HealthSystem, BodyRegion, InjuryType } from "./health.ts";
import type { ForceLevel, InstitutionSystem } from "./institution.ts";
import { itemDefV4, type ItemSystem } from "./itemSystem.ts";
import type { World } from "./world.ts";

export interface CombatParticipant { agentId: number; side: number; surrendered: boolean; nextAction: number; stamina: number; }
export interface CombatEngagement {
  id: number;
  participants: CombatParticipant[];
  startedAt: number;
  lastActionAt: number;
  x: number;
  z: number;
  incidentId: number;
  plannedDistraction: boolean;
  state: "active" | "contained" | "ended";
}

export class CombatSystem {
  readonly engagements = new Map<number, CombatEngagement>();
  private nextId = 1;
  private scanTimer = 0;
  private rngState = 0xb3a19d5f;
  private readonly health: HealthSystem;
  private readonly institution: InstitutionSystem;
  private readonly items: ItemSystem;

  constructor(health: HealthSystem, institution: InstitutionSystem, items: ItemSystem) {
    this.health = health; this.institution = institution; this.items = items;
  }

  isBusy(agentId: number): boolean {
    return [...this.engagements.values()].some((e) => e.state === "active" && e.participants.some((p) => p.agentId === agentId && !p.surrendered));
  }

  responseFor(agent: Agent): CombatEngagement | null {
    let best: CombatEngagement | null = null, distance = Infinity;
    for (const engagement of this.engagements.values()) {
      if (engagement.state !== "active") continue;
      const incident = this.institution.incidents.get(engagement.incidentId);
      if (!incident || incident.state === "unreported") continue;
      const d = Math.hypot(agent.x - engagement.x, agent.z - engagement.z);
      if (d < distance) { best = engagement; distance = d; }
    }
    return best;
  }

  start(attacker: Agent, defender: Agent, time: number, plannedDistraction = false): CombatEngagement | null {
    if (attacker.id === defender.id || this.isBusy(attacker.id) || this.isBusy(defender.id)) return null;
    const incident = this.institution.createIncident(defender.kind === Obj.Prisoner ? "assault-inmate" : "assault-staff",
      attacker.id, defender.id, (attacker.x + defender.x) / 2, (attacker.z + defender.z) / 2, time);
    const engagement: CombatEngagement = {
      id: this.nextId++, participants: [
        { agentId: attacker.id, side: 0, surrendered: false, nextAction: time, stamina: 1 },
        { agentId: defender.id, side: 1, surrendered: false, nextAction: time + .25, stamina: 1 },
      ], startedAt: time, lastActionAt: time, x: incident.x, z: incident.z,
      incidentId: incident.id, plannedDistraction, state: "active",
    };
    this.engagements.set(engagement.id, engagement);
    attacker.state = defender.state = "fighting"; attacker.path = defender.path = null;
    return engagement;
  }

  join(engagementId: number, agent: Agent, side: number): boolean {
    const e = this.engagements.get(engagementId);
    if (!e || e.state !== "active" || e.participants.some((p) => p.agentId === agent.id)) return false;
    e.participants.push({ agentId: agent.id, side, surrendered: false, nextAction: e.lastActionAt + .4, stamina: 1 });
    agent.state = "fighting"; agent.path = null; return true;
  }

  contain(engagementId: number, agents: readonly Agent[]): void {
    const e = this.engagements.get(engagementId); if (!e) return;
    e.state = "contained";
    for (const p of e.participants) {
      const agent = agents.find((a) => a.id === p.agentId);
      if (agent && this.health.state(agent.id)?.alive !== false) {
        agent.state = agent.kind === Obj.Prisoner ? "restrained" : "idle";
        if (agent.kind === Obj.Prisoner) agent.cuffed = true;
      }
    }
    const incident = this.institution.incidents.get(e.incidentId); if (incident && incident.state === "unreported") incident.state = "reported";
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[]): void {
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) { this.scanTimer = 1.5; this.emotionalScan(agents, time); }
    for (const e of this.engagements.values()) {
      if (e.state !== "active") continue;
      const active = e.participants.filter((p) => !p.surrendered).map((p) => ({ p, a: agents.find((a) => a.id === p.agentId) })).filter((x): x is { p: CombatParticipant; a: Agent } => !!x.a);
      const livingSides = new Set(active.filter((x) => this.health.state(x.a.id)?.alive !== false).map((x) => x.p.side));
      if (livingSides.size < 2 || time - e.lastActionAt > 20) { this.end(e, agents); continue; }
      for (const actor of active) {
        actor.p.stamina = Math.min(1, (actor.p.stamina ?? 1) + dt * .045);
        if (actor.p.nextAction > time) continue;
        const h = this.health.ensure(actor.a);
        if (!h.alive || h.consciousness < .15) { actor.p.surrendered = true; continue; }
        const resolve = aptitude(actor.a.profile, "willpower") / 10 + Math.max(0, personality(actor.a.profile, "courage")) * .2;
        if ((h.pain > .78 || actor.p.stamina < .08) && this.random() > resolve * .65) {
          actor.p.surrendered = true; actor.a.state = "surrendered"; actor.a.amp = 0; continue;
        }
        const enemies = active.filter((x) => x.p.side !== actor.p.side && this.health.ensure(x.a).alive && !x.p.surrendered);
        if (!enemies.length) continue;
        const target = enemies.sort((a, b) => Math.hypot(a.a.x - actor.a.x, a.a.z - actor.a.z) - Math.hypot(b.a.x - actor.a.x, b.a.z - actor.a.z))[0].a;
        const distance = Math.hypot(target.x - actor.a.x, target.z - actor.a.z);
        const weaponItem = this.weaponFor(actor.a.id), reach = weaponItem ? itemDefV4(weaponItem.defId).weapon?.reach ?? 1.15 : 1.15;
        if (distance > reach) {
          const step = Math.min(distance - Math.max(1, reach * .82), dt * 2.2 * h.mobility * (.55 + actor.p.stamina * .45));
          actor.a.x += (target.x - actor.a.x) / distance * step; actor.a.z += (target.z - actor.a.z) / distance * step;
          actor.a.heading = Math.atan2(target.z - actor.a.z, target.x - actor.a.x);
          actor.p.nextAction = time + .15; continue;
        }
        this.attack(actor.a, target, time);
        actor.p.stamina = Math.max(0, actor.p.stamina - .07 - (weaponItem && itemDefV4(weaponItem.defId).size === "large" ? .05 : 0));
        const sophistication = skill(actor.a.profile, "fighting") + aptitude(actor.a.profile, "reflexes") * .15;
        actor.p.nextAction = time + Math.max(.45, 1.45 - sophistication * .08 + h.pain * .7 + h.intoxication * .5);
        e.lastActionAt = time; e.x = (actor.a.x + target.x) / 2; e.z = (actor.a.z + target.z) / 2;
      }
      this.recruitAllies(e, agents);
      this.observe(e, agents, world, time);
    }
  }

  saveData() { return { engagements: [...this.engagements.values()].map((e) => ({ ...e, participants: e.participants.map((p) => ({ ...p })) })), nextId: this.nextId, rngState: this.rngState }; }
  loadData(data: Partial<ReturnType<CombatSystem["saveData"]>>): void {
    this.engagements.clear(); for (const e of data.engagements ?? []) this.engagements.set(e.id, { ...e, participants: e.participants.map((p) => ({ ...p, stamina: p.stamina ?? 1 })) });
    this.nextId = data.nextId ?? 1; this.rngState = data.rngState ?? 0xb3a19d5f;
  }

  private attack(attacker: Agent, defender: Agent, time: number): void {
    const weaponItem = this.weaponFor(attacker.id), weapon = weaponItem ? itemDefV4(weaponItem.defId).weapon : undefined;
    const fighting = skill(attacker.profile, "fighting"), dex = aptitude(attacker.profile, "dexterity"), str = aptitude(attacker.profile, "strength");
    const defense = skill(defender.profile, "fighting") + aptitude(defender.profile, "reflexes") * .25;
    const distance = Math.hypot(defender.x - attacker.x, defender.z - attacker.z);
    const rangedPenalty = weapon && weapon.reach > 3 ? Math.max(0, distance / weapon.reach - .45) * .28 : 0;
    const hit = .42 + fighting * .035 + dex * .012 - defense * .025 - rangedPenalty;
    if (this.random() > hit) { attacker.amp = .8; defender.amp = .35; return; }
    const skilled = fighting + aptitude(attacker.profile, "perception") * .2;
    const region = this.pickRegion(skilled, weapon?.targetBias);
    const type = (weapon?.damage ?? "blunt") as InjuryType;
    const base = weapon?.power ?? (.08 + str * .018);
    let severity = Math.max(.025, base * (.65 + this.random() * .7) * this.health.effectiveManipulation(attacker.id));
    severity *= this.armorMultiplier(defender.id, type, time, attacker.id);
    this.health.applyInjury(defender, type, region, severity, time, attacker.id, weaponItem?.id ?? -1);
    if (weaponItem) {
      weaponItem.condition = Math.max(0, weaponItem.condition - (weapon?.ammunition ? .002 : .006));
      if (weapon?.ammunition) this.consumeAmmunition(attacker.id, weapon.ammunition, time);
      else if (weaponItem.condition <= 0) this.items.destroy(weaponItem.id, time, attacker.id, "weapon-broken");
    }
    attacker.amp = 1; defender.amp = .7;
    if (distance < 1.6 && this.random() < .04 + Math.max(0, defense - fighting) * .01 && weaponItem) {
      this.items.moveToWorld(weaponItem.id, defender.x, defender.z, time, defender.id);
    }
  }

  private weaponFor(agentId: number) {
    const ids = ["hands", "equipment"].flatMap((slot) => this.items.containers.get(`agent:${agentId}:${slot}`)?.itemIds ?? []);
    return ids.map((id) => this.items.items.get(id)).find((i) => {
      if (!i || !itemDefV4(i.defId).weapon) return false;
      const ammo = itemDefV4(i.defId).weapon?.ammunition;
      return !ammo || this.hasAmmunition(agentId, ammo);
    });
  }

  /** Guards follow the configured ceiling but only use lethal force against a
   * currently lethal threat. Returns true while the engagement still needs a response. */
  guardIntervene(guard: Agent, engagement: CombatEngagement, agents: readonly Agent[], time: number): boolean {
    if (engagement.state !== "active") return false;
    const incident = this.institution.incidents.get(engagement.incidentId);
    const rule = this.institution.ruleFor(incident?.category ?? "assault-inmate", incident?.itemDefId ?? "");
    const active = engagement.participants.filter((p) => !p.surrendered).map((p) => ({ p, a: agents.find((a) => a.id === p.agentId) }))
      .filter((row): row is { p: CombatParticipant; a: Agent } => !!row.a && this.health.ensure(row.a).alive);
    const prisoners = active.filter((row) => row.a.kind === Obj.Prisoner);
    if (!prisoners.length) { this.contain(engagement.id, agents); return false; }
    const target = prisoners.sort((a, b) => (a.p.surrendered ? 1 : 0) - (b.p.surrendered ? 1 : 0))[0];
    const elapsed = time - engagement.startedAt;
    if (elapsed < 2) {
      const compliance = .18 + aptitude(target.a.profile, "willpower") * -.012 + this.health.ensure(target.a).pain * .35;
      if (this.random() < compliance) { target.p.surrendered = true; target.a.state = "surrendered"; }
      return true;
    }
    const responders = agents.filter((a) => [Obj.Guard, Obj.ArmedGuard, Obj.DogHandler].includes(a.kind as never) &&
      Math.hypot(a.x - engagement.x, a.z - engagement.z) <= 2.5).length;
    const needed = Math.max(1, Math.ceil(prisoners.filter((p) => !p.p.surrendered).length / 2));
    if (responders >= needed && forceRank(rule.force) >= forceRank("restraint") && (elapsed < 6 || this.random() < .25)) {
      this.contain(engagement.id, agents); return false;
    }
    const lethalThreat = prisoners.some((row) => {
      const weapon = this.weaponFor(row.a.id); return !!weapon && itemDefV4(weapon.defId).weapon?.damage === "gunshot";
    });
    const ceiling = lethalThreat ? rule.force : forceRank(rule.force) >= forceRank("lethal") ? "less-lethal" : rule.force;
    const choices: Array<[ForceLevel, string]> = [["lethal", "service-pistol"], ["less-lethal", "less-lethal-launcher"],
      ["taser", "taser"], ["spray", "pepper-spray"], ["baton", "baton"]];
    const equipment = ["hands", "equipment"].flatMap((slot) => this.items.itemsIn(`agent:${guard.id}:${slot}`));
    const selected = choices.find(([level, defId]) => forceRank(level) <= forceRank(ceiling) &&
      (level !== "lethal" || lethalThreat) && equipment.some((i) => i.defId === defId && (!itemDefV4(i.defId).weapon?.ammunition || this.hasAmmunition(guard.id, itemDefV4(i.defId).weapon!.ammunition!))));
    if (selected) {
      const item = equipment.find((i) => i.defId === selected[1])!;
      const distance = Math.hypot(target.a.x - guard.x, target.a.z - guard.z), reach = itemDefV4(item.defId).weapon?.reach ?? 1;
      if (distance <= reach) this.attackWith(guard, target.a, item.id, time);
    }
    if (this.health.ensure(target.a).consciousness < .15) target.p.surrendered = true;
    if (prisoners.every((row) => row.p.surrendered || this.health.ensure(row.a).consciousness < .15)) this.contain(engagement.id, agents);
    return engagement.state === "active";
  }

  private attackWith(attacker: Agent, defender: Agent, itemId: number, time: number): void {
    const hands = `agent:${attacker.id}:hands`, item = this.items.items.get(itemId); if (!item) return;
    const original = item.containerId;
    if (original !== hands) this.items.moveToContainer(item.id, hands, time, attacker.id);
    this.attack(attacker, defender, time);
    if (original !== hands && this.items.items.get(item.id)?.locationKind !== "destroyed") this.items.moveToContainer(item.id, original, time, attacker.id);
  }

  private hasAmmunition(agentId: number, defId: string): boolean {
    return ["hands", "pockets", "equipment"].some((slot) => this.items.itemsIn(`agent:${agentId}:${slot}`).some((i) => i.defId === defId && i.condition > .02));
  }
  private consumeAmmunition(agentId: number, defId: string, time: number): void {
    const magazine = ["hands", "pockets", "equipment"].flatMap((slot) => this.items.itemsIn(`agent:${agentId}:${slot}`))
      .find((i) => i.defId === defId && i.condition > .02);
    if (!magazine) return;
    magazine.condition = Math.max(0, magazine.condition - .1);
    if (magazine.condition <= .02) this.items.destroy(magazine.id, time, agentId, "magazine-empty");
  }
  private armorMultiplier(agentId: number, type: InjuryType, time: number, attackerId: number): number {
    const armor = ["worn", "equipment"].flatMap((slot) => this.items.itemsIn(`agent:${agentId}:${slot}`))
      .find((i) => i.defId === "riot-gear" || i.defId === "body-armor");
    if (!armor || !["gunshot", "puncture", "cut", "blunt"].includes(type)) return 1;
    armor.condition = Math.max(0, armor.condition - .025);
    if (armor.condition <= 0) this.items.destroy(armor.id, time, attackerId, "armor-destroyed");
    return armor.defId === "riot-gear" ? .48 : .67;
  }

  private emotionalScan(agents: readonly Agent[], time: number): void {
    for (const a of agents) {
      if (a.kind !== Obj.Prisoner || !a.mind || this.isBusy(a.id) || this.health.isUnavailable(a.id)) continue;
      const pressure = a.mind.anger * .45 + a.mind.stress * .22 + Math.max(0, personality(a.profile, "aggression")) * .16 + Math.max(0, personality(a.profile, "volatility")) * .12;
      if (pressure < .55 || this.random() > pressure * .025) continue;
      const candidates = agents.filter((b) => b.id !== a.id && !this.isBusy(b.id) && !this.health.isUnavailable(b.id) && Math.hypot(b.x - a.x, b.z - a.z) < 2.2);
      if (!candidates.length) continue;
      this.start(a, candidates[(this.random() * candidates.length) | 0], time);
    }
  }

  private recruitAllies(e: CombatEngagement, agents: readonly Agent[]): void {
    if (e.participants.length >= 12) return;
    for (const candidate of agents) {
      if (candidate.kind !== Obj.Prisoner || this.isBusy(candidate.id) || this.health.isUnavailable(candidate.id)) continue;
      if (Math.hypot(candidate.x - e.x, candidate.z - e.z) > 4) continue;
      const loyalty = personality(candidate.profile, "loyalty"), aggression = personality(candidate.profile, "aggression");
      if (loyalty + aggression < .5 || this.random() > .02) continue;
      this.join(e.id, candidate, this.random() < .5 ? 0 : 1); break;
    }
  }

  private observe(e: CombatEngagement, agents: readonly Agent[], world: World, time: number): void {
    const incident = this.institution.incidents.get(e.incidentId); if (!incident || incident.state !== "unreported") return;
    const guard = agents.find((a) => [Obj.Guard, Obj.ArmedGuard, Obj.Investigator, Obj.DogHandler].includes(a.kind as never) && Math.hypot(a.x - e.x, a.z - e.z) < 12);
    if (!guard) return;
    this.institution.addEvidence(incident.id, "guard", guard.id, incident.aggressorId, .95,
      `Guard ${guard.id} witnessed active violence`, time, e.x, e.z, -1, "The witness may not have seen who initiated the fight");
    void world;
  }

  private end(e: CombatEngagement, agents: readonly Agent[]): void {
    e.state = "ended";
    for (const p of e.participants) {
      const a = agents.find((x) => x.id === p.agentId);
      if (a && this.health.ensure(a).alive && this.health.ensure(a).consciousness > .12) { a.state = "idle"; a.amp = 0; }
    }
  }

  private pickRegion(skillLevel: number, bias?: string): BodyRegion {
    if (bias === "head") return "head"; if (bias === "torso") return this.random() < .55 ? "chest" : "abdomen";
    if (skillLevel >= 7 && this.random() < .42) return this.random() < .55 ? "head" : "abdomen";
    const rows: BodyRegion[] = ["head", "chest", "chest", "abdomen", "left-arm", "right-arm", "left-hand", "right-hand", "left-leg", "right-leg", "left-foot", "right-foot"];
    return rows[(this.random() * rows.length) | 0];
  }

  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}

const FORCE_ORDER: ForceLevel[] = ["order", "restraint", "baton", "spray", "taser", "dog", "riot", "less-lethal", "lethal"];
function forceRank(level: ForceLevel): number { return FORCE_ORDER.indexOf(level); }
