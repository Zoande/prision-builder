import { catalogSnapshot, type CatalogSectionId } from "../editor.ts";
import type { BuildOrderGroup } from "./construction.ts";
import { commodityDef } from "./commodities.ts";
import type { Problem, ProblemAction, ProblemSeverity } from "./problems.ts";

export interface ProblemStockView {
  available(commodity: string): number;
  incoming(commodity: string): number;
}

/** Inputs are the public warning sets already maintained by the simulation.
 * Keep this collector pure so each source is mapped once, without duplicating
 * the aggregate task2/task3 warning sets. */
export interface ServiceProblemInput {
  security?: Iterable<string>;
  market?: Iterable<string>;
  gangs?: Iterable<string>;
  health?: Iterable<string>;
  work?: Iterable<string>;
  facility?: Iterable<string>;
  management?: Iterable<string>;
  constructionGroups?: Iterable<BuildOrderGroup>;
  stock?: ProblemStockView;
}

const catalogSections = new Set<CatalogSectionId>(catalogSnapshot().map((item) => item.section));

function catalog(label: string, mode: string, section: CatalogSectionId): ProblemAction {
  if (!catalogSections.has(section)) throw new Error(`Unknown catalog section for problem action: ${section}`);
  return { kind: "catalog", label, mode, section };
}

function serviceLocation(source: Problem["source"], message: string): {
  severity: ProblemSeverity; actions: ProblemAction[];
} | null {
  if (source === "security") {
    if (/^Emergency active:/i.test(message)) return null;
    if (/critical security item|Armoury|emergency equipment|check out emergency equipment/i.test(message)) {
      return { severity: /critical security item/i.test(message) ? "critical" : "warning", actions: [catalog("Open security objects", "objects", "objects:security")] };
    }
    if (/Solitary order.*waiting for a free Solitary Cell/i.test(message)) {
      return { severity: "warning", actions: [catalog("Build a Solitary Cell", "rooms", "rooms:utility")] };
    }
    if (/Interview.*waiting for a valid Interview Room/i.test(message)) {
      return { severity: "warning", actions: [catalog("Build an Interview Room", "rooms", "rooms:staff")] };
    }
    if (/Kennel|Staff Room|valid free Morgue slab|free Infirmary medical bed|valid Infirmary/i.test(message)) {
      return { severity: "warning", actions: [catalog("Build staff facilities", "rooms", "rooms:staff")] };
    }
    if (/deployment in area .* is short by/i.test(message)) {
      return { severity: "warning", actions: [catalog("Assign guards", "staff", "staff:deploy")] };
    }
    if (/staff response route is blocked/i.test(message)) {
      return { severity: "warning", actions: [catalog("Review access", "rooms", "rooms:access")] };
    }
    return { severity: "warning", actions: [] };
  }

  if (source === "market") {
    // This is hidden simulation state rather than a staff-observed service fault.
    if (/physical contraband market is heavily supplied/i.test(message)) return null;
    if (/Payroll Safe/i.test(message)) {
      return { severity: "warning", actions: [catalog("Place a Payroll Safe", "objects", "objects:office")] };
    }
    if (/valid Mail Room/i.test(message)) {
      return { severity: "warning", actions: [catalog("Build a Mail Room", "rooms", "rooms:work")] };
    }
    if (/active Mail Room worker/i.test(message)) {
      return { severity: "warning", actions: [catalog("Hire Mail Room staff", "staff", "staff:people")] };
    }
    if (/Inbound mail is blocked/i.test(message)) {
      return { severity: "warning", actions: [
        catalog("Review work facilities", "rooms", "rooms:work"),
        catalog("Review work objects", "objects", "objects:work"),
      ] };
    }
    return { severity: "warning", actions: [] };
  }

  if (source === "gangs") {
    if (/Staff intelligence indicates .* active inmate gang/i.test(message)) {
      return { severity: "info", actions: [{ kind: "mode", label: "Review intelligence", mode: "intelligence" }] };
    }
    return { severity: "info", actions: [] };
  }

  if (source === "health") {
    if (/concealed body is producing a detectable odor/i.test(message)) return null;
    if (/waiting for a valid Infirmary|waiting for a free Infirmary/i.test(message)) {
      return { severity: "critical", actions: [catalog("Build an Infirmary", "rooms", "rooms:staff")] };
    }
    if (/waiting for a Doctor/i.test(message)) {
      return { severity: "critical", actions: [catalog("Hire a Doctor", "staff", "staff:people")] };
    }
    if (/missing bandages/i.test(message)) {
      return { severity: "critical", actions: [catalog("Review medical supplies", "objects", "objects:medical")] };
    }
    if (/cannot reach patient/i.test(message)) {
      return { severity: "warning", actions: [catalog("Review access", "rooms", "rooms:access")] };
    }
    return { severity: "warning", actions: [] };
  }

  if (source === "work") {
    if (/waiting for supervision/i.test(message)) {
      return { severity: "warning", actions: [catalog("Review work rooms", "rooms", "rooms:work"), catalog("Hire a foreman", "staff", "staff:people")] };
    }
    if (/Exports/i.test(message)) {
      return { severity: "warning", actions: [
        catalog("Build an Exports room", "rooms", "rooms:logistics"),
        catalog("Open logistics objects", "objects", "objects:logistics"),
      ] };
    }
    if (/cannot reach workplace/i.test(message)) {
      return { severity: "warning", actions: [catalog("Review access", "rooms", "rooms:access"), catalog("Review work rooms", "rooms", "rooms:work")] };
    }
    return { severity: "warning", actions: [] };
  }

  if (source === "facility" && /Gatehouse is unmanned/i.test(message)) {
    return { severity: "warning", actions: [catalog("Assign a guard", "staff", "staff:deploy")] };
  }
  if (source === "management") {
    if (/no unclaimed valid Management Office/i.test(message)) {
      return { severity: "warning", actions: [catalog("Build a Management Office", "rooms", "rooms:staff")] };
    }
    if (/management is required to run/i.test(message)) {
      return { severity: "warning", actions: [catalog("Hire management staff", "staff", "staff:people")] };
    }
    return { severity: "warning", actions: [] };
  }
  return null;
}

