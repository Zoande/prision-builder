// Build editor: the bottom-centre HUD (category tabs + item palette) and the
// current tool. Placement itself is driven by main (pointer + picking); this
// module owns tool state and the UI.

import { Access, Obj, RoomType, World } from "./sim/world";
import { FLOOR_MATS, WALL_MATS, FENCE_MAT } from "./render/materials";

export type ToolCat =
  | "floor" | "wall" | "fence" | "door" | "jaildoor" | "bed"
  | "lamp" | "walllight" | "rooflight"
  | "toilet" | "shower" | "drain" | "fencedoor" | "fencejaildoor"
  | "table" | "servingtable" | "bench2" | "bench4" | "cooker"
  | "prisoner" | "guard" | "cook" | "workman" | "baton"
  | "room" | "access" | "erase";
export interface Tool { cat: ToolCat; mat: number }
interface Item { label: string; swatch: string; tool: Tool }
interface Cat { key: string; label: string; items: Item[] }

const CATS: Cat[] = [
  {
    key: "floor", label: "Floors",
    items: FLOOR_MATS.map((m) => ({ label: m.name, swatch: m.swatch, tool: { cat: "floor", mat: m.id } })),
  },
  {
    key: "wall", label: "Walls",
    items: [
      ...WALL_MATS.map((m) => ({ label: m.name, swatch: m.swatch, tool: { cat: "wall", mat: m.id } as Tool })),
      { label: "Fence", swatch: "#9aa0a6", tool: { cat: "fence", mat: FENCE_MAT.id } },
    ],
  },
  {
    key: "furniture", label: "Furniture",
    items: [
      { label: "Door", swatch: "#b98a57", tool: { cat: "door", mat: 0 } },
      { label: "Jail Door", swatch: "#7e868f", tool: { cat: "jaildoor", mat: 0 } },
      { label: "Fence Door", swatch: "#e07a1f", tool: { cat: "fencedoor", mat: 0 } },
      { label: "Fence Jail Door", swatch: "#c03030", tool: { cat: "fencejaildoor", mat: 0 } },
      { label: "Bed", swatch: "#cabfa6", tool: { cat: "bed", mat: 0 } },
      { label: "Toilet", swatch: "#dfe4ea", tool: { cat: "toilet", mat: 0 } },
      { label: "Shower", swatch: "#9fb4c8", tool: { cat: "shower", mat: 0 } },
      { label: "Drain", swatch: "#4a4f55", tool: { cat: "drain", mat: 0 } },
      { label: "Table", swatch: "#d8d8d2", tool: { cat: "table", mat: 0 } },
      { label: "Serving Table", swatch: "#aeb6ba", tool: { cat: "servingtable", mat: 0 } },
      { label: "Bench 2x1", swatch: "#cfcfc8", tool: { cat: "bench2", mat: 0 } },
      { label: "Bench 4x1", swatch: "#c4c4bc", tool: { cat: "bench4", mat: 0 } },
      { label: "Cooker", swatch: "#666c73", tool: { cat: "cooker", mat: 0 } },
      { label: "Lamp", swatch: "#e8b96a", tool: { cat: "lamp", mat: 0 } },
      { label: "Wall Light", swatch: "#f0d9a0", tool: { cat: "walllight", mat: 0 } },
      { label: "Roof Light", swatch: "#dfe8f2", tool: { cat: "rooflight", mat: 0 } },
    ],
  },
  {
    key: "people", label: "People",
    items: [
      { label: "Prisoner", swatch: "#f07018", tool: { cat: "prisoner", mat: 0 } },
      { label: "Guard", swatch: "#3a4a6b", tool: { cat: "guard", mat: 0 } },
      { label: "Cook", swatch: "#e8e6e0", tool: { cat: "cook", mat: 0 } },
      { label: "Workman", swatch: "#f0c020", tool: { cat: "workman", mat: 0 } },
      { label: "Baton", swatch: "#202024", tool: { cat: "baton", mat: 0 } },
    ],
  },
  {
    key: "rooms", label: "Rooms",
    items: [
      { label: "Kitchen", swatch: "#c96f3b", tool: { cat: "room", mat: RoomType.Kitchen } },
      { label: "Yard", swatch: "#7fae5a", tool: { cat: "room", mat: RoomType.Yard } },
      { label: "Canteen", swatch: "#caa84f", tool: { cat: "room", mat: RoomType.Canteen } },
      { label: "Cell", swatch: "#7f8fa6", tool: { cat: "room", mat: RoomType.Cell } },
      { label: "Dormitory", swatch: "#9aa7c0", tool: { cat: "room", mat: RoomType.Dorm } },
      { label: "Shower Room", swatch: "#8fb8c8", tool: { cat: "room", mat: RoomType.ShowerRoom } },
      { label: "Empty Room", swatch: "#9a9a9a", tool: { cat: "room", mat: RoomType.Empty } },
    ],
  },
  {
    key: "access", label: "Access",
    items: [
      { label: "Staff", swatch: "#e8d44d", tool: { cat: "access", mat: Access.Staff } },
      { label: "Prisoners", swatch: "#f07018", tool: { cat: "access", mat: Access.Prisoners } },
      { label: "Forbidden", swatch: "#d63030", tool: { cat: "access", mat: Access.Forbidden } },
    ],
  },
  { key: "erase", label: "Erase", items: [{ label: "Erase", swatch: "#d66666", tool: { cat: "erase", mat: 0 } }] },
];

