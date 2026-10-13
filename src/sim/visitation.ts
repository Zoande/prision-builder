import type { Agent } from "./agent.ts";
import type { AreaSystem } from "./areas.ts";
import type { FacilitySecurityGraph } from "./facilitySecurity.ts";
import type { MarketSystem } from "./market.ts";
import { followPath, pathAdjacent } from "./move.ts";
import { angleLerp, astar, passable, prisonerAllowed, roleAllowed } from "./nav.ts";
import { Obj, RoomType } from "./objects.ts";
import type { World } from "./world.ts";
import { HOUR_SECONDS } from "./time.ts";

export type VisitState = "waitingGate" | "toScreening" | "waitingScreen" | "toTable" |
  "waitingPrisoner" | "contact" | "leaving";

export interface VisitationStatus {
  visitsCompleted: number;
  state: VisitState | "idle";
  prisonerId: number | null;
  roomId: number | null;
  visitors: ReadonlyArray<Pick<PhysicalVisitor, "id" | "prisonerId" | "x" | "z" | "state">>;
  warnings: readonly string[];
}

export interface PhysicalVisitor {
  id: number;
  contactId: number;
  prisonerId: number;
  x: number;
  z: number;
  heading: number;
  phase: number;
  state: VisitState;
  path: number[];
  pathI: number;
}

interface VisitSession {
  id: number;
  prisonerId: number;
  contactId: number;
  visitorId: number;
  roomId: number;
  deskTile: number;
  tableTile: number;
  exteriorTile: number;
  screeningGuardId: number;
  screenRemaining: number;
  contactElapsed: number;
  waitElapsed: number;
  retryAt: number;
  residentRetryAt: number;
  residentArrived: boolean;
  rewarded: boolean;
  entryPath: number[];
  state: VisitState;
}

/** Ordinary family visits use a real visitor, route, screening desk, table, and resident rendezvous. */
export class VisitationSystem {
  readonly warnings = new Set<string>();
  readonly visitors: PhysicalVisitor[] = [];
  visitsCompleted = 0;
  private session: VisitSession | null = null;
  private nextVisitId = 1;
  private nextVisitorId = 1;
  private nextScheduleAt = 0;
  private scheduleWarning = "";
  private readonly market: MarketSystem;
  private readonly areas: AreaSystem;
  private readonly facility: FacilitySecurityGraph;

  constructor(market: MarketSystem, areas: AreaSystem, facility: FacilitySecurityGraph) {
    this.market = market; this.areas = areas; this.facility = facility;
  }

  status(): VisitationStatus {
    return {
      visitsCompleted: this.visitsCompleted,
      state: this.session?.state ?? "idle",
      prisonerId: this.session?.prisonerId ?? null,
      roomId: this.session?.roomId ?? null,
      visitors: this.visitors.map(({ id, prisonerId, x, z, state }) => ({ id, prisonerId, x, z, state })),
      warnings: [...this.warnings],
    };
  }

