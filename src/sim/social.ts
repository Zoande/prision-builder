import type { Agent } from "./agent.ts";
import { Obj, World } from "./world.ts";
import { aptitude, personality, skill } from "./profiles.ts";
import { itemDef } from "./items.ts";

export type ConversationTopic =
  | "small-talk" | "shared-interests" | "grievance" | "criminal-history"
  | "intelligence" | "recruitment" | "argument" | "reassurance";

export interface SocialBond {
  from: number;
  to: number;
  familiarity: number;
  affinity: number;
  trust: number;
  respect: number;
  fear: number;
  interactions: number;
  lastInteraction: number;
  grievances: number;
}

export type IntelType =
  | "layout" | "object" | "door-window" | "guard-route" | "guard-post"
  | "routine" | "contraband" | "stash" | "capability" | "reliability"
  | "escape-opportunity" | "security";

export interface IntelFact {
  key: string;
  type: IntelType;
  subject: string;
  tile: number;
  value: string;
  sourceId: number;
  observedAt: number;
  confidence: number;
  precision: number;
  firsthand: boolean;
  expiresAt: number;
}

export interface Conversation {
  id: number;
  participants: number[];
  topic: ConversationTopic;
  remaining: number;
  privacy: number;
  x: number;
  z: number;
  argument: boolean;
}

export interface Clique {
  id: number;
  members: number[];
  cohesion: number;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const bondKey = (from: number, to: number) => `${from}:${to}`;

export class PrisonerSocialSystem {
  readonly bonds = new Map<string, SocialBond>();
  readonly intel = new Map<number, Map<string, IntelFact>>();
  readonly conversations = new Map<number, Conversation>();
  readonly cliques = new Map<number, Clique>();
  readonly completed: Conversation[] = [];
  private nextConversationId = 1;
  private nextCliqueId = 1;
  private scanT = 0;
  private cliqueT = 0;
  private rngState = 0x8b9d31e5;

