// Sanity check for World.recomputeRoofs(): build a 6x6 walled room and assert the
// roof covers the 16 interior tiles plus the 20 perimeter ones.
//
// Usage:  npm run check   (Node strips the TS types natively)

import { World } from "../src/sim/world.ts";

const w = new World(1500);
for (let z = 100; z < 106; z++) for (let x = 100; x < 106; x++) w.setFloor(x, z, 1);
for (let x = 100; x < 106; x++) { w.setWall(x, 100, 1); w.setWall(x, 105, 1); }
for (let z = 100; z < 106; z++) { w.setWall(100, z, 1); w.setWall(105, z, 1); }
w.recomputeRoofs();

const tiles = w.roofed.reduce((n, v) => n + v, 0);
const expected = 36; // 16 interior + 20 perimeter
console.log(`roof tiles: ${tiles} (expected ${expected})`);
if (tiles !== expected) process.exit(1);
