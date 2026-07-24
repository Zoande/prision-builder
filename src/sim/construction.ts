import { addRecipe, boxCommodity, ensureBoxCommodity, type Recipe } from "./commodities.ts";
import type { Tool, ToolCat } from "../editor.ts";
import { LogisticsSystem } from "./logistics.ts";
import { DIRS, Obj, RoomType, World, defOf, type Piece } from "./world.ts";

export type BuildOperation = "build" | "demolish" | "repair";
export type BuildState = "waiting-resources" | "ready" | "active" | "blocked" | "complete" | "cancelled";
export type BuildTargetState =
  | "queued" | "awaiting-materials" | "hauling" | "ready"
  | "working" | "blocked" | "complete" | "cancelled";

export interface BuildBlocker {
  code: string;
  message: string;
  retryable: boolean;
  suggestedAction: "wait" | "demolish" | "clear-access" | "hire-workman" | "cancel" | "add-funds";
}

export interface PlacementValidation {
  valid: boolean;
  code: string;
  message: string;
  affectedTiles: { x: number; z: number }[];
  suggestedAction: BuildBlocker["suggestedAction"] | "none";
}

export interface BuildTarget {
  id: number;
  x: number;
  z: number;
  cat: ToolCat;
  mat: number;
  orient: number;
  recipe: Recipe;
  delivered: Recipe;
  workSeconds: number;
  completed: boolean;
  claimedBy: number;
  progress: number;
  blocker: string;
  state: BuildTargetState;
  blockerDetail: BuildBlocker | null;
  demolition?: DemolitionSnapshot;
}

interface DemolitionSnapshot {
  floor: number;
  kind: number;
  mat: number;
  orient: number;
  piece: Piece | null;
}

export interface BuildOrderGroup {
  id: number;
  operation: BuildOperation;
  createdAt: number;
  targets: BuildTarget[];
  state: BuildState;
  blocker: string;
}

export interface GhostTarget extends BuildTarget {
  operation: BuildOperation;
  groupId: number;
  valid: boolean;
}

export class ConstructionSystem {
  readonly groups = new Map<number, BuildOrderGroup>();
  readonly warnings = new Set<string>();
  private readonly reservations = new Map<string, number>();
  private readonly salvageFractions = new Map<string, number>();
  private nextGroupId = 1;
  private nextTargetId = 1;
  private retryTimer = 3;
  lastIssue: PlacementValidation | null = null;

  readonly logistics: LogisticsSystem;
  constructor(logistics: LogisticsSystem) { this.logistics = logistics; }

  tick(dt: number): void {
    this.retryTimer -= dt;
    if (this.retryTimer > 0) return;
    this.retryTimer = 3;
    for (const group of this.groups.values()) for (const target of group.targets) {
      if (target.blockerDetail?.retryable) {
        target.blocker = "";
        target.blockerDetail = null;
        target.state = "queued";
      }
    }
    this.refreshStates();
  }

  plan(tool: Tool, tiles: ReadonlyArray<{ x: number; z: number }>, orient: number, worldTime: number, world: World): BuildOrderGroup | null {
    this.lastIssue = null;
    if (!isConstructedTool(tool.cat)) return null;
    if (tool.cat === "erase") return this.planDemolition(tiles[0]?.x ?? -1, tiles[0]?.z ?? -1, worldTime, world);
    const group: BuildOrderGroup = {
      id: this.nextGroupId++, operation: "build", createdAt: worldTime,
      targets: [], state: "waiting-resources", blocker: "",
    };
    for (const tile of tiles) {
      const target = this.makeTarget(tool, tile.x, tile.z, orient, true);
      if (!target) continue;
      const validation = this.validateTarget(target, world, group.id);
      target.blocker = validation.message;
      target.blockerDetail = validation.valid ? null : this.blockerFromValidation(validation);
      if (!validation.valid) { this.lastIssue ??= validation; continue; }
      group.targets.push(target);
      for (const key of this.targetReservationKeys(target, world)) this.reservations.set(key, group.id);
    }
    if (group.targets.length === 0) return null;
    this.groups.set(group.id, group);
    this.logistics.request(this.groupRecipe(group), worldTime, false, `construction:${group.id}`);
    return group;
  }

  preview(tool: Tool, tiles: ReadonlyArray<{ x: number; z: number }>, orient: number, world: World): GhostTarget[] {
    const result: GhostTarget[] = [];
    for (const tile of tiles) {
      if (tool.cat === "erase") {
        const snapshot = this.snapshotAt(tile.x, tile.z, world);
        if (!snapshot) continue;
        const target = this.demolitionTarget(tile.x, tile.z, snapshot);
        const roadStructure = snapshot.kind === Obj.SecureBridge || snapshot.kind === Obj.Gatehouse;
        result.push({ ...target, operation: "demolish", groupId: 0, valid: !world.isInfrastructure(tile.x, tile.z) || roadStructure });
        continue;
      }
      const target = this.makeTarget(tool, tile.x, tile.z, orient, false);
      if (!target) continue;
      result.push({
        ...target, operation: "build", groupId: 0,
        valid: this.validateTarget(target, world, 0).valid,
      });
    }
    return result;
  }

