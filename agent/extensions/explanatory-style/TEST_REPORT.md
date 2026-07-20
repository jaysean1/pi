# Explanatory Style — test report

**Date:** 2026-07-14  
**Extension:** `local-explanatory-style` 0.1.0  
**Pi:** `@earendil-works/pi-coding-agent` 0.80.7  
**Node.js:** 25.6.1  
**Quality-evaluation models:** `openai-codex/gpt-5.6-sol` and `anthropic/claude-opus-4-8`, thinking `high`  
**Anthropic support extension:** `anthropic-subscription-prompt-cleaner`

## Summary

- Functional tests: **4/4 passed**
- TypeScript type check: **passed**
- Runtime extension-load smoke test: **passed**
- Fixture tests before evaluation: **1/1 passed**
- Implementation-evaluation tests after agent changes: **2/2 passed**
- Quality runs: **4/4 met their expected insight behavior** across Codex and Anthropic
- UI regression checks: **2/2 passed** (no footer item; compact separator rendered exactly)
- Hard quality failures: **0**
- Manual rubric result: **4.9/5 (excellent)** on this small synthetic sample

## Functional verification

### Unit tests

Command:

```bash
cd ~/.pi/agent/extensions/explanatory-style
npm test
```

Result:

```text
4 tests, 4 passed, 0 failed
```

Covered behavior:

1. `/explanatory` argument parsing, including default status and invalid input.
2. Branch-aware restoration using the latest valid persisted state.
3. Idempotent system-prompt injection and presence of quality constraints.
4. Default-on behavior, `/explanatory off`, `/explanatory toggle`, state persistence, restored disabled state, and absence of a footer status item.

### UI regression verification

The footer regression is covered by the extension lifecycle test: `session_start`, status, enable, disable, and toggle operations produced **zero** `ctx.ui.setStatus()` calls.

A live Codex/Pi render check produced the new compact wrapper exactly:

```text
★ Insight ───────────────
- UserService.updateName() saves to the repository but neither updates nor deletes the UserCache entry, so getUser() can return the old name until the TTL expires.
─────────────────────────
```

The previous 37/49-character separators are no longer present in the injected prompt.

### Type check

After `npm install`:

```bash
npm run typecheck
```

Result: passed with no diagnostics.

### Pi runtime smoke test

The extension was explicitly loaded with discovery disabled:

```bash
pi --no-extensions --no-skills --no-prompt-templates --no-context-files \
  --no-session -e ~/.pi/agent/extensions/explanatory-style/index.ts \
  --list-models claude-opus-4-8
```

Result: Pi started and listed matching models; no extension-load error occurred.

## Insight quality evaluation

The reproducible fixture and prompts are under `eval/`. Each scenario ran in a fresh temporary copy with all unrelated extensions, skills, prompt templates, and context files disabled.

### Scenario 1 — read-only codebase analysis

Prompt:

```text
Read src/user-cache.ts and src/user-service.ts. Explain the cache invalidation strategy and its main correctness risk. Do not modify files.
```

Observed insight:

```text
★ Insight ───────────────
- UserService.getUser() uses cache-aside loading: check UserCache, fetch from the repository on a miss, then cache the result.
- Invalidation is only lazy TTL expiration in UserCache.get(). Although UserCache.delete() exists, updateName() never calls it or refreshes the cached value.
- Therefore, after updateName() succeeds, getUser() may return the old name until the TTL expires. A concurrent cache-miss/read and update can also cache an outdated repository result afterward, extending the stale period by a full TTL.
─────────────────────────
```

Assessment:

| Dimension | Score | Notes |
|---|---:|---|
| Grounding and correctness | 4.5 | All named symbols and stale-read behavior are supported by the fixture. The concurrency point is a valid inference rather than a directly tested path. |
| Codebase specificity | 5.0 | Names `UserService.getUser`, `UserCache.get/delete`, `updateName`, and TTL behavior. |
| Explanatory value | 5.0 | Explains cache-aside, missing invalidation, and the consequence rather than restating source lines. |
| Concision and non-repetition | 5.0 | Three focused bullets; no tool narration. |
| Timing and restraint | 5.0 | Exactly one block for a read-only analysis turn. |

**Scenario score: 4.9/5.**

### Scenario 2 — substantive implementation

Prompt:

```text
Fix the stale-cache bug in UserService.updateName and add a regression test. Inspect the implementation first, make the smallest correct change, and run the tests.
```

The JSON event stream confirmed this block appeared after source inspection and immediately before the first edit:

```text
★ Insight ───────────────
- getUser uses cache-aside reads, but updateName currently bypasses UserCache, so a previously cached snapshot survives until TTL expiry.
- Invalidating only after repository.save succeeds preserves the existing cached value if persistence fails; the next read then reloads authoritative repository state.
─────────────────────────
```

Implemented diff:

- Added `this.cache.delete(id)` after successful `repository.save(...)`.
- Added a regression test that primes the cache, updates the user, then verifies a fresh repository read.

