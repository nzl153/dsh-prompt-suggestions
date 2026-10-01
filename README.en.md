# dsh-prompt-suggestions

Next-message suggestions for the DeepSeek Harness composer. Once the assistant finishes replying, the empty input box shows a gray suggestion of what you are most likely to send next, based on the current conversation. Press **Tab** to accept it or **Esc** to dismiss it. The suggestion disappears as soon as you start typing and comes back when the box is empty again.

[中文](README.md)

## Install

Add the dependency and bundle to your profile's `package.json` (e.g. `~/.dsh/profiles/web`):

```json
{
  "dependencies": { "dsh-prompt-suggestions": "^0.1.3" },
  "dsh": { "profile": { "bundles": ["...existing...", "dsh-prompt-suggestions"] } }
}
```

Run `pnpm install` in that directory and restart DSH. For the desktop app, quit from the tray and reopen it.

Requires DSH 0.1.7-rc.2 or later.

## Model

By default the plugin picks a DeepSeek flash model, with thinking off and at most 80 output tokens per suggestion. To choose another model, add this to the profile's `cordis.patch.yml`:

```yaml
- id: dsh-prompt-suggestions
  config:
    provider: deepseek-official
    model: deepseek-flash
```

`provider` and `model` must be set together. Other options: `maxContextChars` (conversation text sent to the model, default 6000) and `timeoutMs` (default 10000).

## Notes

- The model is called once per assistant reply and the result is cached per session, so clearing the input repeatedly costs nothing extra.
- Suggestions only appear when the assistant has finished and it is your turn; nothing is shown in a new session or while the assistant is working.
- The model receives the text of the last few turns of the current session, through the same model service you configured in DSH. DSH keeps the API key; the plugin never sees it.
- The suggestion endpoint is mounted on DSH's own web server and reuses its login check, so unauthenticated requests are rejected.
- Tab is left alone while an input method is composing, and while the `/` command or `@` reference menu is open.

## License

MIT
