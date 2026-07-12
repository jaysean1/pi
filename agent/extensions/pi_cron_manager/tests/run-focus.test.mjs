// Tests keyboard focus order for the Runs-tab schedule switch and run history.

import assert from "node:assert/strict";
import test from "node:test";
import { firstRunsFocus, moveRunsFocus, SCHEDULE_TOGGLE_FOCUS } from "../src/run-focus.mjs";

test("managed tasks focus the schedule switch before history", () => {
  assert.equal(firstRunsFocus(true, 3), SCHEDULE_TOGGLE_FOCUS);
  assert.equal(moveRunsFocus(SCHEDULE_TOGGLE_FOCUS, 1, true, 3), 0);
  assert.equal(moveRunsFocus(0, -1, true, 3), SCHEDULE_TOGGLE_FOCUS);
});

test("run focus clamps at the first and last selectable row", () => {
  assert.equal(moveRunsFocus(SCHEDULE_TOGGLE_FOCUS, -1, true, 2), SCHEDULE_TOGGLE_FOCUS);
  assert.equal(moveRunsFocus(1, 1, true, 2), 1);
});

test("read-only entries skip the schedule switch", () => {
  assert.equal(firstRunsFocus(false, 2), 0);
  assert.equal(moveRunsFocus(0, 1, false, 2), 1);
  assert.equal(firstRunsFocus(false, 0), null);
});

test("refresh normalizes a missing history selection to the first control", () => {
  assert.equal(moveRunsFocus(9, 0, true, 1), SCHEDULE_TOGGLE_FOCUS);
  assert.equal(moveRunsFocus(9, 0, false, 1), 0);
});
