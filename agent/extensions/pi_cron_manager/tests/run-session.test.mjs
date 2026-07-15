// Tests fail-closed actions for valid, missing, and malformed run sessions.
// Does not open a TUI or replace the active Pi session.

import assert from "node:assert/strict";
import test from "node:test";
import { buildRunSessionAction, getRunSessionStatus } from "../src/run-session.mjs";

test("builds a resume action only for a validated session", () => {
  const run = {
    runId: "valid-run",
    sessionFile: "/tmp/valid.jsonl",
    session: { status: "available", path: "/tmp/valid.jsonl", error: null },
  };
  assert.equal(getRunSessionStatus(run), "available");
  assert.deepEqual(buildRunSessionAction("safe-task", run), {
    type: "resume-run",
    id: "safe-task",
    runId: "valid-run",
    sessionFile: "/tmp/valid.jsonl",
  });
});

test("blocks malformed and unvalidated session pointers", () => {
  const invalid = {
    runId: "invalid-run",
    sessionFile: "/tmp/invalid.jsonl",
    session: { status: "invalid", error: "Invalid Pi session header." },
  };
  assert.equal(getRunSessionStatus(invalid), "invalid");
  assert.deepEqual(buildRunSessionAction("safe-task", invalid), {
    type: "session-unavailable",
    id: "safe-task",
    runId: "invalid-run",
    reason: "Invalid Pi session header.",
  });

  const legacyUnvalidated = { runId: "legacy-run", sessionFile: "/tmp/legacy.jsonl" };
  assert.equal(getRunSessionStatus(legacyUnvalidated), "invalid");
  assert.equal(buildRunSessionAction("safe-task", legacyUnvalidated).type, "session-unavailable");
});

test("reports runs without a saved session as unavailable", () => {
  const run = { runId: "missing-run", session: { status: "missing", error: "No saved session was recorded." } };
  assert.equal(getRunSessionStatus(run), "missing");
  assert.equal(buildRunSessionAction("safe-task", run).type, "session-unavailable");
});
