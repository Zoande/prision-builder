import type { Agent, EscapePlan, Method, Tunnel } from "./agent.ts";
import { Item, countItem, removeItem } from "./items.ts";
import { aptitude, personality, skill } from "./profiles.ts";
import type { PrisonerSocialSystem } from "./social.ts";

export type EscapeOperationState =
  | "forming" | "scouting" | "supplying" | "rallying" | "executing"
  | "withdrawing" | "completed" | "failed" | "dissolved";
export type EscapeRole =
  | "architect" | "leader" | "lieutenant" | "recruiter" | "scout"
  | "lookout" | "supplier" | "digger" | "cutter" | "follower";

export interface EscapeMember {
  agentId: number;
  role: EscapeRole;
  parentId: number;
  ready: boolean;
  committed: boolean;
  joinedAt: number;
  missedRallies: number;
}

export interface EscapeOperation {
  id: number;
  method: Method;
  state: EscapeOperationState;
  architectId: number;
  leaderId: number;
  members: EscapeMember[];
  plan: EscapePlan;
  sharedIntel: string[];
  cache: { spoons: number; cutters: number };
  exposure: number;
  cohesion: number;
  rallyTile: number;
  launchAt: number;
  blocker: string;
  tunnelNetworkId: number;
  acquisition: { asset: string; sources: string[]; state: "needed" | "acquired" | "lost"; holderId: number; itemId: number } | null;
  distraction: { planned: boolean; instigatorId: number; state: "none" | "pending" | "active" | "complete"; engagementId: number };
}

export interface TunnelEntry {
  tile: number;
  ownerId: number;
  progress: number;
  required: number;
  connected: boolean;
  claimedBy: number;
}
export interface TunnelEdge { from: number; to: number; length: number; progress: number }
export interface TunnelNetwork {
  id: number;
  operationId: number;
  primaryEntry: number;
  entries: TunnelEntry[];
  edges: TunnelEdge[];
  activeDiggers: number[];
  mainClaimedBy: number;
  occupants: number[];
  surfaceTile: number;
  cache: { spoons: number; cutters: number };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

export class EscapeOperationsSystem {
  readonly operations = new Map<number, EscapeOperation>();
  readonly tunnels = new Map<number, TunnelNetwork>();
  private nextOperationId = 1;
  private nextTunnelId = 1;
  private rngState = 0x31d8ca71;
  private recruitT = 0;

  tick(dt: number, worldTime: number, agents: Agent[], social: PrisonerSocialSystem): void {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const ag of agents) {
      if (!ag.plan || ag.escapeOperationId >= 0) continue;
      this.adoptSoloPlan(ag, ag.plan, worldTime);
    }
    this.recruitT -= dt;
    if (this.recruitT <= 0) {
      this.recruitT = 1;
      this.processRecruitment(worldTime, byId, social);
    }
    for (const [id, op] of this.operations) {
      op.members = op.members.filter((m) => byId.has(m.agentId));
      if (!op.members.length) { this.operations.delete(id); continue; }
      this.elect(op, byId, social);
      this.updateReadiness(op, byId);
      this.updateCohesion(op, social);
      op.exposure = clamp(op.exposure + dt * Math.max(0, op.members.length - 3) * .00008);
      if (op.state === "forming" && worldTime >= op.launchAt) {
        op.state = op.members.length > 1 ? "scouting" : "executing";
        op.blocker = "";
      }
      if (op.state === "scouting") op.state = "supplying";
      if (op.state === "supplying" && this.hasRoleQuorum(op, byId)) {
        op.state = "rallying";
        op.launchAt = worldTime + 4 + Math.min(30, op.members.length * .7);
      }
      if (op.state === "rallying" && worldTime >= op.launchAt) {
        if (this.hasRoleQuorum(op, byId)) {
          op.state = "executing";
          op.blocker = "";
          for (const m of op.members) {
            const ag = byId.get(m.agentId);
            if (!ag || !m.ready || !m.committed) { m.missedRallies++; continue; }
            if (!ag.plan) ag.plan = this.copyPlan(op.plan);
            ag.plan.stage = "prepare";
            ag.decideT = 0;
          }
        } else {
          op.blocker = "Role quorum not ready";
          op.launchAt = worldTime + 8;
        }
      }
      if (op.state === "executing") {
        const active = op.members.some((m) => {
          const a = byId.get(m.agentId);
          return a && (a.plan || ["climbing", "cutting", "digging", "crawling", "fleeing"].includes(a.state));
        });
        if (!active) op.state = "completed";
      }
      if (["completed", "failed", "dissolved"].includes(op.state)) {
        for (const m of op.members) { const a = byId.get(m.agentId); if (a?.escapeOperationId === op.id) { a.escapeOperationId = -1; a.escapeRole = ""; } }
      }
    }
  }

