/**
 * 守护进程发现: find the local daemon and read the credentials it owns.
 *
 * The daemon keeps everything in one data directory (`%USERPROFILE%\.buddyhub`,
 * overridable with `BUDDYHUB_DATA`). `config.json` in that directory is the
 * single source of truth for the two loopback ports and the two bearer keys:
 *
 *   {"version":1,"port":8787,"adminPort":8790,"defaultSite":"cn",
 *    "localKey":"<48 hex>","adminKey":"<64 hex>", ...}
 *
 * The proxy key (`localKey`) authenticates model calls on `port`; the admin key
 * (`adminKey`) authenticates management calls on `adminPort`. Both are stored
 * in plaintext — 守护进程 only encrypts the account vault.
 *
 * Nothing here talks to the network except `probeProxy`, which performs a
 * single unauthenticated `/health` request.
 *
 * @module dsh-command-buddy-connect/daemon-discovery
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Default proxy port when `config.json` omits `port`. */
export const DEFAULT_PORT = 8787
/** Default admin port when `config.json` omits `adminPort`. */
export const DEFAULT_ADMIN_PORT = 8790
/** Default region when `config.json` omits `defaultSite`. */
export const DEFAULT_SITE = 'cn'

/**
 * The base model id the daemon's proxy serves, before the region suffix.
 *
 * The proxy hardcodes exactly one upstream model and expands it into one route
 * per region, so this is not discoverable — see {@link DAEMON_MODEL_IDS}.
 */
export const DAEMON_BASE_MODEL = 'deepseek-v4.1-flash'

/**
 * The two model ids 守护进程 advertises from `GET /v1/models`.
 *
 * The CN and international pools are deliberately independent: the proxy never
 * falls back across regions, so a CN route with no live CN account fails even
 * when an international account is healthy.
 */
export const DAEMON_MODEL_IDS = ['deepseek-v4.1-flash-cn', 'deepseek-v4.1-flash-ai']

/**
 * Reasoning-effort spellings 守护进程 accepts on the wire.
 *
 * The proxy keeps a `reasoning_effort` only when it is one of these; any other
 * value is silently dropped rather than rejected.
 */
export const DAEMON_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Resolve the 守护进程 data directory.
 *
 * `BUDDYHUB_DATA` wins when set (the daemon reads it the same way), then the
 * `dataDir` config field, then `%USERPROFILE%\.buddyhub`.
 *
 * @param explicit - a directory from plugin configuration, when set.
 * @returns the absolute data directory path.
 */
export function resolveDataDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) return resolve(explicit.trim())
  const fromEnv = process.env.BUDDYHUB_DATA
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.buddyhub')
}

/**
 * Read and normalize the daemon's `config.json`.
 *
 * A missing or malformed file is not an error: the daemon may not be installed
 * yet, and the plugin still needs to register its provider so that installing
 * 守护进程 later takes effect on the next request without a restart. Callers
 * distinguish "not installed" from "installed" through {@link ReadConfigResult.exists}.
 *
 * @param dataDir - absolute 守护进程 data directory.
 * @returns the parsed settings, whether the file existed, and any read error.
 */