  tick(dt: number, worldTime: number, world: World, agents: Agent[]): void {
    this.completed.length = 0;
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const [id, c] of this.conversations) {
      c.remaining -= dt;
      const members = c.participants.map((pid) => byId.get(pid)).filter((a): a is Agent => !!a);
      if (members.length < 2 || members.some((a) => !this.canContinue(a))) {
        this.finishConversation(c, members, worldTime);
        this.conversations.delete(id);
        continue;
      }
      for (const ag of members) {
        ag.needs.social = Math.min(1, ag.needs.social + dt * (.018 + members.length * .003) * (c.argument ? .25 : 1));
        if (ag.mind) {
          ag.mind.stress = clamp(ag.mind.stress - dt * (c.argument ? -.004 : .004));
          if (c.argument) ag.mind.anger = clamp(ag.mind.anger + dt * .009);
        }
        ag.socialAction = c.argument ? "arguing" : "talking";
        ag.socialGroup = c.id;
      }
      if (c.remaining <= 0) {
        this.finishConversation(c, members, worldTime);
        this.conversations.delete(id);
      }
    }

    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = .5;
      this.observe(worldTime, world, agents);
      this.startConversations(worldTime, world, agents);
      this.decayIntel(worldTime, agents);
    }
    this.cliqueT -= dt;
    if (this.cliqueT <= 0) {
      this.cliqueT = 30; // one game-hour in the prototype clock
      this.rebuildCliques(agents);
      this.pruneBonds(worldTime, byId);
    }
  }

  bond(from: number, to: number, create = true): SocialBond | null {
    const key = bondKey(from, to);
    let b = this.bonds.get(key) ?? null;
    if (!b && create) {
      b = { from, to, familiarity: 0, affinity: 0, trust: .05, respect: 0, fear: 0, interactions: 0, lastInteraction: 0, grievances: 0 };
      this.bonds.set(key, b);
    }
    return b;
  }

  bondsFrom(id: number): SocialBond[] {
    return [...this.bonds.values()].filter((b) => b.from === id).sort((a, b) => b.trust - a.trust || b.affinity - a.affinity || a.to - b.to);
  }

  intelFor(id: number): IntelFact[] {
    return [...(this.intel.get(id)?.values() ?? [])].sort((a, b) => b.confidence - a.confidence || b.observedAt - a.observedAt);
  }

  cliqueFor(id: number): Clique | null {
    return [...this.cliques.values()].find((c) => c.members.includes(id)) ?? null;
  }

  isTalking(id: number): Conversation | null {
    return [...this.conversations.values()].find((c) => c.participants.includes(id)) ?? null;
  }

  addFact(agentId: number, fact: IntelFact): void {
    let store = this.intel.get(agentId);
    if (!store) this.intel.set(agentId, store = new Map());
    const old = store.get(fact.key);
    if (!old || fact.firsthand || fact.confidence > old.confidence || fact.observedAt > old.observedAt + 30) store.set(fact.key, { ...fact });
  }

  removeAgent(id: number): void {
    this.intel.delete(id);
    for (const [k, b] of this.bonds) if (b.from === id || b.to === id) this.bonds.delete(k);
    for (const [cid, c] of this.conversations) if (c.participants.includes(id)) this.conversations.delete(cid);
    for (const [cid, c] of this.cliques) {
      c.members = c.members.filter((m) => m !== id);
      if (c.members.length < 2) this.cliques.delete(cid);
    }
  }

  private canStart(ag: Agent): boolean {
    if (ag.kind !== Obj.Prisoner || ag.cuffed || ag.underground || ag.path || ag.socialGroup >= 0) return false;
    if (ag.needs.food < .15 || ag.needs.sleep < .12) return false;
    return ["idle", "yardTime", "queueing", "outside", "reading", "inCell"].includes(ag.state);
  }

  private canContinue(ag: Agent): boolean {
    return ag.kind === Obj.Prisoner && !ag.cuffed && !ag.underground && !ag.path &&
      !["climbing", "cutting", "digging", "fleeing", "escorted", "knockedOut"].includes(ag.state);
  }

  private startConversations(worldTime: number, world: World, agents: Agent[]): void {
    for (const ag of agents) if (!this.isTalking(ag.id)) { ag.socialGroup = -1; ag.socialAction = "none"; }
    const eligible = agents.filter((a) => this.canStart(a)).sort((a, b) => a.id - b.id);
    const grid = new Map<string, Agent[]>();
    for (const ag of eligible) {
      const key = `${Math.floor(ag.x / 5)},${Math.floor(ag.z / 5)}`;
      let bucket = grid.get(key); if (!bucket) grid.set(key, bucket = []); bucket.push(ag);
    }
    const used = new Set<number>();
    for (const initiator of eligible) {
      if (used.has(initiator.id)) continue;
      const sociability = personality(initiator.profile, "sociability");
      const urgency = 1 - initiator.needs.social;
      const chance = clamp(.05 + urgency * .38 + sociability * .16, .01, .62);
      if (this.random() > chance) continue;
      const gx = Math.floor(initiator.x / 5), gz = Math.floor(initiator.z / 5);
      const candidates: Agent[] = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        for (const other of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (other.id === initiator.id || used.has(other.id) || Math.hypot(other.x - initiator.x, other.z - initiator.z) > 4.2) continue;
          const a = world.inBounds(Math.floor(initiator.x), Math.floor(initiator.z)) ? world.roomId[world.idx(Math.floor(initiator.x), Math.floor(initiator.z))] : -1;
          const b = world.inBounds(Math.floor(other.x), Math.floor(other.z)) ? world.roomId[world.idx(Math.floor(other.x), Math.floor(other.z))] : -2;
          if (a !== b && a >= 0 && b >= 0) continue;
          candidates.push(other);
        }
      }
      candidates.sort((a, b) => this.socialScore(initiator, b) - this.socialScore(initiator, a) || a.id - b.id);
      if (!candidates.length) continue;
      const preferred = sociability < -.35 ? 2 : 2 + Math.floor(this.random() * 3);
      const members = [initiator, ...candidates.slice(0, preferred - 1)];
      const topic = this.chooseTopic(members);
      const argument = topic === "argument";
      const id = this.nextConversationId++;
      const c: Conversation = {
        id, participants: members.map((m) => m.id), topic,
        remaining: 6 + this.random() * 14 + members.length * 1.5,
        privacy: this.guardDistance(initiator, agents) > 10 ? 1 : .35,
        x: members.reduce((s, m) => s + m.x, 0) / members.length,
        z: members.reduce((s, m) => s + m.z, 0) / members.length,
        argument,
      };
      this.conversations.set(id, c);
      for (const m of members) { used.add(m.id); m.socialGroup = id; m.socialAction = argument ? "arguing" : "talking"; }
      void worldTime;
    }
  }

  private socialScore(a: Agent, b: Agent): number {
    const existing = this.bond(a.id, b.id, false);
    const compatibility = 1 - Math.abs(personality(a.profile, "sociability") - personality(b.profile, "sociability")) * .35
      - Math.abs(personality(a.profile, "conscientiousness") - personality(b.profile, "conscientiousness")) * .12;
    return compatibility + (existing?.affinity ?? 0) * .8 + (existing?.trust ?? 0) * .6 + this.random() * .2;
  }

  private chooseTopic(members: Agent[]): ConversationTopic {
    const aggression = members.reduce((s, a) => s + personality(a.profile, "aggression") + personality(a.profile, "volatility") + (a.mind?.anger ?? 0), 0) / members.length;
    const curiosity = members.reduce((s, a) => s + personality(a.profile, "curiosity"), 0) / members.length;
    const hasPlot = members.some((a) => a.escapeOperationId >= 0);
    const r = this.random();
    if (aggression > .9 && r < .32) return "argument";
    if (hasPlot && r < .2) return "recruitment";
    if (curiosity > .25 && r < .42) return "intelligence";
    if (r < .12) return "criminal-history";
    if (r < .28) return "shared-interests";
    if (r < .37) return "grievance";
    if (r < .45) return "reassurance";
    return "small-talk";
  }

  private finishConversation(c: Conversation, members: Agent[], worldTime: number): void {
    for (const from of members) {
      from.socialGroup = -1; from.socialAction = "none";
      for (const to of members) {
        if (from.id === to.id) continue;
        const b = this.bond(from.id, to.id)!;
        const empathy = personality(from.profile, "empathy"), volatility = personality(from.profile, "volatility");
        const compatible = 1 - Math.abs(personality(from.profile, "sociability") - personality(to.profile, "sociability"));
        b.familiarity = clamp(b.familiarity + .045);
        b.interactions++;
        b.lastInteraction = worldTime;
        if (c.argument) {
          b.affinity = clamp(b.affinity - .09 - Math.max(0, volatility) * .05, -1, 1);
          b.trust = clamp(b.trust - .055);
          b.fear = clamp(b.fear + Math.max(0, personality(to.profile, "dominance")) * .05 + aptitude(to.profile, "strength") * .003);
          b.grievances++;
        } else {
          b.affinity = clamp(b.affinity + .018 + compatible * .018 + empathy * .008, -1, 1);
          b.trust = clamp(b.trust + .008 + b.familiarity * .01 + Math.max(0, personality(to.profile, "loyalty")) * .008);
          b.respect = clamp(b.respect + aptitude(to.profile, "charisma") * .002 + skill(to.profile, "leadership") * .004, -1, 1);
          if (c.topic === "reassurance" && b.grievances > 0 && empathy > 0) b.grievances--;
        }
      }
      if (from.mind) {
        const incoming = members.filter((m) => m.id !== from.id).map((m) => this.bond(m.id, from.id, false)?.respect ?? 0);
        const standing = incoming.length ? incoming.reduce((a, b) => a + b, 0) / incoming.length : 0;
        from.mind.reputation = clamp(from.mind.reputation * .985 + clamp(.5 + standing * .5) * .015);
      }
    }
    if ((c.topic === "intelligence" || c.topic === "recruitment" || c.topic === "criminal-history") && c.privacy > .3) this.shareIntel(members, worldTime);
    if (c.topic === "criminal-history") for (const subject of members) for (const listener of members) {
      if (subject.id === listener.id || !subject.profile) continue;
      const best = Object.entries(subject.profile.skills).sort((a, b) => b[1].level - a[1].level)[0];
      this.addFact(listener.id, { key: `capability:${subject.id}:${best?.[0] ?? "unknown"}`, type: "capability", subject: `${subject.profile.firstName} ${subject.profile.lastName}`, tile: -1, value: best ? `${best[0]}:${best[1].level}` : "unknown", sourceId: subject.id, observedAt: worldTime, confidence: .62, precision: .65, firsthand: false, expiresAt: Infinity });
    }
    this.completed.push({ ...c, participants: [...c.participants] });
  }

  private shareIntel(members: Agent[], worldTime: number): void {
    for (const sender of members) {
      const facts = this.intelFor(sender.id).filter((f) => f.confidence > .28);
      if (!facts.length) continue;
      const max = 1 + Math.floor(this.random() * 3);
      for (const receiver of members) {
        if (receiver.id === sender.id) continue;
        const b = this.bond(sender.id, receiver.id)!;
        const willingness = .18 + b.trust * .38 + personality(sender.profile, "loyalty") * .12 + personality(sender.profile, "sociability") * .1 - Math.max(0, personality(sender.profile, "deceit")) * .08;
        if (this.random() > clamp(willingness)) continue;
        for (let i = 0; i < Math.min(max, facts.length); i++) {
          const src = facts[(Math.floor(this.random() * facts.length) + i) % facts.length];
          const memory = aptitude(receiver.profile, "memory"), intelligence = aptitude(receiver.profile, "intelligence");
          const loss = .12 + (10 - memory) * .018 + this.random() * .08;
          const spatialError = src.tile >= 0 && this.random() > (memory + intelligence) / 22 ? Math.floor(this.random() * 3) - 1 : 0;
          this.addFact(receiver.id, {
            ...src, key: src.key, tile: src.tile < 0 ? -1 : Math.max(0, src.tile + spatialError),
            sourceId: sender.id, observedAt: worldTime, firsthand: false,
            confidence: clamp(src.confidence - loss), precision: clamp(src.precision - loss * .7),
          });
        }
      }
    }
  }

  private observe(worldTime: number, world: World, agents: Agent[]): void {
    for (const ag of agents) {
      if (ag.kind !== Obj.Prisoner || ag.underground || !world.inBounds(Math.floor(ag.x), Math.floor(ag.z))) continue;
      const tile = world.idx(Math.floor(ag.x), Math.floor(ag.z));
      this.addFact(ag.id, { key: `layout:${tile}`, type: "layout", subject: "walkable tile", tile, value: "open", sourceId: ag.id, observedAt: worldTime, confidence: 1, precision: 1, firsthand: true, expiresAt: Infinity });
      const kind = world.objKind[tile];
      if (kind !== Obj.None) this.addFact(ag.id, { key: `object:${kind}:${tile}`, type: "object", subject: `object ${kind}`, tile, value: String(kind), sourceId: ag.id, observedAt: worldTime, confidence: 1, precision: 1, firsthand: true, expiresAt: Infinity });
      if (kind === Obj.JailDoor || kind === Obj.Door) this.addFact(ag.id, { key: `door:${tile}`, type: "door-window", subject: kind === Obj.JailDoor ? "jail door" : "door", tile, value: world.jailClosed[tile] ? "closed" : "open", sourceId: ag.id, observedAt: worldTime, confidence: 1, precision: 1, firsthand: true, expiresAt: worldTime + 60 });
      const range = 5 + aptitude(ag.profile, "perception") * .65;
      for (const other of agents) {
        if (other.kind !== Obj.Guard || Math.hypot(other.x - ag.x, other.z - ag.z) > range) continue;
        const gt = world.inBounds(Math.floor(other.x), Math.floor(other.z)) ? world.idx(Math.floor(other.x), Math.floor(other.z)) : -1;
        this.addFact(ag.id, { key: `guard:${other.id}`, type: other.postRoom >= 0 ? "guard-post" : "guard-route", subject: `guard ${other.id}`, tile: gt, value: `${other.routeId}:${other.postRoom}`, sourceId: ag.id, observedAt: worldTime, confidence: clamp(.65 + aptitude(ag.profile, "perception") * .035), precision: .8, firsthand: true, expiresAt: worldTime + 90 });
      }
      for (const other of agents) {
        if (other.id === ag.id || other.kind !== Obj.Prisoner || Math.hypot(other.x - ag.x, other.z - ag.z) > range * .55) continue;
        const visible = other.inv.hands.filter((stack) => itemDef(stack.kind)?.contraband);
        if (visible.length) this.addFact(ag.id, { key: `contraband:${other.id}`, type: "contraband", subject: `inmate ${other.id}`, tile: world.idx(Math.floor(other.x), Math.floor(other.z)), value: visible.map((s) => `${s.kind}:${s.count}`).join(","), sourceId: ag.id, observedAt: worldTime, confidence: .92, precision: .9, firsthand: true, expiresAt: worldTime + 120 });
        const b = this.bond(ag.id, other.id, false);
        if (b && b.familiarity > .2) this.addFact(ag.id, { key: `reliability:${other.id}`, type: "reliability", subject: `inmate ${other.id}`, tile: -1, value: String(Math.round(b.trust * 100)), sourceId: ag.id, observedAt: worldTime, confidence: clamp(.45 + b.familiarity * .5), precision: .7, firsthand: true, expiresAt: worldTime + 300 });
      }
    }
  }

  private decayIntel(worldTime: number, agents: Agent[]): void {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const [id, store] of this.intel) {
      const ag = byId.get(id);
      if (!ag) { this.intel.delete(id); continue; }
      for (const [key, fact] of store) {
        if (fact.expiresAt <= worldTime) { store.delete(key); continue; }
        if (!fact.firsthand && fact.type !== "layout" && fact.type !== "object") fact.confidence = Math.max(0, fact.confidence - .0015 * (11 - aptitude(ag.profile, "memory")));
        if (fact.confidence < .12) store.delete(key);
      }
      const max = 48 + aptitude(ag.profile, "memory") * 20;
      if (store.size > max) {
        const drop = [...store.values()].sort((a, b) => a.confidence - b.confidence || a.observedAt - b.observedAt);
        for (let i = 0; i < store.size - max; i++) store.delete(drop[i].key);
      }
    }
  }

  private rebuildCliques(agents: Agent[]): void {
    this.cliques.clear();
    const prisonerIds = new Set(agents.filter((a) => a.kind === Obj.Prisoner).map((a) => a.id));
    const seen = new Set<number>();
    for (const id of [...prisonerIds].sort((a, b) => a - b)) {
      if (seen.has(id)) continue;
      const members: number[] = [], queue = [id]; seen.add(id);
      while (queue.length) {
        const cur = queue.shift()!; members.push(cur);
        for (const b of this.bondsFrom(cur)) {
          if (!prisonerIds.has(b.to) || seen.has(b.to) || b.affinity < .32 || b.trust < .28) continue;
          const back = this.bond(b.to, cur, false);
          if (!back || back.affinity < .28 || back.trust < .24) continue;
          seen.add(b.to); queue.push(b.to);
        }
      }
      if (members.length < 2) continue;
      const cohesion = members.reduce((sum, a) => sum + members.reduce((s, b) => a === b ? s : s + (this.bond(a, b, false)?.trust ?? 0), 0), 0) / Math.max(1, members.length * (members.length - 1));
      this.cliques.set(this.nextCliqueId, { id: this.nextCliqueId++, members: members.sort((a, b) => a - b), cohesion });
    }
  }

  private pruneBonds(worldTime: number, byId: Map<number, Agent>): void {
    for (const [key, b] of this.bonds) {
      if (!byId.has(b.from) || !byId.has(b.to)) { this.bonds.delete(key); continue; }
      if (worldTime - b.lastInteraction > 7 * 24 * 30 && b.familiarity < .12 && Math.abs(b.affinity) < .1 && b.grievances === 0) this.bonds.delete(key);
    }
  }

  private guardDistance(ag: Agent, agents: Agent[]): number {
    let d = Infinity;
    for (const other of agents) if (other.kind === Obj.Guard) d = Math.min(d, Math.hypot(other.x - ag.x, other.z - ag.z));
    return d;
  }

  private random(): number {
    let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000;
  }

  saveData() {
    return {
      bonds: [...this.bonds.values()].map((b) => ({ ...b })),
      intel: [...this.intel].map(([id, facts]) => ({ id, facts: [...facts.values()].map((f) => ({ ...f, expiresAt: Number.isFinite(f.expiresAt) ? f.expiresAt : -1 })) })),
      conversations: [...this.conversations.values()].map((c) => ({ ...c, participants: [...c.participants] })),
      cliques: [...this.cliques.values()].map((c) => ({ ...c, members: [...c.members] })),
      nextConversationId: this.nextConversationId, nextCliqueId: this.nextCliqueId, rngState: this.rngState,
    };
  }

  loadData(data: Partial<ReturnType<PrisonerSocialSystem["saveData"]>>): void {
    this.bonds.clear(); for (const b of data.bonds ?? []) this.bonds.set(bondKey(b.from, b.to), { ...b });
    this.intel.clear();
    for (const row of data.intel ?? []) this.intel.set(row.id, new Map(row.facts.map((f) => [f.key, { ...f, expiresAt: f.expiresAt < 0 ? Infinity : f.expiresAt }])));
    this.conversations.clear(); for (const c of data.conversations ?? []) this.conversations.set(c.id, { ...c, participants: [...c.participants] });
    this.cliques.clear(); for (const c of data.cliques ?? []) this.cliques.set(c.id, { ...c, members: [...c.members] });
    this.nextConversationId = data.nextConversationId ?? 1; this.nextCliqueId = data.nextCliqueId ?? 1; this.rngState = data.rngState ?? 0x8b9d31e5;
  }
}
