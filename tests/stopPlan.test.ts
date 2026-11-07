// Stopp ohne laufenden Job – läuft mit `npm test`
import { test } from "node:test";
import assert from "node:assert/strict";
import { stopPlanFor, holdSettled } from "../src/stopPlan.ts";

test("je Zustand das Richtige, im Stillstand nichts", () => {
  assert.equal(stopPlanFor("Run"), "hold-reset");
  assert.equal(stopPlanFor("Hold:0"), "reset");
  assert.equal(stopPlanFor("Hold:1"), "reset");
  assert.equal(stopPlanFor("Jog"), "jog-cancel");
  assert.equal(stopPlanFor("Home"), "reset");
  for (const s of ["Idle", "Alarm", "Door:0", "Check", "", "Offline"]) assert.equal(stopPlanFor(s), "none", s);
});

test("Reset erst, wenn die Maschine steht oder die Zeit um ist", () => {
  assert.equal(holdSettled("Run", 100), false);
  assert.equal(holdSettled("Hold:1", 100), false);
  assert.equal(holdSettled("Hold:0", 100), true);
  assert.equal(holdSettled("Idle", 100), true);
  assert.equal(holdSettled("Run", 3000), true);
});