  adoptSoloPlan(ag: Agent, plan: EscapePlan, worldTime: number): EscapeOperation {
    const id = this.nextOperationId++;
    const role: EscapeRole = aptitude(ag.profile, "intelligence") >= 6 ? "architect" : "leader";
    const op: EscapeOperation = {
      id, method: plan.method, state: "forming", architectId: ag.id, leaderId: ag.id,
      members: [{ agentId: ag.id, role, parentId: -1, ready: false, committed: true, joinedAt: worldTime, missedRallies: 0 }],
      plan: this.copyPlan(plan), sharedIntel: [], cache: { spoons: 0, cutters: 0 },
      exposure: 0, cohesion: 1, rallyTile: plan.breaches[0] ?? plan.toiletIdx,
      launchAt: worldTime + 30, blocker: "Quietly testing possible recruits", tunnelNetworkId: -1,
      acquisition: this.initialAcquisition(plan.method, id),
      distraction: { planned: false, instigatorId: -1, state: "none", engagementId: -1 },
    };
    this.operations.set(id, op); ag.escapeOperationId = id; ag.escapeRole = role;
    return op;
  }

  operationFor(ag: Agent): EscapeOperation | null {
    return ag.escapeOperationId >= 0 ? this.operations.get(ag.escapeOperationId) ?? null : null;
  }

  inviteMember(op: EscapeOperation, candidate: Agent, worldTime: number, preferredParent = op.leaderId): EscapeMember | null {
    if (candidate.escapeOperationId >= 0 || op.members.some((m) => m.agentId === candidate.id)) return null;
    const parent = this.parentWithCapacity(op, preferredParent);
    const role = this.initialRole(candidate, op);
    const member: EscapeMember = { agentId: candidate.id, role, parentId: parent, ready: false, committed: true, joinedAt: worldTime, missedRallies: 0 };
    op.members.push(member);
    candidate.escapeOperationId = op.id; candidate.escapeRole = role;
    candidate.plan = this.copyPlan(op.plan);
    op.exposure = clamp(op.exposure + .012 * op.members.length);
    return member;
  }

  mayExecute(ag: Agent): boolean {
    const op = this.operationFor(ag);
    if (!op) return true;
    if (op.members.length === 1) return op.state === "executing";
    return op.state === "executing" && !!op.members.find((m) => m.agentId === ag.id)?.ready;
  }

  removeAgent(id: number): void {
    for (const op of this.operations.values()) op.members = op.members.filter((m) => m.agentId !== id);
    for (const net of this.tunnels.values()) {
      net.activeDiggers = net.activeDiggers.filter((n) => n !== id);
      net.occupants = net.occupants.filter((n) => n !== id);
      if (net.mainClaimedBy === id) net.mainClaimedBy = -1;
      for (const e of net.entries) if (e.claimedBy === id) e.claimedBy = -1;
    }
  }

  ensureTunnelNetwork(op: EscapeOperation, entryTile: number, ownerId: number, worldSize = 500): TunnelNetwork {
    let net = op.tunnelNetworkId >= 0 ? this.tunnels.get(op.tunnelNetworkId) : undefined;
    if (!net) {
      const id = this.nextTunnelId++;
      net = { id, operationId: op.id, primaryEntry: entryTile, entries: [{ tile: entryTile, ownerId, progress: 0, required: 0, connected: true, claimedBy: -1 }], edges: [], activeDiggers: [], mainClaimedBy: -1, occupants: [], surfaceTile: -1, cache: op.cache };
      this.tunnels.set(id, net); op.tunnelNetworkId = id;
    }
    if (!net.entries.some((e) => e.tile === entryTile)) {
      const sx = entryTile % worldSize, sz = Math.floor(entryTile / worldSize), px = net.primaryEntry % worldSize, pz = Math.floor(net.primaryEntry / worldSize);
      const required = Math.max(2, Math.ceil(Math.hypot(sx - px, sz - pz)));
      net.entries.push({ tile: entryTile, ownerId, progress: 0, required, connected: false, claimedBy: -1 });
      net.edges.push({ from: entryTile, to: net.primaryEntry, length: required, progress: 0 });
    }
    return net;
  }

