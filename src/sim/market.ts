import type { Agent } from "./agent.ts";
import type { EconomySystem } from "./economy.ts";
import type { HealthSystem } from "./health.ts";
import type { InstitutionSystem } from "./institution.ts";
import { ItemSystem, itemDefV4, type ItemInstance } from "./itemSystem.ts";
import { Obj, RoomType } from "./objects.ts";
import { personality, skill } from "./profiles.ts";
import { HOUR_SECONDS } from "./time.ts";
import type { WorkSystem } from "./work.ts";
import type { World } from "./world.ts";
import { astar, passable, roleAllowed } from "./nav.ts";

export interface Contact { id: number; prisonerId: number; name: string; relation: "family" | "friend" | "criminal"; trust: number; resources: number; }
export interface MailRecord { id: number; letterItemId: number; senderContactId: number; recipientId: number; sentAt: number; deliveredAt: number; inspected: boolean; tamperedBy: number; status: "inbound" | "sorted" | "delivered" | "seized"; }
export interface MarketOffer { id: number; sellerId: number; buyerId: number; itemId: number; price: number; state: "offered" | "complete" | "refused" | "stolen"; createdAt: number; }
export interface Debt { id: number; creditorId: number; debtorId: number; amount: number; dueAt: number; paid: number; state: "open" | "late" | "paid" | "defaulted"; }
export interface CraftRecipe { id: string; output: string; inputs: Record<string, number>; station: number; skill: string; level: number; seconds: number; noise: number; }

export const CRAFT_RECIPES: CraftRecipe[] = [
  { id: "shiv", output: "shiv", inputs: { "metal-scrap": 1, cloth: 1 }, station: Obj.MetalWorkbench, skill: "toolcraft", level: 2, seconds: 24, noise: .3 },
  { id: "club", output: "club", inputs: { "wood-scrap": 2, cloth: 1 }, station: Obj.WoodWorkbench, skill: "toolcraft", level: 1, seconds: 20, noise: .35 },
  { id: "cutters", output: "cutter", inputs: { "metal-scrap": 2, file: 1, wire: 1 }, station: Obj.MetalWorkbench, skill: "toolcraft", level: 5, seconds: 42, noise: .65 },
  { id: "hooch", output: "alcohol", inputs: { sugar: 2, yeast: 1 }, station: Obj.Sink, skill: "cooking", level: 1, seconds: 55, noise: .08 },
];

const SHOP: Record<string, number> = {
  "shop-soap": 3, "shop-snack": 4, "shop-drink": 3, "shop-stationery": 2, "shop-envelope": 3,
  "shop-magazine": 5, "shop-cards": 6, "shop-toiletries": 5, book: 10,
};

export class MarketSystem {
  readonly contacts = new Map<number, Contact[]>();
  readonly mail = new Map<number, MailRecord>();
  readonly offers = new Map<number, MarketOffer>();
  readonly debts = new Map<number, Debt>();
  readonly warnings = new Set<string>();
  mailInspection: "none" | "sample" | "all" = "sample";
  private nextContactId = 1; private nextMailId = 1; private nextOfferId = 1; private nextDebtId = 1;
  private lastMailDay = -1; private lastTillDay = -1; private marketTimer = 0; private craftTimer = 0; private hideTimer = 0;
  private readonly pendingTills = new Set<number>();
  private readonly tillClaims = new Map<number, number>();
  private readonly tillJobs = new Map<number, { roomId: number; bagId: number; phase: "pickup" | "safe" }>();
  private readonly craftProgress = new Map<number, { recipeId: string; progress: number }>();
  private seededShops = new Set<number>();
  private rngState = 0x193e70ad;
  private readonly items: ItemSystem;
  private readonly health: HealthSystem;
  private readonly institution: InstitutionSystem;
  private readonly economy: EconomySystem;
  private readonly work: WorkSystem;

  constructor(items: ItemSystem, health: HealthSystem, institution: InstitutionSystem,
    economy: EconomySystem, work: WorkSystem) {
    this.items = items; this.health = health; this.institution = institution; this.economy = economy; this.work = work;
  }

