# Codex Image Path Only

This local Pi companion extension removes inline image blocks from successful `codex_generate_image` tool results after the generated file has been saved.

It does not modify `pi-codex-image-gen`. Results keep their text summary and `details`, including `savedPath`. Inline images remain available when the tool failed or no saved path exists, so `save=none` does not lose the only image copy.

## Test

```sh
npm test
```

The tests use synthetic tool results and do not call Codex or consume image-generation quota.
