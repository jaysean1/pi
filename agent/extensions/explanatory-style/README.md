# Explanatory Style

A lightweight Pi extension inspired by Claude Code's Explanatory output-style plugin. It keeps Pi's normal coding workflow intact while adding short, evidence-based educational insights around substantive code analysis and implementation decisions.

## Behavior

The extension is enabled by default. It asks the model to:

- use at most two `★ Insight` blocks per user turn;
- ground insights in code, tool output, or changes observed during that turn;
- explain codebase-specific patterns, invariants, consequences, and trade-offs;
- omit insights for trivial or non-coding turns;
- keep each block to 2–3 concise bullets;
- avoid hidden chain-of-thought and unsupported project conventions.

It does **not** block tools, prevent edits, turn the session into a tutoring workflow, or add an indicator to Pi's footer. Use `/explanatory status` when you need to check the current state.

## Commands

```text
/explanatory             # status
/explanatory on
/explanatory off
/explanatory toggle
/explanatory status
```

The selected state is stored in the current session branch. New sessions start enabled.

## Development

```bash
cd ~/.pi/agent/extensions/explanatory-style
npm install
npm test
npm run typecheck
```

See [`TEST_REPORT.md`](TEST_REPORT.md) for functional results, model-based quality evaluation, rubric scores, and limitations.

For a clean one-off integration run:

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  --no-session -e ~/.pi/agent/extensions/explanatory-style/index.ts \
  -p "Inspect this project and explain one important implementation decision."
```

When a test explicitly selects an Anthropic provider while using `--no-extensions`, also load the local Anthropic Subscription extension first:

```bash
-e ~/.pi/agent/extensions/anthropic-subscription-prompt-cleaner/index.js \
-e ~/.pi/agent/extensions/explanatory-style/index.ts
```

Because the extension is in Pi's global extension directory, use `/reload` in an existing interactive session to load changes.
