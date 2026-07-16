export const HOUR_SECONDS = 30;
export const DAY_SECONDS_TOTAL = HOUR_SECONDS * 24;

export function hourOf(timeSec: number): number { return (timeSec / HOUR_SECONDS) % 24; }
export function dayOf(timeSec: number): number { return Math.floor(timeSec / DAY_SECONDS_TOTAL) + 1; }
