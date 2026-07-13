// Build editor: the bottom-centre HUD (category tabs + item palette) and the
// current tool. Placement itself is driven by main (pointer + picking); this
// module owns tool state and the UI.

import { Access, OBJ_DEFS, Obj, ROOM_DEFS, RoomType, World, defOf } from "./sim/world";
import { FLOOR_MATS, WALL_MATS, FENCE_MAT } from "./render/materials";

// Structural tools get their own cat because each has a bespoke world setter
// (a door converts a wall, a wall light must find an open face). Everything
// else is a "piece": one cat, and `mat` carries the Obj kind — so a new object
// costs a row in objects.ts and nothing here.
export type ToolCat =
  | "floor" | "wall" | "fence" | "door" | "jaildoor"
  | "fencedoor" | "fencejaildoor"
  | "lamp" | "walllight" | "rooflight"
  | "piece"
  | "prisoner" | "guard" | "cook" | "workman" | "baton"
  | "room" | "access" | "erase";
export interface Tool { cat: ToolCat; mat: number }
interface Item { label: string; swatch: string; tool: Tool }
interface Cat { key: string; label: string; items: Item[] }

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

// The few kinds that need a bespoke world setter rather than placePiece.
const SPECIAL_CAT: Record<number, ToolCat> = {
  [Obj.Door]: "door", [Obj.JailDoor]: "jaildoor",
  [Obj.FenceDoor]: "fencedoor", [Obj.FenceJailDoor]: "fencejaildoor",
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
  return order.map((g) => ({ key: g.toLowerCase(), label: g, items: byGroup.get(g)! }));
}

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
  // One tab per registry group, so the catalog stays browsable as it grows.
  ...groupCats(),
  {
    key: "people", label: "People",
    items: [
      objItem(Obj.Prisoner, "prisoner"),
      objItem(Obj.Guard, "guard"),
      objItem(Obj.Cook, "cook"),
      objItem(Obj.Workman, "workman"),
      { label: "Baton", swatch: "#202024", tool: { cat: "baton", mat: 0 } },
    ],
  },
  {
    key: "rooms", label: "Rooms",
    items: ROOM_DEFS
      .filter((r) => r.type !== RoomType.Empty)
      .map((r) => ({ label: r.name, swatch: r.swatch, tool: { cat: "room", mat: r.type } as Tool }))
      // "Empty" is how you un-paint, so it belongs last, not first.
      .concat([{ label: "Empty Room", swatch: "#9a9a9a", tool: { cat: "room", mat: RoomType.Empty } }]),
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
  /** The room a room-paint drag is filling (0 = not dragging). Set by main. */
  roomDrag = 0;
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
      case "piece": return world.placePiece(x, z, this.tool.mat, this.orient);
      case "lamp": world.setLamp(x, z); return true;
      case "walllight": world.setWallLight(x, z); return true;
      case "rooflight": world.setRoofLight(x, z); return true;
      case "prisoner": world.setPerson(x, z, Obj.Prisoner, this.orient); return true;
      case "guard": world.setPerson(x, z, Obj.Guard, this.orient); return true;
      case "cook": world.setPerson(x, z, Obj.Cook, this.orient); return true;
      case "workman": world.setPerson(x, z, Obj.Workman, this.orient); return true;
      case "baton": world.setBaton(x, z); return true;
      // Rooms are dragged out like floors; main claims the room on pointerdown.
      case "room":
        return this.roomDrag > 0
          ? world.paintRoomInto(x, z, this.roomDrag)
          : world.paintRoom(x, z, this.tool.mat);
      case "access": return world.setRoomAccess(x, z, this.tool.mat);
      case "erase": world.erase(x, z); return true;
    }
  }
}

function sameTool(a: Tool, b: Tool): boolean {
  return a.cat === b.cat && a.mat === b.mat;
}
