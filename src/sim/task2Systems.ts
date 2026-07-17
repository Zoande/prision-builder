import type { Agent } from "./agent.ts";
import { AreaSystem } from "./areas.ts";
import { CombatSystem } from "./combat.ts";
import { HealthSystem } from "./health.ts";
import { InstitutionSystem } from "./institution.ts";
import { ItemSystem } from "./itemSystem.ts";
import { Obj } from "./objects.ts";
import type { World } from "./world.ts";
import type { EconomySystem } from "./economy.ts";
import { WorkSystem } from "./work.ts";
import { SecuritySystem } from "./security.ts";
import { MarketSystem } from "./market.ts";
import { GangSystem } from "./gangs.ts";
import { EscapeSupportSystem } from "./escapeSupport.ts";
import type { PrisonerSocialSystem } from "./social.ts";
import type { EscapeOperationsSystem } from "./escapeOperations.ts";
import type { LogisticsSystem } from "./logistics.ts";

/** Version-four systems are grouped behind one save/tick boundary while their
 * individual modules remain independently testable. */
export class Task2Systems {
  readonly items = new ItemSystem();
  readonly areas: AreaSystem;
  readonly institution = new InstitutionSystem();
  readonly health = new HealthSystem();
  readonly combat = new CombatSystem(this.health, this.institution, this.items);
  readonly work: WorkSystem;
  readonly market: MarketSystem;
  readonly gangs: GangSystem;
  readonly escapeSupport: EscapeSupportSystem;
  social: PrisonerSocialSystem | null = null;
  escapeOperations: EscapeOperationsSystem | null = null;
  readonly security: SecuritySystem;
  readonly warnings = new Set<string>();
  private readonly chargedHearses = new Set<number>();
  private readonly informantReportKeys = new Set<string>();
  private informantTimer = 8;
  private rngState = 0x2b894c31;
  private readonly economy: EconomySystem;

  constructor(worldSize: number, economy: EconomySystem, logistics: LogisticsSystem) {
    this.economy = economy;
    this.areas = new AreaSystem(worldSize);
    this.security = new SecuritySystem(this.items, this.institution, this.combat, this.health, this.areas);
    this.work = new WorkSystem(this.items, economy, logistics);
    this.market = new MarketSystem(this.items, this.health, this.institution, economy, this.work);
    this.gangs = new GangSystem(this.items, this.market, this.combat, this.health, this.institution);
    this.escapeSupport = new EscapeSupportSystem(this.items, this.combat);
  }

  installNewGame(world: World): void {
    this.areas.recompute(world);
    for (const [id, name] of [["institution:kitchen-clean", "Clean kitchen stock"], ["institution:kitchen-in-use", "Place settings in use"],
      ["institution:kitchen-dirty", "Dirty place settings"], ["institution:library-stock", "Library stock"]] as const)
      this.items.ensureContainer({ id, name, x: 0, z: 0, capacity: 5000, concealment: .2, bodyCapacity: 0,
        lockedTier: "staff", ownerId: -1, tags: ["institutional-stock"] });
    const medical = this.items.ensureContainer({ id: "institution:medical-stock", name: "Medical stock",
      x: 0, z: 0, capacity: 80, concealment: .2, bodyCapacity: 0, lockedTier: "staff",
      ownerId: -1, tags: ["medical", "controlled"] });
    for (const [defId, count] of [["bandage", 24], ["medicine", 12], ["splint", 8], ["overdose-kit", 4]] as const) {
      for (const id of this.items.createMany(defId, count, 0)) this.items.moveToContainer(id, medical.id, 0);
    }
  }

  rebuildWorld(world: World): void { this.areas.recompute(world); }

