import "./facilityInspector.css";

export interface FacilityRequirement {
  text: string;
  /** Registry section to open when this requirement has a useful fix. */
  catalogSection?: string;
}

export interface FacilityDetail { label: string; value: string }

export interface FacilityRoomSelection {
  kind: "room";
  id: number;
  name: string;
  status: string;
  operational: boolean;
  /** World tile count and bounding footprint in tiles. */
  tiles: number;
  width: number;
  depth: number;
  /** Capacity is optional for room types without a meaningful seat/bed count. */
  capacity?: string;
  access?: string;
  custody?: string;
  guards?: number;
  requirements: FacilityRequirement[];
  details?: FacilityDetail[];
  paintType?: number;
}

export interface FacilityObjectSelection {
  kind: "object";
  id?: number;
  name: string;
  status?: string;
  operational?: boolean;
  width: number;
  depth: number;
  details?: FacilityDetail[];
  room?: FacilityRoomSelection;
}

export type FacilitySelection = FacilityRoomSelection | FacilityObjectSelection;

export interface FacilityInspectorActions {
  openCatalog(section: string): void;
  paintRoom(type: number): void;
  assignGuard?(roomId: number): void;
  removeGuard?(roomId: number): void;
  close?(): void;
}

/** A compact, retained inspector for a selected room or built object. */
export class FacilityInspector {
  readonly element: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly body: HTMLElement;
  private readonly actions: FacilityInspectorActions;
  private lastSignature = "";

  constructor(actions: FacilityInspectorActions, host: HTMLElement = document.body) {
    this.actions = actions;
    this.element = document.createElement("aside");
    this.element.className = "facility-inspector";
    this.element.setAttribute("aria-label", "Selected facility");
    this.element.setAttribute("aria-live", "polite");
    const header = document.createElement("header");
    const title = document.createElement("div");
    title.className = "fi-eyebrow";
    title.textContent = "Facility inspector";
    const close = document.createElement("button");
    close.className = "fi-close";
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close facility inspector");
    close.addEventListener("click", () => {
      this.clear();
      this.actions.close?.();
    });
    header.append(title, close);
    this.heading = document.createElement("div");
    this.heading.className = "fi-heading";
    this.body = document.createElement("div");
    this.body.className = "fi-body";
    this.element.append(header, this.heading, this.body);
    host.appendChild(this.element);
  }

  update(selection: FacilitySelection | null): void {
    if (!selection) { this.clear(); return; }
    const signature = JSON.stringify(selection);
    if (this.element.classList.contains("is-open") && signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.element.classList.add("is-open");
    this.heading.replaceChildren();
    const name = document.createElement("h2");
    name.textContent = selection.name;
    const state = document.createElement("span");
    const operational = selection.kind === "room" ? selection.operational : selection.operational ?? true;
    state.className = `fi-state ${operational ? "is-ready" : "is-blocked"}`;
    state.textContent = selection.status ?? (selection.kind === "room" && !selection.operational ? "Needs attention" : "Built object");
    this.heading.append(name, state);
    this.body.replaceChildren();

    const dimensions = selection.kind === "room"
      ? `${selection.width} × ${selection.depth} tiles · ${selection.tiles} total`
      : `${selection.width} × ${selection.depth} tile${selection.width * selection.depth === 1 ? "" : "s"}`;
    this.addSection("Footprint", [dimensions]);

    const contextualRoom = selection.kind === "room" ? selection : selection.room;
    const details = [...(selection.details ?? [])];
    if (selection.kind === "room") {
      if (selection.capacity) details.push({ label: "Capacity", value: selection.capacity });
      if (selection.access) details.push({ label: "Access", value: selection.access });
      if (selection.custody) details.push({ label: "Custody", value: selection.custody });
      if (selection.guards !== undefined) details.push({ label: "Guards assigned", value: String(selection.guards) });
    } else {
      if (selection.id !== undefined) details.unshift({ label: "Object ID", value: `#${selection.id}` });
      if (contextualRoom) {
        details.push({ label: "Room", value: contextualRoom.name });
        details.push({ label: "Room state", value: contextualRoom.status });
        if (contextualRoom.capacity) details.push({ label: "Room capacity", value: contextualRoom.capacity });
        if (contextualRoom.access) details.push({ label: "Access", value: contextualRoom.access });
        if (contextualRoom.custody) details.push({ label: "Custody", value: contextualRoom.custody });
        if (contextualRoom.guards !== undefined) details.push({ label: "Guards assigned", value: String(contextualRoom.guards) });
      }
    }
    if (contextualRoom?.requirements.length) {
      const section = document.createElement("section");
      section.className = "fi-section fi-requirements";
      const title = document.createElement("h3");
      title.textContent = selection.kind === "room" ? "Requirements to operate" : `${contextualRoom.name} requirements`;
      const list = document.createElement("ul");
      for (const requirement of contextualRoom.requirements) {
        const row = document.createElement("li");
        const text = document.createElement("span");
        text.textContent = requirement.text;
        row.appendChild(text);
        if (requirement.catalogSection) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "Find item";
          button.addEventListener("click", () => this.actions.openCatalog(requirement.catalogSection!));
          row.appendChild(button);
        }
        list.appendChild(row);
      }
      section.append(title, list);
      this.body.appendChild(section);
    } else if (contextualRoom) {
      this.addSection("Requirements", ["All listed requirements are met."]);
    }
    if (details.length) this.addSection("Operations", details.map((detail) => `${detail.label}: ${detail.value}`));

    const actionRow = document.createElement("div");
    actionRow.className = "fi-actions";
    if (selection.kind === "room" && selection.paintType !== undefined) {
      const paint = document.createElement("button");
      paint.type = "button";
      paint.className = "fi-primary";
      paint.textContent = "Paint this room type";
      paint.addEventListener("click", () => this.actions.paintRoom(selection.paintType!));
      actionRow.appendChild(paint);
    }
    if (contextualRoom && this.actions.assignGuard && this.actions.removeGuard) {
      const assign = document.createElement("button");
      assign.type = "button";
      assign.textContent = "Assign guard";
      assign.disabled = !contextualRoom.operational;
      assign.addEventListener("click", () => this.actions.assignGuard?.(contextualRoom.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove guard";
      remove.disabled = (contextualRoom.guards ?? 0) <= 0;
      remove.addEventListener("click", () => this.actions.removeGuard?.(contextualRoom.id));
      actionRow.append(assign, remove);
    }
    if (actionRow.childElementCount) this.body.appendChild(actionRow);
  }

  clear(): void {
    this.lastSignature = "";
    this.element.classList.remove("is-open");
    this.heading.replaceChildren();
    this.body.replaceChildren();
  }

  private addSection(titleText: string, values: string[]): void {
    const section = document.createElement("section");
    section.className = "fi-section";
    const title = document.createElement("h3");
    title.textContent = titleText;
    const list = document.createElement("ul");
    values.forEach((value) => {
      const row = document.createElement("li");
      row.textContent = value;
      list.appendChild(row);
    });
    section.append(title, list);
    this.body.appendChild(section);
  }
}
