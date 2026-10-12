import "./staffRoster.css";

export interface StaffRosterRow {
  id: number;
  name: string;
  role: string;
  currentState: string;
  assignment?: string;
  /** Fatigue percent, from 0 (rested) to 100 (fully fatigued). */
  fatiguePercent: number;
  onBreak: boolean;
  /** A public staffing summary, such as "Fit for duty" or "Injured". */
  medicalStatus?: string;
}

export interface StaffRosterActions {
  select(id: number): void;
  hire(): void;
  close?(): void;
}

interface RosterEntry {
  button: HTMLButtonElement;
  name: HTMLElement;
  role: HTMLElement;
  state: HTMLElement;
  assignment: HTMLElement;
  fatigue: HTMLElement;
  fatigueBar: HTMLElement;
  badges: HTMLElement;
  signature: string;
  row: StaffRosterRow;
}

/** Searchable list of the current public workforce and their work status. */
export class StaffRoster {
  readonly element: HTMLElement;
  private readonly actions: StaffRosterActions;
  private readonly list: HTMLElement;
  private readonly queryInput: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly entries = new Map<number, RosterEntry>();
  private rows: StaffRosterRow[] = [];
  private query = "";
  private selectedId: number | null = null;

  constructor(actions: StaffRosterActions, host: HTMLElement = document.body) {
    this.actions = actions;
    this.element = document.createElement("aside");
    this.element.className = "staff-roster";
    this.element.setAttribute("aria-label", "Staff roster");
    this.element.setAttribute("aria-hidden", "true");

    const header = document.createElement("header");
    const titleGroup = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "sr-eyebrow";
    eyebrow.textContent = "Workforce";
    const title = document.createElement("h2");
    title.textContent = "Staff roster";
    titleGroup.append(eyebrow, title);
    const close = document.createElement("button");
    close.className = "sr-close";
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close staff roster");
    close.addEventListener("click", () => {
      this.setOpen(false);
      this.actions.close?.();
    });
    header.append(titleGroup, close);

    const controls = document.createElement("div");
    controls.className = "sr-controls";
    this.queryInput = document.createElement("input");
    this.queryInput.type = "search";
    this.queryInput.placeholder = "Search staff";
    this.queryInput.setAttribute("aria-label", "Search staff by name, role, state, or assignment");
    this.queryInput.addEventListener("input", () => {
      this.query = this.queryInput.value.trim().toLocaleLowerCase();
      this.renderVisibility();
    });
    const hire = document.createElement("button");
    hire.className = "sr-hire";
    hire.type = "button";
    hire.textContent = "Hire staff";
    hire.addEventListener("click", () => this.actions.hire());
    controls.append(this.queryInput, hire);

    this.count = document.createElement("div");
    this.count.className = "sr-count";
    this.count.setAttribute("role", "status");
    this.count.setAttribute("aria-live", "polite");
    this.list = document.createElement("div");
    this.list.className = "sr-list";
    this.list.setAttribute("aria-label", "Staff members");
    this.element.append(header, controls, this.count, this.list);
    host.appendChild(this.element);
  }

