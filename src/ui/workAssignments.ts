import "./workAssignments.css";

const retainedQueries = new WeakMap<HTMLElement, string>();

/** Add a retained search filter to the late-game inmate work assignment list.
 * Safe to call after each dashboard render; existing row controls are untouched. */
export function annotateWorkAssignments(dashboard: HTMLElement): void {
  const section = [...dashboard.querySelectorAll<HTMLElement>(".profile-section")]
    .find((row) => row.querySelector("h3")?.textContent?.trim() === "Inmate assignments");
  const matrix = section?.querySelector<HTMLElement>(".matrix");
  if (!section || !matrix) return;
  const existing = section.querySelector<HTMLInputElement>(".work-assignment-search");
  const query = existing?.value ?? retainedQueries.get(dashboard) ?? "";
  existing?.remove();

  const controls = document.createElement("div");
  controls.className = "work-assignment-controls";
  const search = document.createElement("input");
  search.className = "work-assignment-search";
  search.type = "search";
  search.value = query;
  search.placeholder = "Find an inmate or current program";
  search.setAttribute("aria-label", "Filter inmate work assignments by name, custody, or current program");
  const count = document.createElement("span");
  count.className = "work-assignment-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  controls.append(search, count);
  matrix.before(controls);

  const rows = [...matrix.querySelectorAll<HTMLElement>(".matrix-row")];
  const apply = () => {
    const needle = search.value.trim().toLocaleLowerCase();
    retainedQueries.set(dashboard, search.value);
    let visible = 0;
    for (const row of rows) {
      const heading = row.querySelector("header")?.textContent ?? "";
      const select = row.querySelector<HTMLSelectElement>("select[data-work-agent]");
      const currentProgram = select?.selectedOptions[0]?.textContent ?? "";
      const matches = !needle || `${heading} ${currentProgram}`.toLocaleLowerCase().includes(needle);
      row.hidden = !matches;
      if (matches) visible++;
    }
    count.textContent = needle ? `${visible} of ${rows.length} inmates` : `${rows.length} inmates`;
    matrix.dataset.noMatches = String(rows.length > 0 && visible === 0);
  };
  search.addEventListener("input", apply);
  apply();
}
