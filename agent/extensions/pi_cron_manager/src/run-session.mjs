// Builds fail-closed TUI actions for saved cron-run sessions.
// Does not read session files or switch the active Pi session.

export function getRunSessionStatus(run) {
  if (run?.session?.status === "available" && typeof run.sessionFile === "string" && run.sessionFile) {
    return "available";
  }
  if (run?.session?.status === "invalid" || run?.sessionFile) return "invalid";
  return "missing";
}

export function buildRunSessionAction(taskId, run) {
  if (!run) return null;
  const status = getRunSessionStatus(run);
  if (status === "available") {
    return {
      type: "resume-run",
      id: taskId,
      runId: run.runId,
      sessionFile: run.sessionFile,
    };
  }
  const fallback = status === "invalid"
    ? "Saved session has not passed Pi session validation."
    : "This run has no saved Pi session.";
  return {
    type: "session-unavailable",
    id: taskId,
    runId: run.runId,
    reason: run.session?.error ?? fallback,
  };
}