  planDemolition(x: number, z: number, worldTime: number, world: World): BuildOrderGroup | null {
    if (!world.inBounds(x, z)) return null;
    const clickedPiece = world.pieceAtTile(world.idx(x, z));
    if (world.isInfrastructure(x, z) && clickedPiece?.kind !== Obj.SecureBridge && clickedPiece?.kind !== Obj.Gatehouse) return null;
    const snapshot = this.snapshotAt(x, z, world);
    if (!snapshot) return null;
    if (snapshot.kind === Obj.Prisoner) return null;
    const room = world.roomAt(world.idx(x, z));
    if (room?.type === RoomType.Delivery) {
      const validYards = [...world.rooms.values()].filter((r) => r.type === RoomType.Delivery && r.valid).length;
      if (validYards <= 1) return null;
    }
    const anchorX = snapshot.piece?.x ?? x, anchorZ = snapshot.piece?.z ?? z;
    const existing = this.groupAt(anchorX, anchorZ);
    if (existing) return null;
    const target = this.demolitionTarget(anchorX, anchorZ, snapshot);
    const group: BuildOrderGroup = {
      id: this.nextGroupId++, operation: "demolish", createdAt: worldTime,
      targets: [target], state: "ready", blocker: "",
    };
    this.groups.set(group.id, group);
    for (const key of this.targetReservationKeys(target, world)) this.reservations.set(key, group.id);
    return group;
  }

  cancelGroup(groupId: number): boolean {
    const group = this.groups.get(groupId);
    if (!group || group.state === "complete" || group.state === "cancelled") return false;
    for (const target of group.targets) {
      if (target.completed) continue;
      target.claimedBy = -1;
      target.state = "cancelled";
      target.blockerDetail = null;
      this.logistics.returnToStock(this.owner(group.id, target.id));
    }
    this.releaseMapReservations(group.id);
    this.logistics.cancelSource(`construction:${group.id}`);
    group.state = "cancelled";
    group.blocker = "Cancelled by player";
    return true;
  }

  cancelAt(x: number, z: number, world: World): boolean {
    const group = this.groupAt(x, z, world);
    return group ? this.cancelGroup(group.id) : false;
  }

  retryGroup(groupId: number): boolean {
    const group = this.groups.get(groupId);
    if (!group || group.state === "complete" || group.state === "cancelled") return false;
    for (const target of group.targets) {
      if (target.completed || target.claimedBy >= 0) continue;
      target.blocker = "";
      target.blockerDetail = null;
      target.state = "queued";
    }
    this.refreshStates();
    return true;
  }

  groupAt(x: number, z: number, world?: World): BuildOrderGroup | null {
    for (const group of this.groups.values()) {
      if (group.state === "cancelled" || group.state === "complete") continue;
      for (const target of group.targets) {
        if (target.completed) continue;
        if (target.x === x && target.z === z) return group;
        if (world && target.cat === "piece") {
          const def = defOf(target.mat);
          if (!def) continue;
          const [ax, az] = DIRS[target.orient & 3], [bx, bz] = DIRS[(target.orient + 1) & 3];
          for (let a = 0; a < def.w; a++) for (let b = 0; b < def.d; b++) {
            if (target.x + ax * a + bx * b === x && target.z + az * a + bz * b === z) return group;
          }
        }
      }
    }
    return null;
  }

  /** Oldest order first; distance breaks ties. Reachability is checked by the
   *  staff pathfinder after claiming and unreachable claims are released. */
  claimNext(workerId: number, x: number, z: number, world: World): {
    group: BuildOrderGroup; target: BuildTarget; phase: "haul" | "work"; packageId: number;
  } | null {
    this.refreshStates();
    const candidates: { group: BuildOrderGroup; target: BuildTarget; distance: number }[] = [];
    for (const group of this.groups.values()) {
      if (group.state === "cancelled" || group.state === "complete") continue;
      for (const target of group.targets) {
        if (target.completed || target.claimedBy >= 0 || target.blocker) continue;
        if (!this.dependencyReady(target, world)) continue;
        candidates.push({ group, target, distance: Math.abs(target.x - x) + Math.abs(target.z - z) });
      }
    }
    candidates.sort((a, b) =>
      operationPriority(a.group.operation) - operationPriority(b.group.operation) ||
      a.group.createdAt - b.group.createdAt || a.distance - b.distance || a.target.id - b.target.id);
    for (const candidate of candidates) {
      const { group, target } = candidate;
      const owner = this.owner(group.id, target.id);
      let phase: "haul" | "work" = "work", packageId = -1;
      if (group.operation === "build") {
        const remaining = this.remainingRecipe(target);
        if (Object.values(remaining).some((amount) => amount > 0)) {
          const pkg = this.logistics.reserveBundle(remaining, owner);
          if (!pkg) continue;
          phase = "haul"; packageId = pkg.id;
        }
      }
      target.claimedBy = workerId;
      target.state = phase === "haul" ? "hauling" : "working";
      group.state = "active";
      return { group, target, phase, packageId };
    }
    return null;
  }

