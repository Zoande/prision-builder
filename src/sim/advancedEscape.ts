import type { Agent } from "./agent.ts";
import type { CombatSystem } from "./combat.ts";
import type { CredentialKind, CredentialSystem } from "./credentials.ts";
import type { EscapeOperation, EscapeOperationsSystem } from "./escapeOperations.ts";
import type { FacilitySecurityGraph } from "./facilitySecurity.ts";
import type { GangSystem } from "./gangs.ts";
import type { GangTerritorySystem } from "./gangTerritory.ts";
import type { InstitutionSystem } from "./institution.ts";
import type { ItemSystem } from "./itemSystem.ts";
import type { LogisticsSystem } from "./logistics.ts";
import type { ManagementSystem } from "./management.ts";
import type { MarketSystem } from "./market.ts";
import { followPath } from "./move.ts";
import { astar, passable } from "./nav.ts";
import { Obj, RoomType } from "./objects.ts";
import type { World } from "./world.ts";
import { aptitude, skill } from "./profiles.ts";
import type { PrisonerSocialSystem } from "./social.ts";
import type { CorruptionAction, StaffProfileSystem } from "./staffProfiles.ts";
import type { WorkSystem } from "./work.ts";
import { HOUR_SECONDS } from "./time.ts";

export type EscapeExitMode = "perimeter" | "tunnel" | "credential" | "vehicle" | "visitation" | "medical" | "outside-assistance";
export type PlanNodeState = "planned" | "available" | "active" | "waiting" | "complete" | "failed" | "cancelled";
export type PlanFailureMode = "retry" | "delay" | "substitute" | "branch" | "replan" | "abort";
export type EscapeSchemeState = "discovering" | "planning" | "preparing" | "staging" | "executing" | "suspended" | "escaped" | "failed" | "dissolved";

export type PlanAction =
  | "observe" | "steal-record" | "acquire-item" | "write-note" | "stash" | "forge-pass" | "copy-key"
  | "bribe-staff" | "blackmail-staff" | "sabotage-circuit" | "start-distraction" | "rally"
  | "contact-outsider" | "wait-external" | "hide-in-vehicle" | "depart-vehicle"
  | "visitation-exit" | "medical-transfer" | "credential-walkout" | "outside-dig" | "legacy-execute";

export interface EscapeActionDef {
  action: PlanAction;
  label: string;
  baseSeconds: number;
  noise: number;
  evidenceRisk: number;
  skill: "stealth" | "toolcraft" | "deception" | "leadership" | "smuggling" | "mechanics" | "medicine" | "digging";
}

export const ESCAPE_ACTION_DEFS: EscapeActionDef[] = [
  action("observe", "Observe security opportunity", 8, .02, .05, "stealth"),
  action("steal-record", "Copy a schedule or record", 12, .04, .2, "deception"),
  action("acquire-item", "Acquire a physical asset", 10, .05, .18, "smuggling"),
  action("write-note", "Record plan details", 6, .01, .12, "deception"),
  action("stash", "Move asset to a shared cache", 8, .02, .12, "smuggling"),
  action("forge-pass", "Forge an authorization", 20, .08, .3, "deception"),
  action("copy-key", "Mold and duplicate a key", 24, .16, .38, "toolcraft"),
  action("bribe-staff", "Approach a vulnerable staff member", 10, .03, .36, "deception"),
  action("blackmail-staff", "Coerce a staff member", 12, .04, .52, "deception"),
  action("sabotage-circuit", "Disable a security circuit", 18, .24, .48, "mechanics"),
  action("start-distraction", "Create a synchronized disturbance", 4, .9, .95, "leadership"),
  action("rally", "Rally assigned members", 5, .02, .1, "leadership"),
  action("contact-outsider", "Arrange outside assistance", 10, .02, .25, "smuggling"),
  action("wait-external", "Wait for an external commitment", 1, 0, .05, "leadership"),
  action("hide-in-vehicle", "Conceal inside an outgoing vehicle", 12, .08, .3, "stealth"),
  action("depart-vehicle", "Pass the road inspection and depart", 1, 0, .5, "stealth"),
  action("visitation-exit", "Leave through a visit movement", 10, .02, .55, "deception"),
  action("medical-transfer", "Board a secure medical transfer", 10, .02, .6, "medicine"),
  action("credential-walkout", "Present credentials and walk out", 10, .02, .62, "deception"),
  action("outside-dig", "Meet an externally dug tunnel", 18, .18, .45, "digging"),
  action("legacy-execute", "Execute the physical breach", 1, .2, .65, "leadership"),
];
const ACTION_BY_ID = new Map(ESCAPE_ACTION_DEFS.map((row) => [row.action, row]));

export interface PlanNode {
  id: number;
  schemeId: number;
  action: PlanAction;
  label: string;
  state: PlanNodeState;
  dependencies: number[];
  alternatives: number[];
  actors: number[];
  targetTile: number;
  targetRoomId: number;
  itemDefId: string;
  sourceItemId: number;
  credentialKind: CredentialKind | "";
  corruptionAction: CorruptionAction | "";
  progress: number;
  seconds: number;
  attempts: number;
  failure: PlanFailureMode;
  noise: number;
  evidenceRisk: number;
  blocker: string;
  optional: boolean;
  activatedAt: number;
  completedAt: number;
}

export interface MemberPlanKnowledge { schemeId: number; memberId: number; nodeIds: number[]; learnedAt: number; }
export interface ExternalCommitment {
  id: number;
  schemeId: number;
  type: "driver" | "visitor" | "medical" | "outside-digger" | "drop";
  contactId: number;
  cost: number;
  trust: number;
  arrangedAt: number;
  dueAt: number;
  state: "proposed" | "paid" | "scheduled" | "arrived" | "fulfilled" | "failed";
  vehicleId: number;
  evidenceRisk: number;
}
export interface ExternalEscapeVehicle {
  id: number;
  kind: "visitor" | "medical" | "outside";
  state: "queued" | "arriving" | "unloading" | "departing" | "blocked";
  x: number;
  z: number;
  timer: number;
  warning: string;
  passengerIds: number[];
}
export interface ConcealedPassenger { agentId: number; vehicleId: number; schemeId: number; concealment: number; checked: boolean; detected: boolean; boardedAt: number; }

export interface EscapeScheme {
  id: number;
  legacyOperationId: number;
  mode: EscapeExitMode;
  state: EscapeSchemeState;
  architectId: number;
  leaderId: number;
  memberIds: number[];
  escapedMemberIds: number[];
  nodes: PlanNode[];
  complexityBudget: number;
  exposure: number;
  cohesion: number;
  confidence: number;
  sponsoredGangId: number;
  cacheContainer: string;
  createdAt: number;
  lastReplanAt: number;
  blocker: string;
  compromisedNodes: number[];
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** A deterministic HTN-like plan graph. It owns preparation and contingencies;
 * the existing climb/cut/dig engine remains the physical breach executor. */
export class AdvancedEscapeSystem {
  readonly schemes = new Map<number, EscapeScheme>();
  readonly knowledge = new Map<string, MemberPlanKnowledge>();
  readonly commitments = new Map<number, ExternalCommitment>();
  readonly externalVehicles = new Map<number, ExternalEscapeVehicle>();
  readonly concealed = new Map<number, ConcealedPassenger>();
  readonly warnings = new Set<string>();
  private nextSchemeId = 1;
  private nextNodeId = 1;
  private nextCommitmentId = 1;
  private nextVehicleId = 1_000_000;
  private rngState = 0x5d84ce27;
  private readonly escapedIds: number[] = [];

  private readonly items: ItemSystem;
  private readonly credentials: CredentialSystem;
  private readonly facility: FacilitySecurityGraph;
  private readonly institution: InstitutionSystem;
  private readonly combat: CombatSystem;
  private readonly market: MarketSystem;
  private readonly work: WorkSystem;
  private readonly staff: StaffProfileSystem;
  private readonly management: ManagementSystem;
  private readonly gangs: GangSystem;
  private readonly territories: GangTerritorySystem;
  private readonly logistics: LogisticsSystem;