export class Editor {
  tool: Tool | null = null;
  orient = 0; // 0..3 quarter turns
  onChange?: () => void; // called when a tool is (de)selected, to update build mode

  private palette: HTMLElement;
  private cats: HTMLElement;
  private activeCat = CATS[0];
  private itemButtons: HTMLButtonElement[] = [];

  constructor() {
    this.cats = document.getElementById("cats")!;
    this.palette = document.getElementById("palette")!;

    CATS.forEach((cat) => {
      const b = document.createElement("button");
      b.className = "build-cat";
      b.textContent = cat.label;
      b.onclick = () => this.selectCat(cat, b);
      this.cats.appendChild(b);
      (cat as Cat & { el?: HTMLButtonElement }).el = b;
    });

    addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.clear();
      if (e.key === "r" || e.key === "R") this.orient = (this.orient + 1) % 4;
    });

    this.selectCat(CATS[0], (CATS[0] as Cat & { el?: HTMLButtonElement }).el!);
  }

  get active(): boolean { return this.tool !== null; }

  private selectCat(cat: Cat, btn: HTMLButtonElement) {
    this.activeCat = cat;
    this.cats.querySelectorAll(".build-cat").forEach((e) => e.classList.remove("on"));
    btn.classList.add("on");
    this.renderPalette();
  }

  private renderPalette() {
    this.palette.innerHTML = "";
    this.itemButtons = [];
    this.activeCat.items.forEach((item) => {
      const b = document.createElement("button");
      b.className = "build-item";
      b.innerHTML = `<span class="sw" style="background:${item.swatch}"></span>${item.label}`;
      b.onclick = () => this.selectItem(item, b);
      if (this.tool && sameTool(this.tool, item.tool)) b.classList.add("on");
      this.palette.appendChild(b);
      this.itemButtons.push(b);
    });
  }

  private selectItem(item: Item, btn: HTMLButtonElement) {
    this.tool = item.tool;
    this.itemButtons.forEach((b) => b.classList.remove("on"));
    btn.classList.add("on");
    this.onChange?.();
  }

  clear() {
    this.tool = null;
    this.itemButtons.forEach((b) => b.classList.remove("on"));
    this.onChange?.();
  }

  /** Apply the current tool to a tile. Returns true if the world likely changed. */
  apply(world: World, x: number, z: number): boolean {
    if (!this.tool) return false;
    switch (this.tool.cat) {
      case "floor": world.setFloor(x, z, this.tool.mat); return true;
      case "wall": world.setWall(x, z, this.tool.mat); return true;
      case "fence": world.setFence(x, z, this.tool.mat); return true;
      case "door": world.setDoor(x, z); return true;
      case "jaildoor": world.setDoor(x, z, true); return true;
      case "fencedoor": world.setFenceGate(x, z, false); return true;
      case "fencejaildoor": world.setFenceGate(x, z, true); return true;
      case "bed": return world.placeBed(x, z, this.orient);
      case "toilet": world.setFurniture(x, z, Obj.Toilet, this.orient); return true;
      case "shower": world.setFurniture(x, z, Obj.Shower, this.orient); return true;
      case "drain": world.setFurniture(x, z, Obj.Drain, this.orient); return true;
      case "table": world.setFurniture(x, z, Obj.Table, this.orient); return true;
      case "servingtable": world.setFurniture(x, z, Obj.ServingTable, this.orient); return true;
      case "bench2": return world.placeSpan(x, z, this.orient, Obj.Bench2);
      case "bench4": return world.placeSpan(x, z, this.orient, Obj.Bench4);
      case "cooker": world.setFurniture(x, z, Obj.Cooker, this.orient); return true;
      case "lamp": world.setLamp(x, z); return true;
      case "walllight": world.setWallLight(x, z); return true;
      case "rooflight": world.setRoofLight(x, z); return true;
      case "prisoner": world.setPerson(x, z, Obj.Prisoner, this.orient); return true;
      case "guard": world.setPerson(x, z, Obj.Guard, this.orient); return true;
      case "cook": world.setPerson(x, z, Obj.Cook, this.orient); return true;
      case "workman": world.setPerson(x, z, Obj.Workman, this.orient); return true;
      case "baton": world.setBaton(x, z); return true;
      case "room": return world.paintRoom(x, z, this.tool.mat);
      case "access": return world.setRoomAccess(x, z, this.tool.mat);
      case "erase": world.erase(x, z); return true;
    }
  }
}

function sameTool(a: Tool, b: Tool): boolean {
  return a.cat === b.cat && a.mat === b.mat;
}