  hasAppointment(prisonerId: number): boolean {
    return this.session?.prisonerId === prisonerId && this.session.state !== "leaving";
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[], unavailable: (id: number) => boolean): void {
    this.warnings.clear();
    const session = this.session;
    if (session) this.advanceSession(session, dt, time, world, agents, unavailable);
    if (this.session) return;
    const candidate = agents.filter((agent) => agent.kind === Obj.Prisoner && agent.needs.family < .58 &&
      !unavailable(agent.id) && !agent.cuffed && agent.escortedBy < 0 && !this.isCustodyState(agent.state))
      .sort((a, b) => a.needs.family - b.needs.family || a.id - b.id)
      .map((agent) => ({ agent, contact: this.market.contacts.get(agent.id)?.filter((row) =>
        row.relation === "family" && row.trust >= .3 && row.resources >= .08)
        .sort((a, b) => b.trust * b.resources - a.trust * a.resources || a.id - b.id)[0] }))
      .find((row) => row.contact);
    if (!candidate?.contact) {
      this.scheduleWarning = "";
      if (time >= this.nextScheduleAt) this.nextScheduleAt = time + HOUR_SECONDS * 2;
      return;
    }
    if (this.scheduleWarning) this.warnings.add(this.scheduleWarning);
    if (time < this.nextScheduleAt) return;
    const origin = this.exteriorGateStart(world);
    if (origin < 0) {
      this.scheduleWarning = "Family visits need a public Gatehouse beside accessible outdoor space";
      this.warnings.add(this.scheduleWarning);
      this.nextScheduleAt = time + HOUR_SECONDS;
      return;
    }
    const site = this.visitationSite(world, origin);
    if (!site) {
      this.scheduleWarning = "Family visits need a valid Visitation Room with a Visitor Search Desk and Visit Table or Visit Screen";
      this.warnings.add(this.scheduleWarning);
      this.nextScheduleAt = time + HOUR_SECONDS;
      return;
    }
    if (!this.findPath(world, origin, site.deskTile, "visitor")) {
      this.scheduleWarning = "Family visits need Visitor access from the public Gatehouse to the Visitation Room. Review Area Access along the route.";
      this.warnings.add(this.scheduleWarning);
      this.nextScheduleAt = time + HOUR_SECONDS;
      return;
    }
    this.scheduleWarning = "";
    const id = this.nextVisitId++, visitorId = this.nextVisitorId++;
    const x = origin % world.size + .5, z = ((origin / world.size) | 0) + .5;
    this.visitors.push({ id: visitorId, contactId: candidate.contact.id, prisonerId: candidate.agent.id,
      x, z, heading: 0, phase: 0, state: "waitingGate", path: [], pathI: 0 });
    this.session = { id, prisonerId: candidate.agent.id, contactId: candidate.contact.id, visitorId,
      roomId: site.roomId, deskTile: site.deskTile, tableTile: site.tableTile, exteriorTile: origin,
      screeningGuardId: -1, screenRemaining: 8, contactElapsed: 0, waitElapsed: 0, retryAt: time,
      residentRetryAt: time, residentArrived: false, rewarded: false, entryPath: [], state: "waitingGate" };
    this.nextScheduleAt = time + HOUR_SECONDS * 6;
  }

  updatePrisoner(agent: Agent, dt: number, time: number, world: World, _agents: readonly Agent[],
    unavailable: boolean, activeEscape: boolean): boolean {
    const session = this.session;
    if (!session || session.prisonerId !== agent.id || session.state === "leaving") return false;
    if (unavailable || agent.cuffed || agent.escortedBy >= 0 || activeEscape || this.isCustodyState(agent.state)) {
      if (agent.state === "walkingToVisit" || agent.state === "visiting") {
        agent.path = null; agent.state = "idle"; agent.interact = -1;
      }
      session.residentArrived = false;
      return false;
    }
    if (agent.needs.food < .35 || agent.needs.sleep < .35 || agent.needs.bladder < .15 || agent.needs.hygiene < .15) {
      if (agent.state === "walkingToVisit" || agent.state === "visiting") {
        agent.path = null; agent.state = "idle"; agent.interact = -1;
      }
      session.residentArrived = false;
      return false;
    }
    if (session.state !== "toTable" && session.state !== "waitingPrisoner" && session.state !== "contact") return false;
    const pausableEscapeState = agent.state.startsWith("escape:") && !activeEscape;
    if (!["idle", "wandering", "exploring", "walkingToVisit", "visiting"].includes(agent.state) && !pausableEscapeState) {
      session.residentArrived = false; return false;
    }
    const prisonerOpen = (tile: number) => passable(world, tile, false, agent.accessKeys) &&
      prisonerAllowed(world, tile, agent.accessKeys, agent.protectiveCustody ? "protective" : agent.profile?.custody);
    if (!this.nearTile(agent.x, agent.z, session.tableTile, world)) {
      if (!agent.path || agent.pathI >= agent.path.length) {
        if (time < session.residentRetryAt) return true;
        agent.path = null; agent.pathI = 0;
        if (!pathAdjacent(agent, world, session.tableTile, prisonerOpen)) {
          session.residentRetryAt = time + 5;
          this.warnings.add(`Family visit for inmate ${agent.id} is waiting for a reachable Visitation table`);
          return true;
        }
      }
      agent.state = "walkingToVisit";
      if (agent.path && !followPath(agent, dt, world, false)) return true;
    }
    session.residentArrived = this.nearTile(agent.x, agent.z, session.tableTile, world);
    agent.state = session.residentArrived ? "visiting" : "walkingToVisit";
    if (session.residentArrived) {
      agent.path = null;
      agent.interact = session.tableTile;
    } else {
      agent.interact = -1;
    }
    agent.amp = session.residentArrived ? 0 : agent.amp;
    return true;
  }

