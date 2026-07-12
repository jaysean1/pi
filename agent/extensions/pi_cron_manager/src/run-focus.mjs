// Pure focus-navigation helpers for the Runs tab.
// The schedule toggle uses -1; non-negative values address run-history rows.

export const SCHEDULE_TOGGLE_FOCUS = -1;

export function firstRunsFocus(hasToggle, runCount) {
  if (hasToggle) return SCHEDULE_TOGGLE_FOCUS;
  return runCount > 0 ? 0 : null;
}

export function moveRunsFocus(current, delta, hasToggle, runCount) {
  const targets = [
    ...(hasToggle ? [SCHEDULE_TOGGLE_FOCUS] : []),
    ...Array.from({ length: Math.max(0, runCount) }, (_value, index) => index),
  ];
  if (targets.length === 0) return null;
  const currentIndex = targets.indexOf(current);
  const start = currentIndex >= 0 ? currentIndex : 0;
  const next = Math.max(0, Math.min(targets.length - 1, start + delta));
  return targets[next];
}