  releaseClaim(groupId: number, targetId: number, workerId: number, blocker = ""): void {
    const target = this.groups.get(groupId)?.targets.find((t) => t.id === targetId);
    if (!target || target.claimedBy !== workerId) return;
    target.claimedBy = -1;
    target.blocker = blocker;
    target.progress = 0;
    target.blockerDetail = blocker ? {
      code: blocker === "Unreachable construction site" ? "unreachable" : "interrupted",
      message: blocker,
      retryable: true,
      suggestedAction: "clear-access",
    } : null;
    target.state = blocker ? "blocked" : "queued";
    this.logistics.release(this.owner(groupId, targetId));
    this.refreshStates();
  }

  releaseWorker(workerId: number): void {
    for (const group of this.groups.values()) for (const target of group.targets) {
      if (target.claimedBy === workerId) this.releaseClaim(group.id, target.id, workerId, "Assigned workman is no longer available");
    }
  }

  setProgress(groupId: number, targetId: number, workerId: number, progress: number): void {
    const target = this.groups.get(groupId)?.targets.find((t) => t.id === targetId);
    if (target?.claimedBy === workerId) target.progress = Math.max(0, Math.min(1, progress));
  }

  pickUpBundle(groupId: number, targetId: number, packageId: number, workerId: number, x: number, z: number): boolean {
    const target = this.groups.get(groupId)?.targets.find((t) => t.id === targetId);
    if (!target || target.claimedBy !== workerId) return false;
    return this.logistics.carry(packageId, this.owner(groupId, targetId), x, z);
  }

  moveBundle(packageId: number, x: number, z: number): void {
    const pkg = this.logistics.packages.get(packageId);
    if (pkg?.state === "carried") { pkg.x = x; pkg.z = z; }
  }

  deliverBundle(groupId: number, targetId: number, packageId: number, workerId: number): boolean {
    const target = this.groups.get(groupId)?.targets.find((t) => t.id === targetId);
    if (!target || target.claimedBy !== workerId) return false;
    const pkg = this.logistics.placeAtSite(packageId, this.owner(groupId, targetId), target.x, target.z);
    if (!pkg) return false;
    target.delivered[pkg.commodity] = (target.delivered[pkg.commodity] ?? 0) + pkg.quantity;
    target.claimedBy = -1;
    target.state = Object.values(this.remainingRecipe(target)).some((amount) => amount > 0) ? "queued" : "ready";
    this.refreshStates();
    return true;
  }

  complete(groupId: number, targetId: number, workerId: number, world: World): boolean {
    const group = this.groups.get(groupId);
    const target = group?.targets.find((t) => t.id === targetId);
    if (!group || !target || target.claimedBy !== workerId || target.completed) return false;
    let changed = false;
    if (group.operation === "build") {
      if (Object.values(this.remainingRecipe(target)).some((amount) => amount > 0)) return false;
      if (this.matchesDesired(target, world)) {
        changed = true;
        this.logistics.returnToStock(this.owner(groupId, targetId));
      } else {
        const validation = this.validateTarget(target, world, group.id);
        if (!validation.valid) {
          target.claimedBy = -1;
          target.progress = 0;
          target.blocker = validation.message;
          target.blockerDetail = this.blockerFromValidation(validation);
          target.state = "blocked";
          this.logistics.release(this.owner(groupId, targetId));
          this.refreshStates();
          return false;
        }
        changed = this.applyTarget(target, world);
        if (changed) this.logistics.consume(this.owner(groupId, targetId));
        else this.logistics.release(this.owner(groupId, targetId));
      }
    } else if (group.operation === "demolish") {
      changed = target.demolition ? this.applyDemolition(target, target.demolition, world) : false;
      if (changed && target.demolition) this.recover(target, target.demolition);
    }
    target.claimedBy = -1;
    target.progress = changed ? 1 : 0;
    target.completed = changed;
    target.state = changed ? "complete" : "blocked";
    target.blockerDetail = changed ? null : {
      code: "world-changed", message: "World changed before work completed", retryable: false, suggestedAction: "cancel",
    };
    if (!changed) target.blocker = "World changed before work completed";
    this.refreshStates();
    if (group.state === "complete") this.releaseMapReservations(group.id);
    return changed;
  }