  update(rows: readonly StaffRosterRow[]): void {
    this.rows = [...rows];
    const currentIds = new Set<number>();
    for (const row of this.rows) {
      currentIds.add(row.id);
      let entry = this.entries.get(row.id);
      if (!entry) {
        entry = this.createEntry(row);
        this.entries.set(row.id, entry);
        this.list.appendChild(entry.button);
      }
      const signature = JSON.stringify(row);
      if (entry.signature !== signature) {
        entry.row = row;
        entry.signature = signature;
        entry.name.textContent = row.name;
        entry.role.textContent = row.role;
        entry.state.textContent = row.currentState || "Available";
        entry.assignment.textContent = row.assignment || "No assignment";
        const fatigue = Math.max(0, Math.min(100, Number.isFinite(row.fatiguePercent) ? row.fatiguePercent : 0));
        entry.fatigue.textContent = `${Math.round(fatigue)}%`;
        entry.fatigueBar.style.width = `${fatigue}%`;
        entry.fatigueBar.className = `sr-fatigue-fill ${fatigue >= 80 ? "is-high" : fatigue >= 55 ? "is-mid" : "is-low"}`;
        const badges: string[] = [];
        if (row.onBreak) badges.push("On break");
        if (row.medicalStatus) badges.push(row.medicalStatus);
        entry.badges.replaceChildren();
        for (const label of badges) {
          const badge = document.createElement("span");
          badge.className = `sr-badge ${/injur|medical|sick|unfit/i.test(label) ? "is-medical" : ""}`;
          badge.textContent = label;
          entry.badges.appendChild(badge);
        }
        entry.button.setAttribute("aria-label", `${row.name}, ${row.role}, ${row.currentState || "Available"}, ${row.assignment || "no assignment"}, fatigue ${Math.round(fatigue)} percent${row.onBreak ? ", on break" : ""}${row.medicalStatus ? `, ${row.medicalStatus}` : ""}`);
      }
      entry.button.classList.toggle("is-selected", row.id === this.selectedId);
    }
    for (const [id, entry] of this.entries) {
      if (currentIds.has(id)) continue;
      entry.button.remove();
      this.entries.delete(id);
    }
    // Reorder only when the roster order actually changes. Moving an already
    // focused row would interrupt keyboard selection on every live update.
    const desiredOrder = this.rows.map((row) => String(row.id));
    const currentOrder = [...this.list.children].map((child) => (child as HTMLElement).dataset.staffId ?? "");
    if (desiredOrder.length !== currentOrder.length || desiredOrder.some((id, index) => id !== currentOrder[index])) {
      for (const row of this.rows) {
        const entry = this.entries.get(row.id);
        if (entry) this.list.appendChild(entry.button);
      }
    }
    this.renderVisibility();
  }

  setOpen(open: boolean): void {
    this.element.classList.toggle("is-open", open);
    this.element.setAttribute("aria-hidden", String(!open));
  }

  setSelected(id: number | null): void {
    this.selectedId = id;
    for (const [entryId, entry] of this.entries) entry.button.classList.toggle("is-selected", entryId === id);
  }

  private createEntry(row: StaffRosterRow): RosterEntry {
    const button = document.createElement("button");
    button.className = "sr-entry";
    button.type = "button";
    button.dataset.staffId = String(row.id);
    button.addEventListener("click", () => {
      this.setSelected(row.id);
      this.actions.select(row.id);
    });
    const top = document.createElement("span");
    top.className = "sr-entry-top";
    const name = document.createElement("strong");
    name.className = "sr-name";
    const role = document.createElement("span");
    role.className = "sr-role";
    top.append(name, role);
    const state = document.createElement("span");
    state.className = "sr-state";
    const assignment = document.createElement("span");
    assignment.className = "sr-assignment";
    const fatigueLine = document.createElement("span");
    fatigueLine.className = "sr-fatigue-line";
    const fatigueLabel = document.createElement("span");
    fatigueLabel.className = "sr-fatigue-label";
    fatigueLabel.textContent = "Fatigue";
    const fatigue = document.createElement("strong");
    const track = document.createElement("span");
    track.className = "sr-fatigue-track";
    const fatigueBar = document.createElement("span");
    fatigueBar.className = "sr-fatigue-fill";
    track.appendChild(fatigueBar);
    fatigueLine.append(fatigueLabel, fatigue, track);
    const badges = document.createElement("span");
    badges.className = "sr-badges";
    button.append(top, state, assignment, fatigueLine, badges);
    return { button, name, role, state, assignment, fatigue, fatigueBar, badges, signature: "", row };
  }

  private renderVisibility(): void {
    let visible = 0;
    const needle = this.query;
    for (const row of this.rows) {
      const entry = this.entries.get(row.id);
      if (!entry) continue;
      const matches = !needle || `${row.name} ${row.role} ${row.currentState} ${row.assignment ?? ""} ${row.medicalStatus ?? ""}`
        .toLocaleLowerCase().includes(needle);
      entry.button.hidden = !matches;
      if (matches) visible++;
    }
    this.count.textContent = needle ? `${visible} of ${this.rows.length} staff` : `${this.rows.length} staff`;
    if (this.rows.length === 0) {
      this.list.dataset.empty = "true";
      this.list.setAttribute("aria-label", "No staff hired");
    } else if (visible === 0) {
      this.list.dataset.empty = "search";
      this.list.setAttribute("aria-label", "No staff match the search");
    } else {
      delete this.list.dataset.empty;
      this.list.setAttribute("aria-label", "Staff members");
    }
  }
}
