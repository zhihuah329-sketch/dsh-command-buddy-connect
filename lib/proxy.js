/**
 * An in-process reverse proxy for the region pools.
 *
 * the daemon's own proxy (`native/src/proxy.rs`) is the reference for every rule
 * here. Reproducing them locally means this plugin can serve CN and AI pools
 * whether or not the local daemon is running, and behave identically when
 * it is:
 *
 * 1. **Region pools never cross over.** `deepseek-v4.1-flash-cn` only ever
 *    draws from CN accounts and `-ai` only from international ones. A CN model
 *    with no live CN account fails; it does not silently borrow an AI one.
 * 2. **Least-in-flight rotation within a pool.** The next account is the one
 *    with the fewest in-flight requests, broken by a per-region round-robin
 *    cursor. Cooldown, disabled, and signed-out accounts are skipped.
 * 3. **Account-scoped session identity.** A stable conversation id is mintedon
 *    id per (account, client session) pair and a stable turn id per
 *    (account, session, turn), then a fresh message id per model call. The
 *    upstream requires these or answers `11128 conversation id missing`.
 * 4. **Rotate only on retryable failures.** `429`, `5xx`, `401`/`403`,
 *    business codes `401/403/429/10001`, and quota wording rotate to another
 *    account. `11128` is explicitly *not* a rotation trigger: it is a metadata
 *    bug, and rotating would burn every account in the pool on it.
 * 5. **SSE frames are normalised, empty frames dropped.** Upstream emits sparse
 *    deltas carrying empty strings; forwarding those makes clients flicker.
 *
 * @module buddy-connect/proxy
 */

import crypto from 'node:crypto'

/** The single upstream model id, before the region suffix. */
export const BASE_MODEL = 'deepseek-v4.1-flash'

/** The two region routes, and the only models this provider advertises. */
export const MODEL_IDS = [`${BASE_MODEL}-cn`, `${BASE_MODEL}-ai`]

/** Reasoning-effort spellings the upstream accepts. */
export const EFFORT_IDS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Upstream bases per region. */
export const HOSTS = {
  cn: ['https://www.workbuddy.cn', 'https://copilot.tencent.com'],
  ai: ['https://www.workbuddy.ai', 'https://www.codebuddy.ai']
}

/** Business codes that mean "try a different account". */
const ROTATE_CODES = new Set([401, 403, 429, 10001])

/** Wording that indicates a quota problem rather than a request problem. */
const QUOTA_WORDS = [
  'quota', 'credit', 'balance', 'insufficient',
  '余额', '积分', '额度', '超限', 'rate limit', 'rate_limit'
]

/** Cooldown applied to an account that failed in a rotating way. */
const COOLDOWN_MS = 60_000

/**
 * Ceiling for the escalating cooldown.
 *
 * A flat 60s cooldown is right for a one-off blip and wrong for a sustained
 * rate limit: the upstream keeps answering 429, the account becomes eligible
 * again a minute later, is picked again, and fails again. The event log showed
 * exactly that — hundreds of `HTTP 429` rotations a few minutes apart, each one
 * a wasted request that also counted against the account. Escalating the
 * cooldown makes a persistently limited account step out of rotation instead of
 * burning every other attempt.
 */
const MAX_COOLDOWN_MS = 15 * 60_000

/** How many consecutive failures before the cooldown starts doubling. */
const COOLDOWN_ESCALATE_AFTER = 2

/** How many accounts one request may try before giving up. */
const MAX_ACCOUNTS = 8

/**
 * Split a client model id into the upstream model, the region, and an optional
 * effort encoded in a legacy alias suffix.
 *
 * @param requested - the model id a client asked for.
 * @param fallbackSite - region used when the id carries no suffix.
 * @returns the upstream model, region, and effort, or null when unsupported.
 */
export function parseModel(requested, fallbackSite = 'cn') {
  let upstream = String(requested ?? '')
  let effort
  for (const e of EFFORT_IDS) {
    const suffix = `-think-${e}`
    if (upstream.endsWith(suffix)) {
      upstream = upstream.slice(0, -suffix.length)
      effort = e
      break
    }
  }
  if (effort === undefined && upstream.endsWith('-think')) {
    upstream = upstream.slice(0, -'-think'.length)
    effort = 'max'
  }
  let site = fallbackSite
  if (upstream.endsWith('-cn')) {
    upstream = upstream.slice(0, -3)
    site = 'cn'
  } else if (upstream.endsWith('-ai')) {
    upstream = upstream.slice(0, -3)
    site = 'ai'
  }
  if (upstream !== BASE_MODEL) return null
  return { upstream, site, effort }
}