  enterTunnel(networkId: number, ag: Agent): boolean {
    const net = this.tunnels.get(networkId); if (!net) return false;
    if (!net.occupants.includes(ag.id)) net.occupants.push(ag.id);
    return true;
  }

  leaveTunnel(networkId: number, agentId: number): void {
    const net = this.tunnels.get(networkId); if (!net) return;
    net.occupants = net.occupants.filter((id) => id !== agentId);
    this.releaseDigFace(networkId, agentId);
  }

  claimDigFace(networkId: number, ag: Agent, entryTile: number): "branch" | "main" | null {
    const net = this.tunnels.get(networkId); if (!net || net.activeDiggers.includes(ag.id)) return net?.mainClaimedBy === ag.id ? "main" : "branch";
    if (net.activeDiggers.length >= 3) return null;
    const entry = net.entries.find((e) => e.tile === entryTile);
    if (entry && !entry.connected && entry.claimedBy < 0) {
      entry.claimedBy = ag.id; net.activeDiggers.push(ag.id); return "branch";
    }
    if (net.mainClaimedBy < 0) { net.mainClaimedBy = ag.id; net.activeDiggers.push(ag.id); return "main"; }
    return null;
  }

  digBranch(networkId: number, entryTile: number, ag: Agent, amount: number): boolean {
    const net = this.tunnels.get(networkId), entry = net?.entries.find((e) => e.tile === entryTile);
    if (!net || !entry || entry.connected || entry.claimedBy !== ag.id) return false;
    entry.progress += amount;
    const edge = net.edges.find((e) => e.from === entryTile); if (edge) edge.progress = entry.progress;
    if (entry.progress >= entry.required) { entry.connected = true; entry.claimedBy = -1; this.releaseDigFace(networkId, ag.id); return true; }
    return false;
  }

  releaseDigFace(networkId: number, agentId: number): void {
    const net = this.tunnels.get(networkId); if (!net) return;
    net.activeDiggers = net.activeDiggers.filter((id) => id !== agentId);
    if (net.mainClaimedBy === agentId) net.mainClaimedBy = -1;
    for (const e of net.entries) if (e.claimedBy === agentId) e.claimedBy = -1;
  }

  tunnelForLegacy(networkId: number, tunnels: Tunnel[]): Tunnel | null {
    return tunnels.find((t) => t.networkId === networkId) ?? null;
  }

  contributeTools(op: EscapeOperation, ag: Agent): void {
    if (op.method === "dig") {
      while (countItem(ag.inv, Item.Spoon) > 1 && removeItem(ag.inv, Item.Spoon)) op.cache.spoons++;
    } else if (op.method === "cut") {
      while (countItem(ag.inv, Item.Cutter) > 1 && removeItem(ag.inv, Item.Cutter)) op.cache.cutters++;
    }
  }

  takeCached(op: EscapeOperation, kind: number): boolean {
    if (kind === Item.Spoon && op.cache.spoons > 0) { op.cache.spoons--; return true; }
    if (kind === Item.Cutter && op.cache.cutters > 0) { op.cache.cutters--; return true; }
    return false;
  }

  operationSummary(id: number): string {
    const op = this.operations.get(id); if (!op) return "No operation";
    return `${op.method} / ${op.state} · ${op.members.length} members · ${Math.round(op.cohesion * 100)}% cohesion · ${Math.round(op.exposure * 100)}% exposure`;
  }

  private processRecruitment(worldTime: number, byId: Map<number, Agent>, social: PrisonerSocialSystem): void {
    for (const c of social.completed) {
      if (c.topic !== "recruitment" || c.privacy < .3) continue;
      const members = c.participants.map((id) => byId.get(id)).filter((a): a is Agent => !!a);
      const recruiter = members.find((a) => a.escapeOperationId >= 0);
      if (!recruiter) continue;
      const op = this.operationFor(recruiter); if (!op || ["executing", "completed", "failed", "dissolved"].includes(op.state)) continue;
      for (const candidate of members) {
        if (candidate.escapeOperationId >= 0 || candidate.id === recruiter.id || candidate.escapeDesire < .22) continue;
        const bond = social.bond(recruiter.id, candidate.id, false);
        const willingness = (bond?.trust ?? 0) * .35 + (bond?.affinity ?? 0) * .18 + personality(candidate.profile, "loyalty") * .12 + personality(candidate.profile, "defiance") * .1 + candidate.escapeDesire * .35;
        if (willingness < .2 || this.random() > clamp(.16 + willingness)) continue;
        this.inviteMember(op, candidate, worldTime, recruiter.id);
      }
    }
  }

