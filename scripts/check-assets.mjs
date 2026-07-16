import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(ROOT, "public/textures");
const names = ["galv_col", "galv_nrm", "corroded_col", "corroded_nrm", "fabric_col"];

let total = 0;
for (const file of readdirSync(DIR)) {
  const path = resolve(DIR, file);
  if (!statSync(path).isFile()) continue;
  const size = statSync(path).size;
  total += size;
  assert.ok(size < 4 * 1024 * 1024, `${file} is too large for a raw runtime texture`);
}
assert.ok(total < 30 * 1024 * 1024, `raw runtime textures total ${(total / 1024 / 1024).toFixed(1)} MB`);

for (const name of names) {
  const path = resolve(DIR, `${name}.png`);
  assert.ok(existsSync(path), `missing ${name}.png`);
  assert.equal(existsSync(resolve(DIR, `${name}.jpg`)), false, `${name}.jpg source leaked into public`);
  const header = readFileSync(path).subarray(0, 24);
  assert.equal(header.toString("hex", 0, 8), "89504e470d0a1a0a", `${name}.png is not PNG`);
  assert.equal(header.readUInt32BE(16), 1024, `${name}.png width`);
  assert.equal(header.readUInt32BE(20), 1024, `${name}.png height`);
}

console.log(`asset checks passed (${(total / 1024 / 1024).toFixed(1)} MB raw runtime textures)`);