  tick(dt: number, worldTime: number, world: World, agents: readonly Agent[], workActive = false, rollCall = false): void {
    this.warnings.clear();
    for (const agent of agents) this.ensureAgent(agent, worldTime);
    this.health.tick(dt, worldTime, world, agents, this.items);
    for (const body of this.health.bodies.values()) if (body.removed && !this.chargedHearses.has(body.agentId)) {
      this.chargedHearses.add(body.agentId); this.economy.post(worldTime, "medical", -250, `Hearse removal for agent ${body.agentId}`, true);
    }
    this.combat.tick(dt, worldTime, world, agents);
    this.institution.tick(worldTime, agents);
    this.work.tick(dt, worldTime, world, agents, this.health, workActive);
    this.security.tick(dt, worldTime, world, agents, rollCall);
    this.areas.updateOccupancy(world, agents);
    this.market.tick(dt, worldTime, world, agents);
    if (this.social) this.gangs.tick(dt, worldTime, agents, this.social);
    if (this.escapeOperations) this.escapeSupport.tick(worldTime, agents, this.escapeOperations);
    this.informantTimer -= dt; if (this.informantTimer <= 0) { this.informantTimer = 12; this.informantReports(worldTime, agents); }
    const missing = this.items.controlledDiscrepancies();
    if (missing.length) this.warnings.add(`${missing.length} controlled item${missing.length === 1 ? " is" : "s are"} missing`);
    for (const warning of this.health.warnings) this.warnings.add(warning);
    for (const warning of this.work.warnings) this.warnings.add(warning);
    for (const warning of this.security.warnings) this.warnings.add(warning);
    for (const warning of this.market.warnings) this.warnings.add(warning);
    for (const warning of this.gangs.warnings) this.warnings.add(warning);
  }

  ensureAgent(agent: Agent, worldTime: number): void {
    const common = { x: agent.x, z: agent.z, concealment: .6, bodyCapacity: 0,
      ownerId: agent.id, lockedTier: "none" as const };
    const equipmentId = `agent:${agent.id}:equipment`;
    const firstInstall = !this.items.containers.has(equipmentId);
    this.items.ensureContainer({ ...common, id: equipmentId, name: `Agent ${agent.id} equipment`, capacity: 12, tags: ["equipment"] });
    this.items.ensureContainer({ ...common, id: `agent:${agent.id}:hands`, name: `Agent ${agent.id} hands`, capacity: 2, tags: ["hands"] });
    this.items.ensureContainer({ ...common, id: `agent:${agent.id}:pockets`, name: `Agent ${agent.id} pockets`, capacity: 8, concealment: .88, tags: ["personal", "searchable"] });
    this.items.ensureContainer({ ...common, id: `agent:${agent.id}:worn`, name: `Agent ${agent.id} worn items`, capacity: 4, concealment: .72, tags: ["worn", "searchable"] });
    this.health.ensure(agent);
    if (agent.kind === Obj.Prisoner) {
      const carried = [...this.items.itemsIn(`agent:${agent.id}:hands`), ...this.items.itemsIn(`agent:${agent.id}:pockets`), ...this.items.itemsIn(`agent:${agent.id}:worn`)];
      agent.accessKeys = carried.some((i) => i.defId === "guard-key" || i.defId === "duplicate-guard-key") ? 2 :
        carried.some((i) => i.defId === "staff-key" || i.defId === "duplicate-staff-key") ? 1 : 0;
      agent.disguise = carried.some((i) => i.defId === "staff-uniform")
        ? Math.min(.9, .25 + (agent.profile?.skills.deception.level ?? 0) * .055) : 0;
    }
    if (!firstInstall) return;
    const equipment: string[] = [];
    if (agent.kind === Obj.Prisoner) equipment.push("prisoner-uniform");
    else {
      equipment.push("staff-uniform", "staff-key");
      if ([Obj.Guard, Obj.ArmedGuard, Obj.Investigator, Obj.DogHandler].includes(agent.kind as never)) equipment.push("guard-key", "radio");
      if (agent.kind === Obj.Guard) equipment.push("baton");
      if (agent.kind === Obj.ArmedGuard) equipment.push("baton", "service-pistol", "pistol-magazine", "pistol-magazine");
    }
    for (const defId of equipment) {
      const item = this.items.create(defId, worldTime, { ownerId: agent.id, issuedTo: agent.kind === Obj.Prisoner ? -1 : agent.id });
      this.items.moveToContainer(item.id, equipmentId, worldTime, agent.id);
      if (item.issuedTo >= 0) this.items.issue(item.id, agent.id, worldTime);
    }
  }

