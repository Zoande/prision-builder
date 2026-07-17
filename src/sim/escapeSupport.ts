import type { Agent } from "./agent.ts";
import type { CombatSystem } from "./combat.ts";
import type { EscapeOperationsSystem } from "./escapeOperations.ts";
import { Item, countItem, stow } from "./items.ts";
import type { ItemSystem } from "./itemSystem.ts";
import { Obj } from "./objects.ts";
import { personality } from "./profiles.ts";

export class EscapeSupportSystem {
  private readonly items: ItemSystem;
  private readonly combat: CombatSystem;
  constructor(items: ItemSystem, combat: CombatSystem) { this.items = items; this.combat = combat; }

  tick(time: number, agents: readonly Agent[], operations: EscapeOperationsSystem): void {
    for (const op of operations.operations.values()) {
      if (["completed", "failed", "dissolved"].includes(op.state)) continue;
      if (op.acquisition) {
        const held = this.findAsset(op.acquisition.asset, op.members.map((m) => m.agentId));
        if (held) {
          op.acquisition.state = "acquired"; op.acquisition.holderId = held.owner; op.acquisition.itemId = held.itemId;
          const holder = agents.find((a) => a.id === held.owner);
          if (holder && ["cutter", "hacksaw-blade", "pruning-shears"].includes(op.acquisition.asset) && countItem(holder.inv, Item.Cutter) === 0) stow(holder.inv, Item.Cutter);
          if (holder && ["spoon", "trowel", "shovel"].includes(op.acquisition.asset) && countItem(holder.inv, Item.Spoon) === 0) stow(holder.inv, Item.Spoon);
          if (op.acquisition.asset === "radio" && ["rallying", "executing"].includes(op.state)) {
            // A stolen radio can support one simple misleading transmission in
            // Task 2; it lowers exposure but does not fabricate a route or alarm.
            op.exposure = Math.max(0, op.exposure - .002);
          }
        } else if (op.acquisition.state === "acquired") {
          op.acquisition.state = "lost"; op.blocker = `The operation lost its ${op.acquisition.asset}`;
        }
      }
      if (op.members.length >= 3 && !op.distraction.planned) {
        const candidates = op.members.map((m) => agents.find((a) => a.id === m.agentId)).filter((a): a is Agent => !!a);
        const instigator = candidates.sort((a, b) => this.distractionScore(b) - this.distractionScore(a))[0];
        if (instigator && this.distractionScore(instigator) > .9) {
          op.distraction = { planned: true, instigatorId: instigator.id, state: "pending", engagementId: -1 };
        }
      }
      if (op.distraction.planned && op.distraction.state === "pending" && op.state === "rallying" && op.launchAt - time <= 5) {
        const instigator = agents.find((a) => a.id === op.distraction.instigatorId);
        const target = instigator && agents.find((a) => a.id !== instigator.id && !op.members.some((m) => m.agentId === a.id) &&
          [Obj.Prisoner, Obj.Guard].includes(a.kind as never) && Math.hypot(a.x - instigator.x, a.z - instigator.z) < 2.5);
        if (instigator && target) {
          const engagement = this.combat.start(instigator, target, time, true);
          if (engagement) { op.distraction.state = "active"; op.distraction.engagementId = engagement.id; }
        }
      }
      if (op.distraction.state === "active" && this.combat.engagements.get(op.distraction.engagementId)?.state !== "active") op.distraction.state = "complete";
    }
  }

  private findAsset(asset: string, members: number[]): { owner: number; itemId: number } | null {
    for (const owner of members) for (const suffix of ["hands", "pockets", "worn"]) {
      const item = this.items.itemsIn(`agent:${owner}:${suffix}`).find((i) => i.defId === asset);
      if (item) return { owner, itemId: item.id };
    }
    return null;
  }
  private distractionScore(agent: Agent): number { return Math.max(0, personality(agent.profile, "aggression")) +
    Math.max(0, personality(agent.profile, "impulsivity")) * .7 + Math.max(0, personality(agent.profile, "loyalty")) * .3; }
}