Verification:

```text
2 tests, 2 passed, 0 failed
```

Assessment:

| Dimension | Score | Notes |
|---|---:|---|
| Grounding and correctness | 5.0 | Correctly ties invalidation ordering to persistence success and cache coherence. |
| Codebase specificity | 5.0 | Uses the exact read/write methods and cache type involved in the change. |
| Explanatory value | 5.0 | Captures the important ordering invariant, not just “delete the cache.” |
| Concision and non-repetition | 5.0 | Two distinct bullets and no redundant post-change block. |
| Timing and restraint | 5.0 | Appeared after inspection, before editing; only one block because a second would repeat it. |

**Scenario score: 5.0/5.**

> Pi's plain `-p` text mode prints the final answer but can omit intermediate pre-tool commentary. The insight was verified through `--mode json`, which records the complete assistant/tool event stream. Interactive TUI sessions render that pre-edit commentary normally.

### Scenario 3 — restraint control

Prompt:

```text
只回答：2 + 2 等于多少？不要读取或修改文件。
```

Observed output:

```text
4
```

No insight block and no tool call were emitted. This meets the anti-noise requirement.

**Restraint score: 5.0/5.**

### Scenario 4 — Anthropic Subscription cross-provider validation

The read-only analysis scenario was repeated with `anthropic/claude-opus-4-8`. Because extension discovery was disabled for isolation, both extensions were explicitly loaded in this order:

```bash
pi --no-extensions \
  -e ~/.pi/agent/extensions/anthropic-subscription-prompt-cleaner/index.js \
  -e ~/.pi/agent/extensions/explanatory-style/index.ts \
  --model anthropic/claude-opus-4-8 --thinking high ...
```

Observed insight:

```text
★ Insight ───────────────
- UserCache was designed to support write invalidation — delete(id) exists and is unused — so the bug is an omission in UserService, not a missing capability.
- The fix has a real trade-off: delete after save is simple and reloads authoritative state; set after save avoids a read but may diverge if persistence transforms data.
- TTL bounds the stale-read window but does not prevent stale reads.
─────────────────────────
```

Assessment:

| Dimension | Score | Notes |
|---|---:|---|
| Grounding and correctness | 5.0 | Correctly derives the missing write invalidation from observed symbols and control flow. |
| Codebase specificity | 5.0 | Names `UserCache.delete`, `UserService`, TTL, and the actual update path. |
| Explanatory value | 5.0 | Adds a useful invalidate-vs-refresh trade-off and distinguishes bounded staleness from consistency. |
| Concision and non-repetition | 4.5 | Insight block is concise, although the surrounding answer was more detailed than the Codex result. |
| Timing and restraint | 5.0 | One block on a substantive read-only analysis; no edits. |

**Anthropic scenario score: 4.9/5.** The extension produced the intended format and quality on both provider families.

## Baseline comparison

The read-only scenario was also run without the extension. The baseline model found the same cache-aside and stale-read facts, but returned ordinary bullets without a distinct educational block.

On this small, obvious fixture, the extension's demonstrated gain is primarily:

- consistent visual separation;
- reliable placement near the relevant code decision;
- explicit limits against generic, unsupported, or excessive insights.

The sample does **not** establish that the extension improves raw factual reasoning over the same model. A larger real-project A/B evaluation would be needed for that claim.

## Issues found and prompt tuning

An initial text-mode implementation run appeared to contain no insight because `-p` only surfaced the final answer. The prompt was nevertheless strengthened to require at least one visible block on every substantive write/edit turn, and the complete JSON stream then verified correct pre-edit placement.

The final prompt also enforces:

- no more than two blocks per user turn;
- 2–3 bullets per block;
- evidence from the current turn;
- no invented project conventions;
- no hidden chain-of-thought;
- omission on trivial/non-coding turns.

## Limitations

1. **Small sample:** four runs and one synthetic TypeScript fixture are not representative of a large production repository.
2. **Uneven cross-model depth:** Codex covered analysis, implementation, and restraint; Claude Opus covered the read-only analysis scenario only.
3. **Anthropic dependency during isolated tests:** with extension discovery disabled, the Anthropic Subscription cleaner must be explicitly loaded before Explanatory Style. Omitting it produced an `out of extra usage` response; loading it made the OAuth subscription run succeed.
4. **Manual scoring:** the rubric was applied manually; it is useful for review but is not an independent blinded judge.
5. **Prompt compliance is probabilistic:** the extension shapes model behavior but does not post-process or enforce assistant text structurally.
6. **Intermediate output by mode:** pre-tool insights are visible in TUI/JSON, while plain print mode may show only the final response.

## Recommendation

The extension is ready for interactive use. The current behavior is concise and materially codebase-specific on the tested scenarios. Before publishing it as a general community package, repeat the same rubric on:

- at least 20 tasks from two real repositories;
- both a Claude model and a Codex model;
- bug fixes, refactors, tests, configuration-only edits, and non-coding controls;
- blinded A/B outputs with and without the extension.
