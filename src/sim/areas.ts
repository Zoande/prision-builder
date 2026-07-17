import { defOf, RoomType, roomDef } from "./objects.ts";
import type { World } from "./world.ts";
import type { Agent } from "./agent.ts";
import { Obj } from "./objects.ts";

export type AccessRole = "prisoner" | "worker" | "guard" | "armed-guard" | "investigator" |
  "dog-handler" | "doctor" | "cook" | "workman" | "chief" | "foreman" | "accountant" | "staff" | "driver" | "visitor";
export type AccessCustody = "minimum" | "medium" | "maximum" | "supermax" | "protective";
export type LockTier = "public" | "staff" | "guard";

export function accessRoleForAgent(agent: Agent): AccessRole {
  if (agent.kind === Obj.Prisoner) return "prisoner";
  if (agent.kind === Obj.Guard) return "guard";
  if (agent.kind === Obj.ArmedGuard || agent.kind === Obj.Sniper) return "armed-guard";
  if (agent.kind === Obj.Investigator) return "investigator";
  if (agent.kind === Obj.DogHandler || agent.kind === Obj.SecurityDog) return "dog-handler";
  if (agent.kind === Obj.Doctor) return "doctor";
  if (agent.kind === Obj.Cook) return "cook";
  if (agent.kind === Obj.Workman) return "workman";
  if (agent.kind === Obj.ChiefOfficer) return "chief";
  if (agent.kind === Obj.Foreman) return "foreman";
  if (agent.kind === Obj.Accountant) return "accountant";
  return "staff";
}

export interface StructuralArea {
  id: number;
  tiles: Set<number>;
  exterior: boolean;
  roofed: boolean;
  touchesEdges: number;
  roomIds: Set<number>;
}

export interface AreaPortal {
  tile: number;
  a: number;
  b: number;
  lockTier: LockTier;
  open: boolean;
}

export interface AreaAccessPolicy {
  areaId: number;
  roles: Record<AccessRole, boolean>;
  custody: Record<AccessCustody, boolean>;
  mixed: boolean;
  reservedCustody: AccessCustody | "";
}

const ROLE_DEFAULTS: Record<AccessRole, boolean> = {
  prisoner: false, worker: false, guard: true, "armed-guard": true,
  investigator: true, "dog-handler": true, doctor: true, cook: true,
  workman: true, staff: true, driver: false, visitor: false,
  chief: true, foreman: true, accountant: true,
};
const CUSTODY_DEFAULTS: Record<AccessCustody, boolean> = {
  minimum: false, medium: false, maximum: false, supermax: false, protective: false,
};

export class AreaSystem {
  readonly areaAt: Int32Array;
  readonly areas = new Map<number, StructuralArea>();
  readonly portals: AreaPortal[] = [];
  readonly access = new Map<number, AreaAccessPolicy>();
  private nextAreaId = 1;
  private readonly size: number;

  constructor(size: number) { this.size = size; this.areaAt = new Int32Array(size * size); }

