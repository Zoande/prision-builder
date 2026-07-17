// Read-only adapters between simulation state and GPU instance buffers.

import { Item, heldSlots } from "./items.ts";
import { K_CUT, K_OPEN, type Agent } from "./agent.ts";
import { Obj } from "./objects.ts";
import type { Agents } from "./agents.ts";
import type { World } from "./world.ts";
import type { LogisticsSystem } from "./logistics.ts";
import type { IntakeSystem } from "./intake.ts";
import { CUSTODY_COLORS } from "./profiles.ts";

export const PERSON_INSTANCE_FLOATS = 19;

export interface InstanceBatch {
  data: Float32Array;
  count: number;
}

export interface PersonInstances {
  prisoners: InstanceBatch;
  guards: InstanceBatch;
  cooks: InstanceBatch;
  workmen: InstanceBatch;
  snipers: InstanceBatch;
}

/** Reusable CPU staging buffers: normal frames allocate no person arrays. */
export class PersonInstanceStager {
  readonly instances: PersonInstances = {
    prisoners: { data: new Float32Array(0), count: 0 },
    guards: { data: new Float32Array(0), count: 0 },
    cooks: { data: new Float32Array(0), count: 0 },
    workmen: { data: new Float32Array(0), count: 0 },
    snipers: { data: new Float32Array(0), count: 0 },
  };
  private readonly all = [
    this.instances.prisoners, this.instances.guards, this.instances.cooks,
    this.instances.workmen, this.instances.snipers,
  ];

  stage(agents: readonly Agent[]): PersonInstances {
    for (const batch of this.all) batch.count = 0;
    for (const ag of agents) {
      if (ag.underground || ag.state === "removed") continue;
      const batch = this.batch(ag.kind);
      if (batch) batch.count++;
    }
    for (const batch of this.all) this.ensureCapacity(batch, batch.count * PERSON_INSTANCE_FLOATS);

    const offsets = { prisoners: 0, guards: 0, cooks: 0, workmen: 0, snipers: 0 };
    for (const ag of agents) {
      if (ag.underground || ag.state === "removed") continue;
      const key = this.key(ag.kind);
      if (!key) continue;
      const batch = this.instances[key];
      let o = offsets[key];
      const [h0, h1] = heldSlots(ag.inv);
      batch.data[o++] = ag.x;
      batch.data[o++] = ag.z;
      batch.data[o++] = ag.heading;
      batch.data[o++] = ag.baton || ag.kind === Obj.Sniper ? 1 : 0;
      batch.data[o++] = ag.pose;
      batch.data[o++] = ag.phase;
      batch.data[o++] = ag.amp;
      batch.data[o++] = (ag.cuffed ? 1 : 0) + (h0 === Item.Tray || h1 === Item.Tray ? 2 : 0);
      batch.data[o++] = h0;
      batch.data[o++] = h1;
      batch.data[o++] = ag.elev;
      const profile = ag.profile;
      batch.data[o++] = profile?.body.height ?? 1;
      batch.data[o++] = profile?.body.build ?? 1;
      batch.data[o++] = profile?.body.skin ?? .52;
      batch.data[o++] = profile ? profile.body.hairStyle + profile.body.hairColor * .99 : .25;
      const uniform = profile ? CUSTODY_COLORS[profile.custody] : [0, 0, 0];
      batch.data[o++] = uniform[0]; batch.data[o++] = uniform[1]; batch.data[o++] = uniform[2];
      const social = ag.socialAction === "talking" ? 1 : ag.socialAction === "arguing" ? 2 : 0;
      batch.data[o++] = profile ? (profile.body.posture + 1) * .5 + profile.body.gesture * 2 + social * 8 + profile.body.scars * 24 + profile.body.tattoos * 96 : 0;
      offsets[key] = o;
    }
    return this.instances;
  }

  private key(kind: number): keyof PersonInstances | null {
    if (kind === Obj.Prisoner) return "prisoners";
    if (kind === Obj.Guard) return "guards";
    if (kind === Obj.Investigator || kind === Obj.DogHandler || kind === Obj.ArmedGuard || kind === Obj.ChiefOfficer) return "guards";
    if (kind === Obj.Cook) return "cooks";
    if (kind === Obj.Doctor || kind === Obj.Accountant) return "cooks";
    if (kind === Obj.Workman || kind === Obj.Foreman) return "workmen";
    if (kind === Obj.SecurityDog) return "workmen";
    if (kind === Obj.Sniper) return "snipers";
    return null;
  }

  private batch(kind: number): InstanceBatch | null {
    const key = this.key(kind);
    return key ? this.instances[key] : null;
  }