  isParticipant(agent: Agent): boolean {
    const session = this.session;
    return !!session && session.prisonerId === agent.id &&
      ["toTable", "waitingPrisoner", "contact"].includes(session.state) &&
      !agent.cuffed && agent.escortedBy < 0 && !this.isCustodyState(agent.state) &&
      agent.needs.food >= .35 && agent.needs.sleep >= .35 && agent.needs.bladder >= .15 && agent.needs.hygiene >= .15;
  }

  updateStaff(agent: Agent, dt: number, time: number, world: World, urgentResponse: boolean): boolean {
    const session = this.session;
    if (!session || session.state !== "waitingScreen" || session.screeningGuardId !== agent.id || agent.kind !== Obj.Guard) return false;
    if (urgentResponse) { session.screeningGuardId = -1; session.retryAt = time + 5; agent.state = "idle"; agent.path = null; return false; }
    if (!["idle", "deployed", "toDeployment", "toVisitorDesk", "screeningVisitor"].includes(agent.state)) {
      session.screeningGuardId = -1; session.retryAt = time + 5; return false;
    }
    if (!this.nearTile(agent.x, agent.z, session.deskTile, world)) {
      if (!agent.path || agent.pathI >= agent.path.length) {
        if (!pathAdjacent(agent, world, session.deskTile, (tile) => passable(world, tile, true, agent.accessKeys) && roleAllowed(world, tile, "guard"))) {
          session.screeningGuardId = -1; session.retryAt = time + 5; agent.state = "idle";
          this.warnings.add("Family visit screening is waiting for a reachable Visitor Search Desk"); return false;
        }
      }
      agent.state = "toVisitorDesk";
      if (agent.path && !followPath(agent, dt, world, true)) return true;
    }
    agent.path = null; agent.state = "screeningVisitor"; agent.interact = session.deskTile;
    session.screenRemaining = Math.max(0, session.screenRemaining - dt);
    if (session.screenRemaining <= 0) {
      const visitor = this.visitorFor(session);
      const nextPath = visitor ? this.findPath(world, this.currentTile(visitor, world), session.tableTile, "visitor") : null;
      if (!visitor || !nextPath) {
        session.screeningGuardId = -1; agent.state = "idle"; agent.interact = -1;
        session.screenRemaining = 8; session.retryAt += 5;
        this.warnings.add("Family visit is waiting for an accessible Visitation table");
        return true;
      }
      visitor.path = nextPath; visitor.pathI = 0; visitor.state = "toTable";
      session.entryPath = [...session.entryPath, ...visitor.path.slice(1)];
      session.state = "toTable"; session.screeningGuardId = -1;
      agent.state = "idle"; agent.interact = -1;
    }
    return true;
  }

  saveData() {
    return { visitsCompleted: this.visitsCompleted, nextVisitId: this.nextVisitId, nextVisitorId: this.nextVisitorId,
      nextScheduleAt: this.nextScheduleAt, scheduleWarning: this.scheduleWarning,
      session: this.session ? { ...this.session, entryPath: [...this.session.entryPath] } : null,
      visitors: this.visitors.map((visitor) => ({ ...visitor, path: [...visitor.path] })) };
  }

  loadData(data: Partial<ReturnType<VisitationSystem["saveData"]>>): void {
    this.visitsCompleted = data.visitsCompleted ?? 0; this.nextVisitId = data.nextVisitId ?? 1;
    this.nextVisitorId = data.nextVisitorId ?? 1; this.nextScheduleAt = data.nextScheduleAt ?? 0;
    this.scheduleWarning = data.scheduleWarning ?? "";
    this.session = data.session ? { ...data.session, entryPath: [...data.session.entryPath] } : null;
    this.visitors.length = 0; this.visitors.push(...(data.visitors ?? []).map((visitor) => ({ ...visitor, path: [...visitor.path] })));
    if (this.session && !this.visitors.some((visitor) => visitor.id === this.session!.visitorId)) this.session = null;
  }

