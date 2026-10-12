import "./institutionalDashboard.css";

const retainedAreaQueries = new WeakMap<HTMLElement, string>();

/** Improve mobile Financials layout and make late-game structural-area controls searchable. */
export function annotateInstitutionalDashboard(dashboard: HTMLElement): void {
  if (dashboard.id === "financialsDashboard") {
    dashboard.classList.add("financials-mobile");
    return;
  }
  if (dashboard.id !== "logisticsDashboard") return;

  const tab = dashboard.querySelector<HTMLElement>(".dash-tab.on")?.textContent?.trim().toLocaleLowerCase();
  if (tab !== "deployment" && tab !== "access") return;
  const matrix = dashboard.querySelector<HTMLElement>(".matrix");
  if (!matrix) return;

  const existing = dashboard.querySelector<HTMLInputElement>(".area-filter-search");
  const query = existing?.value ?? retainedAreaQueries.get(dashboard) ?? "";
  existing?.remove();
  const controls = document.createElement("div");
  controls.className = "area-filter-controls";
  const search = document.createElement("input");
  search.className = "area-filter-search";
  search.type = "search";
  search.value = query;
  search.placeholder = "Find an area by number or type";
  search.setAttribute("aria-label", `Filter ${tab} settings by area number or type`);
  const count = document.createElement("span");
  count.className = "area-filter-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  controls.append(search, count);
  matrix.before(controls);

  const rows = [...matrix.querySelectorAll<HTMLElement>(".matrix-row")];
  for (const row of rows) {
    const area = row.querySelector("header strong")?.textContent?.trim() ?? "Area";
    row.querySelectorAll<HTMLButtonElement>("button[data-deploy]").forEach((button) => {
      const [, role = "staff", delta = "0"] = (button.dataset.deploy ?? "").split(":");
      const direction = Number(delta) < 0 ? "reduce" : "increase";
      button.setAttribute("aria-label", `${direction} ${role.replaceAll("-", " ")} target in ${area}`);
      button.title = `${direction === "reduce" ? "Reduce" : "Increase"} ${role.replaceAll("-", " ")} staffing target in ${area}`;
    });
    row.querySelectorAll<HTMLInputElement>("input[data-area-mixed]").forEach((input) => {
      input.setAttribute("aria-label", `Allow mixed custody classes in ${area}`);
    });
    row.querySelectorAll<HTMLInputElement>("input[data-area-custody]").forEach((input) => {
      const [, custody = ""] = (input.dataset.areaCustody ?? "").split(":");
      input.setAttribute("aria-label", `Allow ${custody} custody in ${area}`);
    });
    row.querySelectorAll<HTMLInputElement>("input[data-area-role]").forEach((input) => {
      const [, role = ""] = (input.dataset.areaRole ?? "").split(":");
      input.setAttribute("aria-label", `Allow ${role.replaceAll("-", " ")} access in ${area}`);
    });
  }

  const apply = () => {
    const needle = search.value.trim().toLocaleLowerCase();
    retainedAreaQueries.set(dashboard, search.value);
    let visible = 0;
    for (const row of rows) {
      const matches = !needle || (row.textContent ?? "").toLocaleLowerCase().includes(needle);
      row.hidden = !matches;
      if (matches) visible++;
    }
    count.textContent = needle ? `${visible} of ${rows.length} areas` : `${rows.length} areas`;
    matrix.dataset.noMatches = String(rows.length > 0 && visible === 0);
  };
  search.addEventListener("input", apply);
  apply();
}
