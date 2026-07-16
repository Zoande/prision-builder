import type { IssueLabel } from "../sim/agent";
import type { RoomLabel } from "../sim/world";

export interface PreviewTile { x: number; z: number }

interface PositionedElement {
  el: HTMLDivElement;
  x: number;
  z: number;
}

/** Retained DOM overlay: elements are updated and repositioned, not rebuilt. */
export class WorldOverlay {
  private readonly rooms = new Map<number, PositionedElement>();
  private readonly warnings = new Map<string, PositionedElement>();
  private readonly previews: HTMLDivElement[] = [];
  private readonly arrow: HTMLDivElement;
  private capacityText = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly capacity: HTMLElement,
    private readonly tip: HTMLElement,
  ) {
    this.arrow = document.createElement("div");
    this.arrow.className = "build-preview-arrow";
    this.arrow.style.display = "none";
    this.root.appendChild(this.arrow);
  }

  updateData(rooms: readonly RoomLabel[], issues: readonly IssueLabel[], population: number, beds: number) {
    const roomIds = new Set<number>();
    for (const room of rooms) {
      roomIds.add(room.id);
      let item = this.rooms.get(room.id);
      if (!item) {
        const el = document.createElement("div");
        el.className = "room-label";
        this.root.appendChild(el);
        item = { el, x: room.x, z: room.z };
        this.rooms.set(room.id, item);
      }
      item.x = room.x;
      item.z = room.z;
      const label = room.ambience > 0 ? `${room.name}  ${Math.round(room.ambience * 100)}%` : room.name;
      if (item.el.textContent !== label) item.el.textContent = label;
    }
    for (const [id, item] of this.rooms) {
      if (!roomIds.has(id)) { item.el.remove(); this.rooms.delete(id); }
    }

    const issueIds = new Set<string>();
    for (const issue of issues) {
      issueIds.add(issue.id);
      let item = this.warnings.get(issue.id);
      if (!item) {
        const el = document.createElement("div");
        el.className = "warn-mark";
        el.textContent = "!";
        el.addEventListener("mousemove", (event) => this.showTip(event, el.dataset.issue ?? ""));
        el.addEventListener("mouseleave", () => { this.tip.style.display = "none"; });
        this.root.appendChild(el);
        item = { el, x: issue.x, z: issue.z };
        this.warnings.set(issue.id, item);
      }
      item.x = issue.x;
      item.z = issue.z;
      item.el.dataset.issue = issue.issue;
    }
    for (const [id, item] of this.warnings) {
      if (!issueIds.has(id)) { item.el.remove(); this.warnings.delete(id); }
    }

    const text = `${population} / ${beds}`;
    if (text !== this.capacityText) {
      this.capacityText = text;
      const value = this.capacity.querySelector<HTMLElement>(".status-value");
      if (value) value.textContent = text;
    }
    // Keep the facing arrow above retained labels/markers created this refresh.
    this.root.appendChild(this.arrow);
  }

  render(
    viewProj: Float32Array,
    tiles: readonly PreviewTile[],
    tileCount: number,
    facing: number | null,
    anchor: PreviewTile | null,
  ) {
    for (const item of this.rooms.values()) this.position(item, viewProj, 0.12);
    for (const item of this.warnings.values()) this.position(item, viewProj, 1.0);
    this.renderPreviews(viewProj, tiles, tileCount);
    this.renderArrow(viewProj, facing, anchor);
  }

  private position(item: PositionedElement, viewProj: Float32Array, y: number) {
    const p = this.project(viewProj, item.x, y, item.z);
    item.el.style.display = p ? "" : "none";
    if (!p) return;
    item.el.style.left = `${p[0]}px`;
    item.el.style.top = `${p[1]}px`;
  }

  private renderPreviews(viewProj: Float32Array, tiles: readonly PreviewTile[], count: number) {
    let visible = 0;
    for (let i = 0; i < count; i++) {
      const tile = tiles[i];
      const p0 = this.project(viewProj, tile.x, 0.08, tile.z);
      const p1 = this.project(viewProj, tile.x + 1, 0.08, tile.z);
      const p2 = this.project(viewProj, tile.x + 1, 0.08, tile.z + 1);
      const p3 = this.project(viewProj, tile.x, 0.08, tile.z + 1);
      if (!p0 || !p1 || !p2 || !p3) continue;
      const minX = Math.min(p0[0], p1[0], p2[0], p3[0]);
      const minY = Math.min(p0[1], p1[1], p2[1], p3[1]);
      const maxX = Math.max(p0[0], p1[0], p2[0], p3[0]);
      const maxY = Math.max(p0[1], p1[1], p2[1], p3[1]);
      const el = this.preview(visible++);
      el.style.display = "";
      el.style.left = `${minX}px`;
      el.style.top = `${minY}px`;
      el.style.width = `${Math.max(1, maxX - minX)}px`;
      el.style.height = `${Math.max(1, maxY - minY)}px`;
      el.style.clipPath = `polygon(${p0[0] - minX}px ${p0[1] - minY}px,${p1[0] - minX}px ${p1[1] - minY}px,${p2[0] - minX}px ${p2[1] - minY}px,${p3[0] - minX}px ${p3[1] - minY}px)`;
    }
    for (let i = visible; i < this.previews.length; i++) this.previews[i].style.display = "none";
  }

  private preview(index: number): HTMLDivElement {
    let el = this.previews[index];
    if (!el) {
      el = document.createElement("div");
      el.className = "build-preview";
      this.root.insertBefore(el, this.arrow);
      this.previews.push(el);
    }
    return el;
  }

  private renderArrow(viewProj: Float32Array, facing: number | null, tile: PreviewTile | null) {
    if (facing === null || !tile) { this.arrow.style.display = "none"; return; }
    const dirs = [[0.42, 0], [0, 0.42], [-0.42, 0], [0, -0.42]];
    const [dx, dz] = dirs[facing & 3];
    const c = this.project(viewProj, tile.x + 0.5, 0.18, tile.z + 0.5);
    const f = this.project(viewProj, tile.x + 0.5 + dx, 0.18, tile.z + 0.5 + dz);
    if (!c || !f) { this.arrow.style.display = "none"; return; }
    const len = Math.hypot(f[0] - c[0], f[1] - c[1]);
    if (len < 4) { this.arrow.style.display = "none"; return; }
    this.arrow.style.display = "";
    this.arrow.style.left = `${c[0]}px`;
    this.arrow.style.top = `${c[1]}px`;
    this.arrow.style.width = `${len}px`;
    this.arrow.style.transform = `rotate(${Math.atan2(f[1] - c[1], f[0] - c[0])}rad)`;
  }

  private project(viewProj: Float32Array, x: number, y: number, z: number): [number, number] | null {
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 0.0001) return null;
    const nx = cx / cw, ny = cy / cw;
    if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.1) return null;
    return [((nx + 1) * 0.5) * innerWidth, ((1 - ny) * 0.5) * innerHeight];
  }

  private showTip(event: MouseEvent, issue: string) {
    this.tip.textContent = issue;
    this.tip.style.display = "block";
    this.tip.style.left = `${Math.min(event.clientX + 16, innerWidth - 360)}px`;
    this.tip.style.top = `${Math.min(event.clientY + 12, innerHeight - 120)}px`;
  }
}