  persistentGhosts(): GhostTarget[] {
    const result: GhostTarget[] = [];
    for (const group of this.groups.values()) {
      if (group.state === "complete" || group.state === "cancelled") continue;
      for (const target of group.targets) if (!target.completed) {
        result.push({ ...target, operation: group.operation, groupId: group.id, valid: !target.blocker });
      }
    }
    return result;
  }

  groupRecipe(group: BuildOrderGroup): Recipe {
    const result: Recipe = {};
    for (const target of group.targets) if (!target.completed) addRecipe(result, target.recipe);
    return result;
  }

  estimate(tool: Tool, targetCount = 1): Recipe {
    const recipe = recipeFor(tool) ?? {};
    return addRecipe({}, recipe, targetCount);
  }

  private makeTarget(tool: Tool, x: number, z: number, orient: number, allocateId: boolean): BuildTarget | null {
    const recipe = recipeFor(tool);
    if (!recipe) return null;
    if (tool.cat === "piece" && tool.mat === Obj.Gatehouse) {
      if (x < 372 || x > 377) return null;
      x = 370;
      z -= 1;
      orient = 0;
    }
    return {
      id: allocateId ? this.nextTargetId++ : 0, x, z, cat: tool.cat, mat: tool.mat, orient: orient & 3,
      recipe, delivered: {}, workSeconds: workTime(tool), completed: false, claimedBy: -1,
      progress: 0, blocker: "", state: "queued", blockerDetail: null,
    };
  }

  validatePlacement(tool: Tool, x: number, z: number, orient: number, world: World): PlacementValidation {
    const target = this.makeTarget(tool, x, z, orient, false);
    return target
      ? this.validateTarget(target, world, 0)
      : { valid: false, code: "unsupported", message: "This tool cannot create a construction order", affectedTiles: [{ x, z }], suggestedAction: "none" };
  }

  private validateTarget(target: BuildTarget, world: World, groupId: number): PlacementValidation {
    const affectedTiles = this.footprint(target);
    const invalid = (
      code: string, message: string,
      suggestedAction: PlacementValidation["suggestedAction"] = "cancel",
    ): PlacementValidation => ({ valid: false, code, message, affectedTiles, suggestedAction });
    const valid = (): PlacementValidation => ({ valid: true, code: "ok", message: "", affectedTiles, suggestedAction: "none" });
    if (!world.inBounds(target.x, target.z)) return invalid("outside-map", "Outside the buildable map");
    const roadStructure = target.cat === "piece" && (target.mat === Obj.SecureBridge || target.mat === Obj.Gatehouse);
    if (world.isInfrastructure(target.x, target.z) && !roadStructure) return invalid("immutable-road", "The road is immutable");
    for (const key of this.targetReservationKeys(target, world)) {
      const holder = this.reservations.get(key);
      if (holder !== undefined && holder !== groupId) return invalid("reserved", "Reserved by another order", "wait");
    }
    const i = world.idx(target.x, target.z);
    if (target.cat === "floor") return world.floorMat[i] === target.mat ? invalid("already-built", "Already built", "none") : valid();
    if (target.cat === "piece") {
      const def = defOf(target.mat);
      if (!def) return invalid("unknown-object", "Unknown object");
      const [ax, az] = DIRS[target.orient & 3], [bx, bz] = DIRS[(target.orient + 1) & 3];
      for (let a = 0; a < def.w; a++) for (let b = 0; b < def.d; b++) {
        const tx = target.x + ax * a + bx * b, tz = target.z + az * a + bz * b;
        if (!world.inBounds(tx, tz)) return invalid("outside-map", "Object footprint leaves the map");
        const ti = world.idx(tx, tz);
        if (target.mat !== Obj.SecureBridge && target.mat !== Obj.Gatehouse && (world.objKind[ti] !== Obj.None || world.infrastructure[ti])) return invalid("occupied", "Object footprint is occupied", "demolish");
        if ((target.mat === Obj.SecureBridge || target.mat === Obj.Gatehouse) && world.objKind[ti] !== Obj.None) return invalid("occupied", "Object footprint is occupied", "demolish");
      }
      if (target.mat === Obj.SecureBridge && target.orient % 2 !== 0) return invalid("orientation", "Secure bridge has a fixed east/west orientation");
      if (target.mat === Obj.SecureBridge && target.x !== 370) return invalid("road-position", "Secure bridge must span the road and both two-tile approaches");
      if (target.mat === Obj.Gatehouse && (target.orient !== 0 || target.x !== 370)) return invalid("road-position", "Gatehouse must span the road east/west");
      if (target.mat === Obj.Gatehouse && (target.z < 1 || target.z + def.d >= world.size - 1)) return invalid("road-position", "Gatehouse needs road space on both sides");
      return valid();
    }
    if (target.cat === "door" || target.cat === "staffdoor" || target.cat === "jaildoor") {
      if (world.objKind[i] === Obj.Wall || world.objKind[i] === Obj.WallLight) return valid();
      return this.hasPlannedSupport(target.x, target.z, "wall") ? valid() : invalid("missing-wall", "Needs a completed or planned wall", "wait");
    }
    if (target.cat === "fencedoor" || target.cat === "fencestaffdoor" || target.cat === "fencejaildoor") {
      if (world.objKind[i] === Obj.Fence) return valid();
      return this.hasPlannedSupport(target.x, target.z, "fence") ? valid() : invalid("missing-fence", "Needs a completed or planned fence", "wait");
    }
    if (target.cat === "walllight") {
      if (world.objKind[i] === Obj.Wall) return valid();
      return this.hasPlannedSupport(target.x, target.z, "wall") ? valid() : invalid("missing-wall", "Needs a completed or planned wall", "wait");
    }
    if (target.cat === "rooflight" && !world.roofed[i]) return invalid("missing-roof", "Needs a completed roof", "wait");
    if (target.cat === "wall" || target.cat === "fence") {
      if (world.objKind[i] !== Obj.None) {
        const same = target.cat === "wall"
          ? world.objKind[i] === Obj.Wall && world.objMat[i] === target.mat
          : world.objKind[i] === Obj.Fence && world.objMat[i] === target.mat;
        return invalid(same ? "already-built" : "occupied", same ? "Already built" : "Tile is occupied; demolish the existing structure first", same ? "none" : "demolish");
      }
      return valid();
    }
    if (world.objKind[i] !== Obj.None) return invalid("occupied", "Tile is occupied", "demolish");
    return valid();
  }

