import { HOUR_SECONDS, dayOf, hourOf } from "./time.ts";
import { Obj } from "./objects.ts";

export type LedgerKind = "grant" | "wage" | "work-wage" | "work" | "shop" | "medical" | "security" |
  "purchase" | "loss" | "fee" | "export" | "interest" | "hire";

export interface LedgerEntry {
  id: number;
  time: number;
  kind: LedgerKind;
  amount: number;
  memo: string;
  mandatory: boolean;
}

const WAGES = new Map<number, number>([
  [Obj.Guard, 8], [Obj.Cook, 6], [Obj.Workman, 6], [Obj.Sniper, 12],
  [Obj.Doctor, 14], [Obj.Investigator, 10], [Obj.DogHandler, 10], [Obj.ArmedGuard, 16],
  [Obj.ChiefOfficer, 24], [Obj.Foreman, 18], [Obj.Accountant, 18],
]);
const HIRE_FEES = new Map<number, number>([
  [Obj.Guard, 500], [Obj.Cook, 400], [Obj.Workman, 400],
  [Obj.Doctor, 800], [Obj.Investigator, 700], [Obj.DogHandler, 700], [Obj.ArmedGuard, 1200],
  [Obj.SecurityDog, 750],
  [Obj.ChiefOfficer, 2000], [Obj.Foreman, 1400], [Obj.Accountant, 1400],
]);

export class EconomySystem {
  cash = 20_000;
  private nextLedgerId = 1;
  readonly ledger: LedgerEntry[] = [];
  private lastWageHour = -1;
  private lastInterestDay = -1;
  private processedPrisoners = 0;

  get performanceMultiplier(): number {
    if (this.cash >= 0) return 1;
    if (this.cash >= -5_000) return 0.9;
    if (this.cash >= -10_000) return 0.75;
    return 0.6;
  }

  canAfford(amount: number): boolean { return this.cash >= amount; }

  post(time: number, kind: LedgerKind, amount: number, memo: string, mandatory = false): boolean {
    if (!mandatory && amount < 0 && this.cash + amount < 0) return false;
    this.cash += amount;
    this.ledger.push({ id: this.nextLedgerId++, time, kind, amount, memo, mandatory });
    if (this.ledger.length > 1000) this.ledger.splice(0, this.ledger.length - 1000);
    return true;
  }

  hire(kind: number, time: number): boolean {
    const fee = HIRE_FEES.get(kind) ?? 0;
    return fee === 0 || this.post(time, "hire", -fee, `Hired ${staffName(kind)}`);
  }

  markPrisonerProcessed(): void { this.processedPrisoners++; }

  tick(worldTime: number, staffCounts: ReadonlyMap<number, number>): void {
    const hourStamp = Math.floor(worldTime / HOUR_SECONDS);
    if (hourStamp !== this.lastWageHour) {
      this.lastWageHour = hourStamp;
      let wages = 0;
      for (const [kind, rate] of WAGES) wages += rate * (staffCounts.get(kind) ?? 0);
      if (wages > 0) this.post(worldTime, "wage", -wages, "Hourly staff payroll", true);
      if (this.processedPrisoners > 0) {
        this.post(worldTime, "grant", this.processedPrisoners * 12, "Prisoner housing grant", true);
      }
    }
    const day = dayOf(worldTime);
    if (Math.floor(hourOf(worldTime)) === 0 && day !== this.lastInterestDay) {
      this.lastInterestDay = day;
      if (this.cash < 0) {
        const interest = Math.max(1, Math.ceil(-this.cash * 0.01));
        this.post(worldTime, "interest", -interest, "Midnight debt interest", true);
      }
    }
  }

  netForLastGameDay(worldTime: number): number {
    const since = worldTime - HOUR_SECONDS * 24;
    return this.ledger.filter((e) => e.time >= since).reduce((sum, e) => sum + e.amount, 0);
  }

  netHourly(): number {
    const wages = [...WAGES].reduce((sum, [kind, rate]) => sum + rate * (this.lastStaffCounts.get(kind) ?? 0), 0);
    return this.processedPrisoners * 12 - wages;
  }

  private lastStaffCounts = new Map<number, number>();
  setStaffCounts(counts: ReadonlyMap<number, number>): void { this.lastStaffCounts = new Map(counts); }

  saveData() {
    return {
      cash: this.cash, nextLedgerId: this.nextLedgerId, ledger: this.ledger,
      lastWageHour: this.lastWageHour, lastInterestDay: this.lastInterestDay,
      processedPrisoners: this.processedPrisoners,
    };
  }

  loadData(data: Partial<ReturnType<EconomySystem["saveData"]>>): void {
    this.cash = data.cash ?? 20_000;
    this.nextLedgerId = data.nextLedgerId ?? 1;
    this.ledger.length = 0;
    this.ledger.push(...(data.ledger ?? []));
    this.lastWageHour = data.lastWageHour ?? -1;
    this.lastInterestDay = data.lastInterestDay ?? -1;
    this.processedPrisoners = data.processedPrisoners ?? 0;
  }
}

function staffName(kind: number): string {
  if (kind === Obj.Guard) return "guard";
  if (kind === Obj.Cook) return "cook";
  if (kind === Obj.Workman) return "workman";
  if (kind === Obj.Doctor) return "doctor";
  if (kind === Obj.Investigator) return "investigator";
  if (kind === Obj.DogHandler) return "dog handler";
  if (kind === Obj.ArmedGuard) return "armed guard";
  if (kind === Obj.ChiefOfficer) return "chief officer";
  if (kind === Obj.Foreman) return "foreman";
  if (kind === Obj.Accountant) return "accountant";
  if (kind === Obj.SecurityDog) return "security dog";
  return "staff member";
}