  constructor(items: ItemSystem, credentials: CredentialSystem, facility: FacilitySecurityGraph,
    institution: InstitutionSystem, combat: CombatSystem, market: MarketSystem, work: WorkSystem,
    staff: StaffProfileSystem, management: ManagementSystem, gangs: GangSystem,
    territories: GangTerritorySystem, logistics: LogisticsSystem) {
    this.items = items; this.credentials = credentials; this.facility = facility; this.institution = institution;
    this.combat = combat; this.market = market; this.work = work; this.staff = staff; this.management = management;
    this.gangs = gangs; this.territories = territories; this.logistics = logistics;
  }

  tick(dt: number, time: number, world: World, agents: Agent[], social: PrisonerSocialSystem,
    operations: EscapeOperationsSystem): void {
    this.warnings.clear();
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    for (const op of operations.operations.values()) if (op.advancedSchemeId < 0 && !["completed", "failed", "dissolved"].includes(op.state)) {
      this.createSchemeForOperation(op, agents, world, social, undefined, time);
    }
    this.tickCommitments(dt, time, world);
    this.tickVehicles(dt, time, world, byId);
    for (const scheme of this.schemes.values()) {
      const op = operations.operations.get(scheme.legacyOperationId);
      const priorMembers = [...scheme.memberIds];
      if (op) {
        scheme.memberIds = op.members.map((m) => m.agentId).filter((id) => byId.has(id));
        if (["executing", "completed"].includes(op.state)) for (const id of priorMembers) {
          if (!byId.has(id) && !scheme.escapedMemberIds.includes(id)) scheme.escapedMemberIds.push(id);
        }
      } else scheme.memberIds = scheme.memberIds.filter((id) => byId.has(id));
      if (!scheme.memberIds.length && !["escaped", "failed", "dissolved"].includes(scheme.state)) {
        scheme.state = scheme.escapedMemberIds.length || op?.state === "completed" ? "escaped" : "dissolved"; continue;
      }
      if (["escaped", "failed", "dissolved"].includes(scheme.state)) {
        if (op && !["completed", "failed", "dissolved"].includes(op.state)) {
          op.state = scheme.state === "escaped" ? "completed" : scheme.state === "failed" ? "failed" : "dissolved";
        }
        continue;
      }
      this.activateReadyNodes(scheme, time, byId);
      this.advancePassiveNodes(scheme, op ?? null, dt, time, world, agents);
      const leader = byId.get(scheme.leaderId);
      const leaderTile = world.idx(Math.max(0, Math.min(world.size - 1, Math.floor(leader?.x ?? 0))), Math.max(0, Math.min(world.size - 1, Math.floor(leader?.z ?? 0))));
      const territoryPrivacy = scheme.sponsoredGangId >= 0 ? this.territories.privacyBonus(scheme.sponsoredGangId, this.facility.areaIdAt(leaderTile)) : 0;
      scheme.exposure = clamp(scheme.exposure + dt * scheme.nodes.filter((n) => n.state === "active").reduce((s, n) => s + n.evidenceRisk, 0) * .00016 * (1 - territoryPrivacy));
      scheme.cohesion = op?.cohesion ?? scheme.cohesion;
      if (scheme.nodes.every((node) => node.optional || ["complete", "cancelled"].includes(node.state))) {
        const stillTravelling = [...this.concealed.values()].some((record) => record.schemeId === scheme.id);
        scheme.state = stillTravelling ? "executing" : scheme.escapedMemberIds.length ? "escaped" : "suspended";
      }
      const failedRequired = scheme.nodes.find((node) => !node.optional && node.state === "failed" && !this.alternativeComplete(scheme, node));
      if (failedRequired) this.handleFailure(scheme, failedRequired, time, byId);
      if (scheme.blocker && this.schemeKnownToStaff(scheme)) this.warnings.add(`Suspected escape activity: ${scheme.blocker}`);
    }
  }

  createSchemeForOperation(op: EscapeOperation, agents: readonly Agent[], world: World,
    social: PrisonerSocialSystem, forcedMode?: EscapeExitMode, time = 0): EscapeScheme {
    const architect = agents.find((agent) => agent.id === op.architectId) ?? agents.find((agent) => agent.id === op.leaderId)!;
    const id = this.nextSchemeId++, mode = forcedMode ?? this.chooseMode(op, architect, world);
    const intelligence = aptitude(architect?.profile ?? null, "intelligence"), creativity = aptitude(architect?.profile ?? null, "creativity");
    const complexityBudget = Math.max(2, Math.min(12, 1 + Math.floor((intelligence + creativity + skill(architect?.profile ?? null, "leadership")) / 2.7)));
    const rally = op.rallyTile >= 0 ? op.rallyTile : world.idx(Math.floor(architect.x), Math.floor(architect.z));
    const cacheContainer = `escape:${id}:cache`;
    this.items.ensureContainer({ id: cacheContainer, name: `Escape scheme ${id} cache`, x: rally % world.size, z: Math.floor(rally / world.size),
      capacity: 30, concealment: .88, bodyCapacity: 0, lockedTier: "none", ownerId: op.leaderId, tags: ["escape", "hiding-place"] });
    const scheme: EscapeScheme = { id, legacyOperationId: op.id, mode, state: "planning", architectId: op.architectId,
      leaderId: op.leaderId, memberIds: op.members.map((m) => m.agentId), escapedMemberIds: [], nodes: [], complexityBudget,
      exposure: op.exposure, cohesion: op.cohesion, confidence: .35 + intelligence * .045,
      sponsoredGangId: this.sponsorFor(op), cacheContainer, createdAt: time,
      lastReplanAt: 0, blocker: "", compromisedNodes: [] };
    this.schemes.set(id, scheme); op.advancedSchemeId = id; op.advancedReady = false; op.state = "forming";
    this.generatePlan(scheme, op, architect, world);
    this.partitionKnowledge(scheme, op, social, time);
    return scheme;
  }

  updatePrisoner(agent: Agent, dt: number, time: number, world: World, agents: readonly Agent[]): boolean {
    if (this.concealed.has(agent.id)) { agent.state = "concealedInVehicle"; agent.path = null; agent.amp = 0; return true; }
    const assignment = this.activeAssignment(agent.id); if (!assignment) return false;
    const { scheme, node } = assignment;
    if (this.isPassive(node.action)) return node.action === "depart-vehicle" || this.concealed.has(agent.id);
    if (node.targetTile >= 0) {
      const tx = node.targetTile % world.size, tz = Math.floor(node.targetTile / world.size);
      if (Math.hypot(agent.x - (tx + .5), agent.z - (tz + .5)) > 1.35) {
        if (!agent.path) {
          const start = world.idx(Math.floor(agent.x), Math.floor(agent.z));
          const path = astar(world.size, start, node.targetTile, (i) => passable(world, i, false, agent.accessKeys), 35000,
            (from, to) => world.canNavigateEdge(from, to));
          if (path) { agent.path = path; agent.pathI = 0; }
          else { node.attempts++; node.blocker = "Assigned member cannot reach the task"; node.state = "waiting"; return false; }
        }
        agent.state = `escape:${node.action}`; followPath(agent, dt, world, false); return true;
      }
    }
    agent.path = null; agent.state = `escape:${node.action}`; agent.amp = .22;
    const def = ACTION_BY_ID.get(node.action)!;
    const rate = .55 + skill(agent.profile, def.skill) * .07 + aptitude(agent.profile, "dexterity") * .018 + aptitude(agent.profile, "willpower") * .012;
    node.progress += dt * rate / Math.max(1, node.seconds);
    if (node.progress >= 1) this.completePhysicalNode(scheme, node, agent, time, world, agents);
    return true;
  }

