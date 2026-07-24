// Build editor: the bottom-centre HUD (category tabs + item palette) and the
// current tool. Placement itself is driven by main (pointer + picking); this
// module owns tool state and the UI.

import { Access, OBJ_DEFS, Obj, ROOM_DEFS, RoomType, World, defOf } from "./sim/world.ts";
import { FLOOR_MATS, WALL_MATS, FENCE_MAT } from "./render/materials.ts";

// Structural tools get their own cat because each has a bespoke world setter
// (a door converts a wall, a wall light must find an open face). Everything
// else is a "piece": one cat, and `mat` carries the Obj kind — so a new object
// costs a row in objects.ts and nothing here.
export type ToolCat =
  | "floor" | "wall" | "fence" | "door" | "jaildoor"
  | "staffdoor" | "fencedoor" | "fencestaffdoor" | "fencejaildoor"
  | "lamp" | "walllight" | "rooflight"
  | "piece"
  | "person" | "prisoner" | "guard" | "cook" | "workman" | "baton"
  | "room" | "access"
  | "patrol" | "unpatrol" | "deploy" | "undeploy"
  | "erase";
export interface Tool { cat: ToolCat; mat: number }
interface Item { label: string; swatch: string; tool: Tool }
export type CatalogSectionId =
  | `build:${string}`
  | `objects:${string}`
  | `rooms:${string}`
  | `staff:${string}`
  | `security:${string}`
  | `admin:${string}`;
interface Cat { key: CatalogSectionId; label: string; items: Item[] }

interface RoomGroup { key: string; label: string; types: number[] }

/** A palette button straight from the object registry. */
function pieceItem(kind: number): Item {
  const d = defOf(kind)!;
  return { label: d.palette!.label, swatch: d.palette!.swatch, tool: { cat: "piece", mat: kind } };
}

/** A palette button for a kind with a bespoke setter. */
function objItem(kind: number, cat: ToolCat): Item {
  const d = defOf(kind)!;
  return { label: d.palette!.label, swatch: d.palette!.swatch, tool: { cat, mat: 0 } };
}

function personItem(kind: number): Item {
  const d = defOf(kind)!;
  return { label: d.palette!.label, swatch: d.palette!.swatch, tool: { cat: "person", mat: kind } };
}

function roomItem(type: number): Item {
  const d = ROOM_DEFS.find((r) => r.type === type)!;
  return { label: d.name, swatch: d.swatch, tool: { cat: "room", mat: type } };
}

// The few kinds that need a bespoke world setter rather than placePiece.
const SPECIAL_CAT: Record<number, ToolCat> = {
  [Obj.Door]: "door", [Obj.JailDoor]: "jaildoor",
  [Obj.StaffDoor]: "staffdoor",
  [Obj.FenceDoor]: "fencedoor", [Obj.StaffFenceDoor]: "fencestaffdoor", [Obj.FenceJailDoor]: "fencejaildoor",
  [Obj.Lamp]: "lamp", [Obj.WallLight]: "walllight", [Obj.RoofLight]: "rooflight",
};

/** One build tab per palette group in the registry, in registry order. */
function groupCats(): Cat[] {
  const order: string[] = [];
  const byGroup = new Map<string, Item[]>();
  for (const d of OBJ_DEFS) {
    if (!d.palette || d.place === "person") continue;
    const g = d.palette.group;
    if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
    const special = SPECIAL_CAT[d.kind];
    byGroup.get(g)!.push(special ? objItem(d.kind, special) : pieceItem(d.kind));
  }
  return order.map((g) => ({
    key: `objects:${g.toLowerCase().replace(/\s+/g, "-")}` as CatalogSectionId,
    label: g,
    items: byGroup.get(g)!,
  }));
}