  private advanceSession(session: VisitSession, dt: number, time: number, world: World, agents: readonly Agent[],
    unavailable: (id: number) => boolean): void {
    const visitor = this.visitorFor(session), prisoner = agents.find((agent) => agent.id === session.prisonerId);
    if (!visitor || !prisoner || prisoner.state === "dead" || prisoner.state === "removed") {
      this.closeSession(session, agents); return;
    }
    if (session.state !== "leaving" && !this.validSite(world, session)) {
      this.warnings.add("An active family visit is leaving because its Visitation Room or screening furniture is unavailable");
      this.beginDeparture(session, visitor, prisoner); return;
    }
    if (session.state !== "leaving" && (unavailable(prisoner.id) || prisoner.cuffed || prisoner.escortedBy >= 0 ||
        this.isCustodyState(prisoner.state))) {
      this.warnings.add(`Family visit for inmate ${prisoner.id} is paused while the resident is unavailable`);
      session.waitElapsed += dt;
      if (session.waitElapsed > HOUR_SECONDS * 2) this.beginDeparture(session, visitor, prisoner);
      return;
    }
    if (session.state === "waitingGate") {
      session.waitElapsed += dt;
      const staffed = this.hasStaffedGate(agents);
      if (!staffed) this.warnings.add("Family visits are waiting for a guard at the public Gatehouse");
      if (staffed && time >= session.retryAt) {
        const path = this.findPath(world, session.exteriorTile, session.deskTile, "visitor");
        if (path) { visitor.path = path; visitor.pathI = 0; visitor.state = "toScreening"; session.entryPath = [...path]; session.state = "toScreening"; }
        else this.retryRoute(session, time, "A visitor cannot reach the Visitation Room. Review Visitor access along the route.");
      }
      if (session.state === "waitingGate" && session.waitElapsed > HOUR_SECONDS * 3) {
        this.warnings.add("A family visit is ending because the public entrance stayed unavailable. Check the Gatehouse guard and Visitor access to the Visitation Room.");
        this.beginDeparture(session, visitor, prisoner);
      }
      return;
    }
    if (session.state === "toScreening" || session.state === "toTable" || session.state === "leaving") {
      if (session.state === "toScreening" && this.nearTile(visitor.x, visitor.z, session.deskTile, world)) {
        visitor.path = []; visitor.state = "waitingScreen"; session.state = "waitingScreen"; session.waitElapsed = 0;
        return;
      }
      if (session.state === "toTable" && this.nearTile(visitor.x, visitor.z, session.tableTile, world)) {
        visitor.path = []; visitor.state = "waitingPrisoner"; session.state = "waitingPrisoner"; session.waitElapsed = 0;
        return;
      }
      if (session.state === "leaving" && this.nearTile(visitor.x, visitor.z, session.exteriorTile, world)) {
        this.visitors.splice(this.visitors.indexOf(visitor), 1); this.session = null;
        if (session.rewarded) this.visitsCompleted++;
        if (prisoner.state === "visiting") { prisoner.state = "idle"; prisoner.interact = -1; prisoner.path = null; }
        return;
      }
      if (!visitor.path.length && time >= session.retryAt) {
        const target = session.state === "toScreening" ? session.deskTile : session.state === "toTable" ? session.tableTile : session.exteriorTile;
        const path = session.state === "leaving" ? this.findPath(world, this.currentTile(visitor, world), target, "visitor") :
          this.findPath(world, this.currentTile(visitor, world), target, "visitor");
        if (path) { visitor.path = path; visitor.pathI = 0; }
        else this.retryRoute(session, time, "A family visitor is waiting for a reachable route");
      }
      this.moveVisitor(visitor, dt, world, time, session);
      return;
    }
    if (session.state === "waitingScreen") {
      session.waitElapsed += dt;
      const screeningGuard = agents.find((agent) => agent.id === session.screeningGuardId);
      if (session.screeningGuardId >= 0 && (!screeningGuard || screeningGuard.state === "dead" ||
          screeningGuard.state === "morgue" || screeningGuard.state === "removed" || unavailable(screeningGuard.id) ||
          !["toVisitorDesk", "screeningVisitor"].includes(screeningGuard.state))) {
        session.screeningGuardId = -1; session.retryAt = time + 5;
      }
      if (session.screeningGuardId < 0 && time >= session.retryAt) this.assignScreeningGuard(session, agents, world, unavailable);
      if (session.screeningGuardId < 0) this.warnings.add("Family visit screening needs an available guard who is not assigned to the Gatehouse");
      if (session.waitElapsed > HOUR_SECONDS * 2) this.beginDeparture(session, visitor, prisoner);
      return;
    }
    if (session.state === "waitingPrisoner" || session.state === "contact") {
      session.waitElapsed += dt;
      if (session.residentArrived && this.nearTile(prisoner.x, prisoner.z, session.tableTile, world)) {
        session.state = "contact"; visitor.state = "contact"; prisoner.state = "visiting";
        session.contactElapsed += dt;
        if (session.contactElapsed >= 20 && !session.rewarded) {
          const contact = this.market.contacts.get(prisoner.id)?.find((row) => row.id === session.contactId);
          if (contact) { contact.resources = Math.max(0, contact.resources - .08); contact.trust = Math.min(1, contact.trust + .025); }
          prisoner.needs.family = Math.min(1, prisoner.needs.family + .5); session.rewarded = true;
          this.beginDeparture(session, visitor, prisoner);
        }
      } else if (session.waitElapsed > HOUR_SECONDS * 2) this.beginDeparture(session, visitor, prisoner);
      else if (!session.residentArrived) this.warnings.add(`A family visitor is waiting for inmate ${prisoner.id} to reach the Visitation table`);
      return;
    }
  }

