import assert from "node:assert/strict";
import { Agents } from "../src/sim/agents.ts";
import { blankAgent, type EscapePlan } from "../src/sim/agent.ts";
import { Obj, World } from "../src/sim/world.ts";
import {
  APTITUDE_IDS, PERSONALITY_IDS, generatePrisonerProfile, freshPrisonerMind,
} from "../src/sim/profiles.ts";

function prisoner(id: number, x = 10.5, z = 10.5) {
  const a = blankAgent(Obj.Prisoner);
  a.id = id; a.x = x; a.z = z; a.cuffed = false;
  a.profile = generatePrisonerProfile(id);
  a.mind = freshPrisonerMind(a.profile);
  a.needs.social = 0;
  return a;
}

// Profile determinism, score bounds, distribution and rare extremes.
assert.deepEqual(generatePrisonerProfile(42), generatePrisonerProfile(42));
const sums = Object.fromEntries(APTITUDE_IDS.map((id) => [id, 0])) as Record<typeof APTITUDE_IDS[number], number>;
let ones = 0, tens = 0;
for (let i = 1; i <= 20_000; i++) {
  const p = generatePrisonerProfile(i);
  assert.ok(p.firstName && p.lastName && p.labels.length >= 2 && p.labels.length <= 5);
  assert.ok(p.priors.length <= 4 && p.sentenceMonths > 0);
  for (const id of APTITUDE_IDS) {
    assert.ok(p.aptitudes[id] >= 1 && p.aptitudes[id] <= 10);
    sums[id] += p.aptitudes[id];
    if (p.aptitudes[id] === 1) ones++;
    if (p.aptitudes[id] === 10) tens++;
  }
  for (const id of PERSONALITY_IDS) assert.ok(p.personality[id] >= -1 && p.personality[id] <= 1);
}
for (const id of APTITUDE_IDS) assert.ok(sums[id] / 20_000 > 5.25 && sums[id] / 20_000 < 5.75, `${id} mean ${sums[id] / 20_000}`);
assert.ok(ones > 0 && tens > 0);
assert.ok(ones + tens < 20_000 * APTITUDE_IDS.length * .13, "extreme levels remain rare");

// Passive conversation, directed bonds, social refill, observations and save round-trip.
const world = new World(64);
const agents = new Agents();
for (let i = 0; i < 12; i++) agents.agents.push(prisoner(i + 1, 10.5 + (i % 4) * .7, 10.5 + Math.floor(i / 4) * .7));
agents.nextId = 13;
for (let t = 0; t < 1200; t++) agents.update(.05, world, false, 12, t * .05);
assert.ok(agents.social.bonds.size > 0, "social encounters create sparse directed bonds");
assert.ok([...agents.social.intel.values()].some((m) => m.size > 0), "prisoners observe sourced facts");
assert.ok(agents.agents.some((a) => a.needs.social > 0), "conversation refills social need");
for (const b of agents.social.bonds.values()) assert.ok(agents.social.bond(b.to, b.from, false), "conversation creates both directed views");

const restored = new Agents();
restored.loadData(JSON.parse(JSON.stringify(agents.saveData())));
assert.equal(restored.agents.length, agents.agents.length);
assert.equal(restored.social.bonds.size, agents.social.bonds.size);
assert.equal(restored.agents[0].profile?.firstName, agents.agents[0].profile?.firstName);
assert.equal(restored.agents[0].needs.social, agents.agents[0].needs.social);

// Shared operation has no member cap, elects distinct roles, and persists.
const leader = agents.agents[0];
const plan: EscapePlan = { method: "dig", breaches: [900], exitTile: 1000, needed: 1, stage: "prepare", legI: 0, toiletIdx: 650, watchdog: 90 };
leader.plan = plan;
const op = agents.escapeOperations.adoptSoloPlan(leader, plan, 0);
for (let id = 13; id <= 20; id++) agents.agents.push(prisoner(id, 12 + id * .1, 12));
for (const a of agents.agents.slice(1)) assert.ok(agents.escapeOperations.inviteMember(op, a, a.id, leader.id));
assert.equal(op.members.length, 20, "conspiracies are not capped at six or ten");
const direct = new Map<number, number>();
for (const m of op.members) if (m.parentId >= 0) direct.set(m.parentId, (direct.get(m.parentId) ?? 0) + 1);
assert.ok([...direct.values()].every((n) => n <= 4), "leadership hierarchy enforces a four-person span");

// Three diggers maximum, with separate branch/main face claims.
const net = agents.escapeOperations.ensureTunnelNetwork(op, 650, leader.id, 64);
for (let i = 1; i < 5; i++) agents.escapeOperations.ensureTunnelNetwork(op, 650 + i * 64, agents.agents[i].id, 64);
const claims = agents.agents.slice(0, 5).map((a, i) => agents.escapeOperations.claimDigFace(net.id, a, i === 0 ? 650 : 650 + i * 64));
assert.equal(claims.filter(Boolean).length, 3, "only three inmates can actively dig in one network");
assert.equal(net.activeDiggers.length, 3);

const opCopy = new Agents();
opCopy.loadData(JSON.parse(JSON.stringify(agents.saveData())));
assert.equal(opCopy.escapeOperations.operations.get(op.id)?.members.length, 20);
assert.equal(opCopy.escapeOperations.tunnels.get(net.id)?.entries.length, 5);

// A 500-prisoner social broad-phase tick remains bounded and avoids an NxN graph.
const scale = new Agents();
for (let i = 0; i < 500; i++) scale.agents.push(prisoner(i + 1, .5 + (i % 50), .5 + Math.floor(i / 50)));
scale.nextId = 501;
for (let i = 0; i < 20; i++) scale.update(.05, world, false, 12, i * .05);
assert.ok(scale.social.bonds.size < 500 * 30, `sparse graph grew to ${scale.social.bonds.size}`);

console.log("prisoner profiles/social/intel/conspiracies/tunnels: ok");