  private ensureCapacity(batch: InstanceBatch, needed: number) {
    if (batch.data.length >= needed) return;
    let capacity = Math.max(PERSON_INSTANCE_FLOATS * 16, batch.data.length * 2);
    while (capacity < needed) capacity *= 2;
    batch.data = new Float32Array(capacity);
  }
}

export function foodInstances(A: Agents, world: World): Float32Array {
  const out: number[] = [];
  for (const i of A.mealTables) {
    if (world.objKind[i] !== Obj.Table) { A.mealTables.delete(i); A.mealsDirty = true; continue; }
    out.push(i % world.size, (i / world.size) | 0, world.objOrient[i]);
  }
  return new Float32Array(out);
}

export function trayStackInstances(A: Agents, world: World): Float32Array {
  const out: number[] = [];
  for (const [i, stock] of A.servingStock) {
    if (world.objKind[i] !== Obj.ServingTable) { A.servingStock.delete(i); continue; }
    if (stock > 0) out.push(i % world.size, (i / world.size) | 0, world.objOrient[i]);
  }
  return new Float32Array(out);
}

export function holeInstances(A: Agents, world: World): { entries: Float32Array; surfs: Float32Array } {
  const entries: number[] = [], surfs: number[] = [];
  for (const t of A.tunnels) {
    entries.push(t.entry % world.size, (t.entry / world.size) | 0, world.objOrient[t.entry]);
    if (t.surfHole >= 0) surfs.push(t.surfHole % world.size, (t.surfHole / world.size) | 0, 0);
  }
  return { entries: new Float32Array(entries), surfs: new Float32Array(surfs) };
}

export function logisticsInstances(logistics: LogisticsSystem, intake: IntakeSystem): {
  trucks: Float32Array; intakeTrucks: Float32Array; cargo: Float32Array; drivers: Float32Array;
} {
  const trucks: number[] = [], intakeTrucks: number[] = [], cargo: number[] = [], drivers: number[] = [];
  for (const truck of logistics.trucks) {
    trucks.push(truck.x - 1, truck.z - 3, 0);
    if (truck.state === "unloading" || truck.state === "blocked") drivers.push(371, 375 + (truck.id & 1), 2);
  }
  for (const truck of intake.vehicles) {
    intakeTrucks.push(truck.x - 1, truck.z - 3, 0);
    if (truck.state === "processing" || truck.state === "waiting") drivers.push(371, 373, 2);
  }
  for (const pkg of logistics.packages.values()) {
    if (pkg.state === "in-transit" || pkg.state === "ordered") continue;
    cargo.push(pkg.x + (pkg.id % 3) * 0.22, pkg.z + (Math.floor(pkg.id / 3) % 3) * 0.22, pkg.id & 3);
  }
  return { trucks: new Float32Array(trucks), intakeTrucks: new Float32Array(intakeTrucks), cargo: new Float32Array(cargo), drivers: new Float32Array(drivers) };
}

export function knownOverlay(ag: Agent, world: World, A?: Agents): Float32Array {
  if (!ag.known) return new Float32Array(0);
  const out: number[] = [];
  for (const [i, v] of ag.known) {
    out.push(i % world.size, (i / world.size) | 0, v === K_OPEN || v === K_CUT ? 0 : 1);
  }
  for (const s of ag.objMem!.values()) {
    for (const i of s) out.push(i % world.size, (i / world.size) | 0, 2);
  }
  if (ag.tunnel) {
    const t = ag.tunnel;
    const sx = (t.entry % world.size) + 0.5, sz = ((t.entry / world.size) | 0) + 0.5;
    for (let d = 1; d <= t.believed; d++) {
      out.push(Math.floor(sx + Math.cos(t.heading) * d), Math.floor(sz + Math.sin(t.heading) * d), 2);
    }
    out.push(Math.floor(t.actualX), Math.floor(t.actualZ), 1);
  }
  if (A) {
    for (const bond of A.social.bondsFrom(ag.id)) {
      if (bond.familiarity < .08) continue;
      const other = A.agents.find((a) => a.id === bond.to);
      if (!other || other.underground) continue;
      out.push(Math.floor(other.x), Math.floor(other.z), bond.affinity < -.12 || bond.grievances > 0 ? 7 : 6);
    }
    const op = A.escapeOperations.operationFor(ag);
    if (op) for (const member of op.members) {
      const other = A.agents.find((a) => a.id === member.agentId);
      if (other && !other.underground) out.push(Math.floor(other.x), Math.floor(other.z), 8);
    }
    if (op && op.tunnelNetworkId >= 0) {
      const net = A.escapeOperations.tunnels.get(op.tunnelNetworkId);
      if (net) for (const entry of net.entries) out.push(entry.tile % world.size, (entry.tile / world.size) | 0, 9);
    }
  }
  return new Float32Array(out);
}