/** Whether an upstream message body looks like a quota/billing problem. */
export function looksLikeQuota(text) {
  const t = String(text ?? '').toLowerCase()
  return QUOTA_WORDS.some((w) => t.includes(w))
}

/**
 * Decide whether a failed call should move to another account.
 *
 * @param status - HTTP status.
 * @param code - upstream business code, when present.
 * @param message - any upstream message text.
 * @returns true when rotating is the right response.
 */
export function shouldRotate(status, code, message) {
  // A missing conversation id is a metadata defect; rotating cannot fix it and
  // would exhaust the pool, so it is deliberately excluded.
  if (Number(code) === 11128) return false
  if (status === 429 || status >= 500) return true
  if (status === 401 || status === 403) return true
  if (ROTATE_CODES.has(Number(code))) return true
  return looksLikeQuota(message)
}

/**
 * A UUIDv7 string: time-ordered, which is what the upstream expects for the
 * per-call message id.
 *
 * @returns 32 lowercase hex characters.
 */
export function uuid7Hex() {
  const bytes = crypto.randomBytes(16)
  const ms = BigInt(Date.now())
  bytes[0] = Number((ms >> 40n) & 0xffn)
  bytes[1] = Number((ms >> 32n) & 0xffn)
  bytes[2] = Number((ms >> 24n) & 0xffn)
  bytes[3] = Number((ms >> 16n) & 0xffn)
  bytes[4] = Number((ms >> 8n) & 0xffn)
  bytes[5] = Number(ms & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.toString('hex')
}

/** SHA-256 hex of anything JSON-serialisable, used to derive stable ids. */
function digestHex(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex')
}

/**
 * Derive the session and turn keys for one request.
 *
 * The fallback hashes the system + first user message, which keepss a
 * tool continuation inside one conversation without storing prompts. A client
 * that sends an opaque session header supplies a stronger key.
 *
 * @param payload - the request body being sent upstream.
 * @param sessionHint - a client-provided session key, when present.
 * @returns stable session and turn digests.
 */
export function requestContext(payload, sessionHint) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const system = messages.find((m) => m?.role === 'system')
  const initial = messages.find((m) => m?.role === 'user')
  const session = sessionHint && sessionHint.length > 0
    ? digestHex(sessionHint)
    : digestHex([system ?? null, initial ?? null])
  let end = messages.length
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') { end = i + 1; break }
  }
  return { session, turn: digestHex(messages.slice(0, end)) }
}

/**
 * Rewrite a client request body into the shape the upstream accepts.
 *
 * @param input - the client body.
 * @returns a new body safe to send upstream.
 */
export function preparePayload(input) {
  const v = { ...input, stream: true }
  if (Array.isArray(v.messages)) {
    v.messages = v.messages.map((m) =>
      String(m?.role ?? '').toLowerCase() === 'developer' ? { ...m, role: 'system' } : m)
    if (v.messages.length === 0 || String(v.messages[0]?.role ?? '').toLowerCase() !== 'system') {
      v.messages.unshift({ role: 'system', content: 'You are a helpful AI assistant.' })
    }
  }

  // `tool_choice` must be a name string or one of auto/required/none.
  const tc = v.tool_choice
  const kind = typeof tc === 'object' && tc !== null
    ? String(tc.type ?? '').toLowerCase()
    : String(tc ?? '').toLowerCase()
  if (kind === 'none') {
    delete v.tool_choice
    delete v.tools
  } else if (kind === 'function') {
    v.tool_choice = tc?.function?.name ?? tc?.name ?? 'auto'
  } else if (kind === 'auto' || kind === 'required') {
    if (typeof tc === 'object' && tc !== null) v.tool_choice = kind
  } else if (typeof tc === 'object' && tc !== null) {
    delete v.tool_choice
  }

  // Fold the newer `reasoning` object into the flat `reasoning_effort` field.
  if (v.reasoning !== null && typeof v.reasoning === 'object') {
    if (v.reasoning_effort === undefined || v.reasoning_effort === null) {
      v.reasoning_effort = v.reasoning.effort
    }
    if (v.reasoning.enabled === false) v.reasoning_effort = 'none'
  }
  delete v.reasoning

  const effort = String(v.reasoning_effort ?? '').trim().toLowerCase()
  if (EFFORT_IDS.includes(effort)) v.reasoning_effort = effort
  else delete v.reasoning_effort

  return v
}