  tick(dt: number, time: number, world: World, agents: readonly Agent[]): void {
    this.warnings.clear();
    for (const prisoner of agents.filter((a) => a.kind === Obj.Prisoner)) {
      this.ensureContacts(prisoner);
      this.dependencies(prisoner, dt, time);
    }
    this.syncHiding(world); this.syncShops(world, time); this.syncPayrollSafes(world);
    const day = Math.floor(time / (HOUR_SECONDS * 24)), hour = (time / HOUR_SECONDS) % 24;
    if (hour >= 7 && day !== this.lastMailDay) { this.lastMailDay = day; this.createDailyMail(time, agents); }
    if (hour >= 10) this.processMail(time, world, agents);
    if (hour >= 23 && day !== this.lastTillDay) {
      this.lastTillDay = day;
      for (const room of world.rooms.values()) if (room.valid && room.type === RoomType.Shop && this.items.cashValue(`shop:${room.id}:till`) > 0) this.pendingTills.add(room.id);
    }
    this.marketTimer -= dt; if (this.marketTimer <= 0) { this.marketTimer = 3; this.tradePass(time, world, agents); this.shopPass(time, world, agents); }
    this.craftTimer -= dt; if (this.craftTimer <= 0) { this.craftTimer = 1; this.craftPass(time, world, agents); }
    this.hideTimer -= dt; if (this.hideTimer <= 0) { this.hideTimer = 4; this.hidingPass(time, agents); }
    for (const debt of this.debts.values()) if (debt.state === "open" && time > debt.dueAt) debt.state = "late";
    const contraband = [...this.items.items.values()].filter((i) => i.locationKind !== "destroyed" && itemDefV4(i.defId).legality === "contraband").length;
    if (contraband > 20) this.warnings.add("The physical contraband market is heavily supplied");
  }

  cash(agentId: number): number { return this.items.cashValue(`agent:${agentId}:pockets`) + this.items.cashValue(`agent:${agentId}:hands`); }
  transferBetween(fromId: number, toId: number, amount: number, time: number): number { return this.transferCash(fromId, toId, amount, time); }
  collectTo(fromId: number, containerId: string, amount: number, time: number): number { return this.transferCash(fromId, -1, amount, time, containerId); }