  private hasPlannedSupport(x: number, z: number, cat: "wall" | "fence"): boolean {
    for (const group of this.groups.values()) for (const target of group.targets) {
      if (!target.completed && target.x === x && target.z === z && target.cat === cat) return true;
    }
    return false;
  }

  private targetReservationKeys(target: BuildTarget, world: World): string[] {
    if (target.cat === "floor") return [`floor:${target.x},${target.z}`];
    if (["door", "staffdoor", "jaildoor", "fencedoor", "fencestaffdoor", "fencejaildoor", "walllight"].includes(target.cat)) {
      return [`fixture:${target.x},${target.z}`];
    }
    if (target.cat !== "piece") return [`object:${target.x},${target.z}`];
    const def = defOf(target.mat);
    if (!def) return [];
    const [ax, az] = DIRS[target.orient & 3], [bx, bz] = DIRS[(target.orient + 1) & 3];
    const result: string[] = [];
    for (let a = 0; a < def.w; a++) for (let b = 0; b < def.d; b++) {
      const x = target.x + ax * a + bx * b, z = target.z + az * a + bz * b;
      if (world.inBounds(x, z)) result.push(`object:${x},${z}`);
    }
    return result;
  }

  private footprint(target: BuildTarget): { x: number; z: number }[] {
    if (target.cat !== "piece") return [{ x: target.x, z: target.z }];
    const def = defOf(target.mat);
    if (!def) return [{ x: target.x, z: target.z }];
    const [ax, az] = DIRS[target.orient & 3], [bx, bz] = DIRS[(target.orient + 1) & 3];
    const result: { x: number; z: number }[] = [];
    for (let a = 0; a < def.w; a++) for (let b = 0; b < def.d; b++) {
      result.push({ x: target.x + ax * a + bx * b, z: target.z + az * a + bz * b });
    }
    return result;
  }

  private blockerFromValidation(validation: PlacementValidation): BuildBlocker {
    return {
      code: validation.code,
      message: validation.message,
      retryable: ["reserved", "missing-wall", "missing-fence", "missing-roof"].includes(validation.code),
      suggestedAction: validation.suggestedAction === "none" ? "cancel" : validation.suggestedAction,
    };
  }

  private matchesDesired(target: BuildTarget, world: World): boolean {
    if (!world.inBounds(target.x, target.z)) return false;
    const i = world.idx(target.x, target.z);
    if (target.cat === "floor") return world.floorMat[i] === target.mat;
    if (target.cat === "wall") return world.objKind[i] === Obj.Wall && world.objMat[i] === target.mat;
    if (target.cat === "fence") return world.objKind[i] === Obj.Fence && world.objMat[i] === target.mat;
    if (target.cat === "piece") {
      const piece = world.pieceAtTile(i);
      return !!piece && piece.kind === target.mat && piece.x === target.x && piece.z === target.z && piece.orient === target.orient;
    }
    return world.objKind[i] === objectKindFor(target.cat);
  }

