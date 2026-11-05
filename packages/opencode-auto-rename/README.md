# opencode-auto-rename

OpenCode V2 plugin that automatically renames a session after the **first assistant reply** finishes.

## Why

OpenCode's built-in title generator runs at the beginning of Turn 1 using only the first user message. When the first message is a screenshot or a short prompt (e.g. `[Image 1] 分析一下`), the initial title is generic.

`opencode-auto-rename` listens for `session.execution.succeeded` at the end of Turn 1, combines the first user message and the assistant's completed reply, generates a specific title, and updates the session title via `ctx.session.update`.

## Configure

From this repository, add the relative package path to `plugins` in a project-level `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./packages/opencode-auto-rename"
  ]
}
```

For other projects, use the installed package name after publication, or a path to your checkout.
The first request and reply are sent to the configured title agent model, falling back to the session model.