  consumeEscaped(): number[] { return this.escapedIds.splice(0); }
  schemeForAgent(agentId: number): EscapeScheme | null { return [...this.schemes.values()].find((scheme) => scheme.memberIds.includes(agentId) && !["escaped", "failed", "dissolved"].includes(scheme.state)) ?? null; }
  knownNodes(memberId: number, schemeId: number): PlanNode[] {
    const scheme = this.schemes.get(schemeId), known = this.knowledge.get(`${schemeId}:${memberId}`); if (!scheme || !known) return [];
    return known.nodeIds.map((id) => scheme.nodes.find((node) => node.id === id)).filter((node): node is PlanNode => !!node);
  }

  saveData() { return {
    schemes: [...this.schemes.values()].map((s) => ({ ...s, memberIds: [...s.memberIds], escapedMemberIds: [...s.escapedMemberIds], nodes: s.nodes.map(copyNode), compromisedNodes: [...s.compromisedNodes] })),
    knowledge: [...this.knowledge.values()].map((row) => ({ ...row, nodeIds: [...row.nodeIds] })),
    commitments: [...this.commitments.values()].map((row) => ({ ...row })), externalVehicles: [...this.externalVehicles.values()].map((row) => ({ ...row, passengerIds: [...row.passengerIds] })),
    concealed: [...this.concealed.values()].map((row) => ({ ...row })), nextSchemeId: this.nextSchemeId, nextNodeId: this.nextNodeId,
    nextCommitmentId: this.nextCommitmentId, nextVehicleId: this.nextVehicleId, rngState: this.rngState,
  }; }
  loadData(data: Partial<ReturnType<AdvancedEscapeSystem["saveData"]>>): void {
    this.schemes.clear(); for (const s of data.schemes ?? []) this.schemes.set(s.id, { ...s, memberIds: [...s.memberIds], escapedMemberIds: [...(s.escapedMemberIds ?? [])], nodes: s.nodes.map(copyNode), compromisedNodes: [...s.compromisedNodes] });
    this.knowledge.clear(); for (const row of data.knowledge ?? []) this.knowledge.set(`${row.schemeId}:${row.memberId}`, { ...row, nodeIds: [...row.nodeIds] });
    this.commitments.clear(); for (const row of data.commitments ?? []) this.commitments.set(row.id, { ...row });
    this.externalVehicles.clear(); for (const row of data.externalVehicles ?? []) this.externalVehicles.set(row.id, { ...row, passengerIds: [...row.passengerIds] });
    this.concealed.clear(); for (const row of data.concealed ?? []) this.concealed.set(row.agentId, { ...row });
    this.nextSchemeId = data.nextSchemeId ?? 1; this.nextNodeId = data.nextNodeId ?? 1; this.nextCommitmentId = data.nextCommitmentId ?? 1;
    this.nextVehicleId = data.nextVehicleId ?? 1_000_000; this.rngState = data.rngState ?? 0x5d84ce27;
  }

  private generatePlan(scheme: EscapeScheme, op: EscapeOperation, architect: Agent, world: World): void {
    const gate = world.piecesOfKind(Obj.Gatehouse)[0];
    const gateTile = gate ? world.idx(gate.x + 1, gate.z + 1) : world.idx(374, Math.max(1, world.size - 4));
    const securityTile = this.roomTarget(world, RoomType.Security) ?? op.rallyTile;
    const recordsTile = this.roomTarget(world, RoomType.RecordsOffice) ?? this.roomTarget(world, RoomType.Offices) ?? securityTile;
    const laundryTile = this.roomTarget(world, RoomType.Laundry) ?? recordsTile;
    const utilitiesTile = this.roomTarget(world, RoomType.Utilities) ?? securityTile;
    const deliveryTile = this.roomTarget(world, RoomType.Delivery) ?? gateTile;
    const visitTile = this.roomTarget(world, RoomType.Visitation) ?? gateTile;
    const infirmaryTile = this.roomTarget(world, RoomType.Infirmary) ?? gateTile;
    const rallyTile = op.rallyTile >= 0 ? op.rallyTile : world.idx(Math.floor(architect.x), Math.floor(architect.z));
    const scout = this.addNode(scheme, "observe", [], architect.id, securityTile, "Observe the intended route and current security", "replan");
    let prior = scout.id;
    if (aptitude(architect.profile, "memory") <= 5 && scheme.complexityBudget >= 5) prior = this.addNode(scheme, "write-note", [prior], architect.id, rallyTile, "Record route, timing, and assignments", "substitute", true).id;
    if (scheme.mode === "perimeter") {
      const item = op.method === "climb" ? "rope" : "cutter";
      const insideHelp = scheme.complexityBudget >= 7 ? this.addNode(scheme, "bribe-staff", [prior], op.leaderId, this.sourceTile(item, world) ?? rallyTile, "Compromise a worker to leave a controlled tool unsecured", "branch", true, "", "", "leave-tool") : null;
      const asset = this.addNode(scheme, "acquire-item", [prior, ...(insideHelp ? [insideHelp.id] : [])], this.memberFor(op, item === "rope" ? "supplier" : "cutter"), this.sourceTile(item, world) ?? rallyTile, `Acquire ${item}`, "retry", false, item);
      const stash = this.addNode(scheme, "stash", [asset.id], asset.actors[0], rallyTile, "Stage the breach tool near the rally point", "retry", false, item);
      const distraction = scheme.memberIds.length >= 3 ? this.addNode(scheme, "start-distraction", [scout.id], this.memberFor(op, "lookout"), rallyTile, "Draw response away from the perimeter", "delay", true) : null;
      this.addNode(scheme, "legacy-execute", [stash.id, ...(distraction ? [distraction.id] : [])], op.leaderId, rallyTile, "Cut or climb the physical perimeter and flee", "replan");
    } else if (scheme.mode === "tunnel" || scheme.mode === "outside-assistance") {
      const insideHelp = scheme.complexityBudget >= 7 ? this.addNode(scheme, "bribe-staff", [prior], op.leaderId, this.sourceTile("shovel", world) ?? rallyTile, "Compromise a worker to leave a digging tool unsecured", "branch", true, "", "", "leave-tool") : null;
      const tool = this.addNode(scheme, "acquire-item", [prior, ...(insideHelp ? [insideHelp.id] : [])], this.memberFor(op, "digger"), this.sourceTile("shovel", world) ?? rallyTile, "Acquire a digging tool", "retry", false, "shovel");
      const stash = this.addNode(scheme, "stash", [tool.id], tool.actors[0], rallyTile, "Move digging tools and spoons into the entry cache", "retry", false, "shovel");
      if (scheme.mode === "outside-assistance") {
        const contact = this.addNode(scheme, "contact-outsider", [scout.id], op.architectId, this.roomTarget(world, RoomType.MailRoom) ?? rallyTile, "Arrange an outside digger and pickup", "retry");
        const wait = this.addNode(scheme, "wait-external", [contact.id], op.leaderId, rallyTile, "Wait for the outside tunnel commitment", "delay");
        const outside = this.addNode(scheme, "outside-dig", [wait.id, stash.id], tool.actors[0], rallyTile, "Connect the internal tunnel to the outside excavation", "replan");
        this.addNode(scheme, "legacy-execute", [outside.id], op.leaderId, rallyTile, "Traverse the connected tunnel and flee", "replan");
      } else this.addNode(scheme, "legacy-execute", [stash.id], op.leaderId, rallyTile, "Dig, surface, and leave through the shared tunnel", "replan");
    } else if (scheme.mode === "credential") {
      const leak = scheme.complexityBudget >= 7 ? this.addNode(scheme, "bribe-staff", [prior], op.leaderId, recordsTile, "Compromise records staff for a schedule warning", "branch", true, "", "", "leak-schedule") : null;
      const record = this.addNode(scheme, "steal-record", [prior, ...(leak ? [leak.id] : [])], this.memberFor(op, "scout"), recordsTile, "Copy staff movements and credential format", "retry", false, "copied-schedule");
      const uniform = this.addNode(scheme, "acquire-item", [scout.id], this.memberFor(op, "supplier"), laundryTile, "Divert a staff uniform", "retry", false, "staff-uniform");
      const pass = this.addNode(scheme, "forge-pass", [record.id], op.architectId, recordsTile, "Forge a movement authorization", "substitute", false, "forged-pass", "movement-pass");
      const key = this.addNode(scheme, "copy-key", [record.id], this.memberFor(op, "supplier"), this.sourceTile("key-blank", world) ?? recordsTile, "Mold and duplicate a staff key", "substitute", true, "duplicate-staff-key", "staff-key");
      const staffSabotage = scheme.complexityBudget >= 9 ? this.addNode(scheme, "bribe-staff", [record.id], op.leaderId, utilitiesTile, "Compromise maintenance staff to disable a security device", "branch", true, "", "", "disable-device") : null;
      const sabotage = scheme.complexityBudget >= 7 ? this.addNode(scheme, "sabotage-circuit", [record.id, ...(staffSabotage ? [staffSabotage.id] : [])], this.memberFor(op, "supplier"), utilitiesTile, "Disable the credential camera circuit", "branch", true) : null;
      const exit = this.addNode(scheme, "credential-walkout", [uniform.id, pass.id, key.id, ...(sabotage ? [sabotage.id] : [])], op.leaderId, gateTile, "Present the disguise and leave through the staff route", "replan");
      exit.actors = [...scheme.memberIds];
    } else if (scheme.mode === "vehicle") {
      const schedule = this.addNode(scheme, "steal-record", [prior], this.memberFor(op, "scout"), recordsTile, "Copy the outgoing truck and inspection schedule", "retry", false, "delivery-manifest");
      const bribe = this.addNode(scheme, "bribe-staff", [schedule.id], op.leaderId, deliveryTile, "Bribe a driver or Gatehouse guard to ignore the concealment", "substitute", true, "", "", "alter-manifest");
      if (scheme.complexityBudget >= 7) {
        const blackmail = this.addNode(scheme, "blackmail-staff", [schedule.id], op.architectId, deliveryTile, "Pressure a compromised employee to alter the outgoing manifest", "branch", true, "", "", "alter-manifest");
        bribe.alternatives.push(blackmail.id); blackmail.alternatives.push(bribe.id);
      }
      const hide = this.addNode(scheme, "hide-in-vehicle", [schedule.id, bribe.id], this.memberFor(op, "supplier"), deliveryTile, "Conceal members in outgoing cargo", "delay");
      hide.actors = [...scheme.memberIds];
      this.addNode(scheme, "depart-vehicle", [hide.id], op.leaderId, gateTile, "Pass inspection and depart in the truck", "replan");
    } else if (scheme.mode === "visitation") {
      const contact = this.addNode(scheme, "contact-outsider", [prior], op.architectId, this.roomTarget(world, RoomType.MailRoom) ?? visitTile, "Arrange a cooperative visitor and clothing", "retry");
      const wait = this.addNode(scheme, "wait-external", [contact.id], op.leaderId, visitTile, "Wait for the visitor commitment", "delay");
      const bribe = this.addNode(scheme, "bribe-staff", [contact.id], op.leaderId, visitTile, "Compromise visit processing", "substitute", true, "", "", "approve-visitor");
      if (scheme.complexityBudget >= 8) {
        const blackmail = this.addNode(scheme, "blackmail-staff", [contact.id], op.architectId, visitTile, "Coerce a visit worker using gathered leverage", "branch", true, "", "", "approve-visitor");
        bribe.alternatives.push(blackmail.id); blackmail.alternatives.push(bribe.id);
      }
      const clothes = this.addNode(scheme, "acquire-item", [wait.id], this.memberFor(op, "supplier"), visitTile, "Receive civilian clothing and a visitor pass", "delay", false, "civilian-clothes");
      const exit = this.addNode(scheme, "visitation-exit", [clothes.id, bribe.id], op.leaderId, gateTile, "Merge with departing visitors and leave", "replan");
      exit.actors = [...scheme.memberIds];
    } else {
      const contact = this.addNode(scheme, "contact-outsider", [prior], op.architectId, this.roomTarget(world, RoomType.MailRoom) ?? infirmaryTile, "Arrange an outside medical pickup", "retry");
      const bribe = this.addNode(scheme, "bribe-staff", [contact.id], op.leaderId, infirmaryTile, "Compromise a doctor or orderly", "substitute", false, "", "", "approve-visitor");
      const wait = this.addNode(scheme, "wait-external", [contact.id], op.leaderId, infirmaryTile, "Wait for the medical transfer vehicle", "delay");
      const exit = this.addNode(scheme, "medical-transfer", [bribe.id, wait.id], op.leaderId, infirmaryTile, "Board the medical transfer and pass the road gate", "replan");
      exit.actors = [...scheme.memberIds];
    }
  }