/**
 * Normalise one upstream SSE frame into the client-facing shape.
 *
 * @param value - the decoded upstream frame.
 * @param model - the model id to report to the client.
 * @returns the normalised frame, or null when the frame carries nothing.
 */
export function normalizeFrame(value, model) {
  if (value === null || typeof value !== 'object') return null
  const out = {
    object: typeof value.object === 'string' ? value.object : 'chat.completion.chunk',
    model
  }
  if (value.id !== undefined) out.id = value.id
  if (value.created !== undefined) out.created = value.created
  if (value.usage !== undefined && value.usage !== null) out.usage = value.usage

  let meaningful = value.usage !== undefined && value.usage !== null
  const choice = Array.isArray(value.choices) ? value.choices[0] : undefined
  if (choice !== undefined && choice !== null) {
    const delta = {}
    for (const k of ['role', 'content', 'reasoning_content']) {
      const s = choice.delta?.[k]
      if (typeof s === 'string' && s.length > 0) delta[k] = s
    }
    if (Array.isArray(choice.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
      delta.tool_calls = choice.delta.tool_calls
    }
    meaningful = meaningful
      || Object.keys(delta).length > 0
      || (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0)
    out.choices = [{
      index: choice.index ?? 0,
      delta,
      finish_reason: choice.finish_reason ?? null
    }]
  }
  return meaningful ? out : null
}

/**
 * Read SSE `data:` frames from a fetch response body.
 *
 * Chunk boundaries do not align to line boundaries, so a partial trailing line
 * is carried into the next read.
 *
 * @param body - the readable stream.
 * @returns an async iterator of parsed frames, ending at `[DONE]`.
 */
export async function* sseFrames(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { done = true; break }
      try {
        yield JSON.parse(payload)
      } catch {
        // A keep-alive or unknown event must not abandon a healthy stream.
      }
    }
    if (done) break
  }
}

/**
 * An in-memory account pool with least-in-flight rotation per region.
 *
 * Choose the least-busy eligible
 * account, advance a per-region cursor, and record success or failure with a
 * cooldown so a bad account is skipped rather than retried immediately.
 */
export class AccountPool {
  /**
   * @param accounts - account records ({id, site, accessToken, ...}).
   */
  constructor(accounts = []) {
    this.accounts = accounts.map((a) => ({
      enabled: true,
      authState: '有效',
      cooldownUntil: 0,
      requests: 0,
      successes: 0,
      failures: 0,
      lastError: '',
      ...a,
      inflight: 0
    }))
    this.cursor = new Map()
  }

  /**
   * Replace the account set, preserving live runtime state for retained ids.
   *
   * ## What must not be taken from the vault
   *
   * The vault is the *credential* store; the runtime state of a record is not
   * persisted there. The daemon writes `cooldownUntil: 0` for every account it
   * holds, and a cooldown recorded in memory is exactly what makes a rate
   * limited account step aside.
   *
   * Spreading the vault record over the live one therefore reset the cooldown to
   * zero on every refresh. Since the page polls status on a timer and every poll
   * recalculates the pool this way, a 429 cooldown lasted until the next poll:
   * the account became eligible again within seconds, was picked, and answered
   * 429 again. That is the rotation storm in the event log — hundreds of
   * otherwise-identical failures.
   *
   * So credential fields come from the vault (a token may have been refreshed),
   * while the runtime fields are kept from memory whenever they are more
   * restrictive than the vault's copy.
   *
   * @param accounts - the freshly read vault records.
   */
  replace(accounts) {
    const previous = new Map(this.accounts.map((a) => [a.id, a]))
    this.accounts = accounts.map((a) => {
      const old = previous.get(a.id)
      if (old === undefined) {
        return {
          inflight: 0,
          requests: 0,
          successes: 0,
          failures: 0,
          failureStreak: 0,
          lastError: '',
          cooldownUntil: 0,
          ...a
        }
      }
      const liveCooldown = old.cooldownUntil ?? 0
      const vaultCooldown = a.cooldownUntil ?? 0
      return {
        ...a,
        // Keep the counters and the verdict this pool established. A refreshed
        // credential arrives with `authState: '待验证'`, which is fine; a live
        // '需重新登录' from an actual 401 is not, and is kept below.
        requests: old.requests ?? 0,
        successes: old.successes ?? 0,
        failures: old.failures ?? 0,
        failureStreak: old.failureStreak ?? 0,
        inflight: old.inflight ?? 0,
        // A cooldown still in the future is a decision this pool made about a
        // real failure; the vault's zero does not overrule it. Taking the later
        // of the two also honours a cooldown the daemon itself persisted.
        cooldownUntil: Math.max(liveCooldown, vaultCooldown),
        lastError: liveCooldown > Date.now() && old.lastError.length > 0 ? old.lastError : (a.lastError ?? ''),
        // A runtime sign-out is evidence from upstream, not a stale flag.
        authState: old.authState === '需重新登录' && liveCooldown > Date.now()
          ? old.authState
          : (a.authState ?? old.authState)
      }
    })
  }

