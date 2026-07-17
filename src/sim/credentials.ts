import type { Agent } from "./agent.ts";
import type { ItemSystem } from "./itemSystem.ts";

export type CredentialKind = "staff-id" | "visitor-pass" | "movement-pass" | "manifest" | "staff-key" | "guard-key";
export interface CredentialRecord {
  itemId: number;
  kind: CredentialKind;
  issuedTo: number;
  forged: boolean;
  quality: number;
  validFrom: number;
  validUntil: number;
  sourceItemId: number;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/** Physical credentials remain ordinary ItemSystem objects; this registry owns
 * their authorization and provenance without making the generic item schema
 * know about doors, visitors, or manifests. */
export class CredentialSystem {
  readonly credentials = new Map<number, CredentialRecord>();
  private readonly items: ItemSystem;

  constructor(items: ItemSystem) { this.items = items; }

  ensureStaffIdentity(agent: Agent, time: number): number {
    const equipment = `agent:${agent.id}:equipment`;
    const existing = this.items.itemsIn(equipment).find((item) => item.defId === "staff-id");
    if (existing) {
      if (!this.credentials.has(existing.id)) this.credentials.set(existing.id, this.record(existing.id, "staff-id", agent.id, false, 1, time, Number.MAX_SAFE_INTEGER));
      return existing.id;
    }
    const item = this.items.create("staff-id", time, { ownerId: agent.id, issuedTo: agent.id });
    this.items.moveToContainer(item.id, equipment, time, agent.id);
    this.items.issue(item.id, agent.id, time);
    this.credentials.set(item.id, this.record(item.id, "staff-id", agent.id, false, 1, time, Number.MAX_SAFE_INTEGER));
    return item.id;
  }

  register(itemId: number, kind: CredentialKind, issuedTo: number, forged: boolean,
    quality: number, validFrom: number, validUntil: number, sourceItemId = -1): CredentialRecord {
    const row = this.record(itemId, kind, issuedTo, forged, quality, validFrom, validUntil, sourceItemId);
    this.credentials.set(itemId, row);
    return row;
  }

  forge(kind: CredentialKind, ownerId: number, quality: number, time: number, sourceItemId = -1): number {
    const defId = kind === "staff-key" ? "duplicate-staff-key" : kind === "guard-key" ? "duplicate-guard-key" :
      kind === "visitor-pass" ? "visitor-pass" : kind === "manifest" ? "delivery-manifest" : "forged-pass";
    const item = this.items.create(defId, time, { ownerId, quality: clamp(quality, .08, .98) });
    this.items.moveToContainer(item.id, `agent:${ownerId}:pockets`, time, ownerId, true);
    this.register(item.id, kind, ownerId, true, quality, time, time + 30 * 24, sourceItemId);
    return item.id;
  }

  credentialFor(itemId: number, time: number): CredentialRecord | null {
    const row = this.credentials.get(itemId);
    return row && row.validFrom <= time && row.validUntil >= time ? row : null;
  }

  carried(agentId: number, time: number): CredentialRecord[] {
    const ids = ["hands", "pockets", "worn", "equipment"].flatMap((suffix) => this.items.itemsIn(`agent:${agentId}:${suffix}`).map((item) => item.id));
    return ids.map((id) => this.credentialFor(id, time)).filter((row): row is CredentialRecord => !!row);
  }

  keyTier(agentId: number, time: number): 0 | 1 | 2 {
    const physical = ["hands", "pockets", "worn"].flatMap((suffix) => this.items.itemsIn(`agent:${agentId}:${suffix}`));
    if (physical.some((item) => item.defId === "guard-key" || item.defId === "duplicate-guard-key")) return 2;
    if (physical.some((item) => item.defId === "staff-key" || item.defId === "duplicate-staff-key")) return 1;
    const rows = this.carried(agentId, time);
    return rows.some((row) => row.kind === "guard-key") ? 2 : rows.some((row) => row.kind === "staff-key") ? 1 : 0;
  }

  bestPresentation(agentId: number, kind: CredentialKind, time: number): CredentialRecord | null {
    return this.carried(agentId, time).filter((row) => row.kind === kind)
      .sort((a, b) => b.quality - a.quality || a.itemId - b.itemId)[0] ?? null;
  }

  invalidate(itemId: number): void {
    const row = this.credentials.get(itemId);
    if (row) row.validUntil = -1;
  }

  removeItem(itemId: number): void { this.credentials.delete(itemId); }

  saveData() { return { credentials: [...this.credentials.values()].map((row) => ({ ...row })) }; }
  loadData(data: Partial<ReturnType<CredentialSystem["saveData"]>>): void {
    this.credentials.clear();
    for (const row of data.credentials ?? []) this.credentials.set(row.itemId, { ...row });
  }

  private record(itemId: number, kind: CredentialKind, issuedTo: number, forged: boolean,
    quality: number, validFrom: number, validUntil: number, sourceItemId = -1): CredentialRecord {
    return { itemId, kind, issuedTo, forged, quality: clamp(quality), validFrom, validUntil, sourceItemId };
  }
}
