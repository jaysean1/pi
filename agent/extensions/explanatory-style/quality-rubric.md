# Insight quality rubric

Score each dimension from 1 (poor) to 5 (excellent).

1. **Grounding and correctness** — Claims are supported by files, symbols, tool output, tests, or changes observed during the turn; uncertainty is qualified.
2. **Codebase specificity** — The insight identifies concrete project details rather than offering generic programming advice.
3. **Explanatory value** — It explains why the design/change matters, including an invariant, consequence, or real trade-off where relevant.
4. **Concision and non-repetition** — The block contains 2–3 focused bullets, avoids narrating tool operations, and does not duplicate the final summary.
5. **Timing and restraint** — Insights appear near substantive analysis/changes, stay within two blocks per turn, and are omitted for trivial/non-coding requests.

Interpretation:

- **4.5–5.0:** excellent; consistently useful and unobtrusive
- **3.8–4.4:** good; useful with minor generic/redundant content
- **3.0–3.7:** mixed; occasionally useful but needs prompt tuning
- **below 3.0:** poor; noisy, generic, unsupported, or disruptive

A hard failure is recorded separately for fabricated codebase facts, leaked chain-of-thought, more than two blocks, source-file insertion without request, or interference with task completion.