export function readConfig(dataDir) {
  const path = join(dataDir, 'config.json')
  if (!existsSync(path)) return { path, exists: false, config: defaults(), error: undefined }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { path, exists: true, config: defaults(), error: `cannot parse ${path}: ${message(error)}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { path, exists: true, config: defaults(), error: `${path} is not a JSON object` }
  }
  return { path, exists: true, config: normalize(raw), error: undefined }
}

/**
 * Normalize the fields this plugin consumes, keeping the file's own defaults
 * when a value is absent or the wrong type. The daemon rewrites this file
 * whenever the user changes a setting, so every field is re-read per request
 * and never cached across one.
 *
 * @param raw - the parsed `config.json` object.
 * @returns the settings this plugin needs.
 */
function normalize(raw) {
  const fallback = defaults()
  return {
    port: port(raw.port, fallback.port),
    adminPort: port(raw.adminPort, fallback.adminPort),
    localKey: text(raw.localKey),
    adminKey: text(raw.adminKey),
    defaultSite: raw.defaultSite === 'ai' ? 'ai' : fallback.defaultSite,
    checkinEnabled: raw.checkinEnabled === true,
    checkinTime: text(raw.checkinTime) ?? fallback.checkinTime,
    proxyEnabled: raw.proxyEnabled !== false,
    dataDir: fallback.dataDir
  }
}

/** Settings used when no `config.json` is readable. */
function defaults() {
  return {
    port: DEFAULT_PORT,
    adminPort: DEFAULT_ADMIN_PORT,
    localKey: undefined,
    adminKey: undefined,
    defaultSite: DEFAULT_SITE,
    checkinEnabled: false,
    checkinTime: '09:00',
    proxyEnabled: false,
    dataDir: undefined
  }
}

/** Coerce a JSON number into a usable TCP port, or fall back. */
function port(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback
}

/** Coerce a JSON value into a non-empty trimmed string. */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Read one `Error`'s message without assuming the thrown value is an Error. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ask the proxy's public health route whether a daemon is listening.
 *
 * `/health` is the only route that needs no key, which makes it the right
 * liveness probe: it distinguishes "守护进程 is running" from "a key is wrong"
 * without spending a model call.
 *
 * @param baseUrl - proxy root, e.g. `http://127.0.0.1:8787`.
 * @param signal - cancellation for the probe.
 * @returns the health payload, or an error description when unreachable.
 */
export async function probeProxy(baseUrl, signal) {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: signal ?? AbortSignal.timeout(3000),
      headers: { accept: 'application/json' }
    })
    if (!response.ok) return { ok: false, error: `health returned HTTP ${response.status}` }
    const body = await response.json()
    if (body === null || typeof body !== 'object') return { ok: false, error: 'health returned a non-object body' }
    return { ok: true, health: body }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

/**
 * Call one 守护进程 admin route.
 *
 * Two behaviours of the admin server are load-bearing here:
 *
 * 1. The `Origin` header must be absent. Any request carrying a non-empty
 *    `Origin` is rejected with 403 `管理接口仅供桌面软件使用`, before routing —
 *    a deliberate anti-CSRF guard, since the server has no CORS support. Node's
 *    `fetch` does not set `Origin` by default, so this holds as long as callers
 *    do not add it.
 * 2. Authentication is checked before the `Origin` guard, so a wrong key
 *    reports 401 even when the request would also have been refused.
 *
 * @param options - admin endpoint, key, method, and optional JSON body.
 * @returns the decoded response, or a structured failure.
 */
export async function adminRequest(options) {
  const { adminBaseUrl, adminKey, path, method = 'GET', body, signal } = options
  if (typeof adminKey !== 'string' || adminKey.length === 0) {
    return { ok: false, status: 0, error: '守护进程 admin key is unavailable; no readable config.json' }
  }
  const headers = { authorization: `Bearer ${adminKey}`, accept: 'application/json' }
  let payload
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(`${adminBaseUrl}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      ...(signal === undefined ? {} : { signal })
    })
  } catch (error) {
    return { ok: false, status: 0, error: `cannot reach the 守护进程 admin server: ${message(error)}` }
  }
  const raw = await response.text()
  let decoded
  try {
    decoded = raw.length === 0 ? undefined : JSON.parse(raw)
  } catch {
    decoded = undefined
  }
  if (!response.ok) {
    // The admin server answers every failure, including unknown routes, with
    // HTTP 400 and an `{"error": "..."}` body; there is no 404 there.
    const detail = decoded !== null && typeof decoded === 'object' && typeof decoded.error === 'string' ? decoded.error : raw.trim()
    return {
      ok: false,
      status: response.status,
      error: detail.length > 0 ? `守护进程 admin HTTP ${response.status}: ${detail}` : `守护进程 admin HTTP ${response.status}`
    }
  }
  return { ok: true, status: response.status, data: decoded }
}
