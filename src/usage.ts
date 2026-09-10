import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * OpenCode Go quota client.
 *
 * Go exposes an (undocumented) usage endpoint that the web console is built on:
 *
 *   GET https://opencode.ai/zen/go/v1/usage
 *   Authorization: Bearer <Go API key>
 *
 * It reports the used percentage and reset time for each of the three
 * subscription windows (rolling 5h / weekly / monthly).
 */

/** One quota window as reported by the usage endpoint. */
export interface UsageWindow {
  status?: string
  percent?: number
  resetsAt?: string
}

/** The three OpenCode Go subscription quota windows. */
export interface GoUsage {
  rolling?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageWindow
}

export const DEFAULT_BASE_URL = "https://opencode.ai/zen/go"

/** Hard deadline for one usage request, covering the request and the body read. */
export const DEFAULT_TIMEOUT_MS = 12_000

/** A resolved API key plus where it came from (for diagnostics). */
export interface ResolvedKey {
  apiKey: string
  source: "option" | "env" | "auth"
}

export type UsageErrorKind =
  | "no-key"
  | "config"
  | "unauthorized"
  | "no-subscription"
  | "bad-response"
  | "network"
  | "http"

export class UsageError extends Error {
  readonly kind: UsageErrorKind
  readonly status?: number

  constructor(kind: UsageErrorKind, message: string, status?: number) {
    super(message)
    this.name = "UsageError"
    this.kind = kind
    this.status = status
  }
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

/**
 * Resolve the OpenCode Go API key, mirroring opencode's own resolution order:
 * plugin option -> OPENCODE_API_KEY env -> auth.json (`opencode-go`, then the
 * legacy `opencode` entry).
 */
export async function resolveApiKey(
  options: Readonly<Record<string, unknown>> = {},
): Promise<ResolvedKey | undefined> {
  const fromOption = options["apiKey"]
  if (typeof fromOption === "string" && fromOption.trim()) {
    return { apiKey: fromOption.trim(), source: "option" }
  }

  const fromEnv = process.env["OPENCODE_API_KEY"]
  if (fromEnv && fromEnv.trim()) {
    return { apiKey: fromEnv.trim(), source: "env" }
  }

  const auth = await readAuthFile()
  if (auth) {
    for (const provider of ["opencode-go", "opencode"] as const) {
      const entry = auth[provider]
      if (!entry || typeof entry !== "object") continue
      const key =
        typeof entry.key === "string"
          ? entry.key
          : typeof entry.apiKey === "string"
            ? entry.apiKey
            : undefined
      if (key && key.trim()) return { apiKey: key.trim(), source: "auth" }
    }
  }

  return undefined
}

/**
 * Fetch the usage windows for the current subscription. The whole exchange is
 * bounded by `timeoutMs` so it can never hang the widget.
 */
export async function fetchUsage(
  apiKey: string,
  options: { baseUrl?: unknown; timeoutMs?: number } = {},
): Promise<GoUsage> {
  const baseUrl = assertSecureBaseUrl(
    stripTrailingSlashes(
      (typeof options.baseUrl === "string" ? options.baseUrl : "").trim() || DEFAULT_BASE_URL,
    ),
  )
  const url = `${baseUrl}/v1/usage`

  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS
  const deadline = AbortSignal.timeout(timeoutMs)
  const timeoutMessage = `OpenCode Go usage request did not respond within ${timeoutMs}ms`

  let response: Response
  try {
    response = await withTimeout(
      fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        // Never follow a redirect with the bearer token attached.
        redirect: "error",
        signal: deadline,
      }),
      timeoutMs,
      timeoutMessage,
    )
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError("network", deadline.aborted ? timeoutMessage : `Could not reach ${url}`)
  }

  if (response.status === 401) {
    throw new UsageError("unauthorized", "OpenCode Go API key was rejected (HTTP 401)")
  }
  if (response.status === 403) {
    throw new UsageError("no-subscription", "No OpenCode Go subscription on this key (HTTP 403)")
  }
  if (!response.ok) {
    throw new UsageError(
      "http",
      `OpenCode Go usage endpoint returned HTTP ${response.status}`,
      response.status,
    )
  }

  let body: unknown
  try {
    body = await withTimeout(response.json(), timeoutMs, timeoutMessage)
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new UsageError("bad-response", "OpenCode Go usage response was not valid JSON")
  }

  const usage = parseUsage(body)
  if (!usage) {
    throw new UsageError("bad-response", "OpenCode Go usage response did not match the expected shape")
  }
  return usage
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UsageError("network", timeoutMessage)), timeoutMs)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function parseUsage(body: unknown): GoUsage | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const usage = (body as Record<string, unknown>)["usage"]
  if (typeof usage !== "object" || usage === null) return undefined

  const record = usage as Record<string, unknown>
  const result: GoUsage = {}
  let found = false

  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const raw = record[key]
    if (typeof raw !== "object" || raw === null) continue
    const window = raw as Record<string, unknown>

    const percentRaw = window["percent"] ?? window["usagePercent"]
    const percent = typeof percentRaw === "number" ? clampPercent(percentRaw) : undefined

    let resetsAt: string | undefined
    const resetsAtRaw = window["resetsAt"] ?? window["resets_at"]
    if (typeof resetsAtRaw === "string" && !Number.isNaN(Date.parse(resetsAtRaw))) {
      resetsAt = resetsAtRaw
    } else {
      const resetInSecRaw = window["resetInSec"] ?? window["reset_in_sec"]
      if (typeof resetInSecRaw === "number" && Number.isFinite(resetInSecRaw)) {
        resetsAt = new Date(Date.now() + resetInSecRaw * 1000).toISOString()
      }
    }

    result[key] = {
      status: typeof window["status"] === "string" ? window["status"] : undefined,
      percent,
      resetsAt,
    }
    found = true
  }

  return found ? result : undefined
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}

/**
 * The API key is a credential, so it must only ever be sent over TLS. `http://`
 * is tolerated solely for localhost/loopback so a mock server can be used for
 * local testing.
 */
function assertSecureBaseUrl(baseUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new UsageError("config", `Invalid baseUrl: "${baseUrl}"`)
  }
  if (parsed.protocol === "https:") return baseUrl
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase()
    const isLoopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
    if (isLoopback) return baseUrl
  }
  throw new UsageError(
    "config",
    "baseUrl must use https; http is only allowed for localhost/loopback",
  )
}

type AuthEntry = { key?: unknown; apiKey?: unknown }
type AuthFile = Record<string, AuthEntry>

/**
 * Candidate locations for the credential file opencode's `auth login` writes.
 * opencode has used both the XDG data dir and the macOS Application Support dir.
 */
function authFilePaths(): string[] {
  const paths: string[] = []
  const explicit = process.env["OPENCODE_AUTH_JSON"]
  if (explicit && explicit.trim()) paths.push(explicit.trim())

  const home = homedir()
  const xdg = process.env["XDG_DATA_HOME"]?.trim() || join(home, ".local", "share")
  paths.push(join(xdg, "opencode", "auth.json"))
  paths.push(join(home, "Library", "Application Support", "opencode", "auth.json"))

  const localAppData = process.env["LOCALAPPDATA"]
  if (localAppData) paths.push(join(localAppData, "opencode", "auth.json"))

  return paths
}

async function readAuthFile(): Promise<AuthFile | undefined> {
  for (const file of authFilePaths()) {
    try {
      const raw = await readFile(file, "utf8")
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null) continue
      return parsed as AuthFile
    } catch {
      // try the next candidate
    }
  }
  return undefined
}
