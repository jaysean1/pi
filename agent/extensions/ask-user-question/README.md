# ask-user-question extension

This local Pi extension registers the `ask_user_question` tool.

## Purpose

Use it when the model should ask structured clarifying questions instead of guessing. The tool supports:

- 1-4 questions in one dialog.
- 2-5 options per question.
- Single-select questions with a `Type something.` fallback.
- Multi-select questions with checkboxes.
- A `Chat about this` escape row.
- Optional per-option preview text.
- A multi-question review tab before submit.

## Location

This extension is auto-discovered from:

```text
~/.pi/agent/extensions/ask-user-question/index.ts
```

No package install is required. Restart Pi or run `/reload` after editing.

Avoid installing another package that registers the same `ask_user_question` tool at the same time, unless you intentionally want to test tool override behaviour.

## Demo

In Pi, run:

```text
/ask-question-demo
```

## Tool schema

```ts
ask_user_question({
  questions: [
    {
      question: string,
      header?: string,
      options: [
        {
          label: string,
          description?: string,
          preview?: string,
        }
      ],
      multiSelect?: boolean,
      allowCustom?: boolean,
    }
  ]
})
```

## Customisation

Optional config path:

```text
~/.config/pi-ask-user-question/config.json
```

Example:

```json
{
  "defaultAllowCustom": true,
  "promptSnippet": "Ask structured clarifying questions before making risky assumptions.",
  "promptGuidelines": [
    "Use ask_user_question when the request is ambiguous and guessing would change the result.",
    "Use ask_user_question in the user's language.",
    "Use ask_user_question once per uncertainty cluster, with concise options."
  ]
}
```

Run `/reload` after changing the config.
