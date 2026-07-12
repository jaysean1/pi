// Adapts Pi's default identity line for Anthropic subscription calls.
// Tool guidance, Pi documentation, project context, and skills remain unchanged.

const PLUGIN_NAME = "anthropic-subscription-prompt-cleaner";

const DEFAULT_OPENING =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const CLAUDE_OPENING =
  "You are Claude, an expert coding assistant operating inside a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

// Rewrite only Pi's known built-in prose. Absolute documentation paths and all
// operational instructions remain intact, while user/project text is not subject
// to a risky global `pi` replacement.
const BUILTIN_PROSE_REPLACEMENTS = [
  [
    "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
    "Coding-agent framework documentation (read only when the user asks about the framework itself, its SDK, extensions, themes, skills, or TUI):",
  ],
  [
    "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
    "- When reading framework docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory",
  ],
  [
    "adding models (docs/models.md), pi packages (docs/packages.md)",
    "adding models (docs/models.md), framework packages (docs/packages.md)",
  ],
  [
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- When working on framework topics, read the docs and examples, and follow .md cross-references before implementing",
  ],
  [
    "- Always read pi .md files completely and follow links to related docs",
    "- Always read framework .md files completely and follow links to related docs",
  ],
];

function isAnthropicSubscription(ctx) {
  const model = ctx?.model;
  if (!model || model.provider !== "anthropic") return false;

  try {
    return ctx.modelRegistry?.isUsingOAuth(model) === true;
  } catch {
    return false;
  }
}

function customisePrompt(prompt) {
  if (typeof prompt !== "string") return prompt;

  let adapted = prompt;

  if (adapted.startsWith(DEFAULT_OPENING)) {
    adapted = CLAUDE_OPENING + adapted.slice(DEFAULT_OPENING.length);
  } else {
    // A narrowly anchored fallback tolerates small changes after the first sentence.
    adapted = adapted.replace(
      /^You are an expert coding assistant operating inside pi, a coding agent harness\./,
      "You are Claude, an expert coding assistant operating inside a coding agent harness.",
    );
  }

  for (const [piProse, neutralProse] of BUILTIN_PROSE_REPLACEMENTS) {
    adapted = adapted.replace(piProse, neutralProse);
  }

  return adapted;
}

function customiseProviderPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  if (typeof payload.system === "string") {
    const system = customisePrompt(payload.system);
    return system === payload.system ? payload : { ...payload, system };
  }

  if (!Array.isArray(payload.system)) return payload;

  let changed = false;
  const system = payload.system.map((block) => {
    if (!block || typeof block !== "object" || typeof block.text !== "string") return block;
    const text = customisePrompt(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });

  return changed ? { ...payload, system } : payload;
}

function buildStatus(ctx) {
  const model = ctx?.model;
  const provider = model?.provider ?? "none";
  const modelId = model?.id ?? "none";
  const subscription = isAnthropicSubscription(ctx);
  const prompt = ctx?.getSystemPrompt?.() ?? "";
  const adapted = subscription ? customisePrompt(prompt) : prompt;
  const identityRewrite = subscription && adapted !== prompt;

  return [
    `${PLUGIN_NAME}: ${subscription ? "active" : "inactive"}`,
    `model: ${provider}/${modelId}`,
    `scope: Anthropic OAuth subscription calls only`,
    `prompt_adaptation: ${identityRewrite ? "applied" : "no-match"}`,
    `framework_docs_and_paths_preserved: yes`,
  ].join("\n");
}

export {
  BUILTIN_PROSE_REPLACEMENTS,
  CLAUDE_OPENING,
  DEFAULT_OPENING,
  customisePrompt,
  customiseProviderPayload,
  isAnthropicSubscription,
};

export default function activate(pi) {
  pi.on("before_agent_start", (event, ctx) => {
    if (!isAnthropicSubscription(ctx)) return undefined;

    const systemPrompt = customisePrompt(event.systemPrompt);
    if (systemPrompt === event.systemPrompt) return undefined;

    return { systemPrompt };
  });

  // Final serialization guard: catches prompts rebuilt by later lifecycle logic
  // while preserving Anthropic's provider-injected Claude Code identity block.
  pi.on("before_provider_request", (event, ctx) => {
    if (!isAnthropicSubscription(ctx)) return undefined;

    const payload = customiseProviderPayload(event.payload);
    return payload === event.payload ? undefined : payload;
  });

  pi.registerCommand("anthropic-prompt-cleaner-status", {
    description: "Show whether the Anthropic subscription identity adapter is active.",
    handler: async (_args, ctx) => {
      pi.sendMessage({
        customType: "anthropic-prompt-cleaner-status",
        content: buildStatus(ctx),
        display: true,
      });
    },
  });
}
