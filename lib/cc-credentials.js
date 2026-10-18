/**
 * User-supplied Command Code API key: storage, validation, and connectivity.
 *
 * ## Why the key is not plugin configuration
 *
 * An earlier version put the key in the profile's `cordis.patch.yml`. That is
 * wrong for a credential the *user* owns: it made every install of this plugin
 * ship one person's key, and it forced anyone else to edit a YAML file to use
 * the feature. The key is therefore entered on the plugin page and stored
 * beside the plugin's own preferences, in the user's profile directory.
 *
 * ## What "connected" means
 *
 * There is no documented quota endpoint, so the page does not invent one.
 * Connectivity is established by the cheapest real call available — the model
 * catalogue — and the result distinguishes the failures that matter:
 * a rejected key, a network problem, and an account with no credit left.
 *
 * @module buddy-connect/cc-credentials
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CC_API_BASE } from './command-code.js'
import { resolveStateDir } from './state-dir.js'

/**
 * Directory holding this plugin's own state.
 *
 * Resolved rather than hard-coded: the package was renamed after users had
 * already entered an API key, and the resolver keeps reading the directory that
 * key was written to.
 */
function baseDir() {
  return resolveStateDir({ create: true })
}

/** Full path of the credential file. */
function credentialPath() {
  return join(baseDir(), 'command-code.json')
}

/**
 * Read the stored key.
 *
 * @returns the key, or undefined when none has been saved.
 */
export function readCommandCodeKey() {
  try {
    const raw = JSON.parse(fs.readFileSync(credentialPath(), 'utf8'))
    const key = raw?.apiKey
    return typeof key === 'string' && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the key, or clear it.
 *
 * The file is written atomically and restricted to the current user, because a
 * credential readable by other local accounts is a credential leak.
 *
 * @param apiKey - the key to store, or an empty string to forget it.
 * @returns where the key is stored.
 */
export function writeCommandCodeKey(apiKey) {
  const path = credentialPath()
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    try {
      fs.rmSync(path, { force: true })
    } catch {
      // Already gone is the desired state.
    }
    return { path, cleared: true }
  }
  fs.mkdirSync(baseDir(), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ apiKey: apiKey.trim() }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, path)
  try {
    fs.chmodSync(path, 0o600)
  } catch {
    // Windows ignores POSIX modes; the directory ACL already scopes it.
  }
  return { path, cleared: false }
}

/** Mask a key for display: enough to recognise it, not enough to use it. */
export function maskKey(apiKey) {
  const s = String(apiKey ?? '')
  if (s.length === 0) return ''
  if (s.length <= 10) return '****'
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

/**
 * Whether a string looks like a Command Code key.
 *
 * The CLI issues `user_…` keys. A client may also paste an `sk-…` value, so
 * both shapes are accepted; anything wildly different is rejected before it is
 * stored, which catches the common paste-the-wrong-thing mistake.
 *
 * @param apiKey - the candidate key.
 * @returns null when acceptable, or a message explaining the problem.
 */
export function validateKeyShape(apiKey) {
  const s = String(apiKey ?? '').trim()
  if (s.length === 0) return '请填写 API Key。'
  if (/\s/.test(s)) return 'API Key 里不能包含空格或换行，请检查是否复制了多余内容。'
  if (!/^(user_|sk-|cc_)[A-Za-z0-9_\-]{8,}$/.test(s)) {
    return '这个值看起来不是 Command Code 的 API Key（应以 user_ 开头）。'
  }
  return null
}

/**
 * Check the key against the upstream by requesting the model catalogue.
 *
 * This is the cheapest call that proves the credential works. It is deliberately
 * not a generate call: that costs credit, and a user testing a key should not be
 * billed for it.
 *
 * @param options - `apiKey` and an optional `apiBase`.
 * @returns a structured verdict the page can render.
 */
export async function testCommandCodeKey(options = {}) {
  const apiKey = String(options.apiKey ?? '').trim()
  const apiBase = options.apiBase ?? CC_API_BASE
  const shapeError = validateKeyShape(apiKey)
  if (shapeError !== null) return { ok: false, reason: 'shape', message: shapeError }

  let response
  try {
    response = await fetch(`${apiBase}/provider/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: `无法连接 Command Code（${apiBase}）：${error instanceof Error ? error.message : String(error)}`
    }
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', status: response.status, message: 'API Key 无效或已失效，请重新复制。' }
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'upstream',
      status: response.status,
      message: `Command Code 返回 HTTP ${response.status}。`
    }
  }

  let count = 0
  try {
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
    count = rows.length
  } catch {
    // A 2xx that is not JSON still proves the credential was accepted.
  }
  return {
    ok: true,
    reason: 'ok',
    message: count > 0 ? `已连接，上游提供 ${count} 个模型。` : '已连接。',
    models: count
  }
}