  private assignScreeningGuard(session: VisitSession, agents: readonly Agent[], world: World,
    unavailable: (id: number) => boolean): void {
    const gateGuards = new Set([...this.facility.gatehouses.values()].map((gate) => gate.guardId));
    const visitorGuard = agents.filter((agent) => agent.kind === Obj.Guard && !unavailable(agent.id) && !gateGuards.has(agent.id) &&
      ["idle", "deployed", "toDeployment"].includes(agent.state) && !agent.cuffed)
      .sort((a, b) => Math.hypot(a.x - session.deskTile % world.size, a.z - Math.floor(session.deskTile / world.size)) -
        Math.hypot(b.x - session.deskTile % world.size, b.z - Math.floor(session.deskTile / world.size)) || a.id - b.id)[0];
    if (visitorGuard) session.screeningGuardId = visitorGuard.id;
    else this.warnings.add("Family visit screening is waiting for an available guard");
  }

  private beginDeparture(session: VisitSession, visitor: PhysicalVisitor, prisoner: Agent): void {
    if (prisoner.state === "visiting" || prisoner.state === "walkingToVisit") {
      prisoner.path = null; prisoner.state = "idle"; prisoner.interact = -1;
    }
    session.residentArrived = false; session.state = "leaving"; visitor.state = "leaving";
    visitor.path = [...session.entryPath].reverse(); visitor.pathI = 0; session.retryAt = 0;
  }

  private closeSession(session: VisitSession, agents: readonly Agent[]): void {
    const prisoner = agents.find((agent) => agent.id === session.prisonerId);
    if (prisoner && (prisoner.state === "visiting" || prisoner.state === "walkingToVisit")) {
      prisoner.path = null; prisoner.state = "idle"; prisoner.interact = -1;
    }
    const visitor = this.visitorFor(session);
    if (visitor) this.beginDeparture(session, visitor, prisoner ?? ({} as Agent));
    else this.session = null;
  }

  private moveVisitor(visitor: PhysicalVisitor, dt: number, world: World, time: number, session: VisitSession): void {
    if (!visitor.path.length || visitor.pathI >= visitor.path.length) return;
    const tile = visitor.path[visitor.pathI]!;
    const open = (index: number) => passable(world, index, false) && roleAllowed(world, index, "visitor");
    if (!open(tile)) { visitor.path = []; visitor.pathI = 0; this.retryRoute(session, time, "A visitor's route was blocked by a door or access change"); return; }
    const x = tile % world.size + .5, z = ((tile / world.size) | 0) + .5, dx = x - visitor.x, dz = z - visitor.z, d = Math.hypot(dx, dz);
    visitor.heading = angleLerp(visitor.heading, Math.atan2(dz, dx), Math.min(1, dt * 10));
    visitor.phase += dt * 9;
    const step = dt * 2.2;
    if (d <= step) { visitor.x = x; visitor.z = z; visitor.pathI++; }
    else { visitor.x += dx / d * step; visitor.z += dz / d * step; }
  }

