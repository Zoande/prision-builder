// Items and the inventory that holds them.
//
// An inmate has two stores:
//
//   HANDS   — two "hand units", and whatever is in them is VISIBLE. Most things
//             take one hand; a meal tray takes both. This is the store guards
//             (and the player) can actually see.
//   POCKETS — two small slots. Only `small` items fit, and a slot stacks up to
//             `perSlot` of them (two spoons to a slot). A book is too big.
//
// Anything that doesn't fit goes under the bed. That is the whole tension: four
// spoons fit in your pockets exactly, but cutters only stack one to a slot, so
// a man planning to cut three fences *cannot* carry his kit — he has to hide it
// somewhere, and hidden things survive a guard confiscating what's in his hands.

export const Item = {
  None: 0,
  Spoon: 1,
  Cutter: 2,
  Book: 3,
  Tray: 4,
} as const;
export type ItemKind = (typeof Item)[keyof typeof Item];

export interface ItemDef {
  kind: number;
  name: string;
  /** "small" fits a pocket slot; "large" can only be held in the hands. */
  size: "small" | "large";
  /** Hand units needed to carry it. A tray needs both. */
  hands: 1 | 2;
  /** How many stack into one pocket slot (0 = never pocketable). */
  perSlot: number;
  /** Guards take it off you when they catch you with it. */
  contraband: boolean;
}

const DEFS: ItemDef[] = [
  { kind: Item.Spoon, name: "Spoon", size: "small", hands: 1, perSlot: 2, contraband: true },
  { kind: Item.Cutter, name: "Cutters", size: "small", hands: 1, perSlot: 1, contraband: true },
  { kind: Item.Book, name: "Book", size: "large", hands: 1, perSlot: 0, contraband: false },
  { kind: Item.Tray, name: "Meal Tray", size: "large", hands: 2, perSlot: 0, contraband: false },
];

const BY_KIND: (ItemDef | undefined)[] = [];
for (const d of DEFS) BY_KIND[d.kind] = d;

export function itemDef(kind: number): ItemDef | undefined {
  return BY_KIND[kind];
}
export const ITEM_DEFS = DEFS;

export const HAND_UNITS = 2;
export const POCKET_SLOTS = 2;
/** How much a prisoner can hide under his bunk. */
export const STASH_CAP = 8;

export interface Stack { kind: number; count: number }

export interface Inventory {
  /** Held items. Their hand costs sum to at most HAND_UNITS. Visible. */
  hands: Stack[];
  /** Fixed small slots; null = empty. */
  pockets: (Stack | null)[];
}

export function newInventory(): Inventory {
  return { hands: [], pockets: new Array(POCKET_SLOTS).fill(null) };
}

export function handsUsed(inv: Inventory): number {
  let n = 0;
  for (const s of inv.hands) n += (itemDef(s.kind)?.hands ?? 1) * s.count;
  return n;
}

export function freeHands(inv: Inventory): number {
  return HAND_UNITS - handsUsed(inv);
}

/** Is there room in the hands for one of these? */
export function canHold(inv: Inventory, kind: number): boolean {
  const d = itemDef(kind);
  return !!d && freeHands(inv) >= d.hands;
}

/** Put one in the hands. Fails if there aren't enough free hands. */
export function takeInHands(inv: Inventory, kind: number): boolean {
  if (!canHold(inv, kind)) return false;
  const existing = inv.hands.find((s) => s.kind === kind);
  if (existing) existing.count++;
  else inv.hands.push({ kind, count: 1 });
  return true;
}

/** Is there a pocket slot that would take one of these? */
export function canPocket(inv: Inventory, kind: number): boolean {
  const d = itemDef(kind);
  if (!d || d.size !== "small" || d.perSlot <= 0) return false;
  for (const s of inv.pockets) {
    if (s === null) return true;
    if (s.kind === kind && s.count < d.perSlot) return true;
  }
  return false;
}

/** Slip one into a pocket: top up a matching slot, else claim an empty one. */
export function pocket(inv: Inventory, kind: number): boolean {
  const d = itemDef(kind);
  if (!d || d.perSlot <= 0) return false;
  for (const s of inv.pockets) {
    if (s && s.kind === kind && s.count < d.perSlot) { s.count++; return true; }
  }
  for (let i = 0; i < inv.pockets.length; i++) {
    if (inv.pockets[i] === null) { inv.pockets[i] = { kind, count: 1 }; return true; }
  }
  return false;
}

