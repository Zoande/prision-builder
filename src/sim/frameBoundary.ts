export type SimulationFrameResult<T> =
  | { kind: "advanced"; value: T }
  | { kind: "faulted"; error: unknown };

/**
 * Runs simulation advances until one fails, then permanently blocks further
 * advances for this game session. The caller owns pausing controls and making
 * the captured error visible; the original thrown value is preserved.
 */
export function createSimulationFrameBoundary() {
  let failed = false;
  let failure: unknown;

  return {
    get failure(): unknown | undefined {
      return failed ? failure : undefined;
    },

    advance<T>(step: () => T): SimulationFrameResult<T> {
      if (failed) return { kind: "faulted", error: failure };

      try {
        return { kind: "advanced", value: step() };
      } catch (error) {
        failed = true;
        failure = error;
        return { kind: "faulted", error };
      }
    },
  };
}
