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
  const groupedTypes = new Set(ROOM_GROUPS.flatMap((group) => group.types));
  const cats: Cat[] = ROOM_GROUPS.map((group) => ({
    key: `rooms:${group.key}` as CatalogSectionId,
    label: group.label,
    items: group.types.map((type) => roomItem(type)),
  }));
  const ungrouped = ROOM_DEFS.filter((room) => !groupedTypes.has(room.type));
  if (ungrouped.length) cats.push({
    key: "rooms:other",
    label: "Other rooms",
    items: ungrouped.map((room) => roomItem(room.type)),
  });
  return cats;
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
      // Keep every player-placeable person in the registry represented here.
      // This also makes future staff roles appear without another UI-only list.
      ...OBJ_DEFS.filter((d) => d.place === "person" && d.palette && d.kind !== Obj.Prisoner).map((d) => personItem(d.kind)),
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
  staff: ["staff:people", "staff:deploy", "security:patrol"],
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

  /** The catalog item whose details are shown, distinct from placement state. */
  get detailTool(): Tool | null {
    return this.candidate?.tool ?? null;
  }

  private palette: HTMLElement;
  private cats: HTMLElement;
  private activeCat = CATS[0];
  private visibleCats: Cat[] = CATS;
  private currentMode = "build";
  private searchQuery = "";
  private searchFilterCat: CatalogSectionId | null = null;
  private preSearchCat: CatalogSectionId | null = null;
  private itemButtons: HTMLButtonElement[] = [];
  private candidate: Item | null = null;
  private detailType: HTMLElement;
  private detailName: HTMLElement;
  private detailCopy: HTMLElement;
  private resultsStatus: HTMLElement | null;
  private orientationStatus: HTMLElement | null;
  private allResultsButton: HTMLButtonElement | null = null;

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
    // A fixed-position child of the animated build tray is positioned against
    // the tray's transform box on phones. Portal it to body at that breakpoint
    // so the details card can use the viewport coordinates its CSS specifies.
    const detail = document.getElementById("itemDetail")!;
    const catalogMain = document.getElementById("catalogMain")!;
    const mobile = matchMedia("(max-width: 720px)");
    const placeDetail = () => {
      if (mobile.matches && detail.parentElement !== document.body) document.body.appendChild(detail);
      else if (!mobile.matches && detail.parentElement !== catalogMain) catalogMain.appendChild(detail);
    };
    placeDetail();
    mobile.addEventListener("change", placeDetail);
    this.resultsStatus = document.getElementById("catalogResults");
    this.orientationStatus = document.getElementById("orientationStatus");
    const search = document.getElementById("catalogSearch") as HTMLInputElement | null;
    if (search) search.addEventListener("input", () => {
      const query = search.value.trim().toLowerCase();
      if (!this.searchQuery && query) this.preSearchCat = this.activeCat.key;
      if (query !== this.searchQuery) this.searchFilterCat = null;
      this.searchQuery = query;
      this.applyVisibleSections(false);
    });

    this.setMode("build", false);

    addEventListener("keydown", (e) => {
      const target = e.target;
      const typing = target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (e.key === "Escape") {
        if (search && search.value) {
          search.value = "";
          this.searchQuery = "";
          this.searchFilterCat = null;
          this.applyVisibleSections(false);
        } else this.clear();
      }
      if (!typing && !e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "r" || e.key === "R")) {
        this.orient = (this.orient + 1) % 4;
        this.announceOrientation();
      }
    });
  }

  private renderCategories() {
    this.cats.innerHTML = "";
    this.allResultsButton = null;
    if (this.searchQuery) {
      const b = document.createElement("button");
      b.className = "build-cat search-all";
      b.type = "button";
      const label = document.createElement("span");
      label.textContent = "All results";
      const count = document.createElement("small");
      count.className = "category-count";
      count.textContent = String(this.allSearchItems().length);
      count.setAttribute("aria-hidden", "true");
      b.append(label, count);
      b.onclick = () => {
        this.searchFilterCat = null;
        this.renderCategories();
        this.renderPalette();
      };
      this.cats.appendChild(b);
      this.allResultsButton = b;
    }
    this.visibleCats.forEach((cat) => {
      const b = document.createElement("button");
      b.className = "build-cat";
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      const countValue = this.searchQuery ? this.searchItems(cat).length : cat.items.length;
      b.title = this.categoryHelp[cat.key] ?? `${countValue} catalog items`;
      b.dataset.section = cat.key;
      const label = document.createElement("span");
      label.textContent = cat.label;
      const count = document.createElement("small");
      count.className = "category-count";
      count.textContent = String(countValue);
      count.setAttribute("aria-hidden", "true");
      b.append(label, count);
      b.onclick = () => {
        if (this.searchQuery) this.searchFilterCat = cat.key;
        this.selectCat(cat, true);
      };
      this.cats.appendChild(b);
      (cat as Cat & { el?: HTMLButtonElement }).el = b;
    });
    this.updateCategorySelection();
  }

  private updateCategorySelection() {
    const selectedKey = this.searchQuery ? this.searchFilterCat : this.activeCat.key;
    this.cats.querySelectorAll<HTMLButtonElement>(".build-cat").forEach((button) => {
      const isAllResults = button === this.allResultsButton;
      const selected = isAllResults ? !!this.searchQuery && !selectedKey
        : (button as HTMLButtonElement).dataset.section === selectedKey;
      button.classList.toggle("on", selected);
      button.setAttribute("aria-pressed", String(selected));
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
      ? CATS.filter((cat) => this.searchItems(cat).length > 0)
      : CATS.filter((cat) => keys.includes(cat.key));
    this.renderCategories();
    const preferred = this.searchQuery ? this.visibleCats[0]
      : this.visibleCats.find((cat) => cat.key === this.preSearchCat) ?? this.visibleCats[0];
    const first = preferred ?? CATS[0];
    if (!this.searchQuery) this.preSearchCat = null;
    this.selectCat(first, clearTool);
  }

  selectCategory(key: string) {
    const normalized = key.toLowerCase();
    const cat = CATS.find((x) => x.key === key || x.label.toLowerCase() === normalized) ?? CATS[0];
    if (this.searchQuery) this.searchFilterCat = cat.key;
    if (!this.visibleCats.includes(cat)) {
      this.visibleCats = [cat];
      this.renderCategories();
    }
    this.selectCat(cat, true);
  }

  /** Select a catalog tool by its registry-backed identity. Useful for direct
   * actions from inspectors, so those actions never need to locate a button by
   * its display label. */
  selectTool(tool: Tool): boolean {
    const cat = CATS.find((section) => section.items.some((item) => sameTool(item.tool, tool)));
    const item = cat?.items.find((candidate) => sameTool(candidate.tool, tool));
    if (!cat || !item) return false;

    const search = document.getElementById("catalogSearch") as HTMLInputElement | null;
    if (search) search.value = "";
    this.searchQuery = "";
    this.searchFilterCat = null;
    this.preSearchCat = null;
    const mode = cat.key.startsWith("rooms:") ? "rooms"
      : cat.key.startsWith("objects:") ? "objects"
      : cat.key.startsWith("staff:") || cat.key.startsWith("security:") ? "staff"
      : cat.key.startsWith("admin:") ? "admin" : "build";
    this.setMode(mode, false);
    this.selectCategory(cat.key);
    const index = cat.items.indexOf(item);
    const button = this.itemButtons[index];
    if (!button) return false;
    this.selectItem(item, button, cat);
    return true;
  }

  private selectCat(cat: Cat, clearTool: boolean) {
    this.activeCat = cat;
    this.updateCategorySelection();
    if (clearTool) {
      this.tool = null;
      this.candidate = null;
      document.getElementById("itemDetail")?.classList.remove("has-selection");
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
    const rows = this.searchQuery
      ? this.allSearchItems().filter(({ cat }) => !this.searchFilterCat || cat.key === this.searchFilterCat)
      : this.activeCat.items.map((item) => ({ cat: this.activeCat, item }));
    rows.forEach(({ cat, item }) => {
      const b = document.createElement("button");
      b.className = "build-item";
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      const swatch = document.createElement("span");
      swatch.className = "item-swatch";
      swatch.style.background = `linear-gradient(135deg, rgba(255,255,255,.15), transparent 52%), ${item.swatch}`;
      const title = document.createElement("span");
      title.className = "item-title";
      title.textContent = item.label;
      title.title = item.label;
      const group = document.createElement("span");
      group.className = "item-group";
      group.textContent = cat.label;
      const meta = document.createElement("span");
      meta.className = "item-meta";
      meta.textContent = this.itemMeta(item);
      b.setAttribute("aria-label", `${item.label}. ${cat.label} category. ${meta.textContent}. ${this.itemDescription(item)}`);
      b.append(swatch, title, group, meta);
      b.onclick = () => this.selectItem(item, b, cat);
      if (this.candidate && sameTool(this.candidate.tool, item.tool)) {
        b.classList.add("on");
        b.setAttribute("aria-pressed", "true");
      }
      this.palette.appendChild(b);
      this.itemButtons.push(b);
    });
    if (this.resultsStatus) {
      const count = rows.length;
      const categoryCount = new Set(rows.map(({ cat }) => cat.key)).size;
      this.resultsStatus.textContent = this.searchQuery
        ? `${count} ${count === 1 ? "result" : "results"}${this.searchFilterCat ? ` in ${this.activeCat.label}` : ` across ${categoryCount} categories`}`
        : `${count} ${count === 1 ? "item" : "items"}`;
    }
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "catalog-empty";
      empty.textContent = "No items match this search. Try another name or clear the search.";
      this.palette.appendChild(empty);
    }
  }

  private searchItems(cat: Cat): Item[] {
    if (!this.searchQuery) return cat.items;
    if (cat.label.toLowerCase().includes(this.searchQuery)) return cat.items;
    return cat.items.filter((item) => this.itemMatchesSearch(item));
  }

  private allSearchItems(): { cat: Cat; item: Item }[] {
    return CATS.flatMap((cat) => this.searchItems(cat).map((item) => ({ cat, item })));
  }

  private itemMatchesSearch(item: Item): boolean {
    if (this.searchText(item).includes(this.searchQuery)) return true;
    if (item.tool.cat !== "piece") return false;
    const kind = item.tool.mat;
    return ROOM_DEFS.some((room) => room.name.toLowerCase().includes(this.searchQuery) &&
      room.requires.some((requirement) => requirement.kinds.includes(kind)));
  }

  private searchText(item: Item): string {
    const parts = [item.label, this.itemMeta(item), this.itemDescription(item)];
    if (item.tool.cat === "piece" || item.tool.cat === "person") {
      const def = defOf(item.tool.mat);
      if (def) {
        parts.push(def.name);
        if (def.use) parts.push(...Object.keys(def.use.needs));
      }
    }
    if (item.tool.cat === "room") {
      const room = ROOM_DEFS.find((row) => row.type === item.tool.mat);
      if (room) parts.push(room.name, ...room.requires.map((requirement) => requirement.issue));
    }
    return parts.join(" ").toLowerCase();
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

  private selectItem(item: Item, btn: HTMLButtonElement, category: Cat = this.activeCat) {
    this.tool = item.tool;
    this.candidate = item;
    this.activeCat = category;
    this.itemButtons.forEach((b) => b.classList.remove("on"));
    this.itemButtons.forEach((b) => b.setAttribute("aria-pressed", "false"));
    btn.classList.add("on");
    btn.setAttribute("aria-pressed", "true");
    this.detailType.textContent = category.label;
    this.detailName.textContent = item.label;
    this.detailCopy.textContent = this.itemDescription(item);
    document.getElementById("itemDetail")?.classList.add("has-selection");
    const costLabel = document.querySelector<HTMLElement>("#detailCost span");
    const cost = document.querySelector<HTMLElement>("#detailCost strong");
    if (costLabel && cost) {
      costLabel.textContent = "Placement";
      cost.textContent = this.itemMeta(item);
    }
    this.onChange?.();
  }

  private itemDescription(item: Item): string {
    if (item.tool.cat === "floor") return `Lay ${item.label.toLowerCase()} across a selected area. Drag to fill a rectangle.`;
    if (item.tool.cat === "wall" || item.tool.cat === "fence") return `Draw a straight run of ${item.label.toLowerCase()} to shape and secure the prison.`;
    if (item.tool.cat === "room") {
      const room = ROOM_DEFS.find((row) => row.type === item.tool.mat);
      const requirements = room?.requires.map((req) => req.issue.replace(/^Needs? /, "").replace(/\.$/, "")).join(", ");
      return `Finish the enclosing walls or fences and an entrance, then paint the interior as a ${item.label.toLowerCase()}.` +
        (room?.minSquare ? ` Minimum clear area: ${room.minSquare}\u00d7${room.minSquare}.` : "") +
        (requirements ? ` Requires: ${requirements}.` : "");
    }
    if (item.tool.cat === "patrol") return "Click or drag across tiles to draw a guard patrol route.";
    if (item.tool.cat === "unpatrol") return "Click a tile on a patrol route to remove that route.";
    if (item.tool.cat === "deploy") return "Click a patrol route or staff room to post an available guard there.";
    if (item.tool.cat === "undeploy") return "Click a staffed patrol route or room to remove its guard assignment.";
    if (item.tool.cat === "person") return `Hire and place ${item.label.toLowerCase()}. The hiring fee is charged on placement and payroll is charged hourly.`;
    if (["door", "jaildoor", "staffdoor"].includes(item.tool.cat)) return "Click a wall tile to convert it into this door. It must sit in a wall boundary.";
    if (["fencedoor", "fencestaffdoor", "fencejaildoor"].includes(item.tool.cat)) return "Click a fence tile to convert it into this gate.";
    if (item.tool.cat === "piece") {
      const def = defOf(item.tool.mat);
      const needs = def?.use ? Object.entries(def.use.needs).map(([need, amount]) => `${need} (+${amount})`).join(", ") : "";
      return `Place ${item.label.toLowerCase()}${def ? ` (${def.w}\u00d7${def.d} tile${def.w * def.d === 1 ? "" : "s"})` : ""}.` +
        (needs ? ` Used by prisoners for: ${needs}.` : "") +
        " Click a map tile to order construction. Press R to rotate.";
    }
    if (item.tool.cat === "access") return `Paint the ${item.label.toLowerCase()} restriction over designated room tiles.`;
    if (item.tool.cat === "erase") return "Click a tile or object to schedule demolition. Erased items may return materials to stock.";
    if (item.tool.cat === "baton") return "Place a baton on the map for staff use.";
    if (item.tool.cat === "walllight") return "Click an open wall face to mount a wall light.";
    if (item.tool.cat === "rooflight") return "Click a roof tile to mount a roof light.";
    if (item.tool.cat === "lamp") return "Place a floor lamp on an open tile.";
    return `Use ${item.label.toLowerCase()} on the map. Press R to rotate where applicable.`;
  }

  clear() {
    this.tool = null;
    this.candidate = null;
    this.itemButtons.forEach((b) => b.classList.remove("on"));
    this.detailName.textContent = "Choose an item";
    this.detailCopy.textContent = this.categoryHelp[this.activeCat.key] ?? "Select an item from the catalog to see its placement details.";
    document.getElementById("itemDetail")?.classList.remove("has-selection");
    const costLabel = document.querySelector<HTMLElement>("#detailCost span");
    const cost = document.querySelector<HTMLElement>("#detailCost strong");
    if (costLabel && cost) { costLabel.textContent = "Placement"; cost.textContent = "Select an item to see its controls."; }
    this.onChange?.();
  }

  private announceOrientation() {
    if (this.orientationStatus) this.orientationStatus.textContent = `Direction ${this.orient + 1} of 4`;
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