const ROOM_GROUPS: RoomGroup[] = [
  { key: "prisoner", label: "Prisoner", types: [RoomType.Cell, RoomType.Dorm, RoomType.Canteen, RoomType.ShowerRoom, RoomType.Yard] },
  { key: "living", label: "Living", types: [RoomType.CommonRoom, RoomType.Library, RoomType.Gym, RoomType.Chapel] },
  { key: "staff", label: "Staff", types: [RoomType.Kitchen, RoomType.StaffRoom, RoomType.Reception,
    RoomType.Infirmary, RoomType.Morgue, RoomType.Security, RoomType.Armoury, RoomType.Kennel, RoomType.Offices, RoomType.Interview,
    RoomType.ManagementOffice, RoomType.EvidenceRoom, RoomType.Utilities, RoomType.RecordsOffice, RoomType.Visitation] },
  { key: "work", label: "Work", types: [RoomType.Laundry, RoomType.MailRoom, RoomType.Greenhouse, RoomType.Janitorial,
    RoomType.Recycling, RoomType.Woodshop, RoomType.Metalshop, RoomType.Tailoring, RoomType.Maintenance, RoomType.Shop, RoomType.PrintShop,
    RoomType.ConstructionYard, RoomType.WasteYard] },
  { key: "logistics", label: "Logistics", types: [RoomType.Delivery, RoomType.Exports] },
  { key: "utility", label: "Utility", types: [RoomType.Solitary, RoomType.Empty] },
];

function roomCats(): Cat[] {
  return ROOM_GROUPS.map((group) => ({
    key: `rooms:${group.key}` as CatalogSectionId,
    label: group.label,
    items: group.types.map((type) => roomItem(type)),
  }));
}

const CATS: Cat[] = [
  {
    key: "build:floors", label: "Floors",
    items: FLOOR_MATS.filter((m) => m.buildable !== false)
      .map((m) => ({ label: m.name, swatch: m.swatch, tool: { cat: "floor", mat: m.id } })),
  },
  {
    key: "build:walls", label: "Walls",
    items: [
      ...WALL_MATS.map((m) => ({ label: m.name, swatch: m.swatch, tool: { cat: "wall", mat: m.id } as Tool })),
      { label: "Fence", swatch: "#9aa0a6", tool: { cat: "fence", mat: FENCE_MAT.id } },
    ],
  },
  // One tab per registry group, so the catalog stays browsable as it grows.
  ...groupCats(),
  {
    key: "staff:people", label: "People",
    items: [
      personItem(Obj.Guard), personItem(Obj.Cook), personItem(Obj.Workman), personItem(Obj.Doctor),
      personItem(Obj.Investigator), personItem(Obj.DogHandler), personItem(Obj.ArmedGuard),
      personItem(Obj.ChiefOfficer), personItem(Obj.Foreman), personItem(Obj.Accountant),
      personItem(Obj.SecurityDog),
      { label: "Baton", swatch: "#202024", tool: { cat: "baton", mat: 0 } },
    ],
  },
  ...roomCats(),
  {
    key: "rooms:access", label: "Access",
    items: [
      { label: "Staff", swatch: "#e8d44d", tool: { cat: "access", mat: Access.Staff } },
      { label: "Prisoners", swatch: "#f07018", tool: { cat: "access", mat: Access.Prisoners } },
      { label: "Forbidden", swatch: "#d63030", tool: { cat: "access", mat: Access.Forbidden } },
    ],
  },
  {
    key: "security:patrol", label: "Patrol",
    items: [
      // Two colours so two beats can cross without becoming one beat.
      { label: "Blue Beat", swatch: "#3372f2", tool: { cat: "patrol", mat: 0 } },
      { label: "Purple Beat", swatch: "#9e47eb", tool: { cat: "patrol", mat: 1 } },
      { label: "Clear Beat", swatch: "#d66666", tool: { cat: "unpatrol", mat: 0 } },
    ],
  },
  {
    key: "staff:deploy", label: "Deploy",
    items: [
      // Click a beat to put a guard on it; click a room to post one inside.
      { label: "Assign Guard", swatch: "#f2c53d", tool: { cat: "deploy", mat: 0 } },
      { label: "Remove Guard", swatch: "#d66666", tool: { cat: "undeploy", mat: 0 } },
    ],
  },
  { key: "admin:erase", label: "Erase", items: [{ label: "Erase", swatch: "#d66666", tool: { cat: "erase", mat: 0 } }] },
];