  private findPath(world: World, start: number, target: number, role: "visitor"): number[] | null {
    const open = (tile: number) => passable(world, tile, false) && roleAllowed(world, tile, role);
    let best: number[] | null = null;
    const tx = target % world.size, tz = Math.floor(target / world.size);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = tx + dx, z = tz + dz;
      if (!world.inBounds(x, z)) continue;
      const end = z * world.size + x;
      if (!open(end) && end !== start) continue;
      const path = astar(world.size, start, end, open, 30000, (from, to) => world.canNavigateEdge(from, to));
      if (path && (!best || path.length < best.length)) best = path;
    }
    return best;
  }

  private visitationSite(world: World, origin: number): { roomId: number; deskTile: number; tableTile: number } | null {
    const candidates: Array<{ roomId: number; deskTile: number; tableTile: number }> = [];
    for (const room of world.rooms.values()) {
      if (!room.valid || room.type !== RoomType.Visitation) continue;
      const desk = [...room.tiles].find((tile) => world.objKind[tile] === Obj.VisitorSearchDesk);
      const table = [...room.tiles].find((tile) => [Obj.VisitTable, Obj.VisitScreen].includes(world.objKind[tile] as never));
      if (desk !== undefined && table !== undefined) candidates.push({ roomId: room.id,
        deskTile: world.anchorOf(desk), tableTile: world.anchorOf(table) });
    }
    return candidates.sort((a, b) => Math.hypot(a.tableTile % world.size - origin % world.size,
      Math.floor(a.tableTile / world.size) - Math.floor(origin / world.size)) -
      Math.hypot(b.tableTile % world.size - origin % world.size,
        Math.floor(b.tableTile / world.size) - Math.floor(origin / world.size)) || a.roomId - b.roomId)[0] ?? null;
  }

  private validSite(world: World, session: VisitSession): boolean {
    const room = world.rooms.get(session.roomId);
    return !!room?.valid && room.type === RoomType.Visitation &&
      room.tiles.has(session.deskTile) && room.tiles.has(session.tableTile) &&
      world.objKind[session.deskTile] === Obj.VisitorSearchDesk &&
      [Obj.VisitTable, Obj.VisitScreen].includes(world.objKind[session.tableTile] as never);
  }

  private exteriorGateStart(world: World): number {
    for (const gate of this.facility.gatehouses.values()) {
      const piece = world.pieces.get(gate.pieceId); if (!piece) continue;
      const occupied = new Set(world.pieceTiles(piece));
      for (const tile of occupied) {
        const x = tile % world.size, z = Math.floor(tile / world.size);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, nz = z + dz;
          if (!world.inBounds(nx, nz)) continue;
          const neighbor = world.idx(nx, nz);
          if (this.areas.areas.get(this.areas.areaAt[neighbor])?.exterior && passable(world, neighbor, false)) return neighbor;
        }
      }
    }
    return -1;
  }

  private hasStaffedGate(agents: readonly Agent[]): boolean {
    return [...this.facility.gatehouses.values()].some((gate) => gate.open && agents.some((agent) =>
      agent.id === gate.guardId && agent.kind === Obj.Guard && agent.state === "manningGatehouse"));
  }

  private retryRoute(session: VisitSession, time: number, warning: string): void {
    if (time < session.retryAt) return;
    session.retryAt = time + 5; this.warnings.add(warning);
  }

  private visitorFor(session: VisitSession): PhysicalVisitor | undefined {
    return this.visitors.find((visitor) => visitor.id === session.visitorId);
  }

  private currentTile(visitor: PhysicalVisitor, world: World): number {
    return world.idx(Math.max(0, Math.min(world.size - 1, Math.floor(visitor.x))),
      Math.max(0, Math.min(world.size - 1, Math.floor(visitor.z))));
  }

  private nearTile(x: number, z: number, tile: number, world: World): boolean {
    return Math.hypot(x - (tile % world.size + .5), z - (Math.floor(tile / world.size) + .5)) <= 1.8;
  }

  private isCustodyState(state: string): boolean {
    return ["cuffed", "restrained", "policyEscort", "escorted", "intakeGo", "intakeEscort", "regimeGo", "regimeEscort",
      "beingTransported", "inTreatment", "incapacitated", "solitary", "caughtAtGatehouse"].includes(state);
  }
}