function stableId(source: string, text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `service-${source}-${(hash >>> 0).toString(36)}`;
}

function remainingRecipe(group: BuildOrderGroup): Map<string, number> {
  const totals = new Map<string, number>();
  for (const target of group.targets) {
    if (target.completed || target.state === "blocked" || target.state === "cancelled") continue;
    for (const [commodity, amount] of Object.entries(target.recipe)) {
      const remaining = Math.max(0, amount - (target.delivered[commodity] ?? 0));
      if (remaining > 0) totals.set(commodity, (totals.get(commodity) ?? 0) + remaining);
    }
  }
  return totals;
}

function commodityName(id: string): string {
  try { return commodityDef(id).name; } catch { return id.replace(/^box:/, "Boxed object "); }
}

function constructionProblems(groups: Iterable<BuildOrderGroup>, stock?: ProblemStockView): Problem[] {
  const rows: Problem[] = [];
  for (const group of [...groups].sort((a, b) => a.id - b.id)) {
    if (group.operation !== "build" || group.state !== "waiting-resources") continue;
    const recipe = remainingRecipe(group);
    if (!recipe.size) continue;
    const materialDetails = [...recipe.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, amount]) => {
      const available = Math.max(0, stock?.available(id) ?? 0);
      const incoming = Math.max(0, stock?.incoming(id) ?? 0);
      const shortage = Math.max(0, amount - available - incoming);
      const inventory = stock ? ` (${available} available, ${incoming} incoming${shortage ? `; ${shortage} still unaccounted for` : ""})` : "";
      return `${commodityName(id)} × ${amount}${inventory}`;
    });
    const first = group.targets.find((target) => !target.completed && target.state !== "blocked") ?? group.targets[0];
    rows.push({
      id: `construction-${group.id}`,
      severity: "warning",
      source: "construction",
      message: `Order ${group.id} is waiting for materials: ${materialDetails.join(", ")}.`,
      x: first?.x ?? 0,
      z: first?.z ?? 0,
      actions: [
        { kind: "order", label: "Open order", orderId: group.id },
        catalog("Open Logistics", "logistics", "objects:logistics"),
      ],
    });
  }
  return rows;
}

/** Convert service warnings and material-starved construction groups to
 * actionable, deduplicated problem rows. Catalog destinations are verified
 * against the editor's current live registry when actions are created. */
export function collectServiceProblems(input: ServiceProblemInput): Problem[] {
  const rows = new Map<string, Problem>();
  const warningSources: Array<[Problem["source"], Iterable<string> | undefined]> = [
    ["security", input.security], ["market", input.market], ["gangs", input.gangs],
    ["health", input.health], ["work", input.work], ["facility", input.facility], ["management", input.management],
  ];
  for (const [source, warnings] of warningSources) for (const message of warnings ?? []) {
    const mapped = serviceLocation(source, message);
    if (!mapped) continue;
    const id = stableId(source, message);
    rows.set(id, { id, source, message, severity: mapped.severity, x: 0, z: 0, actions: mapped.actions });
  }
  for (const problem of constructionProblems(input.constructionGroups ?? [], input.stock)) rows.set(problem.id, problem);
  return [...rows.values()].sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}