/** Pocket it if it fits, otherwise hold it. This is what "take" means. */
export function stow(inv: Inventory, kind: number): boolean {
  return pocket(inv, kind) || takeInHands(inv, kind);
}

/** How many of a kind are on this person (hands + pockets). */
export function countItem(inv: Inventory, kind: number): number {
  let n = 0;
  for (const s of inv.hands) if (s.kind === kind) n += s.count;
  for (const s of inv.pockets) if (s && s.kind === kind) n += s.count;
  return n;
}

export function hasItem(inv: Inventory, kind: number): boolean {
  return countItem(inv, kind) > 0;
}

/** Drop one from the pockets first, then the hands. Returns false if none. */
export function removeItem(inv: Inventory, kind: number): boolean {
  for (let i = 0; i < inv.pockets.length; i++) {
    const s = inv.pockets[i];
    if (s && s.kind === kind) {
      if (--s.count <= 0) inv.pockets[i] = null;
      return true;
    }
  }
  for (let i = 0; i < inv.hands.length; i++) {
    const s = inv.hands[i];
    if (s.kind === kind) {
      if (--s.count <= 0) inv.hands.splice(i, 1);
      return true;
    }
  }
  return false;
}

/** Drop one specifically from the hands (not the pockets). */
export function removeFromHands(inv: Inventory, kind: number): boolean {
  const i = inv.hands.findIndex((s) => s.kind === kind);
  if (i < 0) return false;
  const s = inv.hands[i];
  if (--s.count <= 0) inv.hands.splice(i, 1);
  return true;
}

/** Move one from the hands into a pocket, to free a hand up. */
export function stash(inv: Inventory, kind: number): boolean {
  if (!canPocket(inv, kind)) return false;
  const i = inv.hands.findIndex((s) => s.kind === kind);
  if (i < 0) return false;
  const s = inv.hands[i];
  if (--s.count <= 0) inv.hands.splice(i, 1);
  return pocket(inv, kind);
}

/** Everything a guard would take off him. Returns what was seized. */
export function seizeContraband(inv: Inventory): Stack[] {
  const taken: Stack[] = [];
  const take = (s: Stack) => {
    if (!itemDef(s.kind)?.contraband) return false;
    const t = taken.find((x) => x.kind === s.kind);
    if (t) t.count += s.count; else taken.push({ ...s });
    return true;
  };
  inv.hands = inv.hands.filter((s) => !take(s));
  for (let i = 0; i < inv.pockets.length; i++) {
    const s = inv.pockets[i];
    if (s && take(s)) inv.pockets[i] = null;
  }
  return taken;
}

/** Drop everything (on capture, or when the agent is removed). */
export function clearInventory(inv: Inventory) {
  inv.hands = [];
  inv.pockets.fill(null);
}

// --- Stashes (under the bunk) -----------------------------------------------

export function stashCount(items: Stack[], kind: number): number {
  return items.find((s) => s.kind === kind)?.count ?? 0;
}

export function stashTotal(items: Stack[]): number {
  return items.reduce((a, s) => a + s.count, 0);
}

export function stashAdd(items: Stack[], kind: number): boolean {
  if (stashTotal(items) >= STASH_CAP) return false;
  const s = items.find((x) => x.kind === kind);
  if (s) s.count++;
  else items.push({ kind, count: 1 });
  return true;
}

export function stashTake(items: Stack[], kind: number): boolean {
  const i = items.findIndex((x) => x.kind === kind);
  if (i < 0) return false;
  if (--items[i].count <= 0) items.splice(i, 1);
  return true;
}

/** The two visible hand slots, expanded one entry per held thing (for the
 *  renderer, which draws what's actually in each hand). */
export function heldSlots(inv: Inventory): [number, number] {
  const out: number[] = [];
  for (const s of inv.hands) {
    for (let n = 0; n < s.count && out.length < HAND_UNITS; n++) out.push(s.kind);
  }
  return [out[0] ?? Item.None, out[1] ?? Item.None];
}
