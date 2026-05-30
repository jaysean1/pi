// Removes Pi-specific prompt text for Anthropic subscription calls.
// Not for changing auth, quota, or non-Anthropic model behaviour.

const PLUGIN_NAME = "anthropic-subscription-prompt-cleaner";

const DEFAULT_OPENING =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const NEUTRAL_OPENING =
  "You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.";

const PI_DOCS_START = "\n\nPi documentation (read only when";
const PI_DOCS_END =
  "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

function isAnthropicSubscription(ctx) {
  const model = ctx?.model;
  if (!model || model.provider !== "anthropic") return false;

  try {
    return ctx.modelRegistry?.isUsingOAuth(model) === true;
  } catch {
    return false;
  }
}

function stripPiDocsBlock(prompt) {
  const start = prompt.indexOf(PI_DOCS_START);
  if (start === -1) return prompt;

  const end = prompt.indexOf(PI_DOCS_END, start);
  if (end === -1) return prompt;

  return prompt.slice(0, start) + prompt.slice(end + PI_DOCS_END.length);
}

function sanitisePrompt(prompt) {
  let next = prompt.replace(DEFAULT_OPENING, NEUTRAL_OPENING);
  next = stripPiDocsBlock(next);

  // Defensive clean-up for minor prompt wording changes across Pi versions.
  next = next.replace(/\boperating inside pi, a coding agent harness\b/gi, "");
  next = next.replace(/\n{3,}/g, "\n\n").trimEnd();
  return next;
}

function buildStatus(ctx) {
  const model = ctx?.model;
  const provider = model?.provider ?? "none";
  const modelId = model?.id ?? "none";
  const subscription = isAnthropicSubscription(ctx);
  const prompt = ctx?.getSystemPrompt?.() ?? "";
  const cleaned = subscription ? sanitisePrompt(prompt) : prompt;
  const removed = prompt.length - cleaned.length;

  return [
    `${PLUGIN_NAME}: ${subscription ? "active" : "inactive"}`,
    `model: ${provider}/${modelId}`,
    `scope: Anthropic OAuth subscription calls only`,
    `would_remove_chars: ${subscription ? Math.max(0, removed) : 0}`,
  ].join("\n");
}

export { isAnthropicSubscription, sanitisePrompt };

export default function activate(pi) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!isAnthropicSubscription(ctx)) return undefined;

    const systemPrompt = sanitisePrompt(event.systemPrompt);
    if (systemPrompt === event.systemPrompt) return undefined;

    return { systemPrompt };
  });

  pi.registerCommand("anthropic-prompt-cleaner-status", {
    description: "Show whether the Anthropic subscription prompt cleaner is active.",
    handler: async (_args, ctx) => {
      pi.sendMessage({
        customType: "anthropic-prompt-cleaner-status",
        content: buildStatus(ctx),
        display: true,
      });
    },
  });
}
