// Tests batched touchpad wheel parsing and terminal mouse reporting lifecycle.
// Does not open a terminal, render the TUI, or process pointer clicks.

import assert from "node:assert/strict";
import test from "node:test";
import { enableMouseWheel, isMouseSequence, parseWheelEvents } from "../src/mouse.mjs";

test("parses batched SGR wheel reports", () => {
  const input = "\x1b[<65;10;5M\x1b[<65;10;5M\x1b[<64;10;5M";
  assert.deepEqual(parseWheelEvents(input), ["down", "down", "up"]);
  assert.equal(isMouseSequence(input), true);
});

test("parses X10 wheel reports", () => {
  const down = `\x1b[M${String.fromCharCode(65 + 32)}!!`;
  const up = `\x1b[M${String.fromCharCode(64 + 32)}!!`;
  assert.deepEqual(parseWheelEvents(down + up), ["down", "up"]);
});

test("enables and restores mouse reporting once", () => {
  const writes = [];
  const disable = enableMouseWheel({ write: (data) => writes.push(data) });
  disable();
  disable();
  assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1006h", "\x1b[?1000l\x1b[?1006l"]);
});