  private parentWithCapacity(op: EscapeOperation, preferred: number): number {
    const count = (id: number) => op.members.filter((m) => m.parentId === id).length;
    if (count(preferred) < 4) return preferred;
    for (const m of op.members.filter((m) => ["leader", "lieutenant", "recruiter"].includes(m.role))) if (count(m.agentId) < 4) return m.agentId;
    // Promote the oldest trusted branch member when every coordinator has a
    // full four-person span. Unlimited conspiracies grow as a tree, never a
    // giant flat follower list hanging from one leader.
    const promote = op.members.filter((m) => m.agentId !== op.leaderId && count(m.agentId) === 0)
      .sort((a, b) => a.joinedAt - b.joinedAt || a.agentId - b.agentId)[0];
    if (promote) { promote.role = "lieutenant"; return promote.agentId; }
    return op.leaderId;
  }

  private initialRole(ag: Agent, op: EscapeOperation): EscapeRole {
    if (op.method === "dig" && skill(ag.profile, "digging") + aptitude(ag.profile, "strength") >= 8) return "digger";
    if (op.method === "cut" && skill(ag.profile, "toolcraft") + aptitude(ag.profile, "dexterity") >= 8) return "cutter";
    if (aptitude(ag.profile, "perception") + skill(ag.profile, "stealth") >= 10) return "lookout";
    if (aptitude(ag.profile, "charisma") + skill(ag.profile, "leadership") >= 10) return "recruiter";
    return "supplier";
  }

  private elect(op: EscapeOperation, byId: Map<number, Agent>, social: PrisonerSocialSystem): void {
    const living = op.members.map((m) => byId.get(m.agentId)).filter((a): a is Agent => !!a);
    const architect = [...living].sort((a, b) => this.architectScore(b) - this.architectScore(a) || a.id - b.id)[0];
    const leader = [...living].sort((a, b) => this.leaderScore(b, op, social) - this.leaderScore(a, op, social) || a.id - b.id)[0];
    if (architect) op.architectId = architect.id;
    if (leader) op.leaderId = leader.id;
    for (const m of op.members) {
      if (m.agentId === op.architectId) m.role = "architect";
      else if (m.agentId === op.leaderId) m.role = "leader";
      else if (op.members.filter((x) => x.parentId === m.agentId).length > 0) m.role = "lieutenant";
      const ag = byId.get(m.agentId); if (ag) ag.escapeRole = m.role;
    }
  }

  private architectScore(a: Agent): number {
    return aptitude(a.profile, "intelligence") * .32 + aptitude(a.profile, "creativity") * .2 + aptitude(a.profile, "memory") * .16 + aptitude(a.profile, "technical") * .16 + skill(a.profile, "toolcraft") * .08 + skill(a.profile, "digging") * .08;
  }

  private leaderScore(a: Agent, op: EscapeOperation, social: PrisonerSocialSystem): number {
    const respect = op.members.reduce((s, m) => s + (social.bond(m.agentId, a.id, false)?.respect ?? 0), 0) / Math.max(1, op.members.length);
    return aptitude(a.profile, "charisma") * .24 + aptitude(a.profile, "willpower") * .15 + aptitude(a.profile, "intelligence") * .1 + skill(a.profile, "leadership") * .22 + personality(a.profile, "dominance") * 1.1 + personality(a.profile, "empathy") * .4 + personality(a.profile, "loyalty") * .5 + (a.mind?.reputation ?? 0) + respect;
  }

  private updateReadiness(op: EscapeOperation, byId: Map<number, Agent>): void {
    for (const member of op.members) {
      const ag = byId.get(member.agentId); if (!ag) continue;
      this.contributeTools(op, ag);
      const healthy = ag.needs.food >= .1 && ag.needs.sleep >= .1 && (ag.mind?.stress ?? 0) < .92;
      if (op.method === "climb") member.ready = healthy;
      else if (op.method === "cut") member.ready = healthy && (member.role !== "cutter" || countItem(ag.inv, Item.Cutter) > 0 || op.cache.cutters > 0);
      else member.ready = healthy && (member.role !== "digger" || countItem(ag.inv, Item.Spoon) > 0 || op.cache.spoons > 0);
      const resolve = aptitude(ag.profile, "willpower") / 10 + personality(ag.profile, "courage") * .2 + personality(ag.profile, "loyalty") * .15 - (ag.mind?.stress ?? 0) * .3;
      member.committed = resolve > .18 || personality(ag.profile, "impulsivity") > .55;
    }
  }

