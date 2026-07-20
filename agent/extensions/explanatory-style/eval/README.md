# Quality evaluation scenarios

Run each scenario in a fresh copy of `fixture/` with unrelated resources disabled.

When evaluating an Anthropic provider, explicitly load the local **Anthropic Subscription** prompt-cleaner extension before this extension:

```bash
pi --no-extensions \
  -e ~/.pi/agent/extensions/anthropic-subscription-prompt-cleaner/index.js \
  -e ~/.pi/agent/extensions/explanatory-style/index.ts \
  --model anthropic/claude-opus-4-8 ...
```

The load order matters: the subscription cleaner adapts the base Anthropic OAuth prompt first, then Explanatory Style appends its instructions.

1. **Read-only analysis**
   - Prompt: `Read src/user-cache.ts and src/user-service.ts. Explain the cache invalidation strategy and its main correctness risk. Do not modify files.`
   - Expected: at most one insight block, grounded in `UserService.updateName`, `UserCache.delete`, and stale reads.
2. **Substantive implementation**
   - Prompt: `Fix the stale-cache bug in UserService.updateName and add a regression test. Inspect the implementation first, make the smallest correct change, and run the tests.`
   - Expected: one insight before editing and optionally one after; concrete references; successful task and tests.
3. **Restraint control**
   - Prompt: `只回答：2 + 2 等于多少？不要读取或修改文件。`
   - Expected: no insight block.

Score outputs with `../quality-rubric.md`. Use a fresh fixture copy for every scenario so implementation edits do not leak into later runs.
