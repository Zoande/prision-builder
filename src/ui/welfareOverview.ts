import "./welfareOverview.css";

export interface WelfareNeedAction {
  mode: string;
  section: string;
  label: string;
}

export interface WelfareNeedSummary {
  id: string;
  label: string;
  affected: number;
  urgent: number;
  action?: WelfareNeedAction;
}

export interface WelfareResidentConcern {
  id: number;
  name: string;
  need: string;
  percent: number;
  detail: string;
}

export interface WelfareOverviewData {
  population: number;
  needs: readonly WelfareNeedSummary[];
  concerns: readonly WelfareResidentConcern[];
}

export interface WelfareOverviewActions {
  selectResident(id: number): void;
  openCatalog(mode: string, section: string): void;
}

/** Prison-wide, public welfare trends with direct links to affected residents
 * and their relevant facility category. Hidden plans are deliberately absent. */
export class WelfareOverview {
  readonly element: HTMLElement;
  private readonly actions: WelfareOverviewActions;
  private signature = "";

  constructor(actions: WelfareOverviewActions, host: HTMLElement = document.body) {
    this.actions = actions;
    this.element = document.createElement("section");
    this.element.className = "welfare-overview";
    this.element.setAttribute("aria-label", "Prison-wide welfare overview");
    host.appendChild(this.element);
  }

  update(data: WelfareOverviewData): void {
    const safeCount = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const population = safeCount(data.population);
    const needs = data.needs.map((row) => {
      const affected = safeCount(row.affected);
      return { ...row, affected, urgent: Math.min(affected, safeCount(row.urgent)) };
    });
    const concerns = data.concerns.map((row) => ({
      ...row,
      percent: Number.isFinite(row.percent) ? Math.max(0, Math.min(100, row.percent)) : 0,
    }));
    const signature = JSON.stringify({ population, needs, concerns });
    if (signature === this.signature) return;
    this.signature = signature;
    const lowRows = needs.filter((row) => row.affected > 0)
      .sort((a, b) => b.urgent - a.urgent || b.affected - a.affected || a.label.localeCompare(b.label));
    const topConcerns = [...concerns].sort((a, b) => a.percent - b.percent || a.id - b.id).slice(0, 6);
    this.element.replaceChildren();

    const header = document.createElement("header");
    const titles = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "wo-eyebrow";
    eyebrow.textContent = "Public welfare";
    const title = document.createElement("h2");
    title.textContent = "Resident needs";
    titles.append(eyebrow, title);
    const count = document.createElement("span");
    count.className = "wo-population";
    count.textContent = `${population} residents`;
    header.append(titles, count);
    this.element.appendChild(header);

    if (!lowRows.length && !concerns.length) {
      const empty = document.createElement("p");
      empty.className = "wo-empty";
      empty.textContent = population ? "No current needs require attention." : "No residents to assess yet.";
      this.element.appendChild(empty);
      return;
    }

    const summaries = document.createElement("div");
    summaries.className = "wo-needs";
    for (const row of lowRows) {
      const item = document.createElement("article");
      item.className = "wo-need";
      item.dataset.urgent = String(row.urgent > 0);
      const label = document.createElement("strong");
      label.textContent = row.label;
      const stats = document.createElement("span");
      stats.textContent = `${row.affected} affected${row.urgent ? ` · ${row.urgent} urgent` : ""}`;
      item.append(label, stats);
      if (row.action) {
        const action = document.createElement("button");
        action.type = "button";
        action.textContent = row.action.label;
        action.setAttribute("aria-label", `${row.action.label} to address ${row.label.toLowerCase()} needs`);
        action.addEventListener("click", () => this.actions.openCatalog(row.action!.mode, row.action!.section));
        item.appendChild(action);
      }
      summaries.appendChild(item);
    }
    this.element.appendChild(summaries);

    if (topConcerns.length) {
      const concernSection = document.createElement("div");
      concernSection.className = "wo-concerns";
      const subhead = document.createElement("h3");
      subhead.textContent = "Residents needing a check";
      concernSection.appendChild(subhead);
      for (const concern of topConcerns) {
        const button = document.createElement("button");
        button.className = "wo-concern";
        button.type = "button";
        button.setAttribute("aria-label", `${concern.name}: ${concern.need} ${Math.round(concern.percent)} percent. ${concern.detail}. Select resident.`);
        const name = document.createElement("strong");
        name.textContent = concern.name;
        const detail = document.createElement("span");
        detail.textContent = `${concern.need} · ${Math.round(concern.percent)}% · ${concern.detail}`;
        button.append(name, detail);
        button.addEventListener("click", () => this.actions.selectResident(concern.id));
        concernSection.appendChild(button);
      }
      this.element.appendChild(concernSection);
    }
  }
}
