export type ProblemSeverity = "info" | "warning" | "critical";
export type ProblemAction =
  | { kind: "center"; label: string }
  | { kind: "catalog"; label: string; mode: string; section: string }
  | { kind: "order"; label: string; orderId: number };

export interface Problem {
  id: string;
  severity: ProblemSeverity;
  source: "construction" | "room" | "logistics" | "intake" | "staff" | "kitchen" | "work";
  message: string;
  x: number;
  z: number;
  actions: ProblemAction[];
}

export class ProblemRegistry {
  private readonly rows = new Map<string, Problem>();

  clear(): void { this.rows.clear(); }

  add(problem: Problem): void {
    const prior = this.rows.get(problem.id);
    if (!prior || this.rank(problem.severity) >= this.rank(prior.severity)) this.rows.set(problem.id, problem);
  }

  list(): Problem[] {
    return [...this.rows.values()].sort((a, b) =>
      this.rank(b.severity) - this.rank(a.severity) ||
      a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  }

  private rank(severity: ProblemSeverity): number {
    return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
  }
}
