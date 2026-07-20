import assert from "node:assert/strict";
import test from "node:test";

import activate, {
  DEFAULT_STATE,
  EXPLANATORY_STYLE_PROMPT,
  STATE_ENTRY_TYPE,
  appendExplanatoryPrompt,
  createState,
  parseCommand,
  restoreState,
} from "./index.ts";

test("command parser supports status by default and rejects invalid input", () => {
  assert.equal(parseCommand(""), "status");
  assert.equal(parseCommand(" ON "), "on");
  assert.equal(parseCommand("toggle"), "toggle");
  assert.equal(parseCommand("wat"), undefined);
});

test("state restoration uses the latest valid entry on the active branch", () => {
  const off = createState(false, "2026-07-14T10:00:00.000Z");
  const on = createState(true, "2026-07-14T10:01:00.000Z");
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: off },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { version: 2, enabled: false } },
    { type: "custom", customType: "other-extension", data: off },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: on },
  ];

  assert.deepEqual(restoreState(entries), on);
  assert.deepEqual(restoreState([]), DEFAULT_STATE);
});

test("prompt injection is idempotent and contains the quality contract", () => {
  const once = appendExplanatoryPrompt("BASE");
  const twice = appendExplanatoryPrompt(once);

  assert.equal(once, twice);
  assert.ok(once.startsWith("BASE\n\n[EXPLANATORY OUTPUT STYLE]"));
  assert.ok(once.includes("`★ Insight ───────────────`"));
  assert.ok(once.includes("`─────────────────────────`"));
  assert.ok(!once.includes("─────────────────────────────────────────────────"));
  for (const requirement of [
    "Ground every point in code",
    "Never invent a project convention",
    "must include at least one visible insight block",
    "no more than two insight blocks",
    "2-3 concise bullets",
    "Do not reveal hidden chain-of-thought",
  ]) {
    assert.ok(EXPLANATORY_STYLE_PROMPT.includes(requirement), `missing requirement: ${requirement}`);
  }
});

test("extension defaults on, toggles, persists state, restores it, and adds no footer status", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const entries: any[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<[string, string]> = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses.push([key, value]);
      },
      notify(message: string, level: string) {
        notifications.push([message, level]);
      },
    },
  };

  activate(pi as any);
  await handlers.get("session_start")?.({}, ctx);
  assert.deepEqual(await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx), {
    systemPrompt: appendExplanatoryPrompt("BASE"),
  });

  await commands.get("explanatory").handler("off", ctx);
  assert.equal(entries.at(-1).data.enabled, false);
  assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx), undefined);

  await commands.get("explanatory").handler("toggle", ctx);
  assert.equal(entries.at(-1).data.enabled, true);
  assert.ok(notifications.some(([message]) => message === "Explanatory insights enabled."));

  entries.push({ type: "custom", customType: STATE_ENTRY_TYPE, data: createState(false) });
  await handlers.get("session_start")?.({}, ctx);
  assert.equal(await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx), undefined);
  assert.deepEqual(statuses, [], "the extension must not add an insights footer status");
});
