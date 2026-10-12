import assert from "node:assert/strict";
import { catalogSnapshot } from "../src/editor.ts";
import { collectServiceProblems } from "../src/sim/serviceProblems.ts";
import type { BuildOrderGroup } from "../src/sim/construction.ts";

const group: BuildOrderGroup = {
  id: 17,
  operation: "build",
  createdAt: 1,
  state: "waiting-resources",
  blocker: "Waiting for delivered materials",
  targets: [{
    id: 31, x: 42, z: 58, cat: "piece", mat: 100, orient: 0,
    recipe: { concrete: 8, metal: 4 }, delivered: { concrete: 2 }, workSeconds: 8,
    completed: false, claimedBy: -1, progress: 0, blocker: "", state: "awaiting-materials", blockerDetail: null,
  }],
};
const warnings = {
  security: ["Fatigued staff have no valid Staff Room", "Solitary order for inmate 8 is waiting for a free Solitary Cell",
    "Security dogs need a valid Kennel", "A response deployment in area 2 is short by 1"],
  market: ["Shop till cash is waiting for a Payroll Safe", "Inbound mail is waiting for an active Mail Room worker",
    "The physical contraband market is heavily supplied"],
  gangs: ["Staff intelligence indicates 2 active inmate gangs; unidentified members remain uncertain"],
  health: ["Treatment is blocked by missing bandages", "A concealed body is producing a detectable odor"],
  work: ["Contract output is waiting for a valid Exports room", "Laundry is waiting for supervision"],
  facility: ["A Gatehouse is unmanned; vehicles are leaving unchecked"],
  management: ["Chief Officer has no unclaimed valid Management Office"],
};
const problems = collectServiceProblems({
  ...warnings,
  constructionGroups: [group, group],
  stock: {
    available: (id) => id === "concrete" ? 2 : 0,
    incoming: (id) => id === "concrete" ? 1 : 0,
  },
});
const byMessage = (fragment: string) => problems.find((problem) => problem.message.includes(fragment));
const action = (fragment: string) => byMessage(fragment)?.actions[0];

assert.equal(problems.filter((problem) => problem.id === "construction-17").length, 1, "one material row per waiting order");
assert.match(byMessage("Order 17")?.message ?? "", /Concrete × 6 \(2 available, 1 incoming; 3 still unaccounted for\)/);
assert.match(byMessage("Order 17")?.message ?? "", /Metal × 4 \(0 available, 0 incoming; 4 still unaccounted for\)/);
assert.deepEqual(action("Payroll Safe"), { kind: "catalog", label: "Place a Payroll Safe", mode: "objects", section: "objects:office" });
assert.deepEqual(action("Solitary order"), { kind: "catalog", label: "Build a Solitary Cell", mode: "rooms", section: "rooms:utility" });
assert.deepEqual(action("active inmate gangs"), { kind: "mode", label: "Review intelligence", mode: "intelligence" });
assert.deepEqual(action("Exports room"), { kind: "catalog", label: "Build an Exports room", mode: "rooms", section: "rooms:logistics" });
assert.ok(!problems.some((problem) => /contraband market|concealed body/i.test(problem.message)), "hidden state isn't surfaced as an operational alert");
const validSections = new Set(catalogSnapshot().map((row) => row.section));
for (const problem of problems) for (const row of problem.actions) {
  if (row.kind === "catalog") assert.ok(validSections.has(row.section as never), `catalog action points to live section: ${row.section}`);
}
console.log(`Service problems mapped ${problems.length} unique warnings/orders to verified actions.`);
