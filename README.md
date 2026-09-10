# opencode-go-usage

An [OpenCode](https://opencode.ai) **TUI plugin** that shows your **OpenCode Go**
subscription usage in the session sidebar: the rolling 5-hour, weekly, and
monthly quota windows with used percentage, reset countdown, and a warning
color as you approach a limit.

```
● Go usage              2m ago
5h  12%  █░░░░░░░░░░░  2h 15m
wk  78%  █████████░░░  3d 4h
mo  94%  ███████████░  12d
```

- Colors: green under 70%, yellow 70–89%, red 90%+ (relative to the highest
  window).
- Refreshes on an interval (default 60s) and via the `Go usage` command.
- Keeps the last known values if a refresh fails, and toasts once per failure.
- Hides itself when OpenCode Go is not configured on this machine.

## How it works

OpenCode Go exposes a quota endpoint — the same one the web console uses:

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <your Go API key>
```

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 12, "resetsAt": "…" },
    "weekly":  { "status": "ok", "percent": 78, "resetsAt": "…" },
    "monthly": { "status": "ok", "percent": 94, "resetsAt": "…" }
  }
}
```

The plugin reads your Go API key from the same places opencode does:

1. `options.apiKey` (plugin option — always wins)
2. the `OPENCODE_API_KEY` environment variable
3. the opencode auth file (`opencode-go`, then legacy `opencode`)

## Install

TUI plugins are configured in `tui.json` (not `opencode.json`). Add the plugin
to the `plugin` array:

```jsonc
// ~/.config/opencode/tui.json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-go-usage"]
}
```

Restart opencode after changing `tui.json`.

### Options

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "opencode-go-usage",
      { "refreshSeconds": 120, "baseUrl": "https://opencode.ai/zen/go" }
    ]
  ]
}
```

| Option           | Type     | Default                        | Description                                   |
| ---------------- | -------- | ------------------------------ | --------------------------------------------- |
| `apiKey`         | `string` | auto-detected                  | Go API key override.                          |
| `refreshSeconds` | `number` | `60`                           | Refresh interval (clamped to a 30s minimum).  |
| `baseUrl`        | `string` | `https://opencode.ai/zen/go`   | Usage API base; `/v1/usage` is appended.      |

## Command

`Go usage · refresh` — command palette entry with default binding
`ctrl+alt+g`, also available as `/go-usage`.

## Local development

Point `tui.json` at the source file directly:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///absolute/path/to/opencode-go-usage/src/tui.tsx"]
}
```

```sh
npm install
npm run typecheck
```

## Limitations

- The `/zen/go/v1/usage` endpoint is not in the public Go docs. It is the
  endpoint the console uses; if it changes, this plugin needs a small update.
- The widget lives in the session sidebar. If the sidebar is hidden, it is not
  rendered.
- Percentages are account-wide, the same numbers as the web console.

## License

MIT