  updateTillGuard(guard: Agent, dt: number, time: number, world: World, allowClaim = true): boolean {
    let job = this.tillJobs.get(guard.id);
    if (!job && !allowClaim) return false;
    if (!job) {
      const roomId = [...this.pendingTills].find((id) => !this.tillClaims.has(id)); if (roomId === undefined) return false;
      job = { roomId, bagId: -1, phase: "pickup" }; this.tillJobs.set(guard.id, job); this.tillClaims.set(roomId, guard.id);
    }
    const till = this.items.containers.get(`shop:${job.roomId}:till`);
    const safes = [...this.items.containers.values()].filter((c) => c.tags.includes("payroll-safe"));
    if (!till || !this.pendingTills.has(job.roomId)) { this.clearTillJob(guard.id, job.roomId); return false; }
    if (!safes.length) { this.warnings.add("Shop till cash is waiting for a Payroll Safe"); return true; }
    const safe = safes.sort((a, b) => Math.hypot(guard.x - a.x, guard.z - a.z) - Math.hypot(guard.x - b.x, guard.z - b.z))[0];
    const target = job.phase === "pickup" ? till : safe;
    if (Math.hypot(guard.x - target.x, guard.z - target.z) > 1.4) {
      if (!guard.path) {
        const start = world.idx(Math.floor(guard.x), Math.floor(guard.z)), rawGoal = world.idx(Math.floor(target.x), Math.floor(target.z));
        const open = (i: number) => passable(world, i, true, guard.accessKeys) && roleAllowed(world, i, "guard");
        let goal = rawGoal;
        if (!open(goal)) {
          const gx = goal % world.size, gz = (goal / world.size) | 0;
          goal = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => [gx + dx, gz + dz] as const)
            .filter(([x, z]) => world.inBounds(x, z)).map(([x, z]) => world.idx(x, z)).find(open) ?? -1;
        }
        guard.path = goal >= 0 ? astar(world.size, start, goal, open, 30000, (a, b) => world.canNavigateEdge(a, b)) : null;
        guard.pathI = 0;
      }
      if (!guard.path || guard.pathI >= guard.path.length) { this.warnings.add("A shop till cannot reach the Payroll Safe"); return true; }
      const next = guard.path[guard.pathI], nx = next % world.size + .5, nz = ((next / world.size) | 0) + .5, d = Math.hypot(nx - guard.x, nz - guard.z);
      if (d < .12) guard.pathI++; else { guard.x += (nx - guard.x) / d * Math.min(d, dt * 2.2); guard.z += (nz - guard.z) / d * Math.min(d, dt * 2.2); }
      guard.state = job.phase === "pickup" ? "collectingTill" : "carryingTill"; guard.amp = 1; return true;
    }
    guard.path = null;
    if (job.phase === "pickup") {
      const notes = [...this.items.itemsIn(till.id)].filter((i) => i.denomination > 0);
      if (!notes.length) { this.pendingTills.delete(job.roomId); this.clearTillJob(guard.id, job.roomId); return false; }
      const bag = this.items.create("cash-bag", time, { ownerId: -1, issuedTo: guard.id });
      const inside = this.items.ensureContainer({ id: `cash-bag:${bag.id}`, name: `Contents of cash bag ${bag.id}`, x: guard.x, z: guard.z,
        capacity: 500, concealment: .9, bodyCapacity: 0, lockedTier: "guard", ownerId: -1, tags: ["cash-bag"] });
      for (const note of notes) this.items.moveToContainer(note.id, inside.id, time, guard.id);
      bag.contents = [...inside.itemIds];
      if (!this.items.moveToContainer(bag.id, `agent:${guard.id}:hands`, time, guard.id)) { this.items.destroy(bag.id, time, guard.id, "bag-cancelled"); return true; }
      job.bagId = bag.id; job.phase = "safe"; guard.state = "carryingTill"; return true;
    }
    const bag = this.items.items.get(job.bagId), inside = this.items.containers.get(`cash-bag:${job.bagId}`);
    let total = 0;
    if (bag && inside) for (const note of [...this.items.itemsIn(inside.id)]) { total += note.denomination; this.items.destroy(note.id, time, guard.id, "till-deposit"); }
    if (bag) this.items.destroy(bag.id, time, guard.id, "cash-bag-deposited");
    if (total) this.economy.post(time, "shop", total, "Guard deposited prison shop till", true);
    this.pendingTills.delete(job.roomId); this.clearTillJob(guard.id, job.roomId); guard.state = "idle"; return true;
  }

  saveData() { return { contacts: [...this.contacts].map(([id, rows]) => [id, rows.map((r) => ({ ...r }))] as const),
    mail: [...this.mail.values()].map((m) => ({ ...m })), offers: [...this.offers.values()].map((o) => ({ ...o })),
    debts: [...this.debts.values()].map((d) => ({ ...d })), mailInspection: this.mailInspection,
    nextContactId: this.nextContactId, nextMailId: this.nextMailId, nextOfferId: this.nextOfferId, nextDebtId: this.nextDebtId,
    lastMailDay: this.lastMailDay, lastTillDay: this.lastTillDay, craftProgress: [...this.craftProgress], seededShops: [...this.seededShops],
    pendingTills: [...this.pendingTills], tillClaims: [...this.tillClaims], tillJobs: [...this.tillJobs], rngState: this.rngState }; }
  loadData(data: Partial<ReturnType<MarketSystem["saveData"]>>): void {
    this.contacts.clear(); for (const [id, rows] of data.contacts ?? []) this.contacts.set(id, rows.map((r) => ({ ...r })));
    this.mail.clear(); for (const m of data.mail ?? []) this.mail.set(m.id, { ...m });
    this.offers.clear(); for (const o of data.offers ?? []) this.offers.set(o.id, { ...o });
    this.debts.clear(); for (const d of data.debts ?? []) this.debts.set(d.id, { ...d });
    this.mailInspection = data.mailInspection ?? "sample"; this.nextContactId = data.nextContactId ?? 1; this.nextMailId = data.nextMailId ?? 1;
    this.nextOfferId = data.nextOfferId ?? 1; this.nextDebtId = data.nextDebtId ?? 1; this.lastMailDay = data.lastMailDay ?? -1; this.lastTillDay = data.lastTillDay ?? -1;
    this.craftProgress.clear(); for (const [id, row] of data.craftProgress ?? []) this.craftProgress.set(id, { ...row });
    this.pendingTills.clear(); for (const id of data.pendingTills ?? []) this.pendingTills.add(id);
    this.tillClaims.clear(); for (const [room, guard] of data.tillClaims ?? []) this.tillClaims.set(room, guard);
    this.tillJobs.clear(); for (const [guard, job] of data.tillJobs ?? []) this.tillJobs.set(guard, { ...job });
    this.seededShops = new Set(data.seededShops ?? []); this.rngState = data.rngState ?? 0x193e70ad;
  }

  private ensureContacts(prisoner: Agent): void {
    if (this.contacts.has(prisoner.id) || !prisoner.profile) return;
    const first = ["Alex", "Jamie", "Morgan", "Taylor", "Jordan", "Casey", "Robin", "Sam"];
    const relations: Contact["relation"][] = ["family", "friend", "criminal"];
    const count = 1 + ((prisoner.profile.seed >>> 5) % 3), rows: Contact[] = [];
    for (let n = 0; n < count; n++) rows.push({ id: this.nextContactId++, prisonerId: prisoner.id,
      name: `${first[(prisoner.profile.seed + n * 3) % first.length]} ${prisoner.profile.lastName}`,
      relation: relations[(prisoner.profile.seed + n) % relations.length], trust: .4 + this.random() * .55, resources: .2 + this.random() * .75 });
    this.contacts.set(prisoner.id, rows);
  }

  private createDailyMail(time: number, agents: readonly Agent[]): void {
    const sack = this.items.ensureContainer({ id: `mail-sack:${this.lastMailDay}`, name: `Inbound mail day ${this.lastMailDay}`,
      x: 371, z: 375, capacity: 200, concealment: .3, bodyCapacity: 0, lockedTier: "staff", ownerId: -1, tags: ["mail-sack", "delivery"] });
    for (const prisoner of agents.filter((a) => a.kind === Obj.Prisoner)) {
      const contacts = this.contacts.get(prisoner.id) ?? []; if (!contacts.length || this.random() > .48) continue;
      const contact = contacts[(this.random() * contacts.length) | 0];
      const letter = this.items.create("mail-letter", time, { ownerId: prisoner.id });
      const inside = this.items.ensureContainer({ id: `mail:${letter.id}:contents`, name: `Contents of letter ${letter.id}`, x: sack.x, z: sack.z,
        capacity: 6, concealment: .9, bodyCapacity: 0, lockedTier: "none", ownerId: prisoner.id, tags: ["sealed-mail"] });
      if (this.random() < .2 * contact.resources) this.addCash(inside.id, this.random() < .72 ? 5 : 10, time, prisoner.id);
      if (contact.relation === "criminal" && this.random() < .18 * contact.resources) {
        const defId = this.random() < .5 ? "drugs" : this.random() < .75 ? "phone" : "hacksaw-blade";
        const item = this.items.create(defId, time, { ownerId: prisoner.id }); this.items.moveToContainer(item.id, inside.id, time);
      }
      letter.contents = [...inside.itemIds]; this.items.moveToContainer(letter.id, sack.id, time);
      const id = this.nextMailId++; this.mail.set(id, { id, letterItemId: letter.id, senderContactId: contact.id,
        recipientId: prisoner.id, sentAt: time, deliveredAt: -1, inspected: false, tamperedBy: -1, status: "inbound" });
    }
  }

  private processMail(time: number, world: World, agents: readonly Agent[]): void {
    const mailRoom = [...world.rooms.values()].find((r) => r.valid && r.type === RoomType.MailRoom);
    if (!mailRoom) { if ([...this.mail.values()].some((m) => m.status === "inbound")) this.warnings.add("Inbound mail is waiting for a valid Mail Room"); return; }
    const workplace = this.work.workplaces.get(mailRoom.id);
    const workerIds = [...this.work.assignments].filter(([, roomId]) => roomId === mailRoom.id).map(([id]) => id)
      .filter((id) => agents.some((a) => a.id === id && a.state === "working"));
    if (!workerIds.length) { this.warnings.add("Inbound mail is waiting for an active Mail Room worker"); return; }
    if (workplace?.blocked) { this.warnings.add(`Inbound mail is blocked: ${workplace.blocked}`); return; }
    for (const record of this.mail.values()) {
      if (record.status !== "inbound") continue;
      const letter = this.items.items.get(record.letterItemId), recipient = agents.find((a) => a.id === record.recipientId);
      if (!letter || !recipient) { record.status = "seized"; continue; }
      const supervision = workplace?.supervision === "constant" ? 1 : workplace?.supervision === "periodic" ? .72 : .42;
      const inspect = this.mailInspection === "all" || (this.mailInspection === "sample" && this.random() < .35 * supervision);
      record.inspected = inspect;
      const contents = [...(this.items.containers.get(`mail:${letter.id}:contents`)?.itemIds ?? [])];
      if (inspect) {
        for (const id of contents) {
          const item = this.items.items.get(id); if (!item) continue;
          if (itemDefV4(item.defId).legality !== "contraband" && !itemDefV4(item.defId).tags.includes("cash")) continue;
          const incident = this.institution.createIncident("mail", recipient.id, -1, letter.x, letter.z, time, item.defId);
          this.institution.addEvidence(incident.id, "mail", -1, recipient.id, .95, `${itemDefV4(item.defId).name} found in sealed incoming mail`, time, letter.x, letter.z, item.id);
          const rule = this.institution.ruleFor("mail", item.defId);
          if (rule.confiscate) { this.items.moveToContainer(item.id, "institution:evidence", time, -1); record.status = "seized"; }
          if (rule.medicalCheck) this.health.requestMedicalCheck(recipient);
        }
      }
      const worker = workerIds.length ? agents.find((a) => a.id === workerIds[(this.random() * workerIds.length) | 0]) : null;
      if (worker && this.random() < (.025 + skill(worker.profile, "smuggling") * .006) * (1.2 - supervision) && contents.length) {
        const stolen = this.items.items.get(contents[(this.random() * contents.length) | 0]);
        if (stolen) { this.items.moveToContainer(stolen.id, `agent:${worker.id}:pockets`, time, worker.id, true); record.tamperedBy = worker.id; }
      }
      for (const id of [...(this.items.containers.get(`mail:${letter.id}:contents`)?.itemIds ?? [])]) this.items.moveToContainer(id, `agent:${recipient.id}:pockets`, time, recipient.id);
      this.items.destroy(letter.id, time, recipient.id, "mail-opened"); record.status = record.status === "seized" ? "seized" : "delivered"; record.deliveredAt = time;
      recipient.needs.family = Math.min(1, recipient.needs.family + .55);
    }
  }

  private dependencies(prisoner: Agent, dt: number, time: number): void {
    if (!prisoner.mind) return;
    for (const [need, defId] of [["tobacco", "tobacco"], ["alcohol", "alcohol"], ["drugs", "drugs"]] as const) {
      if ((prisoner.mind.needWeights[need] ?? 0) <= 0) { prisoner.needs[need] = 1; continue; }
      if (prisoner.needs[need] < .32) {
        const item = this.items.itemsIn(`agent:${prisoner.id}:pockets`).find((i) => i.defId === defId);
        if (item) { this.items.destroy(item.id, time, prisoner.id, "consumed-substance"); prisoner.needs[need] = .9; this.health.applySubstance(prisoner, need, 1, time); continue; }
      }
      if (prisoner.needs[need] < .2) {
        prisoner.mind.stress = Math.min(1, prisoner.mind.stress + dt * .012);
        prisoner.mind.anger = Math.min(1, prisoner.mind.anger + dt * .007);
      }
    }
  }

  private tradePass(time: number, world: World, agents: readonly Agent[]): void {
    const prisoners = agents.filter((a) => a.kind === Obj.Prisoner && !this.health.isUnavailable(a.id));
    for (const seller of prisoners) {
      const goods = this.items.itemsIn(`agent:${seller.id}:pockets`).filter((i) => itemDefV4(i.defId).legality === "contraband");
      if (!goods.length) continue;
      const buyer = prisoners.find((b) => b.id !== seller.id && Math.hypot(b.x - seller.x, b.z - seller.z) < 2.2 && this.wants(b, goods[0]));
      if (!buyer || this.random() > .09) continue;
      const item = goods[0], scarcity = 1 + Math.max(0, 8 - this.items.count(item.defId)) * .08;
      const price = Math.max(1, Math.round(itemDefV4(item.defId).baseValue * scarcity * (.55 + this.random() * .45)));
      const offer: MarketOffer = { id: this.nextOfferId++, sellerId: seller.id, buyerId: buyer.id, itemId: item.id, price, state: "offered", createdAt: time };
      this.offers.set(offer.id, offer);
      const paid = this.transferCash(buyer.id, seller.id, price, time);
      if (paid >= price) { this.items.moveToContainer(item.id, `agent:${buyer.id}:pockets`, time, buyer.id, true); offer.state = "complete"; }
      else if (paid > 0 || personality(buyer.profile, "loyalty") > .25) {
        this.items.moveToContainer(item.id, `agent:${buyer.id}:pockets`, time, buyer.id, true); offer.state = "complete";
        this.debts.set(this.nextDebtId, { id: this.nextDebtId++, creditorId: seller.id, debtorId: buyer.id, amount: price, paid, dueAt: time + HOUR_SECONDS * 8, state: "open" });
      } else offer.state = "refused";
      void world;
    }
  }

  private shopPass(time: number, world: World, agents: readonly Agent[]): void {
    for (const prisoner of agents.filter((a) => a.kind === Obj.Prisoner)) {
      const tile = world.idx(Math.floor(prisoner.x), Math.floor(prisoner.z)), roomId = world.roomId[tile];
      if (world.roomTypeAt(tile) !== RoomType.Shop || this.random() > .18) continue;
      const shop = this.items.containers.get(`shop:${roomId}:stock`), till = this.items.containers.get(`shop:${roomId}:till`);
      if (!shop || !till) continue;
      const wanted = prisoner.needs.hygiene < .55 ? "shop-soap" : prisoner.needs.food < .55 ? "shop-snack" :
        prisoner.needs.family < .55 ? "shop-envelope" : prisoner.needs.comfort < .55 ? "shop-drink" :
          prisoner.needs.recreation < .6 ? "shop-magazine" : "shop-cards";
      const item = this.items.itemsIn(shop.id).find((i) => i.defId === wanted), price = SHOP[wanted];
      if (!item || this.cash(prisoner.id) < price) continue;
      this.transferCash(prisoner.id, -1, price, time, till.id); this.items.moveToContainer(item.id, `agent:${prisoner.id}:pockets`, time, prisoner.id);
      if (wanted === "shop-soap") prisoner.needs.hygiene = Math.min(1, prisoner.needs.hygiene + .35);
      if (wanted === "shop-snack") prisoner.needs.food = Math.min(1, prisoner.needs.food + .25);
      if (wanted === "shop-drink") prisoner.needs.comfort = Math.min(1, prisoner.needs.comfort + .25);
      if (["shop-magazine", "shop-cards"].includes(wanted)) prisoner.needs.recreation = Math.min(1, prisoner.needs.recreation + .3);
    }
  }

  private craftPass(time: number, world: World, agents: readonly Agent[]): void {
    for (const prisoner of agents.filter((a) => a.kind === Obj.Prisoner && !this.health.isUnavailable(a.id))) {
      const pockets = this.items.itemsIn(`agent:${prisoner.id}:pockets`);
      const recipe = CRAFT_RECIPES.find((r) => skill(prisoner.profile, r.skill as never) >= r.level &&
        Object.entries(r.inputs).every(([id, count]) => pockets.filter((i) => i.defId === id).length >= count) && this.nearStation(prisoner, r.station, world));
      if (!recipe) { this.craftProgress.delete(prisoner.id); continue; }
      const state = this.craftProgress.get(prisoner.id);
      const progress = state?.recipeId === recipe.id ? state.progress + 1 : 1;
      if (progress < recipe.seconds) { this.craftProgress.set(prisoner.id, { recipeId: recipe.id, progress }); continue; }
      for (const [id, count] of Object.entries(recipe.inputs)) for (const item of pockets.filter((i) => i.defId === id).slice(0, count)) this.items.destroy(item.id, time, prisoner.id, "crafting-input");
      const output = this.items.create(recipe.output, time, { ownerId: prisoner.id, quality: Math.min(1, .45 + skill(prisoner.profile, recipe.skill as never) * .055) });
      this.items.moveToContainer(output.id, `agent:${prisoner.id}:pockets`, time, prisoner.id, true); this.craftProgress.delete(prisoner.id);
    }
  }

  private hidingPass(time: number, agents: readonly Agent[]): void {
    const hiding = [...this.items.containers.values()].filter((c) => c.tags.includes("hiding-place"));
    for (const prisoner of agents.filter((a) => a.kind === Obj.Prisoner)) {
      const illegal = this.items.itemsIn(`agent:${prisoner.id}:pockets`).find((i) => itemDefV4(i.defId).legality !== "legal");
      if (!illegal) continue;
      const place = hiding.filter((c) => Math.hypot(c.x - prisoner.x, c.z - prisoner.z) < 2.2 && c.itemIds.length < c.capacity)
        .sort((a, b) => b.concealment - a.concealment)[0];
      if (place && this.random() < .22) this.items.moveToContainer(illegal.id, place.id, time, prisoner.id, true);
    }
    for (const thief of agents.filter((a) => a.kind === Obj.Prisoner && skill(a.profile, "smuggling") >= 3)) {
      const place = hiding.find((c) => c.itemIds.length && Math.hypot(c.x - thief.x, c.z - thief.z) < 1.5);
      if (!place || this.random() > .015) continue;
      const item = this.items.items.get(place.itemIds[0]); if (item) this.items.moveToContainer(item.id, `agent:${thief.id}:pockets`, time, thief.id, true);
    }
    for (const body of this.health.bodies.values()) {
      if (body.removed || body.hiddenIn || body.discovered) continue;
      const concealer = agents.find((a) => a.kind === Obj.Prisoner && Math.hypot(a.x - body.x, a.z - body.z) < 1.6 && skill(a.profile, "smuggling") >= 3);
      const place = concealer && hiding.find((c) => c.bodyCapacity > 0 && Math.hypot(c.x - body.x, c.z - body.z) < 2);
      if (concealer && place && this.random() < .035) {
        this.health.hideBody(body.agentId, place.id);
        const incident = this.institution.createIncident("body-concealment", concealer.id, body.agentId, body.x, body.z, time);
        void incident;
      }
    }
  }

  private syncHiding(world: World): void {
    const kinds = new Map<number, { concealment: number; capacity: number; body: number; tag: string }>([
      [Obj.Bed, { concealment: .8, capacity: 10, body: 0, tag: "mattress" }], [Obj.Toilet, { concealment: .62, capacity: 5, body: 0, tag: "toilet" }],
      [Obj.Sink, { concealment: .55, capacity: 4, body: 0, tag: "sink" }], [Obj.TrashCan, { concealment: .72, capacity: 12, body: 1, tag: "bin" }],
      [Obj.GreenhousePlanter, { concealment: .83, capacity: 16, body: 0, tag: "planter" }], [Obj.JanitorCart, { concealment: .75, capacity: 14, body: 1, tag: "cart" }],
      [Obj.LoadingPallet, { concealment: .48, capacity: 20, body: 1, tag: "pallet" }], [Obj.Bookshelf, { concealment: .6, capacity: 8, body: 0, tag: "book" }],
    ]);
    for (const [kind, meta] of kinds) for (const tile of world.tilesOfKind(kind)) {
      const id = `world:${tile}:${meta.tag}`; this.items.ensureContainer({ id, name: `${meta.tag} hiding place`, x: tile % world.size + .5,
        z: ((tile / world.size) | 0) + .5, capacity: meta.capacity, concealment: meta.concealment, bodyCapacity: meta.body,
        lockedTier: "none", ownerId: -1, tags: ["hiding-place", meta.tag] });
    }
  }

  private syncShops(world: World, time: number): void {
    for (const room of world.rooms.values()) {
      if (!room.valid || room.type !== RoomType.Shop || this.seededShops.has(room.id)) continue; this.seededShops.add(room.id);
      const tile = [...room.tiles][0], x = tile % world.size + .5, z = ((tile / world.size) | 0) + .5;
      const stock = this.items.ensureContainer({ id: `shop:${room.id}:stock`, name: `Shop ${room.id} stock`, x, z, capacity: 250,
        concealment: .2, bodyCapacity: 0, lockedTier: "staff", ownerId: -1, tags: ["shop", "stock"] });
      this.items.ensureContainer({ id: `shop:${room.id}:till`, name: `Shop ${room.id} till`, x, z, capacity: 250,
        concealment: .35, bodyCapacity: 0, lockedTier: "staff", ownerId: -1, tags: ["shop", "cash"] });
      for (const defId of Object.keys(SHOP)) for (const id of this.items.createMany(defId, 20, time)) this.items.moveToContainer(id, stock.id, time);
    }
  }

  private syncPayrollSafes(world: World): void {
    for (const tile of world.tilesOfKind(Obj.PayrollSafe)) this.items.ensureContainer({ id: `payroll-safe:${tile}`, name: "Payroll Safe",
      x: tile % world.size + .5, z: ((tile / world.size) | 0) + .5, capacity: 500, concealment: .15,
      bodyCapacity: 0, lockedTier: "guard", ownerId: -1, tags: ["payroll-safe", "cash", "controlled"] });
  }
  private clearTillJob(guardId: number, roomId: number): void { this.tillJobs.delete(guardId); this.tillClaims.delete(roomId); }
  private wants(agent: Agent, item: ItemInstance): boolean {
    if (item.defId === "tobacco") return agent.needs.tobacco < .6; if (item.defId === "alcohol") return agent.needs.alcohol < .6;
    if (item.defId === "drugs") return agent.needs.drugs < .65; return skill(agent.profile, "smuggling") >= 2 || agent.escapeOperationId >= 0;
  }
  private nearStation(agent: Agent, kind: number, world: World): boolean { return world.tilesOfKind(kind).some((t) => Math.hypot(t % world.size + .5 - agent.x, ((t / world.size) | 0) + .5 - agent.z) < 3); }
  private transferCash(fromId: number, toId: number, amount: number, time: number, overrideTarget = ""): number {
    let paid = 0; const source = this.items.itemsIn(`agent:${fromId}:pockets`).filter((i) => i.denomination > 0).sort((a, b) => a.denomination - b.denomination);
    const target = overrideTarget || `agent:${toId}:pockets`;
    for (const note of source) { if (paid >= amount) break; if (paid + note.denomination > amount && paid > 0) continue; if (this.items.moveToContainer(note.id, target, time, fromId)) paid += note.denomination; }
    return paid;
  }
  private addCash(containerId: string, amount: number, time: number, ownerId: number): void {
    for (const denom of [20, 10, 5, 1]) while (amount >= denom) { const item = this.items.create(`cash-${denom}`, time, { ownerId }); this.items.moveToContainer(item.id, containerId, time); amount -= denom; }
  }
  private random(): number { let x = this.rngState | 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.rngState = x >>> 0; return this.rngState / 0x1_0000_0000; }
}