  private addNode(scheme: EscapeScheme, actionId: PlanAction, dependencies: number[], actorId: number, targetTile: number,
    label: string, failure: PlanFailureMode, optional = false, itemDefId = "", credentialKind: CredentialKind | "" = "",
    corruptionAction: CorruptionAction | "" = ""): PlanNode {
    const def = ACTION_BY_ID.get(actionId)!;
    const node: PlanNode = { id: this.nextNodeId++, schemeId: scheme.id, action: actionId, label, state: dependencies.length ? "planned" : "available",
      dependencies: [...dependencies], alternatives: [], actors: actorId >= 0 ? [actorId] : [], targetTile, targetRoomId: -1,
      itemDefId, sourceItemId: -1, credentialKind, corruptionAction, progress: 0, seconds: def.baseSeconds,
      attempts: 0, failure, noise: def.noise, evidenceRisk: def.evidenceRisk, blocker: "", optional, activatedAt: -1, completedAt: -1 };
    scheme.nodes.push(node); return node;
  }

  private activateReadyNodes(scheme: EscapeScheme, time: number, byId: Map<number, Agent>): void {
    for (const node of scheme.nodes) {
      if (!['planned', 'available', 'waiting'].includes(node.state)) continue;
      if (!this.dependenciesComplete(scheme, node)) continue;
      if (node.state === "waiting" && node.attempts > 0 && time - node.activatedAt < Math.min(30, 3 + node.attempts * 2)) continue;
      if (!node.actors.length || !node.actors.some((id) => byId.has(id))) {
        const replacement = this.replacementActor(scheme, node, byId); if (replacement >= 0) node.actors = [replacement];
        else { node.blocker = "No available member can perform this task"; node.state = "waiting"; continue; }
      }
      node.state = "active"; node.activatedAt = time; node.blocker = ""; scheme.state = scheme.nodes.some((n) => n.action === "rally" && n.state === "complete") ? "staging" : "preparing";
    }
  }

  private advancePassiveNodes(scheme: EscapeScheme, op: EscapeOperation | null, dt: number, time: number,
    world: World, agents: readonly Agent[]): void {
    for (const node of scheme.nodes.filter((n) => n.state === "active")) {
      if (node.action === "wait-external") {
        const commitment = [...this.commitments.values()].find((row) => row.schemeId === scheme.id);
        if (!commitment) { node.blocker = "No outside commitment was created"; node.state = "waiting"; continue; }
        if (["arrived", "fulfilled"].includes(commitment.state)) this.finishNode(scheme, node, time, world, agents);
        else node.blocker = `${commitment.type} commitment is ${commitment.state}`;
      } else if (node.action === "legacy-execute") {
        if (!op) { node.state = "failed"; node.blocker = "Original breach operation no longer exists"; continue; }
        if (op.state !== "executing" && op.state !== "completed") {
          this.stageLegacyAssets(scheme, op, agents, time);
          op.advancedReady = true; op.state = "executing"; scheme.state = "executing";
        }
        if (op.state === "completed" || !scheme.memberIds.some((id) => agents.some((agent) => agent.id === id))) this.finishNode(scheme, node, time, world, agents);
      } else if (node.action === "depart-vehicle") {
        const passengers = [...this.concealed.values()].filter((row) => row.schemeId === scheme.id);
        if (!passengers.length && scheme.escapedMemberIds.length) this.finishNode(scheme, node, time, world, agents);
        else if (!passengers.length) { node.blocker = "No member is concealed in an outgoing vehicle"; node.state = "waiting"; }
      } else if (node.action === "start-distraction") {
        const instigator = agents.find((a) => node.actors.includes(a.id));
        const target = instigator && agents.find((a) => a.id !== instigator.id && !scheme.memberIds.includes(a.id) && Math.hypot(a.x - instigator.x, a.z - instigator.z) < 3);
        if (instigator && target) { const fight = this.combat.start(instigator, target, time, true); if (fight) this.finishNode(scheme, node, time, world, agents); }
      } else if (this.concealed.has(node.actors[0])) node.progress += dt;
    }
  }

