/** @jsxImportSource @opentui/solid */
import { For, type JSX } from "solid-js"
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
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
 * Stateless usage widget. A fresh element is mounted for every snapshot rather
 * than relying on reactive updates: on the packaged CLI, plugin slot
 * contributions paint once at mount and their reactive signal updates are not
 * propagated to the host renderer (anomalyco/opencode#39986). Remounting the
 * slot contribution is a fresh initial paint, which always renders.
 */
function UsageWidget(props: { state: WidgetState; theme: TuiThemeCurrent }): JSX.Element {
  const usage = props.state.usage
  const percents = [usage?.rolling?.percent, usage?.weekly?.percent, usage?.monthly?.percent].filter(
    (value): value is number => typeof value === "number",
  )
  const max = percents.length > 0 ? Math.max(...percents) : undefined
  const overall: Level = props.state.status === "error" && !usage ? "error" : levelFor(max)
  const dot =
    props.state.status === "loading" ? props.theme.textMuted : colorFor(props.theme, overall)
  const statusLine =
    props.state.status === "error"
      ? (props.state.message ?? "Unavailable")
      : props.state.status === "loading"
        ? "Loading…"
        : ""

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={dot}>●</text>
        <text fg={props.theme.text}>
          <b>Go usage</b>
        </text>
        <text fg={props.theme.textMuted}>{formatRelative(Date.now(), props.state.fetchedAt)}</text>
      </box>
      <For each={WINDOW_KEYS}>
        {(window) => (
          <WindowRow label={window.label} window={usage?.[window.key]} theme={props.theme} />
        )}
      </For>
      {statusLine !== "" ? (
        <text fg={props.theme.textMuted} wrapMode="none">
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
  let current: WidgetState = { status: "loading" }
  let disposeSlot: (() => void) | undefined

  /**
   * Remount the sidebar contribution with an immutable snapshot. The host's
   * `slots.register` is typed as returning a string id, but at runtime it
   * returns the slot registry's unregister function; keep a no-op fallback in
   * case that ever changes.
   */
  const renderWidget = (snapshot: WidgetState): void => {
    current = snapshot
    disposeSlot?.()
    disposeSlot = undefined
    if (snapshot.status === "no-key") return
    const registered = api.slots.register({
      order: 650,
      slots: {
        sidebar_content(ctx) {
          return <UsageWidget state={snapshot} theme={ctx.theme.current} />
        },
      },
    }) as unknown as (() => void) | string
    disposeSlot = typeof registered === "function" ? registered : () => {}
  }

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
      renderWidget({ status: "no-key" })
      return
    }

    try {
      const usage = await fetchUsage(key.apiKey, { baseUrl: opts["baseUrl"] })
      if (mine !== generation) return
      notified = null
      renderWidget({ status: "ok", usage, fetchedAt: Date.now() })
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
      renderWidget({ status: "error", message, usage: current.usage, fetchedAt: current.fetchedAt })
    }
  }

  renderWidget(current)

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
  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    disposeSlot?.()
    disposeSlot = undefined
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-go-usage",
  tui,
}

export default plugin