  /**
   * Forget a failure streak for one account.
   *
   * Called after a credential is replaced: a new token has not failed yet, and
   * inheriting the old streak would immediately penalise it with the escalated
   * cooldown the old token earned.
   *
   * @param id - the account id.
   */
  resetStreak(id) {
    const a = this.accounts.find((x) => x.id === id)
    if (a === undefined) return
    a.failureStreak = 0
    a.failures = 0
    a.cooldownUntil = 0
    a.lastError = ''
  }

  /** Eligible accounts for a region, in pool order. */
  /**
   * Accounts in a region that rotation may actually try.
   *
   * This is where an expired token used to slip through: selection checked
   * enabled/sign-out/cooldown but not expiry, so a lapsed account was handed a
   * request that could only fail. All four conditions now come from
   * `eligibility()`, the same rule the pool counts use.
   *
   * @param site - the region.
   * @param excluded - ids already tried for this request.
   */
  eligible(site, excluded) {
    const now = Date.now()
    return this.accounts.filter((a) =>
      a.site === site && !excluded.has(a.id) && eligibility(a, now).usable)
  }

  /**
   * Claim the least-busy account of a region.
   *
   * @param site - 'cn' or 'ai'.
   * @param excluded - ids already tried for this request.
   * @returns the claimed account, or undefined when the pool is empty.
   */
  pick(site, excluded = new Set()) {
    const pool = this.eligible(site, excluded)
    if (pool.length === 0) return undefined
    const min = Math.min(...pool.map((a) => a.inflight))
    const free = pool.filter((a) => a.inflight === min)
    const cursor = this.cursor.get(site) ?? 0
    const chosen = free[cursor % free.length]
    this.cursor.set(site, (cursor + 1) >>> 0)
    chosen.inflight += 1
    chosen.requests += 1
    return chosen
  }

  /**
   * Release a claim and record the outcome.
   *
   * ## Why a failure can cool an account down for longer than `cooldownMs`
   *
   * `cooldownMs` is the *first* cooldown. A repeatedly rate-limited account
   * needs to step further out of rotation each time, otherwise every retry a
   * minute later hits the same 429 and the pool never recovers. The streak is
   * tracked here rather than at the call site so every rotation path — proxy
   * adapter and local adapter alike — benefits without duplicating the rule.
   *
   * @param id - the account id.
   * @param ok - whether the call succeeded.
   * @param error - a diagnostic, when it failed.
   * @param cooldownMs - base cooldown for this failure.
   */
  finish(id, ok, error = '', cooldownMs = 0) {
    const a = this.accounts.find((x) => x.id === id)
    if (a === undefined) return
    a.inflight = Math.max(0, a.inflight - 1)
    if (ok) {
      a.successes += 1
      a.failureStreak = 0
    } else {
      a.failures += 1
      a.failureStreak = (a.failureStreak ?? 0) + 1
    }
    a.lastError = error
    let effective = cooldownMs
    if (ok !== true && cooldownMs > 0) {
      const streak = a.failureStreak ?? 1
      if (streak > COOLDOWN_ESCALATE_AFTER) {
        const doublings = Math.min(streak - COOLDOWN_ESCALATE_AFTER, 8)
        effective = Math.min(cooldownMs * 2 ** doublings, MAX_COOLDOWN_MS)
      }
    }
    a.cooldownUntil = effective > 0 ? Date.now() + effective : 0
    if (ok) a.authState = '有效'
  }

