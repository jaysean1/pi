// Provides terminal mouse-wheel parsing and reporting for the full-screen cron TUI.
// Does not handle clicks, pointer positioning, or application keyboard shortcuts.

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1000l\x1b[?1006l";
const SGR_EVENT = /\x1b\[<(\d+);\d+;\d+[mM]/g;
const X10_PREFIX = "\x1b[M";
const MODIFIER_BITS = 4 | 8 | 16 | 32;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

export function enableMouseWheel(terminal) {
  terminal.write(ENABLE_MOUSE);
  let disabled = false;
  return () => {
    if (disabled) return;
    disabled = true;
    terminal.write(DISABLE_MOUSE);
  };
}

function wheelFromButton(code) {
  const wheel = code & ~MODIFIER_BITS;
  if (wheel === WHEEL_UP) return "up";
  if (wheel === WHEEL_DOWN) return "down";
  return undefined;
}

export function parseWheelEvents(data) {
  const events = [];
  for (const match of data.matchAll(SGR_EVENT)) {
    const direction = wheelFromButton(Number.parseInt(match[1] ?? "", 10));
    if (direction) events.push(direction);
  }
  let at = data.indexOf(X10_PREFIX);
  while (at !== -1 && at + 6 <= data.length) {
    const direction = wheelFromButton(data.charCodeAt(at + 3) - 32);
    if (direction) events.push(direction);
    at = data.indexOf(X10_PREFIX, at + 6);
  }
  return events;
}

export function isMouseSequence(data) {
  if (data.length === 0) return false;
  const stripped = data
    .replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "")
    .replace(/\x1b\[M[\s\S]{3}/g, "");
  return stripped.length === 0;
}