  private completePhysicalNode(scheme: EscapeScheme, node: PlanNode, actor: Agent, time: number,
    world: World, agents: readonly Agent[]): void {
    if (node.action === "acquire-item" || node.action === "steal-record") {
      const existing = this.findCarried(actor.id, node.itemDefId);
      let item = existing ?? this.findSourceItem(node.itemDefId, actor, world);
      if (!item) { node.attempts++; node.state = "waiting"; node.progress = 0; node.blocker = `No physical ${node.itemDefId} is currently available`; return; }
      if (!existing && !this.items.moveToContainer(item.id, `agent:${actor.id}:pockets`, time, actor.id, true)) {
        node.state = "waiting"; node.blocker = "The assigned member cannot conceal the item"; return;
      }
      node.sourceItemId = item.id;
    } else if (node.action === "write-note") {
      const note = this.items.create("plan-note", time, { ownerId: actor.id, quality: scheme.confidence });
      this.items.moveToContainer(note.id, `agent:${actor.id}:pockets`, time, actor.id, true); node.sourceItemId = note.id;
    } else if (node.action === "stash") {
      const item = this.findCarried(actor.id, node.itemDefId);
      if (!item || !this.items.moveToContainer(item.id, scheme.cacheContainer, time, actor.id, true)) { node.state = "waiting"; node.blocker = "The staged asset is missing"; return; }
    } else if (node.action === "forge-pass" || node.action === "copy-key") {
      const ingredients = node.action === "copy-key" ? ["key-blank", "metal-scrap"] : ["paper", "ink"];
      const consumed = ingredients.map((defId) => this.findCarried(actor.id, defId) ?? this.findSourceItem(defId, actor, world));
      if (consumed.some((item) => !item)) {
        node.state = "waiting"; node.progress = 0;
        node.blocker = `Missing physical ${ingredients.filter((_, i) => !consumed[i]).join(" and ")}`; return;
      }
      if (node.action === "copy-key") {
        const mold = this.items.create("key-mold", time, { ownerId: actor.id, quality: scheme.confidence });
        this.items.moveToContainer(mold.id, `agent:${actor.id}:pockets`, time, actor.id, true);
        node.sourceItemId = mold.id;
      }
      for (const item of consumed) if (item) this.items.destroy(item.id, time, actor.id, node.action === "copy-key" ? "key-casting" : "document-forgery");
      const quality = clamp(.22 + skill(actor.profile, node.action === "copy-key" ? "toolcraft" : "deception") * .075 + aptitude(actor.profile, "dexterity") * .025);
      const kind = node.credentialKind || (node.action === "copy-key" ? "staff-key" : "movement-pass");
      const source = node.sourceItemId;
      node.sourceItemId = this.credentials.forge(kind, actor.id, quality, time, source);
      if (source >= 0) this.items.destroy(source, time, actor.id, "key-mold-consumed");
    } else if (node.action === "bribe-staff" || node.action === "blackmail-staff") {
      const preferred = node.corruptionAction === "leave-tool" || node.corruptionAction === "disable-device" ? Obj.Workman :
        node.corruptionAction === "leak-schedule" || node.corruptionAction === "misfile-evidence" ? Obj.Investigator :
        scheme.mode === "medical" ? Obj.Doctor : scheme.mode === "vehicle" ? Obj.Guard : Obj.Cook;
      const target = [...agents].filter((a) => a.kind !== Obj.Prisoner && a.kind !== Obj.SecurityDog && Math.hypot(a.x - actor.x, a.z - actor.z) <= 4.5)
        .sort((a, b) => node.action === "blackmail-staff" ? this.staff.leverageAgainst(b.id) - this.staff.leverageAgainst(a.id) || a.id - b.id :
          (a.kind === preferred ? -1 : 0) - (b.kind === preferred ? -1 : 0) || Math.hypot(a.x - actor.x, a.z - actor.z) - Math.hypot(b.x - actor.x, b.z - actor.z))[0];
      if (!target) { node.state = node.optional ? "cancelled" : "waiting"; node.blocker = "No suitable staff target"; return; }
      const leverage = node.action === "blackmail-staff" ? this.staff.leverageAgainst(target.id) : 0;
      if (node.action === "blackmail-staff" && leverage < .22) { node.state = node.optional ? "cancelled" : "waiting"; node.blocker = "No evidence-backed leverage against staff"; return; }
      const amount = node.action === "blackmail-staff" ? 0 : 8 + Math.min(60, scheme.complexityBudget * 3);
      const actionId = node.corruptionAction || (scheme.mode === "vehicle" ? "alter-manifest" : scheme.mode === "medical" ? "approve-visitor" : "warn-audit");
      if (!this.staff.attemptCompromise(actor, target, time, amount, actionId, leverage)) {
        node.attempts++; node.state = node.optional ? "complete" : "waiting"; node.blocker = "Staff approach failed or was reported";
        if (node.optional) node.completedAt = time; return;
      }
    } else if (node.action === "sabotage-circuit") {
      const roomId = world.roomId[node.targetTile];
      if (!this.facility.sabotageCircuit(roomId, actor.id, time, 20 + scheme.complexityBudget * 2)) { node.state = "waiting"; node.blocker = "No live security circuit can be reached"; return; }
    } else if (node.action === "contact-outsider") {
      if (!this.createCommitment(scheme, actor, time)) { node.state = "waiting"; node.blocker = "No trusted outside contact is available"; return; }
    } else if (node.action === "hide-in-vehicle") {
      const truck = this.logistics.trucks.filter((row) => ["unloading", "departing"].includes(row.state)).sort((a, b) => a.id - b.id)[0];
      if (!truck) { node.state = "waiting"; node.blocker = "No outgoing truck is present"; node.progress = 0; return; }
      this.concealed.set(actor.id, { agentId: actor.id, vehicleId: truck.id, schemeId: scheme.id,
        concealment: clamp(.34 + skill(actor.profile, "stealth") * .055 + skill(actor.profile, "smuggling") * .04), checked: false, detected: false, boardedAt: time });
      actor.x = truck.x; actor.z = truck.z; actor.path = null; actor.state = "concealedInVehicle";
      if (this.completeOneActor(node, actor.id)) return;
    } else if (node.action === "visitation-exit" || node.action === "medical-transfer") {
      const commitment = [...this.commitments.values()].find((row) => row.schemeId === scheme.id && ["arrived", "fulfilled"].includes(row.state));
      const vehicle = commitment && this.externalVehicles.get(commitment.vehicleId);
      if (!vehicle) { node.state = "waiting"; node.blocker = "The external vehicle has not arrived"; return; }
      this.boardExternalVehicle(scheme, vehicle, actor, time);
      if (this.completeOneActor(node, actor.id)) return;
      vehicle.state = "departing"; vehicle.timer = 8;
    } else if (node.action === "credential-walkout") {
      const pass = this.credentials.bestPresentation(actor.id, "movement-pass", time);
      const uniform = this.findCarried(actor.id, "staff-uniform") || this.findCarried(actor.id, "civilian-clothes");
      const gate = [...this.facility.gatehouses.values()][0], guard = gate && agents.find((a) => a.id === gate.guardId);
      const areaId = this.facility.areaIdAt(world.idx(Math.floor(actor.x), Math.floor(actor.z)));
      const familiarity = guard ? this.staff.familiarity(guard.id, areaId) : 0;
      const deception = skill(actor.profile, "deception") / 10 + (pass?.quality ?? 0) * .45 + (uniform ? .22 : 0) - familiarity * .3;
      const bribed = guard && this.staff.permits(guard.id, actor.id, "ignore-access", time);
      if (!bribed && (!pass || !uniform || deception < .46 + this.random() * .28)) { this.exposeExitAttempt(scheme, actor, time, "Forged credential presentation failed"); node.state = "failed"; return; }
      this.queueEscape(scheme, actor.id);
      if (this.completeOneActor(node, actor.id)) return;
      this.finishNode(scheme, node, time, world, agents); return;
    } else if (node.action === "outside-dig") {
      const commitment = [...this.commitments.values()].find((row) => row.schemeId === scheme.id && row.type === "outside-digger" && ["arrived", "fulfilled"].includes(row.state));
      if (!commitment) { node.state = "waiting"; node.blocker = "Outside excavation has not reached the rendezvous"; return; }
    }
    this.finishNode(scheme, node, time, world, agents);
  }

