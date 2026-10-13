import assert from "node:assert/strict";
import { Obj } from "../src/sim/world.ts";
import { createVisitationSave } from "./visitationFixture.ts";

// Exercise a legitimate room furnished with the permitted privacy screen
// instead of a visit table, using the ordinary guard, access and travel flow.
const save = createVisitationSave(true, true);
const roomObjects = save.world.pieces.map((piece) => piece.kind);
assert(roomObjects.includes(Obj.VisitScreen), "the fixture contains the screen rendezvous furniture");
assert(!roomObjects.includes(Obj.VisitTable), "the screen-only fixture does not silently rely on a visit table");
assert.equal(save.task3.visitation.session.state, "contact",
  "screen-only visitation reaches live physical contact through screening and rendezvous");
assert.equal(save.task3.visitation.session.residentArrived, true,
  "the resident physically joins the screened visitor at the privacy screen");
assert(save.task3.visitation.visitors.some((visitor) => visitor.state === "contact"),
  "the screened visitor is physically present in contact state");
console.log("screen-only family visitation reaches actual physical contact through the normal visitor flow");
