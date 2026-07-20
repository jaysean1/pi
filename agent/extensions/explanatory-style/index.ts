import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

export const STATE_ENTRY_TYPE = "explanatory-style-state";

export const EXPLANATORY_STYLE_PROMPT = `[EXPLANATORY OUTPUT STYLE]

Keep task completion primary. Add brief educational insights only when they materially help the user understand the codebase or a substantive implementation decision.

Insight timing:
- Every substantive coding turn that uses write/edit must include at least one visible insight block. Never finish such a turn with no insight block.
- Prefer the first block before the first write/edit, but only after you have inspected enough code to say something concrete. If the response/tool flow does not expose that block to the user, include it in the final response instead.
- After the implementation, add a second block only when the completed change reveals a distinct, non-repetitive pattern, trade-off, invariant, or verification lesson.
- For codebase analysis without edits, use at most one insight block at the point where it is most useful.
- Omit insight blocks for greetings, simple factual answers, trivial mechanical changes, or whenever the content would be generic or repetitive.
- Use no more than two insight blocks per user turn.

Use this exact compact wrapper, in the user's language:
\`★ Insight ───────────────\`
- [2-3 concise educational points]
\`─────────────────────────\`

Insight quality rules:
- Ground every point in code, tool output, or a change actually observed in this turn. Never invent a project convention.
- Be codebase-specific: name the relevant file, symbol, data flow, invariant, or test when that improves clarity.
- Explain why the implementation is shaped this way, including a real trade-off or consequence when relevant; do not merely narrate tool actions or restate the diff.
- Prefer transferable reasoning about this codebase over general textbook advice.
- Clearly qualify an inference when evidence is incomplete.
- Keep each block to 2-3 concise bullets and avoid repeating the final summary.
- Put insights in the conversation only, never into source files unless the user explicitly asks.
- Do not reveal hidden chain-of-thought. Provide only concise conclusions and evidence-based explanations.`;

export interface ExplanatoryStyleState {
  version: 1;
  enabled: boolean;
  updatedAt?: string;
}

export type ExplanatoryCommand = "on" | "off" | "status" | "toggle";

export const DEFAULT_STATE: ExplanatoryStyleState = {
  version: 1,
  enabled: true,
};

export function createState(enabled: boolean, updatedAt = new Date().toISOString()): ExplanatoryStyleState {
  return { version: 1, enabled, updatedAt };
}

export function parseCommand(input: string): ExplanatoryCommand | undefined {
  const value = input.trim().toLowerCase();
  if (value === "") return "status";
  if (value === "on" || value === "off" || value === "status" || value === "toggle") return value;
  return undefined;
}

function isState(value: unknown): value is ExplanatoryStyleState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExplanatoryStyleState>;
  return candidate.version === 1 && typeof candidate.enabled === "boolean";
}

function isCustomEntry(entry: unknown): entry is SessionEntry & { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: unknown }).type === "custom";
}

export function restoreState(entries: readonly unknown[]): ExplanatoryStyleState {
  let state = DEFAULT_STATE;
  for (const entry of entries) {
    if (!isCustomEntry(entry) || entry.customType !== STATE_ENTRY_TYPE || !isState(entry.data)) continue;
    state = entry.data;
  }
  return state;
}

export function appendExplanatoryPrompt(systemPrompt: string): string {
  if (systemPrompt.includes("[EXPLANATORY OUTPUT STYLE]")) return systemPrompt;
  return `${systemPrompt}\n\n${EXPLANATORY_STYLE_PROMPT}`;
}

export default function explanatoryStyleExtension(pi: ExtensionAPI): void {
  let state = DEFAULT_STATE;

  const setEnabled = (enabled: boolean): void => {
    state = createState(enabled);
    pi.appendEntry(STATE_ENTRY_TYPE, state);
  };

  pi.registerCommand("explanatory", {
    description: "Control explanatory insights: /explanatory on|off|toggle|status",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      const options: ExplanatoryCommand[] = ["on", "off", "toggle", "status"];
      const matches = options.filter((option) => option.startsWith(normalized));
      return matches.length > 0 ? matches.map((option) => ({ value: option, label: option })) : null;
    },
    handler: async (args, ctx) => {
      const command = parseCommand(args);
      if (!command) {
        ctx.ui.notify("Usage: /explanatory on | off | toggle | status", "warning");
        return;
      }

      if (command === "status") {
        ctx.ui.notify(`Explanatory insights are ${state.enabled ? "ON" : "OFF"}.`, "info");
        return;
      }

      const enabled = command === "toggle" ? !state.enabled : command === "on";
      setEnabled(enabled);
      ctx.ui.notify(`Explanatory insights ${enabled ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx.sessionManager.getBranch());
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.enabled) return undefined;
    return { systemPrompt: appendExplanatoryPrompt(event.systemPrompt) };
  });
}