  private finishNode(scheme: EscapeScheme, node: PlanNode, time: number, _world: World, agents: readonly Agent[]): void {
    node.state = "complete"; node.progress = 1; node.completedAt = time; node.blocker = "";
    scheme.state = node.action.includes("exit") || node.action === "depart-vehicle" || node.action === "legacy-execute" ? "executing" : "preparing";
    this.createTrace(scheme, node, time, agents);
  }

  private createTrace(scheme: EscapeScheme, node: PlanNode, time: number, agents: readonly Agent[]): void {
    const auditBonus = (node.action === "acquire-item" ? this.management.procedure("tool-count", time)?.detectionBonus :
      node.action === "copy-key" ? this.management.procedure("key-signout", time)?.detectionBonus :
      node.action === "hide-in-vehicle" ? this.management.procedure("shipment-manifest", time)?.detectionBonus : 0) ?? 0;
    if (node.evidenceRisk <= 0 || this.random() > node.evidenceRisk * (.18 + node.noise * .5 + auditBonus * .35)) return;
    const actor = agents.find((a) => node.actors.includes(a.id)); if (!actor) return;
    const guard = agents.find((a) => [Obj.Guard, Obj.Investigator, Obj.ChiefOfficer].includes(a.kind as never) && Math.hypot(a.x - actor.x, a.z - actor.z) < 8);
    const category = node.action === "sabotage-circuit" ? "utility" : node.action === "copy-key" || node.action === "forge-pass" ? "credential" : "escape";
    const incident = this.institution.createIncident(category, actor.id, -1, actor.x, actor.z, time, node.itemDefId);
    const confidence = guard ? .62 + this.random() * .28 : .28 + this.random() * .28;
    this.institution.addEvidence(incident.id, guard ? "guard" : "audit", guard?.id ?? -1, actor.id, confidence,
      guard ? `Staff observed suspicious activity consistent with: ${node.label}` : `A delayed audit found traces consistent with: ${node.label}`,
      time, actor.x, actor.z, node.sourceItemId, "The activity may have an innocent work, social, or maintenance explanation");
    scheme.exposure = clamp(scheme.exposure + confidence * .08);
  }

  private tickCommitments(_dt: number, time: number, world: World): void {
    for (const row of this.commitments.values()) {
      if (["fulfilled", "failed"].includes(row.state) || time < row.dueAt) continue;
      if (row.state === "scheduled") {
        row.state = "arrived";
        if (["visitor", "medical", "outside-digger"].includes(row.type)) {
          const id = this.nextVehicleId++, kind = row.type === "medical" ? "medical" : row.type === "visitor" ? "visitor" : "outside";
          this.externalVehicles.set(id, { id, kind, state: "arriving", x: 374.5, z: -8, timer: 8, warning: "", passengerIds: [] }); row.vehicleId = id;
        } else row.state = "fulfilled";
      }
    }
    void world;
  }

  private tickVehicles(dt: number, time: number, world: World, byId: Map<number, Agent>): void {
    const allVehicles = new Map<number, { state: string; x: number; z: number }>();
    for (const truck of this.logistics.trucks) allVehicles.set(truck.id, truck);
    for (const vehicle of this.externalVehicles.values()) {
      vehicle.timer -= dt;
      if (vehicle.state === "arriving") { vehicle.z = Math.min(375, vehicle.z + dt * 48); if (vehicle.z >= 375) {
        vehicle.state = "unloading"; vehicle.timer = vehicle.kind === "outside" ? 20 : 12;
        const commitment = [...this.commitments.values()].find((row) => row.vehicleId === vehicle.id);
        if (commitment && vehicle.kind === "outside") commitment.state = "fulfilled";
      } }
      else if (vehicle.state === "unloading" && vehicle.timer <= 0 && (vehicle.passengerIds.length || vehicle.kind === "outside")) { vehicle.state = "departing"; vehicle.timer = 8; }
      else if (vehicle.state === "departing") vehicle.z += dt * 48;
      allVehicles.set(vehicle.id, vehicle);
    }
    for (const record of [...this.concealed.values()]) {
      const vehicle = allVehicles.get(record.vehicleId), agent = byId.get(record.agentId), scheme = this.schemes.get(record.schemeId);
      if (!scheme) { this.concealed.delete(record.agentId); continue; }
      if (vehicle && agent) { agent.x = vehicle.x; agent.z = vehicle.z; agent.state = "concealedInVehicle"; }
      if (vehicle && vehicle.state === "departing" && !record.checked && this.facility.gateInspectionComplete(record.vehicleId)) {
        record.checked = true;
        const gate = [...this.facility.gatehouses.values()][0], guard = gate && byId.get(gate.guardId);
        const external = this.externalVehicles.get(record.vehicleId);
        const ignored = !!guard && this.staff.permits(guard.id, record.agentId, "ignore-access", time);
        const manifestAltered = [...this.staff.profiles.values()].some((profile) => this.staff.permits(profile.agentId, record.agentId, "alter-manifest", time));
        const approvedMovement = !!external && ["visitor", "medical"].includes(external.kind) &&
          [...this.staff.profiles.values()].some((profile) => this.staff.permits(profile.agentId, record.agentId, "approve-visitor", time));
        const intensity = gate?.inspection === "full" ? .82 : gate?.inspection === "standard" ? .55 : gate?.inspection === "spot" ? .28 : 0;
        const paperworkMitigation = manifestAltered ? .42 : approvedMovement ? .58 : 1;
        if (!ignored && this.random() < intensity * paperworkMitigation * (1 - record.concealment)) { record.detected = true; this.catchPassenger(record, agent, scheme, time, gate?.anchor ?? -1, world); }
      }
      if (!vehicle || (vehicle.state === "departing" && vehicle.z > world.size + 6)) {
        if (!record.detected) this.queueEscape(scheme, record.agentId);
        this.concealed.delete(record.agentId);
      }
    }
    for (const [id, vehicle] of this.externalVehicles) if (vehicle.state === "departing" && vehicle.z > world.size + 10) this.externalVehicles.delete(id);
  }

