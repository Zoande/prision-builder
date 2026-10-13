export interface ResidentCareAction {
  label: string;
  mode: string;
  section: string;
}

/** Public, observable care and custody facts for the selected resident.
 * Keep latent behavior and private plans out of this DTO. */
export interface ResidentCareFacts {
  state: string;
  housing: string;
  escort: string;
  medical: string;
  discipline: string;
  visit?: string;
  warnings: readonly string[];
  actions: readonly ResidentCareAction[];
}

const escapeHTML = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]!));

const display = (value: string): string => escapeHTML(value.trim() || "No current information");

/** Render a compact status summary for the selected resident's inspector and
 * Intelligence profile. Equal facts produce byte-for-byte equal markup. */
export function residentCareMarkup(facts: ResidentCareFacts): string {
  const fields: Array<[string, string]> = [
    ["Current state", facts.state],
    ["Housing", facts.housing],
    ["Escort", facts.escort],
    ["Medical", facts.medical],
    ["Discipline", facts.discipline],
  ];
  if (facts.visit) fields.push(["Family visit", facts.visit]);
  const warnings = facts.warnings.length
    ? `<ul class="resident-care-warnings" aria-label="Care and custody warnings">${facts.warnings.map((warning) => `<li>${display(warning)}</li>`).join("")}</ul>`
    : "";
  const actions = facts.actions.length
    ? `<div class="resident-care-actions">${facts.actions.map((action) =>
      `<button type="button" data-care-action="catalog" data-mode="${escapeHTML(action.mode)}" data-section="${escapeHTML(action.section)}">${display(action.label)}</button>`
    ).join("")}</div>`
    : "";
  return `<section class="resident-care" aria-label="Current care and custody status">` +
    `<div class="resident-care-grid">${fields.map(([label, value]) =>
      `<div class="resident-care-item"><small>${label}</small><strong>${display(value)}</strong></div>`
    ).join("")}</div>${warnings}${actions}</section>`;
}