const OBJECT_SECTION_IDS = CATS.filter((cat) => cat.key.startsWith("objects:")).map((cat) => cat.key);
const ROOM_SECTION_IDS = CATS.filter((cat) => cat.key.startsWith("rooms:")).map((cat) => cat.key);
const MODE_SECTIONS: Record<string, CatalogSectionId[]> = {
  build: ["build:floors", "build:walls", "objects:doors", "objects:lights"],
  rooms: ROOM_SECTION_IDS,
  objects: OBJECT_SECTION_IDS,
  staff: ["staff:people", "staff:deploy"],
  logistics: ["objects:logistics", "rooms:logistics", "rooms:access"],
  intelligence: ["rooms:access", "security:patrol"],
  admin: ["admin:erase"],
};

export class Editor {
  tool: Tool | null = null;
  orient = 0; // 0..3 quarter turns
  /** The room a room-paint drag is filling (0 = not dragging). Set by main. */
  roomDrag = 0;
  /** The beat a patrol drag is drawing (0 = not dragging). Set by main. */
  routeDrag = 0;
  onChange?: () => void; // called when a tool is (de)selected, to update build mode

  private palette: HTMLElement;
  private cats: HTMLElement;
  private activeCat = CATS[0];
  private visibleCats: Cat[] = CATS;
  private currentMode = "build";
  private searchQuery = "";
  private itemButtons: HTMLButtonElement[] = [];
  private candidate: Item | null = null;
  private detailType: HTMLElement;
  private detailName: HTMLElement;
  private detailCopy: HTMLElement;

  private readonly categoryHelp: Record<string, string> = {
    "build:floors": "Choose a surface finish for paths, interiors, and yards.",
    "build:walls": "Build the perimeter and define secure interior spaces.",
    "rooms:prisoner": "Core prisoner spaces for meals, sleep, hygiene, and yard access.",
    "rooms:living": "Shared welfare rooms that raise comfort and routine.",
    "rooms:staff": "Back-of-house rooms for the prison team.",
    "rooms:logistics": "Road-connected yards for incoming materials and outgoing goods.",
    "rooms:utility": "Empty room lets you clear a painted area back to nothing.",
    "staff:people": "Hire operational staff. Hiring fees and wages are charged immediately.",
    "rooms:access": "Control where staff and prisoners are permitted to go.",
    "security:patrol": "Lay out patrol routes and security coverage.",
    "staff:deploy": "Assign guards to rooms and patrol routes.",
    "admin:erase": "Schedule demolition or remove a staff member.",
  };

  constructor() {
    this.cats = document.getElementById("cats")!;
    this.palette = document.getElementById("palette")!;
    this.detailType = document.getElementById("detailType")!;
    this.detailName = document.getElementById("detailName")!;
    this.detailCopy = document.getElementById("detailCopy")!;
    const search = document.getElementById("catalogSearch") as HTMLInputElement | null;
    if (search) search.addEventListener("input", () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.applyVisibleSections(false);
    });

    this.setMode("build", false);

    addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.clear();
      if (e.key === "r" || e.key === "R") this.orient = (this.orient + 1) % 4;
    });
  }

  private renderCategories() {
    this.cats.innerHTML = "";
    this.visibleCats.forEach((cat) => {
      const b = document.createElement("button");
      b.className = "build-cat";
      b.textContent = cat.label;
      b.onclick = () => this.selectCat(cat, b, true);
      this.cats.appendChild(b);
      (cat as Cat & { el?: HTMLButtonElement }).el = b;
    });
  }

  get active(): boolean { return this.tool !== null; }

  /** Open a catalog section from the operations rail. */
  setMode(mode: string, clearTool = true) {
    this.currentMode = mode;
    this.applyVisibleSections(clearTool);
  }

  private applyVisibleSections(clearTool: boolean) {
    const keys = MODE_SECTIONS[this.currentMode] ?? MODE_SECTIONS.build;
    this.visibleCats = this.searchQuery
      ? CATS.filter((cat) =>
          cat.label.toLowerCase().includes(this.searchQuery) ||
          cat.items.some((item) => item.label.toLowerCase().includes(this.searchQuery)))
      : CATS.filter((cat) => keys.includes(cat.key));
    this.renderCategories();
    const first = this.visibleCats[0] ?? CATS[0];
    this.selectCat(first, (first as Cat & { el?: HTMLButtonElement }).el!, clearTool);
  }

  selectCategory(key: string) {
    const normalized = key.toLowerCase();
    const cat = CATS.find((x) => x.key === key || x.label.toLowerCase() === normalized) ?? CATS[0];
    if (!this.visibleCats.includes(cat)) {
      this.visibleCats = [cat];
      this.renderCategories();
    }
    this.selectCat(cat, (cat as Cat & { el?: HTMLButtonElement }).el!, true);
  }

  private selectCat(cat: Cat, btn: HTMLButtonElement, clearTool: boolean) {
    this.activeCat = cat;
    this.cats.querySelectorAll(".build-cat").forEach((e) => e.classList.remove("on"));
    btn.classList.add("on");
    if (clearTool) {
      this.tool = null;
      this.candidate = null;
      this.onChange?.();
    }
    this.updateCatalogHeading();
    this.renderPalette();
  }

  private updateCatalogHeading() {
    const icon = document.getElementById("catalogIcon")!;
    const title = document.getElementById("toolName")!;
    const hint = document.getElementById("toolHint")!;
    const icons: Record<string, string> = {
      "build:floors": "\u25A4", "build:walls": "\u25A5", "staff:people": "\u2659", "rooms:access": "\u25C9",
      "security:patrol": "\u2301", "staff:deploy": "\u2691", "admin:erase": "\u00D7",
    };
    icon.textContent = icons[this.activeCat.key] ?? "\u25C8";
    title.textContent = this.activeCat.label;
    hint.textContent = this.categoryHelp[this.activeCat.key] ?? "Choose an item, then confirm construction.";
    this.detailType.textContent = this.activeCat.label;
    this.detailName.textContent = "Choose an item";
    this.detailCopy.textContent = this.categoryHelp[this.activeCat.key] ?? "Select an item from the catalog to see its placement details.";
  }

  private renderPalette() {
    this.palette.innerHTML = "";
    this.itemButtons = [];
    const items = this.searchQuery && !this.activeCat.label.toLowerCase().includes(this.searchQuery)
      ? this.activeCat.items.filter((item) => item.label.toLowerCase().includes(this.searchQuery))
      : this.activeCat.items;
    items.forEach((item) => {
      const b = document.createElement("button");
      b.className = "build-item";
      const swatch = document.createElement("span");
      swatch.className = "item-swatch";
      swatch.style.background = `linear-gradient(135deg, rgba(255,255,255,.15), transparent 52%), ${item.swatch}`;
      const title = document.createElement("span");
      title.className = "item-title";
      title.textContent = item.label;
      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.textContent = this.itemMeta(item);
      b.append(swatch, title, meta);
      b.onclick = () => this.selectItem(item, b);
      if (this.candidate && sameTool(this.candidate.tool, item.tool)) b.classList.add("on");
      this.palette.appendChild(b);
      this.itemButtons.push(b);
    });
  }

  private itemMeta(item: Item): string {
    if (item.tool.cat === "floor") return "Surface finish";
    if (item.tool.cat === "wall" || item.tool.cat === "fence") return "Structural";
    if (item.tool.cat === "room") return "Room designation";
    if (item.tool.cat === "piece") {
      const def = defOf(item.tool.mat);
      if (def) return `${def.w}\u00d7${def.d} footprint`;
    }
    if (item.tool.cat === "person") return "Hire staff";
    if (item.tool.cat === "patrol" || item.tool.cat === "deploy") return "Security tool";
    if (item.tool.cat === "erase") return "Removal tool";
    return "Ready to place";
  }

  private selectItem(item: Item, btn: HTMLButtonElement) {
    this.tool = item.tool;
    this.candidate = item;
    this.itemButtons.forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    this.detailType.textContent = this.activeCat.label;
    this.detailName.textContent = item.label;
    this.detailCopy.textContent = this.itemDescription(item);
    this.onChange?.();
  }

  private itemDescription(item: Item): string {
    if (item.tool.cat === "floor") return `Lay ${item.label.toLowerCase()} across a selected area. Drag to fill a rectangle.`;
    if (item.tool.cat === "wall" || item.tool.cat === "fence") return `Draw a straight run of ${item.label.toLowerCase()} to shape and secure the prison.`;
    if (item.tool.cat === "room") {
      const room = ROOM_DEFS.find((row) => row.type === item.tool.mat);
      const requirements = room?.requires.map((req) => req.issue.replace(/^Needs? /, "").replace(/\.$/, "")).join(", ");
      return `Mark a zone as a ${item.label.toLowerCase()}.` +
        (room?.minSquare ? ` Minimum clear area: ${room.minSquare}\u00d7${room.minSquare}.` : "") +
        (requirements ? ` Requires: ${requirements}.` : "");
    }
    if (item.tool.cat === "patrol" || item.tool.cat === "deploy") return `Use this ${item.label.toLowerCase()} tool directly on the yard.`;
    if (item.tool.cat === "person") return `Hire and place ${item.label.toLowerCase()}. The hiring fee is charged on placement and payroll is charged hourly.`;
    if (item.tool.cat === "piece") {
      const def = defOf(item.tool.mat);
      return `Place ${item.label.toLowerCase()}${def ? ` (${def.w}\u00d7${def.d} tiles)` : ""}. Use R to rotate before placement.`;
    }
    return `Place ${item.label.toLowerCase()} in the world. Use R to rotate before placement where applicable.`;
  }

  clear() {
    this.tool = null;
    this.candidate = null;
    this.itemButtons.forEach((b) => b.classList.remove("on"));
    this.detailName.textContent = "Choose an item";
    this.detailCopy.textContent = this.categoryHelp[this.activeCat.key] ?? "Select an item from the catalog to see its placement details.";
    this.onChange?.();
  }

  /** Do the staff tools show their layer? Beats and postings are invisible
   *  clutter the rest of the time, so they only appear while you're editing. */
  get showStaffLayer(): boolean {
    const c = this.tool?.cat;
    return c === "patrol" || c === "unpatrol" || c === "deploy" || c === "undeploy";
  }

  /** Apply the current tool to a tile. Returns true if the world likely changed. */
  apply(world: World, x: number, z: number): boolean {
    if (!this.tool) return false;
    switch (this.tool.cat) {
      case "floor": return world.setFloor(x, z, this.tool.mat);
      case "wall": return world.setWall(x, z, this.tool.mat);
      case "fence": return world.setFence(x, z, this.tool.mat);
      case "door": return world.setDoor(x, z);
      case "staffdoor": return world.setDoor(x, z, "staff");
      case "jaildoor": return world.setDoor(x, z, true);
      case "fencedoor": return world.setFenceGate(x, z, false);
      case "fencestaffdoor": return world.setFenceGate(x, z, "staff");
      case "fencejaildoor": return world.setFenceGate(x, z, true);
      case "piece": return world.placePiece(x, z, this.tool.mat, this.orient);
      case "lamp": return world.setLamp(x, z);
      case "walllight": return world.setWallLight(x, z);
      case "rooflight": return world.setRoofLight(x, z);
      case "prisoner": return world.setPerson(x, z, Obj.Prisoner, this.orient);
      case "guard": return world.setPerson(x, z, Obj.Guard, this.orient);
      case "cook": return world.setPerson(x, z, Obj.Cook, this.orient);
      case "workman": return world.setPerson(x, z, Obj.Workman, this.orient);
      case "person": return world.setPerson(x, z, this.tool.mat, this.orient);
      case "baton": return world.setBaton(x, z);
      // Rooms are dragged out like floors; main claims the room on pointerdown.
      case "room":
        return this.roomDrag > 0
          ? world.paintRoomInto(x, z, this.roomDrag)
          : world.paintRoom(x, z, this.tool.mat);
      case "access": return world.setRoomAccess(x, z, this.tool.mat);
      // Patrol and deploy are wired up by main (they need agent state), but the
      // drag itself runs through here.
      case "patrol":
        return this.routeDrag > 0 && world.addRouteTile(this.routeDrag, x, z);
      case "unpatrol": {
        const r = world.routeAtTile(x, z);
        if (r === 0) return false;
        world.removeRoute(r);
        return true;
      }
      case "deploy":
      case "undeploy":
        return false; // handled in main: it owns the guard roster
      case "erase": return world.erase(x, z);
    }
  }
}

function sameTool(a: Tool, b: Tool): boolean {
  return a.cat === b.cat && a.mat === b.mat;
}

/** Read-only catalog view used by coverage checks and problem deep links. */
export function catalogSnapshot(): { section: CatalogSectionId; label: string; tool: Tool }[] {
  return CATS.flatMap((cat) => cat.items.map((item) => ({ section: cat.key, label: item.label, tool: { ...item.tool } })));
}