  private createCommitment(scheme: EscapeScheme, actor: Agent, time: number): ExternalCommitment | null {
    if ([...this.commitments.values()].some((row) => row.schemeId === scheme.id && row.state !== "failed")) return [...this.commitments.values()].find((row) => row.schemeId === scheme.id)!;
    const contacts = [...(this.market.contacts.get(actor.id) ?? [])].sort((a, b) => b.trust * b.resources - a.trust * a.resources || a.id - b.id);
    const contact = contacts[0]; if (!contact) return null;
    const type: ExternalCommitment["type"] = scheme.mode === "vehicle" ? "driver" : scheme.mode === "visitation" ? "visitor" : scheme.mode === "medical" ? "medical" : "outside-digger";
    const cost = Math.max(0, Math.round(8 + scheme.complexityBudget * 2 - contact.resources * 8));
    const escrowId = `escape:${scheme.id}:external-escrow`;
    this.items.ensureContainer({ id: escrowId, name: `Escape scheme ${scheme.id} outside payment`, x: actor.x, z: actor.z,
      capacity: 30, concealment: .8, bodyCapacity: 0, lockedTier: "none", ownerId: contact.id, tags: ["cash", "external", "escape"] });
    let paid = cost > 0 ? this.market.collectTo(actor.id, escrowId, cost, time) : 0;
    if (paid < cost && scheme.sponsoredGangId >= 0) {
      const gang = this.gangs.gangs.get(scheme.sponsoredGangId);
      if (gang) for (const note of this.items.itemsIn(gang.treasuryContainer).filter((item) => item.denomination > 0).sort((a, b) => b.denomination - a.denomination || a.id - b.id)) {
        if (paid >= cost) break;
        if (this.items.moveToContainer(note.id, escrowId, time, actor.id, true)) paid += note.denomination;
      }
    }
    if (cost > 0 && paid < Math.min(cost, 3) && contact.trust < .65) return null;
    const id = this.nextCommitmentId++, trust = clamp(contact.trust * .65 + contact.resources * .35);
    const row: ExternalCommitment = { id, schemeId: scheme.id, type, contactId: contact.id, cost: paid,
      trust, arrangedAt: time, dueAt: time + HOUR_SECONDS * (2 + (1 - trust) * 10), state: "scheduled", vehicleId: -1,
      evidenceRisk: .18 + (1 - trust) * .35 };
    this.commitments.set(id, row); return row;
  }

  private boardExternalVehicle(scheme: EscapeScheme, vehicle: ExternalEscapeVehicle, agent: Agent, time: number): void {
    if (!vehicle.passengerIds.includes(agent.id)) vehicle.passengerIds.push(agent.id);
    this.concealed.set(agent.id, { agentId: agent.id, vehicleId: vehicle.id, schemeId: scheme.id,
      concealment: clamp(.28 + skill(agent.profile, "deception") * .05 + skill(agent.profile, "stealth") * .04), checked: false, detected: false, boardedAt: time });
    agent.x = vehicle.x; agent.z = vehicle.z; agent.path = null; agent.state = "concealedInVehicle";
  }

  private catchPassenger(record: ConcealedPassenger, agent: Agent | undefined, scheme: EscapeScheme,
    time: number, gateAnchor: number, world: World): void {
    if (agent) { const x = gateAnchor >= 0 ? gateAnchor % world.size : 374, z = gateAnchor >= 0 ? Math.floor(gateAnchor / world.size) : 375;
      agent.x = x + .5; agent.z = z + 3.5; agent.cuffed = true; agent.state = "caughtAtGatehouse"; }
    const incident = this.institution.createIncident("escape", record.agentId, -1, agent?.x ?? 374, agent?.z ?? 375, time);
    this.institution.addEvidence(incident.id, "search", -1, record.agentId, .99,
      "Gatehouse search found an inmate concealed in an outgoing vehicle", time, agent?.x ?? 374, agent?.z ?? 375, -1,
      "No credible innocent explanation remains after physical identification");
    scheme.exposure = 1; scheme.state = "failed"; record.detected = true; this.concealed.delete(record.agentId);
  }

  private exposeExitAttempt(scheme: EscapeScheme, actor: Agent, time: number, summary: string): void {
    const incident = this.institution.createIncident("credential", actor.id, -1, actor.x, actor.z, time);
    this.institution.addEvidence(incident.id, "guard", -1, actor.id, .96, summary, time, actor.x, actor.z, -1,
      "The credential may have been issued incorrectly rather than deliberately forged");
    actor.cuffed = true; actor.state = "caughtAtGatehouse"; scheme.exposure = 1;
  }

  private queueEscape(scheme: EscapeScheme, agentId: number): void {
    if (!this.escapedIds.includes(agentId)) this.escapedIds.push(agentId);
    if (!scheme.escapedMemberIds.includes(agentId)) scheme.escapedMemberIds.push(agentId);
    scheme.memberIds = scheme.memberIds.filter((id) => id !== agentId);
    if (!scheme.memberIds.length) scheme.state = "escaped";
  }

  private stageLegacyAssets(scheme: EscapeScheme, op: EscapeOperation, agents: readonly Agent[], time: number): void {
    const cached = this.items.itemsIn(scheme.cacheContainer).sort((a, b) => a.id - b.id);
    for (const item of cached) {
      const role = ["cutter", "hacksaw-blade", "pruning-shears"].includes(item.defId) ? "cutter" :
        ["spoon", "trowel", "shovel"].includes(item.defId) ? "digger" : "supplier";
      const memberId = op.members.find((member) => member.role === role)?.agentId ?? op.leaderId;
      const member = agents.find((agent) => agent.id === memberId); if (!member) continue;
      if (this.items.moveToContainer(item.id, `agent:${member.id}:pockets`, time, member.id, true) && op.acquisition &&
          (["cutter", "hacksaw-blade", "pruning-shears"].includes(item.defId) || ["spoon", "trowel", "shovel"].includes(item.defId))) {
        op.acquisition.asset = item.defId; op.acquisition.state = "needed"; op.acquisition.holderId = member.id; op.acquisition.itemId = item.id;
      }
    }
  }

  /** Multi-member physical exits are shared nodes, but every member must
   * independently reach and complete the action. */
  private completeOneActor(node: PlanNode, actorId: number): boolean {
    node.actors = node.actors.filter((id) => id !== actorId);
    if (!node.actors.length) return false;
    node.progress = 0; node.state = "active"; node.blocker = `${node.actors.length} assigned member${node.actors.length === 1 ? "" : "s"} still need to reach the exit`;
    return true;
  }

  private handleFailure(scheme: EscapeScheme, node: PlanNode, time: number, byId: Map<number, Agent>): void {
    if (node.failure === "abort") { scheme.state = "failed"; scheme.blocker = node.blocker || `${node.label} failed`; return; }
    if (node.failure === "delay" || node.failure === "retry") {
      node.state = "waiting"; node.progress = 0; node.attempts++; node.activatedAt = time; scheme.state = "suspended"; scheme.blocker = node.blocker || `Waiting to retry ${node.label}`; return;
    }
    if (node.failure === "substitute") {
      const replacement = this.replacementActor(scheme, node, byId); if (replacement >= 0) { node.actors = [replacement]; node.state = "waiting"; node.progress = 0; node.attempts++; return; }
    }
    if (time - scheme.lastReplanAt > HOUR_SECONDS) {
      scheme.lastReplanAt = time; scheme.confidence = clamp(scheme.confidence - .08); node.state = node.optional ? "cancelled" : "waiting"; node.progress = 0; node.attempts++;
      scheme.blocker = `Architect is revising the failed ${node.label.toLowerCase()}`;
    } else { scheme.state = "suspended"; scheme.blocker = `No safe contingency for ${node.label.toLowerCase()}`; }
  }

  private partitionKnowledge(scheme: EscapeScheme, op: EscapeOperation, social: PrisonerSocialSystem, time: number): void {
    for (const member of op.members) {
      let nodeIds = scheme.nodes.filter((node) => node.actors.includes(member.agentId) || node.dependencies.some((id) => scheme.nodes.find((n) => n.id === id)?.actors.includes(member.agentId))).map((node) => node.id);
      if (member.agentId === op.architectId) nodeIds = scheme.nodes.map((node) => node.id);
      else if (member.agentId === op.leaderId) nodeIds = scheme.nodes.filter((node) => node.action === "rally" || node.action.includes("exit") || node.action === "legacy-execute" || node.actors.includes(member.agentId)).map((node) => node.id);
      const parent = op.members.find((m) => m.agentId === member.parentId);
      if (parent && (social.bond(member.agentId, parent.agentId, false)?.trust ?? 0) > .55) nodeIds.push(...scheme.nodes.filter((node) => node.actors.includes(parent.agentId)).map((node) => node.id));
      this.knowledge.set(`${scheme.id}:${member.agentId}`, { schemeId: scheme.id, memberId: member.agentId, nodeIds: [...new Set(nodeIds)], learnedAt: time });
    }
  }