  recompute(world: World): void {
    const previousAt = new Int32Array(this.areaAt);
    const previousAreas = new Map(this.areas);
    this.areaAt.fill(0); this.areas.clear(); this.portals.length = 0;
    const seen = new Uint8Array(this.size * this.size);
    const components: number[][] = [];
    const barrier = (i: number) => {
      const def = defOf(world.objKind[i]);
      return !!def?.roomBarrier;
    };
    for (let start = 0; start < seen.length; start++) {
      if (seen[start] || barrier(start)) continue;
      seen[start] = 1;
      const tiles = [start], queue = [start];
      while (queue.length) {
        const i = queue.pop()!, x = i % this.size, z = (i / this.size) | 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nz < 0 || nx >= this.size || nz >= this.size) continue;
          const ni = nz * this.size + nx;
          if (seen[ni] || barrier(ni) || !world.canNavigateEdge(i, ni)) continue;
          seen[ni] = 1; tiles.push(ni); queue.push(ni);
        }
      }
      components.push(tiles);
    }

    const claimedPrevious = new Set<number>();
    components.sort((a, b) => b.length - a.length);
    for (const tiles of components) {
      const overlap = new Map<number, number>();
      for (const tile of tiles) {
        const old = previousAt[tile];
        if (old > 0) overlap.set(old, (overlap.get(old) ?? 0) + 1);
      }
      let id = 0, best = 0;
      for (const [old, count] of overlap) if (!claimedPrevious.has(old) && count > best) { id = old; best = count; }
      if (id <= 0) id = this.nextAreaId++;
      else claimedPrevious.add(id);
      this.nextAreaId = Math.max(this.nextAreaId, id + 1);
      const tileSet = new Set(tiles);
      let touchesEdges = 0, roofedCount = 0;
      const roomIds = new Set<number>();
      for (const tile of tiles) {
        this.areaAt[tile] = id;
        const x = tile % this.size, z = (tile / this.size) | 0;
        if (x === 0) touchesEdges |= 1; if (x === this.size - 1) touchesEdges |= 2;
        if (z === 0) touchesEdges |= 4; if (z === this.size - 1) touchesEdges |= 8;
        if (world.roofed[tile]) roofedCount++;
        const roomId = world.roomId[tile]; if (roomId > 0) roomIds.add(roomId);
      }
      this.areas.set(id, { id, tiles: tileSet, exterior: touchesEdges !== 0, roofed: roofedCount === tiles.length, touchesEdges, roomIds });
      if (!this.access.has(id)) this.access.set(id, this.defaultAccess(id, world, tileSet));
    }

    for (const old of previousAreas.keys()) if (!this.areas.has(old)) this.access.delete(old);
    this.buildPortals(world);
    world.externalRoomIssues.clear();
    for (const room of world.rooms.values()) {
      const ids = new Set([...room.tiles].map((tile) => this.areaAt[tile]).filter((id) => id > 0));
      if (ids.size !== 1) world.externalRoomIssues.set(room.id, "Room designation must be contiguous and remain inside one structural area.");
    }
    world.task2Access = (tile, custody) => {
      const areaId = this.areaAt[tile], policy = this.access.get(areaId);
      if (!policy || !policy.roles.prisoner) return false;
      const tier = (custody || "minimum") as AccessCustody;
      return !!policy.custody[tier] && (policy.mixed || !policy.reservedCustody || policy.reservedCustody === tier);
    };
    world.task2RoleAccess = (tile, role, custody) => {
      const areaId = this.areaAt[tile], policy = this.access.get(areaId);
      if (!policy) return false;
      const accessRole = role as AccessRole;
      if (!policy.roles[accessRole]) return false;
      if (!custody) return true;
      const tier = custody as AccessCustody;
      return !!policy.custody[tier] && (policy.mixed || !policy.reservedCustody || policy.reservedCustody === tier);
    };
    world.validateRooms();
  }

  areaForTile(tile: number): StructuralArea | null { return this.areas.get(this.areaAt[tile]) ?? null; }
  isExteriorTile(tile: number): boolean { return this.areaForTile(tile)?.exterior ?? true; }

  mayEnter(areaId: number, role: AccessRole, custody?: AccessCustody): boolean {
    const policy = this.access.get(areaId);
    if (!policy || !policy.roles[role]) return false;
    if (!custody) return true;
    if (!policy.custody[custody]) return false;
    return policy.mixed || !policy.reservedCustody || policy.reservedCustody === custody;
  }

  admitCustody(areaId: number, custody: AccessCustody): boolean {
    const policy = this.access.get(areaId);
    if (!policy || !policy.custody[custody]) return false;
    if (!policy.mixed && policy.reservedCustody && policy.reservedCustody !== custody) return false;
    if (!policy.mixed) policy.reservedCustody = custody;
    return true;
  }

  releaseReservation(areaId: number): void {
    const policy = this.access.get(areaId);
    if (policy) policy.reservedCustody = "";
  }

  updateOccupancy(world: World, agents: readonly Agent[]): void {
    const occupied = new Map<number, AccessCustody[]>();
    for (const agent of agents) {
      if (agent.kind !== Obj.Prisoner || !agent.profile || agent.underground || !world.inBounds(Math.floor(agent.x), Math.floor(agent.z))) continue;
      const areaId = this.areaAt[world.idx(Math.floor(agent.x), Math.floor(agent.z))];
      const custody = ((agent as Agent & { protectiveCustody?: boolean }).protectiveCustody ? "protective" : agent.profile.custody) as AccessCustody;
      const list = occupied.get(areaId) ?? []; list.push(custody); occupied.set(areaId, list);
    }
    for (const [areaId, policy] of this.access) {
      if (policy.mixed) { policy.reservedCustody = ""; continue; }
      const present = occupied.get(areaId) ?? [];
      if (!present.length) policy.reservedCustody = "";
      else if (!policy.reservedCustody) policy.reservedCustody = present.sort()[0];
    }
  }

  saveData() {
    return {
      nextAreaId: this.nextAreaId,
      access: [...this.access.values()].map((p) => ({ ...p, roles: { ...p.roles }, custody: { ...p.custody } })),
    };
  }

  loadData(data: Partial<ReturnType<AreaSystem["saveData"]>>): void {
    this.nextAreaId = data.nextAreaId ?? 1; this.access.clear();
    for (const p of data.access ?? []) this.access.set(p.areaId, { ...p, roles: { ...ROLE_DEFAULTS, ...p.roles }, custody: { ...CUSTODY_DEFAULTS, ...p.custody } });
  }

  private defaultAccess(areaId: number, world: World, tiles: Set<number>): AreaAccessPolicy {
    const roles = { ...ROLE_DEFAULTS }, custody = { ...CUSTODY_DEFAULTS };
    for (const tile of tiles) {
      const room = world.rooms.get(world.roomId[tile]);
      if (!room?.valid) continue;
      if (roomDef(room.type)?.prisonerAccess || [RoomType.Cell, RoomType.Dorm].includes(room.type as never)) {
        roles.prisoner = true;
        custody.minimum = custody.medium = custody.maximum = custody.supermax = true;
      }
    }
    return { areaId, roles, custody, mixed: true, reservedCustody: "" };
  }

  private buildPortals(world: World): void {
    for (let tile = 0; tile < this.areaAt.length; tile++) {
      const kind = world.objKind[tile], def = defOf(kind);
      if (!def?.roomBarrier || def.place !== "opening") continue;
      const x = tile % this.size, z = (tile / this.size) | 0;
      const pairs = [[[x - 1, z], [x + 1, z]], [[x, z - 1], [x, z + 1]]];
      for (const pair of pairs) {
        const [aa, bb] = pair;
        if (!world.inBounds(aa[0], aa[1]) || !world.inBounds(bb[0], bb[1])) continue;
        const a = this.areaAt[world.idx(aa[0], aa[1])], b = this.areaAt[world.idx(bb[0], bb[1])];
        if (a <= 0 || b <= 0 || a === b) continue;
        const lockTier: LockTier = def.name.toLowerCase().includes("jail") ? "guard"
          : def.name.toLowerCase().includes("staff") ? "staff" : "public";
        this.portals.push({ tile, a, b, lockTier, open: world.jailClosed[tile] === 0 });
        break;
      }
    }
  }
}