  private applyTarget(target: BuildTarget, world: World): boolean {
    switch (target.cat) {
      case "floor": return world.setFloor(target.x, target.z, target.mat);
      case "wall": return world.setWall(target.x, target.z, target.mat);
      case "fence": return world.setFence(target.x, target.z, target.mat);
      case "door": return world.setDoor(target.x, target.z);
      case "staffdoor": return world.setDoor(target.x, target.z, "staff");
      case "jaildoor": return world.setDoor(target.x, target.z, true);
      case "fencedoor": return world.setFenceGate(target.x, target.z, false);
      case "fencestaffdoor": return world.setFenceGate(target.x, target.z, "staff");
      case "fencejaildoor": return world.setFenceGate(target.x, target.z, true);
      case "lamp": return world.setLamp(target.x, target.z);
      case "walllight": return world.setWallLight(target.x, target.z);
      case "rooflight": return world.setRoofLight(target.x, target.z);
      case "piece": return world.placePiece(target.x, target.z, target.mat, target.orient);
      default: return false;
    }
  }

  private dependencyReady(target: BuildTarget, world: World): boolean {
    const i = world.idx(target.x, target.z);
    if (target.cat === "door" || target.cat === "staffdoor" || target.cat === "jaildoor" || target.cat === "walllight") {
      return world.objKind[i] === Obj.Wall || world.objKind[i] === Obj.WallLight;
    }
    if (target.cat === "fencedoor" || target.cat === "fencestaffdoor" || target.cat === "fencejaildoor") return world.objKind[i] === Obj.Fence;
    return true;
  }

  private snapshotAt(x: number, z: number, world: World): DemolitionSnapshot | null {
    if (!world.inBounds(x, z)) return null;
    const i = world.idx(x, z), piece = world.pieceAtTile(i);
    if (!piece && world.objKind[i] === Obj.None && world.floorMat[i] === 0) return null;
    const anchor = piece ? world.idx(piece.x, piece.z) : i;
    return {
      floor: world.floorMat[anchor], kind: world.objKind[anchor], mat: world.objMat[anchor],
      orient: world.objOrient[anchor], piece: piece ? { ...piece } : null,
    };
  }

  private demolitionTarget(x: number, z: number, snapshot: DemolitionSnapshot): BuildTarget {
    const sourceTool = toolFromSnapshot(snapshot);
    return {
      id: this.nextTargetId++, x, z, cat: snapshot.piece ? "piece" : sourceTool.cat,
      mat: snapshot.piece?.kind ?? sourceTool.mat, orient: snapshot.orient,
      recipe: {}, workSeconds: workTime(sourceTool) * 0.6, completed: false,
      delivered: {},
      claimedBy: -1, progress: 0, blocker: "", state: "queued", blockerDetail: null, demolition: snapshot,
    };
  }

  private recover(target: BuildTarget, snapshot: DemolitionSnapshot): void {
    const bulkStructure = snapshot.kind === Obj.SecureBridge || snapshot.kind === Obj.Gatehouse;
    if ((snapshot.piece || isBoxedObject(snapshot.kind)) && !bulkStructure) {
      const kind = snapshot.piece?.kind ?? snapshot.kind;
      this.logistics.addSalvage(boxCommodity(kind), 1, target.x, target.z);
      return;
    }
    const recipe = recipeFor(toolFromSnapshot(snapshot)) ?? {};
    for (const [commodity, amount] of Object.entries(recipe)) {
      const accumulated = (this.salvageFractions.get(commodity) ?? 0) + amount * 0.5;
      const whole = Math.floor(accumulated);
      this.salvageFractions.set(commodity, accumulated - whole);
      if (whole > 0) this.logistics.addSalvage(commodity, whole, target.x, target.z);
    }
  }

  private applyDemolition(target: BuildTarget, snapshot: DemolitionSnapshot, world: World): boolean {
    if (snapshot.piece && (snapshot.kind === Obj.SecureBridge || snapshot.kind === Obj.Gatehouse)) {
      return world.removePieceAt(target.x, target.z);
    }
    if (snapshot.kind === Obj.WallLight || snapshot.kind === Obj.Door || snapshot.kind === Obj.StaffDoor || snapshot.kind === Obj.JailDoor) {
      return world.setWall(target.x, target.z, snapshot.mat || 1);
    }
    if (snapshot.kind === Obj.FenceDoor || snapshot.kind === Obj.StaffFenceDoor || snapshot.kind === Obj.FenceJailDoor) {
      return world.setFence(target.x, target.z, snapshot.mat || 1);
    }
    return world.erase(target.x, target.z);
  }

