/** @jsxImportSource @opentui/solid */
import { For, createMemo, type JSX } from "solid-js"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import {
  UsageError,
  clampPercent,
  fetchUsage,
  resolveApiKey,
  type GoUsage,
  type UsageWindow,
} from "./usage"
import { formatCountdown, formatRelative, progressBar } from "./format"

const BAR_WIDTH = 12
const DEFAULT_REFRESH_SECONDS = 60
const MIN_REFRESH_SECONDS = 30

/** Shared KV key the widget reads reactively and refresh() writes. */
const KV_KEY = "opencode-go-usage"

const WINDOW_KEYS = [
  { key: "rolling", label: "5h" },
  { key: "weekly", label: "wk" },
  { key: "monthly", label: "mo" },
] as const

type Level = "none" | "ok" | "warning" | "error"

type WidgetState = {
  status: "loading" | "no-key" | "ok" | "error"
  usage?: GoUsage
  fetchedAt?: number
  message?: string
}

const LOADING_STATE: WidgetState = { status: "loading" }

function isWidgetState(value: unknown): value is WidgetState {
  if (typeof value !== "object" || value === null) return false
  const status = (value as { status?: unknown }).status
  return status === "loading" || status === "no-key" || status === "ok" || status === "error"
}

function levelFor(percent: number | undefined): Level {
  if (percent === undefined) return "none"
  if (percent >= 90) return "error"
  if (percent >= 70) return "warning"
  return "ok"
}

function colorFor(theme: TuiThemeCurrent, level: Level): TuiThemeCurrent["text"] {
  switch (level) {
    case "ok":
      return theme.success
    case "warning":
      return theme.warning
    case "error":
      return theme.error
    default:
      return theme.textMuted
  }
}

function WindowRow(props: {
  label: string
  window: UsageWindow | undefined
  theme: TuiThemeCurrent
}): JSX.Element {
  const percent =
    typeof props.window?.percent === "number" ? Math.round(clampPercent(props.window.percent)) : undefined
  const color = colorFor(props.theme, levelFor(percent))

  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.theme.textMuted} width={3} wrapMode="none">
        {props.label}
      </text>
      <text fg={color} width={4} wrapMode="none">
        {percent === undefined ? "—" : `${percent}%`}
      </text>
      <text fg={color} wrapMode="none">
        {percent === undefined ? "" : progressBar(percent, BAR_WIDTH)}
      </text>
      <text fg={props.theme.textMuted} wrapMode="none">
        {formatCountdown(Date.now(), props.window?.resetsAt)}
      </text>
    </box>
  )
}

/**
 * The widget derives all of its data from `api.kv`, which is backed by the
 * host's Solid store. Reading the key inside the component subscribes it to the
 * host's reactive graph; writing the key from refresh() triggers a repaint.
 * This is the same mechanism the built-in sidebar plugins use via `api.state`
 * (anomalyco/opencode#39986 makes plugin-local signals unrenderable on stable).
 */
function UsageWidget(props: { api: TuiPluginApi }): JSX.Element {
  const snapshot = createMemo<WidgetState>(() => {
    const raw = props.api.kv.get(KV_KEY)
    return isWidgetState(raw) ? raw : LOADING_STATE
  })
  const theme = createMemo<TuiThemeCurrent>(() => props.api.theme.current)

  const state = snapshot()
  const usage = state.usage
  const percents = [usage?.rolling?.percent, usage?.weekly?.percent, usage?.monthly?.percent].filter(
    (value): value is number => typeof value === "number",
  )
  const max = percents.length > 0 ? Math.max(...percents) : undefined
  const overall: Level = state.status === "error" && !usage ? "error" : levelFor(max)
  const t = theme()
  const dot = state.status === "loading" ? t.textMuted : colorFor(t, overall)
  const statusLine =
    state.status === "error"
      ? (state.message ?? "Unavailable")
      : state.status === "loading"
        ? "Loading…"
        : ""

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={dot}>●</text>
        <text fg={t.text}>
          <b>Go usage</b>
        </text>
        <text fg={t.textMuted}>{formatRelative(Date.now(), state.fetchedAt)}</text>
      </box>
      <For each={WINDOW_KEYS}>
        {(window) => (
          <WindowRow label={window.label} window={usage?.[window.key]} theme={t} />
        )}
      </For>
      {statusLine !== "" ? (
        <text fg={t.textMuted} wrapMode="none">
          {statusLine}
        </text>
      ) : null}
    </box>
  )
}

function refreshIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_REFRESH_SECONDS * 1000
  }
  return Math.max(MIN_REFRESH_SECONDS, Math.round(value)) * 1000
}

const tui: TuiPlugin = async (api, options) => {
  const opts = (options ?? {}) as Readonly<Record<string, unknown>>
  const refreshMs = refreshIntervalMs(opts["refreshSeconds"])

  let generation = 0
  let notified: string | null = null

  const refresh = async (): Promise<void> => {
    const mine = ++generation

    let key: Awaited<ReturnType<typeof resolveApiKey>>
    try {
      key = await resolveApiKey(opts)
    } catch {
      key = undefined
    }
    if (mine !== generation) return

    if (!key) {
      api.kv.set(KV_KEY, { status: "no-key" })
      return
    }

    try {
      const usage = await fetchUsage(key.apiKey, { baseUrl: opts["baseUrl"] })
      if (mine !== generation) return
      notified = null
      api.kv.set(KV_KEY, { status: "ok", usage, fetchedAt: Date.now() })
    } catch (error) {
      if (mine !== generation) return
      const message =
        error instanceof UsageError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error)
      if (notified !== message) {
        notified = message
        api.ui.toast({ variant: "error", title: "Go usage", message, duration: 6000 })
      }
      const prev = api.kv.get(KV_KEY)
      api.kv.set(KV_KEY, {
        status: "error",
        message,
        usage: isWidgetState(prev) ? prev.usage : undefined,
        fetchedAt: isWidgetState(prev) ? prev.fetchedAt : undefined,
      })
    }
  }

  api.kv.set(KV_KEY, LOADING_STATE)

  api.slots.register({
    order: 650,
    slots: {
      sidebar_content() {
        return <UsageWidget api={api} />
      },
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "go-usage.refresh",
        title: "Refresh OpenCode Go usage",
        category: "Plugin",
        namespace: "palette",
        slashName: "go-usage",
        run() {
          void refresh()
        },
      },
    ],
    bindings: [{ key: "ctrl+alt+g", cmd: "go-usage.refresh", desc: "Refresh OpenCode Go usage" }],
  })

  void refresh()
  const timer = setInterval(() => void refresh(), refreshMs)
  api.lifecycle.onDispose(() => clearInterval(timer))
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-go-usage",
  tui,
}

export default plugin