  /** A snapshot safe to show a user: no token material. */
  snapshot() {
    return this.accounts.map((a) => ({
      id: a.id,
      site: a.site,
      label: a.label ?? a.id.slice(0, 6),
      enabled: a.enabled !== false,
      authState: a.authState,
      inflight: a.inflight,
      requests: a.requests,
      successes: a.successes,
      failures: a.failures,
      lastError: a.lastError,
      cooldownUntil: a.cooldownUntil ?? 0,
      expiresAt: a.expiresAt ?? 0
    }))
  }

  /**
   * Counts per region: accounts that could serve a call right now.
   *
   * This must agree with `accountOverview().pools` in `account-status.js`, or
   * the page would show two different answers for the same question. Both
   * therefore apply the same four conditions — enabled, not signed-out, not
   * cooling down, not expired — and `eligibility()` is the single place that
   * expresses them.
   *
   * @param now - the instant to judge against; defaults to the current time.
   */
  poolCounts(now = Date.now()) {
    const live = (site) => this.accounts.filter((a) =>
      a.site === site && eligibility(a, now).usable).length
    return { cn: live('cn'), ai: live('ai') }
  }
}

/**
 * Whether an account could serve a call right now, and why not.
 *
 * An expired token is treated exactly like a signed-out one: the upstream will
 * reject it, so counting it as available would overstate the pool and make a
 * dead region look healthy.
 *
 * @param account - a pooled account.
 * @param now - the instant to judge against.
 * @returns whether it is usable, with a short reason when it is not.
 */
export function eligibility(account, now = Date.now()) {
  if (account.enabled === false) return { usable: false, reason: 'disabled' }
  // A missing token is reported before an expiry: there is nothing to expire,
  // and "缺少令牌" is the more accurate description of that record.
  if (typeof account.accessToken !== 'string' || account.accessToken.length === 0) {
    return { usable: false, reason: 'no-token' }
  }
  const expiresAt = typeof account.expiresAt === 'number' ? account.expiresAt : 0
  if (expiresAt > 0 && expiresAt <= now) return { usable: false, reason: 'expired' }
  if (account.authState === '需重新登录') return { usable: false, reason: 'signin-required' }
  if ((account.cooldownUntil ?? 0) > now) return { usable: false, reason: 'cooling-down' }
  return { usable: true, reason: 'ok' }
}

/**
 * Build the request headers sent upstream for one account.
 *
 * @param account - the pooled account.
 * @param base - the upstream base URL being called.
 * @param ids - conversation metadata for this call.
 * @returns a header record.
 */
export function upstreamHeaders(account, base, ids) {
  const headers = {
    authorization: `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-user-id': account.uid ?? '',
    'x-product': 'SaaS',
    'x-requested-with': 'XMLHttpRequest',
    'x-domain': account.domain ?? '',
    'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    origin: base,
    referer: `${base}/`,
    'x-conversation-id': ids.conversation,
    'x-conversation-request-id': ids.turn,
    'x-conversation-message-id': ids.message,
    'x-request-id': ids.message,
    'x-request-trace-id': crypto.randomBytes(16).toString('hex')
  }
  if (account.enterpriseId) headers['x-enterprise-id'] = account.enterpriseId
  return headers
}

/**
 * Format a 32-hex message id as the dashed conversation id the upstream wants.
 *
 * @param hex - 32 lowercase hex characters.
 * @returns 8-4-4-4-12 formatting.
 */
export function dashify(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Render the upstream failure as a client-facing error object.
 *
 * Unknown upstream text is not echoed, because it can contain credentials or
 * the caller's own prompt.
 *
 * @param status - HTTP status.
 * @param code - upstream business code, when present.
 * @returns an OpenAI-shaped error body.
 */
export function failureBody(status, code) {
  const message = Number(code) === 11128
    ? '上游会话信息缺失（conversation id missing）'
    : `上游拒绝请求，HTTP ${status}`
  const error = { message, type: 'upstream_error' }
  if (code !== undefined && code !== null) error.code = code
  return { error }
}

export { MAX_ACCOUNTS, COOLDOWN_MS }
