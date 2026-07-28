# OpenCode Temporal Context plugin

This local OpenCode plugin adds sparse calendar-day boundaries to the model-facing conversation history. It does not modify the stored session or display markers in the OpenCode UI.

## Behavior

For a session spanning several days, the model effectively receives:

```text
Current date: 2026-07-30

<conversation_date value="2026-07-28"/>
User: Check the deployment.
Assistant: It is healthy.

<conversation_date value="2026-07-29"/>
User: Check again.
Assistant: Still healthy.

<conversation_date current="true"/>
User: Check again.
```

The current group does not repeat the absolute date. The `current="true"` marker is emitted only when needed to separate the current group from an older group. If all visible user turns are from the current day, no message marker is emitted.

Dates are assigned to user turns. The assistant response following a user message remains part of that turn, even if the response crosses midnight. This avoids inserting synthetic text into stored assistant reasoning or tool-call structures.

During compaction, the plugin tells the summarizer to preserve absolute dates only when chronology, freshness, deadlines, checks, decisions, state transitions, or future actions depend on them.

## Install globally

```sh
mkdir -p ~/.config/opencode/plugins
cp temporal-context.ts ~/.config/opencode/plugins/temporal-context.ts
```

Restart OpenCode after installing or changing the plugin.

OpenCode automatically loads TypeScript files from `~/.config/opencode/plugins/`. No external runtime dependencies are used.

## Install for one project

```sh
mkdir -p .opencode/plugins
cp temporal-context.ts .opencode/plugins/temporal-context.ts
```

## Timezone

By default, the plugin uses the timezone of the machine running OpenCode. Override it with an IANA timezone:

```sh
OPENCODE_TEMPORAL_TIMEZONE=Europe/Berlin opencode
```

The plugin also normalizes OpenCode's existing environment date to ISO format using the same timezone.

## Development

The tests are optional and not needed for installation. They compile against the real OpenCode plugin types:

```sh
npm ci
npm test
```

## Compatibility

The implementation exposes one loader-safe default plugin function and uses these experimental hooks:

- `experimental.chat.messages.transform`
- `experimental.chat.system.transform`
- `experimental.session.compacting`

OpenCode may change experimental hook contracts. The plugin was written against the `dev` branch interfaces available on 2026-07-28 and type-checked against `@opencode-ai/plugin` 1.3.17.

## License

MIT