  private refreshStates(): void {
    this.warnings.clear();
    let unfinished = 0;
    for (const group of this.groups.values()) {
      if (group.state === "cancelled" || group.state === "complete") continue;
      const open = group.targets.filter((target) => !target.completed && target.state !== "cancelled");
      unfinished += open.length;
      for (const target of open) {
        if (target.claimedBy >= 0) continue;
        if (target.blockerDetail) { target.state = "blocked"; continue; }
        const remaining = this.remainingRecipe(target);
        const needsMaterials = Object.values(remaining).some((amount) => amount > 0);
        if (!needsMaterials || group.operation !== "build") target.state = "ready";
        else {
          const available = Object.entries(remaining).some(([id, n]) => n > 0 && this.logistics.quantity(id) - this.logistics.reserved(id) > 0);
          target.state = available ? "queued" : "awaiting-materials";
        }
      }
      if (open.length === 0) {
        group.state = "complete";
        group.blocker = "";
        this.releaseMapReservations(group.id);
      } else if (open.some((target) => target.claimedBy >= 0 || target.state === "hauling" || target.state === "working")) {
        group.state = "active";
        group.blocker = "";
      } else if (open.every((target) => target.state === "blocked")) {
        group.state = "blocked";
        group.blocker = open[0]?.blocker || "Construction is blocked";
      } else if (open.some((target) => target.state === "awaiting-materials")) {
        group.state = "waiting-resources";
        group.blocker = "Waiting for delivered materials";
      } else {
        group.state = "ready";
        group.blocker = "";
      }
    }
    if (unfinished > 0) this.warnings.add("Construction orders need workmen");
  }

  private remainingRecipe(target: BuildTarget): Recipe {
    const result: Recipe = {};
    for (const [commodity, amount] of Object.entries(target.recipe)) {
      result[commodity] = Math.max(0, amount - (target.delivered[commodity] ?? 0));
    }
    return result;
  }

  private releaseMapReservations(groupId: number): void {
    for (const [key, holder] of [...this.reservations]) if (holder === groupId) this.reservations.delete(key);
  }

  private owner(groupId: number, targetId: number): string { return `build:${groupId}:${targetId}`; }

  saveData() {
    return {
      groups: [...this.groups.values()], reservations: [...this.reservations],
      salvageFractions: [...this.salvageFractions], nextGroupId: this.nextGroupId,
      nextTargetId: this.nextTargetId,
    };
  }

  reconcile(world: World, liveWorkerIds: ReadonlySet<number>): void {
    for (const group of this.groups.values()) for (const target of group.targets) {
      if (target.claimedBy >= 0 && !liveWorkerIds.has(target.claimedBy)) {
        this.logistics.returnToStock(this.owner(group.id, target.id));
        target.claimedBy = -1;
        target.progress = 0;
        target.state = "queued";
      }
      if (target.completed) {
        target.state = "complete";
        target.blocker = "";
        target.blockerDetail = null;
      } else if (target.blockerDetail?.retryable) {
        target.blocker = "";
        target.blockerDetail = null;
        target.state = "queued";
      } else if (!target.blockerDetail && target.blocker) {
        target.blockerDetail = {
          code: "legacy-blocker", message: target.blocker, retryable: target.blocker === "Unreachable construction site",
          suggestedAction: target.blocker === "Unreachable construction site" ? "clear-access" : "cancel",
        };
        target.state = "blocked";
      }
      if (!target.completed && this.matchesDesired(target, world)) {
        target.completed = true;
        target.progress = 1;
        target.state = "complete";
        target.blocker = "";
        target.blockerDetail = null;
        this.logistics.returnToStock(this.owner(group.id, target.id));
      }
    }
    this.reservations.clear();
    for (const group of this.groups.values()) {
      if (group.state === "cancelled") continue;
      for (const target of group.targets) if (!target.completed && target.state !== "cancelled") {
        for (const key of this.targetReservationKeys(target, world)) this.reservations.set(key, group.id);
      }
    }
    this.refreshStates();
  }

