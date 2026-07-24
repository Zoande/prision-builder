export const SAVE_VERSION = 6;

export interface SaveEnvelopeV6 {
  version: typeof SAVE_VERSION;
  savedAt: string;
  worldTime: number;
  // The owning systems validate their own payloads. `any` here keeps this
  // envelope guard from pretending it knows every subsystem's evolving shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  world: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  infrastructure: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  economy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logistics: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  construction: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  kitchen: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intake: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task2: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task3: any;
}

export function isSaveV6(value: unknown): value is SaveEnvelopeV6 {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SaveEnvelopeV6>;
  return row.version === SAVE_VERSION && !!row.world && !!row.agents && !!row.task2 && !!row.task3;
}
