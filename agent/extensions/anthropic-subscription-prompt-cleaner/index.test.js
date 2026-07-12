import assert from "node:assert/strict";
import test from "node:test";

import activate, {
  BUILTIN_PROSE_REPLACEMENTS,
  CLAUDE_OPENING,
  DEFAULT_OPENING,
  customisePrompt,
  customiseProviderPayload,
  isAnthropicSubscription,
} from "./index.js";

const PRESERVED_SUFFIX = `

Available tools:
- read: Read file contents
- edit: Edit files

Guidelines:
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/README.md
- Additional docs: /opt/pi/docs

<project_context>
<project_instructions path="/repo/AGENTS.md">
Keep three blank lines below.



Done.
</project_instructions>
</project_context>

Available skills:
- example

Current date: 2026-07-11
Current working directory: /repo
`;

const ADAPTED_SUFFIX = BUILTIN_PROSE_REPLACEMENTS.reduce(
  (text, [piProse, neutralProse]) => text.replace(piProse, neutralProse),
  PRESERVED_SUFFIX,
);

function oauthContext(provider = "anthropic") {
  const model = { provider, id: "claude-opus-4-8" };
  return {
    model,
    modelRegistry: {
      isUsingOAuth(candidate) {
        return candidate === model;
      },
    },
  };
}

test("rewrites the default identity and known built-in Pi prose", () => {
  const adapted = customisePrompt(DEFAULT_OPENING + PRESERVED_SUFFIX);

  assert.equal(adapted, CLAUDE_OPENING + ADAPTED_SUFFIX);
  assert.ok(adapted.includes("Coding-agent framework documentation"));
  assert.ok(!adapted.includes("Pi documentation (read only when"));
});

test("preserves framework instructions, paths, project context, skills, whitespace, date, and cwd", () => {
  const adapted = customisePrompt(DEFAULT_OPENING + PRESERVED_SUFFIX);

  for (const expected of [
    "Coding-agent framework documentation",
    "/opt/pi/README.md",
    "/opt/pi/docs",
    '<project_instructions path="/repo/AGENTS.md">',
    "Available skills:",
    "\n\n\n\nDone.",
    "Current date: 2026-07-11",
    "Current working directory: /repo\n",
  ]) {
    assert.ok(adapted.includes(expected), `expected preserved content: ${expected}`);
  }
});

test("uses a start-anchored fallback for a changed default continuation", () => {
  const original =
    "You are an expert coding assistant operating inside pi, a coding agent harness. Updated wording.\n\nPi documentation: keep me";

  assert.equal(
    customisePrompt(original),
    "You are Claude, an expert coding assistant operating inside a coding agent harness. Updated wording.\n\nPi documentation: keep me",
  );
});

test("does not modify custom prompts and is idempotent", () => {
  const custom = "You are a project-specific reviewer.\n\nPi documentation: /some/path";
  const adapted = customisePrompt(DEFAULT_OPENING + PRESERVED_SUFFIX);

  assert.equal(customisePrompt(custom), custom);
  assert.equal(customisePrompt(adapted), adapted);
});

test("detects only Anthropic OAuth subscription contexts", () => {
  assert.equal(isAnthropicSubscription(oauthContext()), true);
  assert.equal(isAnthropicSubscription(oauthContext("openai-codex")), false);
  assert.equal(
    isAnthropicSubscription({
      model: { provider: "anthropic", id: "claude-opus-4-8" },
      modelRegistry: { isUsingOAuth: () => false },
    }),
    false,
  );
  assert.equal(isAnthropicSubscription({}), false);
});

test("adapts serialized system blocks without changing Claude Code identity or metadata", () => {
  const payload = {
    model: "claude-opus-4-8",
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: DEFAULT_OPENING + PRESERVED_SUFFIX, cache_control: { type: "ephemeral" } },
    ],
  };
  const adapted = customiseProviderPayload(payload);

  assert.notEqual(adapted, payload);
  assert.deepEqual(adapted.system[0], payload.system[0]);
  assert.equal(adapted.system[1].text, CLAUDE_OPENING + ADAPTED_SUFFIX);
  assert.deepEqual(adapted.system[1].cache_control, { type: "ephemeral" });
  assert.equal(adapted.model, payload.model);
  assert.equal(customiseProviderPayload(adapted), adapted);
});

test("lifecycle hooks adapt Anthropic OAuth and leave other calls untouched", () => {
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    sendMessage() {},
  };

  activate(pi);
  const handler = handlers.get("before_agent_start");
  assert.equal(typeof handler, "function");
  assert.ok(commands.has("anthropic-prompt-cleaner-status"));

  const systemPrompt = DEFAULT_OPENING + PRESERVED_SUFFIX;
  assert.deepEqual(handler({ systemPrompt }, oauthContext()), {
    systemPrompt: CLAUDE_OPENING + ADAPTED_SUFFIX,
  });
  assert.equal(handler({ systemPrompt }, oauthContext("openai-codex")), undefined);

  const providerHandler = handlers.get("before_provider_request");
  const payload = { system: [{ type: "text", text: systemPrompt }] };
  assert.equal(providerHandler({ payload }, oauthContext("openai-codex")), undefined);
  assert.deepEqual(providerHandler({ payload }, oauthContext()), {
    system: [{ type: "text", text: CLAUDE_OPENING + ADAPTED_SUFFIX }],
  });
});