  saveData() { return {
    items: this.items.saveData(), areas: this.areas.saveData(), health: this.health.saveData(),
    combat: this.combat.saveData(), institution: this.institution.saveData(),
    work: this.work.saveData(),
    security: this.security.saveData(),
    market: this.market.saveData(),
    gangs: this.gangs.saveData(),
    chargedHearses: [...this.chargedHearses],
    informantReportKeys: [...this.informantReportKeys], informantTimer: this.informantTimer, rngState: this.rngState,
  }; }

  loadData(data: Partial<ReturnType<Task2Systems["saveData"]>>, world: World): void {
    this.items.loadData(data.items ?? {});
    this.areas.loadData(data.areas ?? {});
    this.health.loadData(data.health ?? {});
    this.combat.loadData(data.combat ?? {});
    this.institution.loadData(data.institution ?? {});
    this.work.loadData(data.work ?? {});
    this.security.loadData(data.security ?? {});
    this.market.loadData(data.market ?? {});
    this.gangs.loadData(data.gangs ?? {});
    this.chargedHearses.clear(); for (const id of data.chargedHearses ?? []) this.chargedHearses.add(id);
    this.informantReportKeys.clear(); for (const key of data.informantReportKeys ?? []) this.informantReportKeys.add(key);
    this.informantTimer = data.informantTimer ?? 8; this.rngState = data.rngState ?? 0x2b894c31;
    this.areas.recompute(world);
  }

  private informantReports(time: number, agents: readonly Agent[]): void {
    for (const [sourceId, source] of this.institution.informants) {
      const informant = agents.find((a) => a.id === sourceId); if (!informant || this.health.isUnavailable(sourceId)) continue;
      const gang = this.gangs.gangFor(sourceId);
      if (gang) {
        const subject = gang.members.find((member) => member.agentId !== sourceId)?.agentId ?? sourceId, key = `gang:${gang.id}:${subject}`;
        if (!this.informantReportKeys.has(key) && this.random() < source.reliability * .35) {
          this.informantReportKeys.add(key);
          const incident = this.institution.createIncident("gang", subject, -1, informant.x, informant.z, time);
          this.institution.addEvidence(incident.id, "informant", sourceId, subject, source.reliability,
            `Source reports a mutual-protection group associated with inmate ${subject}`, time, informant.x, informant.z, -1,
            "The source may be describing an ordinary friendship clique or settling a grievance");
        }
      }
      const op = this.escapeOperations?.operationFor(informant);
      if (op) {
        const subject = op.members.find((m) => m.agentId !== sourceId)?.agentId ?? sourceId, key = `escape:${op.id}:${subject}`;
        if (!this.informantReportKeys.has(key) && this.random() < source.reliability * .28) {
          this.informantReportKeys.add(key);
          const incident = this.institution.createIncident("escape", subject, -1, informant.x, informant.z, time);
          this.institution.addEvidence(incident.id, "informant", sourceId, subject, source.reliability * .9,
            `Source alleges preparations for a ${op.method} escape`, time, informant.x, informant.z, -1,
            "The source did not provide enough corroboration to establish timing or route");
        }
      } else if (source.reliability < .5 && this.random() > source.reliability && this.random() < .03) {
        const candidates = agents.filter((a) => a.kind === Obj.Prisoner && a.id !== sourceId); if (!candidates.length) continue;
        const subject = candidates[(this.random() * candidates.length) | 0], key = `false:${sourceId}:${subject.id}`;
        if (this.informantReportKeys.has(key)) continue; this.informantReportKeys.add(key);
        const incident = this.institution.createIncident("gang", subject.id, -1, informant.x, informant.z, time);
        this.institution.addEvidence(incident.id, "informant", sourceId, subject.id, source.reliability * .55,
          `Source loosely associates inmate ${subject.id} with organized activity`, time, informant.x, informant.z, -1,
          "This low-confidence report may be false or retaliatory");
      }
    }
  }

  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}