  private updateCohesion(op: EscapeOperation, social: PrisonerSocialSystem): void {
    if (op.members.length <= 1) { op.cohesion = 1; return; }
    let sum = 0, count = 0;
    for (const m of op.members) {
      if (m.parentId < 0) continue;
      const a = social.bond(m.agentId, m.parentId, false), b = social.bond(m.parentId, m.agentId, false);
      sum += ((a?.trust ?? .1) + (b?.trust ?? .1)) * .5; count++;
    }
    op.cohesion = clamp((count ? sum / count : .2) + .2 - Math.max(0, op.members.length - 6) * .006);
  }

  private hasRoleQuorum(op: EscapeOperation, byId: Map<number, Agent>): boolean {
    if (op.acquisition && op.acquisition.state !== "acquired") { op.blocker = `Needs physical ${op.acquisition.asset}`; return false; }
    const committed = op.members.filter((m) => m.ready && m.committed && byId.has(m.agentId));
    if (committed.length < Math.max(1, Math.ceil(op.members.length * .5))) { op.blocker = "Waiting for a committed majority"; return false; }
    if (!committed.some((m) => m.agentId === op.leaderId || m.role === "lieutenant")) { op.blocker = "No coordinator ready"; return false; }
    if (op.method === "dig" && !committed.some((m) => m.role === "digger" || m.role === "architect")) { op.blocker = "No digger ready"; return false; }
    if (op.method === "cut" && !committed.some((m) => m.role === "cutter" || m.role === "architect")) { op.blocker = "No cutter ready"; return false; }
    return true;
  }

  private copyPlan(plan: EscapePlan): EscapePlan { return { ...plan, breaches: [...plan.breaches] }; }
  private initialAcquisition(method: Method, operationId: number): EscapeOperation["acquisition"] {
    if (method === "cut") {
      const asset = ["cutter", "hacksaw-blade", "pruning-shears"][operationId % 3];
      return { asset, sources: ["metalshop", "greenhouse", "trade", "crafting", "theft"], state: "needed", holderId: -1, itemId: -1 };
    }
    if (method === "dig") {
      const asset = ["spoon", "trowel", "shovel"][operationId % 3];
      return { asset, sources: ["canteen", "greenhouse", "groundskeeping", "trade", "theft"], state: "needed", holderId: -1, itemId: -1 };
    }
    const assets = ["staff-key", "guard-key", "staff-uniform", "rope", "radio", "service-pistol"];
    const asset = assets[operationId % assets.length];
    return { asset, sources: ["laundry", "maintenance", "groundskeeping", "trade", "theft", "assault"], state: "needed", holderId: -1, itemId: -1 };
  }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }

  saveData() {
    return {
      operations: [...this.operations.values()].map((o) => ({ ...o, members: o.members.map((m) => ({ ...m })), plan: this.copyPlan(o.plan), sharedIntel: [...o.sharedIntel], cache: { ...o.cache } })),
      tunnels: [...this.tunnels.values()].map((t) => ({ ...t, entries: t.entries.map((e) => ({ ...e, claimedBy: -1 })), edges: t.edges.map((e) => ({ ...e })), activeDiggers: [], occupants: [], mainClaimedBy: -1, cache: { ...t.cache } })),
      nextOperationId: this.nextOperationId, nextTunnelId: this.nextTunnelId, rngState: this.rngState,
    };
  }

  loadData(data: Partial<ReturnType<EscapeOperationsSystem["saveData"]>>): void {
    this.operations.clear();
    for (const o of data.operations ?? []) this.operations.set(o.id, { ...o, members: o.members.map((m) => ({ ...m })), plan: this.copyPlan(o.plan), sharedIntel: [...o.sharedIntel], cache: { ...o.cache },
      acquisition: o.acquisition ? { ...o.acquisition, sources: [...o.acquisition.sources] } : this.initialAcquisition(o.method, o.id),
      distraction: o.distraction ? { ...o.distraction } : { planned: false, instigatorId: -1, state: "none", engagementId: -1 } });
    this.tunnels.clear();
    for (const t of data.tunnels ?? []) this.tunnels.set(t.id, { ...t, entries: t.entries.map((e) => ({ ...e, claimedBy: -1 })), edges: t.edges.map((e) => ({ ...e })), activeDiggers: [], occupants: [], mainClaimedBy: -1, cache: { ...t.cache } });
    this.nextOperationId = data.nextOperationId ?? 1; this.nextTunnelId = data.nextTunnelId ?? 1; this.rngState = data.rngState ?? 0x31d8ca71;
  }
}