  private chooseMode(op: EscapeOperation, architect: Agent, world: World): EscapeExitMode {
    const candidates: EscapeExitMode[] = op.method === "dig" ? ["tunnel", "outside-assistance"] : ["perimeter", "credential", "vehicle", "visitation", "medical"];
    const known = (room: number) => {
      const r = [...world.rooms.values()].find((row) => row.valid && row.type === room); if (!r) return false;
      return [...r.tiles].some((tile) => architect.known?.has(tile) || [...(architect.objMem?.values() ?? [])].some((set) => set.has(tile)));
    };
    const feasible = candidates.filter((mode) => mode === "perimeter" || mode === "tunnel" || mode === "outside-assistance" ||
      mode === "vehicle" && known(RoomType.Delivery) || mode === "visitation" && known(RoomType.Visitation) ||
      mode === "medical" && known(RoomType.Infirmary) || mode === "credential" && (known(RoomType.Laundry) || known(RoomType.RecordsOffice)));
    const intelligence = aptitude(architect.profile, "intelligence");
    const pool = intelligence < 6 ? feasible.filter((mode) => ["perimeter", "tunnel"].includes(mode)) : feasible;
    const contacts = this.market.contacts.get(architect.id) ?? [];
    const contactQuality = contacts.reduce((best, contact) => Math.max(best, contact.trust * contact.resources), 0);
    const gateIntensity = [...this.facility.gatehouses.values()].reduce((best, gate) => Math.max(best,
      gate.inspection === "full" ? 1 : gate.inspection === "standard" ? .68 : gate.inspection === "spot" ? .35 : 0), 0);
    const score = (mode: EscapeExitMode): number => {
      const aptitudeScore = mode === "perimeter" ? (aptitude(architect.profile, "agility") + skill(architect.profile, "athletics") + skill(architect.profile, "toolcraft")) / 30 :
        mode === "tunnel" ? (aptitude(architect.profile, "technical") + skill(architect.profile, "digging") + skill(architect.profile, "toolcraft")) / 30 :
        mode === "credential" ? (skill(architect.profile, "deception") + skill(architect.profile, "toolcraft") + aptitude(architect.profile, "memory")) / 30 :
        mode === "vehicle" ? (skill(architect.profile, "smuggling") + skill(architect.profile, "stealth") + aptitude(architect.profile, "perception")) / 30 :
        mode === "visitation" ? (skill(architect.profile, "deception") + skill(architect.profile, "smuggling") + aptitude(architect.profile, "charisma")) / 30 :
        mode === "medical" ? (skill(architect.profile, "medicine") + skill(architect.profile, "deception") + aptitude(architect.profile, "willpower")) / 30 :
        (skill(architect.profile, "digging") + skill(architect.profile, "smuggling") + aptitude(architect.profile, "technical")) / 30;
      const external = ["visitation", "medical", "outside-assistance"].includes(mode) ? contactQuality * .55 : 0;
      const roadRisk = ["credential", "vehicle", "visitation", "medical"].includes(mode) ? gateIntensity * .32 : 0;
      const directFit = mode === "perimeter" && op.method !== "dig" || mode === "tunnel" && op.method === "dig" ? .18 : 0;
      const stableTie = (((op.id * 1103515245 + candidates.indexOf(mode) * 12345) >>> 0) % 1000) / 100_000;
      return aptitudeScore + external + directFit - roadRisk + stableTie;
    };
    return [...(pool.length ? pool : candidates)].sort((a, b) => score(b) - score(a) || candidates.indexOf(a) - candidates.indexOf(b))[0];
  }

  private sponsorFor(op: EscapeOperation): number {
    const counts = new Map<number, number>();
    for (const member of op.members) { const gang = this.gangs.gangFor(member.agentId); if (gang) counts.set(gang.id, (counts.get(gang.id) ?? 0) + 1); }
    const best = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]; return best && best[1] >= Math.max(2, Math.ceil(op.members.length / 2)) ? best[0] : -1;
  }

  private dependenciesComplete(scheme: EscapeScheme, node: PlanNode): boolean {
    return node.dependencies.every((id) => { const dep = scheme.nodes.find((n) => n.id === id); return dep?.state === "complete" || !!dep && this.alternativeComplete(scheme, dep) || dep?.optional && dep.state === "cancelled"; });
  }
  private schemeKnownToStaff(scheme: EscapeScheme): boolean {
    return [...this.institution.cases.values()].some((securityCase) => securityCase.status !== "resolved" &&
      securityCase.subjectIds.some((id) => scheme.memberIds.includes(id) || scheme.escapedMemberIds.includes(id)) &&
      securityCase.incidentIds.some((id) => ["escape", "credential", "utility", "structural"].includes(this.institution.incidents.get(id)?.category ?? "")));
  }
  private alternativeComplete(scheme: EscapeScheme, node: PlanNode): boolean { return node.alternatives.some((id) => scheme.nodes.find((n) => n.id === id)?.state === "complete"); }
  private activeAssignment(agentId: number): { scheme: EscapeScheme; node: PlanNode } | null {
    for (const scheme of this.schemes.values()) { const node = scheme.nodes.find((n) => n.state === "active" && n.actors.includes(agentId)); if (node) return { scheme, node }; }
    return null;
  }
  private replacementActor(scheme: EscapeScheme, node: PlanNode, byId: Map<number, Agent>): number {
    const def = ACTION_BY_ID.get(node.action)!;
    return scheme.memberIds.map((id) => byId.get(id)).filter((a): a is Agent => !!a && !this.activeAssignment(a.id))
      .sort((a, b) => skill(b.profile, def.skill) - skill(a.profile, def.skill) || aptitude(b.profile, "willpower") - aptitude(a.profile, "willpower") || a.id - b.id)[0]?.id ?? -1;
  }
  private memberFor(op: EscapeOperation, role: string): number { return op.members.find((m) => m.role === role)?.agentId ?? op.members.find((m) => m.agentId !== op.architectId)?.agentId ?? op.leaderId; }
  private roomTarget(world: World, type: number): number | null { const room = [...world.rooms.values()].find((r) => r.valid && r.type === type); return room ? [...room.tiles][0] : null; }
  private sourceTile(defId: string, world: World): number | null {
    const item = [...this.items.items.values()].find((row) => row.defId === defId && row.locationKind !== "destroyed");
    if (item) return world.idx(Math.max(0, Math.min(world.size - 1, Math.floor(item.x))), Math.max(0, Math.min(world.size - 1, Math.floor(item.z))));
    const workplace = [...this.work.workplaces.values()].find((row) => this.items.itemsIn(row.stockContainer).some((i) => i.defId === defId));
    return workplace ? [...world.rooms.get(workplace.roomId)?.tiles ?? []][0] ?? null : null;
  }
  private findSourceItem(defId: string, actor: Agent, _world: World) {
    const candidates = [...this.items.items.values()].filter((item) => item.defId === defId && item.locationKind !== "destroyed" && item.ownerId !== actor.id && Math.hypot(item.x - actor.x, item.z - actor.z) <= 4.25);
    return candidates.sort((a, b) => Math.hypot(a.x - actor.x, a.z - actor.z) - Math.hypot(b.x - actor.x, b.z - actor.z) || a.id - b.id)[0] ?? null;
  }
  private findCarried(agentId: number, defId: string) { return ["hands", "pockets", "worn"].flatMap((suffix) => this.items.itemsIn(`agent:${agentId}:${suffix}`)).find((item) => item.defId === defId) ?? null; }
  private isPassive(actionId: PlanAction): boolean { return ["wait-external", "start-distraction", "depart-vehicle", "legacy-execute"].includes(actionId); }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}

function action(actionId: PlanAction, label: string, baseSeconds: number, noise: number, evidenceRisk: number,
  skillId: EscapeActionDef["skill"]): EscapeActionDef { return { action: actionId, label, baseSeconds, noise, evidenceRisk, skill: skillId }; }
function copyNode(node: PlanNode): PlanNode { return { ...node, dependencies: [...node.dependencies], alternatives: [...node.alternatives], actors: [...node.actors] }; }
