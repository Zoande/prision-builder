// Verify that a JSON save restores the shared RNG stream and that a fresh
// runtime can resume the same integrated prison simulation exactly.
import assert from "node:assert/strict";
import { Agents } from "../src/sim/agents.ts";
import { getRngState, rnd, seedRng, setRngState } from "../src/sim/rng.ts";
import { createPrison } from "./scenarios/prison.ts";

for (const invalid of [0, -1, 1.5, 0x1_0000_0000, Number.NaN])
  assert.throws(() => setRngState(invalid), RangeError, `reject invalid RNG state ${invalid}`);

seedRng(0x12345678);
for (let i = 0; i < 37; i++) rnd();
const agents = new Agents();
const savedAgents = JSON.parse(JSON.stringify(agents.saveData()));
const expectedState = getRngState();
const expectedSequence = Array.from({ length: 12 }, () => rnd());
const restoredAgents = new Agents();
restoredAgents.loadData(savedAgents);
assert.equal(getRngState(), expectedState, "agent save must retain the current global RNG state");
assert.deepEqual(Array.from({ length: 12 }, () => rnd()), expectedSequence,
  "JSON roundtrip must resume the exact random sequence");

const source = createPrison(24680, 2);
source.advance(1);
const checkpoint = JSON.parse(JSON.stringify(source.snapshot()));
const streamState = checkpoint.agents.rngState as number;
setRngState(streamState);
const expectedContinuation = Array.from({ length: 12 }, () => rnd());

// Construct another live runtime first, then restore the source save into it.
// This catches restore paths that accidentally keep the new game's RNG stream.
const resumed = createPrison(97531, 2);
resumed.restore(checkpoint);
assert.equal(getRngState(), streamState, "scenario restore must reinstate the saved global stream");
assert.deepEqual(Array.from({ length: 12 }, () => rnd()), expectedContinuation,
  "a fresh integrated runtime must continue the exact sequence after JSON restore");

console.log("Shared RNG state and integrated save/load continuation: passed");