  loadData(data: Partial<ReturnType<ConstructionSystem["saveData"]>>): void {
    this.groups.clear();
    for (const group of data.groups ?? []) this.groups.set(group.id, {
      ...group,
      targets: group.targets.map((target) => ({
        ...target,
        recipe: { ...target.recipe },
        delivered: {},
        claimedBy: -1,
        progress: target.completed ? 1 : 0,
        state: target.completed ? "complete" : target.blocker ? "blocked" : "queued",
        blockerDetail: target.blocker ? {
          code: "loaded-blocker", message: target.blocker,
          retryable: target.blocker === "Unreachable construction site",
          suggestedAction: target.blocker === "Unreachable construction site" ? "clear-access" : "cancel",
        } : null,
      })),
    });
    this.reservations.clear();
    for (const [key, id] of data.reservations ?? []) this.reservations.set(key, id);
    this.salvageFractions.clear();
    for (const [key, amount] of data.salvageFractions ?? []) this.salvageFractions.set(key, amount);
    this.nextGroupId = data.nextGroupId ?? 1;
    this.nextTargetId = data.nextTargetId ?? 1;
  }
}

function isConstructedTool(cat: ToolCat): boolean {
  return ["floor", "wall", "fence", "door", "staffdoor", "jaildoor", "fencedoor", "fencestaffdoor", "fencejaildoor", "lamp", "walllight", "rooflight", "piece", "erase"].includes(cat);
}

function operationPriority(operation: BuildOperation): number {
  return operation === "repair" ? 0 : operation === "build" ? 1 : 2;
}

function isBoxedObject(kind: number): boolean {
  const def = defOf(kind);
  return !!def && kind !== Obj.None && kind !== Obj.Wall && kind !== Obj.Fence &&
    kind !== Obj.CutFence && def.place !== "person" && def.place !== "sim";
}

function objectKindFor(cat: ToolCat): number {
  if (cat === "door") return Obj.Door;
  if (cat === "staffdoor") return Obj.StaffDoor;
  if (cat === "jaildoor") return Obj.JailDoor;
  if (cat === "fencedoor") return Obj.FenceDoor;
  if (cat === "fencestaffdoor") return Obj.StaffFenceDoor;
  if (cat === "fencejaildoor") return Obj.FenceJailDoor;
  if (cat === "lamp") return Obj.Lamp;
  if (cat === "walllight") return Obj.WallLight;
  if (cat === "rooflight") return Obj.RoofLight;
  return Obj.None;
}

function recipeFor(tool: Tool): Recipe | null {
  if (tool.cat === "floor") {
    if (tool.mat === 1 || tool.mat === 2) return { concrete: 1 };
    if (tool.mat === 3) return { timber: 1 };
    if (tool.mat === 4) return { metal: 1 };
  }
  if (tool.cat === "wall") return tool.mat === 1 ? { concrete: 2 } : { metal: 2 };
  if (tool.cat === "fence") return { metal: 1 };
  if (tool.cat === "piece") {
    if (tool.mat === Obj.SecureBridge) return { concrete: 20, metal: 10 };
    if (tool.mat === Obj.Gatehouse) return { concrete: 18, metal: 12 };
    const def = defOf(tool.mat);
    if (!def) return null;
    ensureBoxCommodity(def);
    return { [boxCommodity(tool.mat)]: 1 };
  }
  const kind = objectKindFor(tool.cat);
  if (kind !== Obj.None) {
    const def = defOf(kind)!;
    ensureBoxCommodity(def);
    return { [boxCommodity(kind)]: 1 };
  }
  return null;
}

function workTime(tool: Tool): number {
  if (tool.cat === "floor") return 2;
  if (tool.cat === "wall" || tool.cat === "fence") return 4;
  if (tool.cat === "piece") {
    if (tool.mat === Obj.SecureBridge) return 30;
    if (tool.mat === Obj.Gatehouse) return 40;
    return 8;
  }
  return 6;
}

function toolFromSnapshot(snapshot: DemolitionSnapshot): Tool {
  if (snapshot.piece) return { cat: "piece", mat: snapshot.piece.kind };
  if (snapshot.kind === Obj.Wall || snapshot.kind === Obj.WallLight) return { cat: "wall", mat: snapshot.mat };
  if (snapshot.kind === Obj.Fence || snapshot.kind === Obj.CutFence) return { cat: "fence", mat: snapshot.mat };
  if (snapshot.kind === Obj.Door) return { cat: "door", mat: 0 };
  if (snapshot.kind === Obj.StaffDoor) return { cat: "staffdoor", mat: 0 };
  if (snapshot.kind === Obj.JailDoor) return { cat: "jaildoor", mat: 0 };
  if (snapshot.kind === Obj.FenceDoor) return { cat: "fencedoor", mat: 0 };
  if (snapshot.kind === Obj.StaffFenceDoor) return { cat: "fencestaffdoor", mat: 0 };
  if (snapshot.kind === Obj.FenceJailDoor) return { cat: "fencejaildoor", mat: 0 };
  if (snapshot.kind === Obj.Lamp) return { cat: "lamp", mat: 0 };
  if (snapshot.kind === Obj.RoofLight) return { cat: "rooflight", mat: 0 };
  return { cat: "floor", mat: snapshot.floor };
}
