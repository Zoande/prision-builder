import type { Agent } from "./agent.ts";
import { Obj, RoomType, type World } from "./world.ts";
import { canSee } from "./vision.ts";

const CELL_SIZE = 12;
const unavailable = (actor: Agent) => ["dead", "morgue", "removed", "incapacitated", "inTreatment", "staffBreak"].includes(actor.state);
const cellKey = (x: number, z: number) => `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`;
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Safety and privacy have physical sources, just like food and rest. These
 * derived indexes are rebuilt once per tick and do not belong in a save. */
export class WelfareSystem {
  private readonly guards = new Map<string, Agent[]>();
  private readonly threats = new Map<string, Agent[]>();
  private readonly occupants = new Map<number, number>();

  refresh(world: World, actors: readonly Agent[]): void {
    this.guards.clear(); this.threats.clear(); this.occupants.clear();
    for (const actor of actors) {
      if (unavailable(actor) || !world.inBounds(Math.floor(actor.x), Math.floor(actor.z))) continue;
      const room = world.roomId[world.idx(Math.floor(actor.x), Math.floor(actor.z))];
      if (actor.kind === Obj.Prisoner && room > 0) this.occupants.set(room, (this.occupants.get(room) ?? 0) + 1);
      const bucket = actor.state === "fighting" ? this.threats
        : [Obj.Guard, Obj.ArmedGuard, Obj.DogHandler, Obj.Investigator].includes(actor.kind as never) ? this.guards : null;
      if (!bucket) continue;
      const key = cellKey(actor.x, actor.z), entries = bucket.get(key) ?? [];
      entries.push(actor); bucket.set(key, entries);
    }
  }

  tick(actor: Agent, dt: number, world: World): void {
    if (actor.kind !== Obj.Prisoner || dt <= 0 || unavailable(actor) || actor.underground ||
        !world.inBounds(Math.floor(actor.x), Math.floor(actor.z))) return;
    const here = world.idx(Math.floor(actor.x), Math.floor(actor.z));
    const room = world.rooms.get(world.roomId[here]);
    const atHome = room?.valid && room.id === actor.cellRoom && (room.type === RoomType.Cell || room.type === RoomType.Dorm);
    // A private cell is a stronger source than shared dormitory space. Other
    // inmates have to physically be present to diminish that privacy.
    if (atHome && !actor.cuffed) {
      const roommates = Math.max(0, (this.occupants.get(room.id) ?? 1) - 1);
      const target = room.type === RoomType.Cell ? Math.max(.55, .95 - roommates * .12)
        : Math.max(.3, .75 - roommates * .045);
      if (actor.needs.privacy < target) actor.needs.privacy = clamp(actor.needs.privacy + (target - actor.needs.privacy) * Math.min(1, dt / 120));
    }

    const visible = (candidate: Agent) => Math.hypot(actor.x - candidate.x, actor.z - candidate.z) <= CELL_SIZE &&
      canSee(actor, world, candidate.x, candidate.z, CELL_SIZE, CELL_SIZE);
    const cx = Math.floor(actor.x / CELL_SIZE), cz = Math.floor(actor.z / CELL_SIZE);
    let protection = false, danger = actor.state === "fighting";
    for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      const key = `${x},${z}`;
      if (!protection) protection = (this.guards.get(key) ?? []).some(visible);
      if (!danger) danger = (this.threats.get(key) ?? []).some(visible);
    }
    if (danger) actor.needs.safety = clamp(actor.needs.safety - dt / 90);
    else {
      const target = protection ? .9 : atHome && !actor.cuffed ? .8 : 0;
      if (actor.needs.safety < target) actor.needs.safety = clamp(actor.needs.safety + (target - actor.needs.safety) * Math.min(1, dt / 180));
    }
  }
}
