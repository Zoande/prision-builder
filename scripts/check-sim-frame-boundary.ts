import assert from "node:assert/strict";
import { createSimulationFrameBoundary } from "../src/sim/frameBoundary.ts";

const boundary = createSimulationFrameBoundary();
assert.deepEqual(boundary.advance(() => 42), { kind: "advanced", value: 42 });
assert.equal(boundary.failure, undefined);

const failure = new Error("Unknown commodity: box62");
let advancesAfterFailure = 0;
assert.deepEqual(boundary.advance(() => { throw failure; }), { kind: "faulted", error: failure });
assert.equal(boundary.failure, failure);
assert.deepEqual(boundary.advance(() => { advancesAfterFailure++; return 43; }), { kind: "faulted", error: failure });
assert.equal(advancesAfterFailure, 0, "a failed simulation is never retried in the same session");

console.log("Simulation frame boundary latches the original error and blocks retry.");
