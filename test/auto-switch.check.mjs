/**
 * A spent quota must switch accounts automatically.
 *
 * This is the behaviour the user asked for: 「额度用完自动切号」. The pieces each
 * have their own checks elsewhere; this one exercises them together, through the
 * real pool, because the failure mode is that each piece looks correct alone
 * while the request still does not switch.
 *
 * The upstream is simulated, so the shape of a refusal matters:
 *
 *   - `6004` with a reset time  → span quota, hold out of rotation
 *   - `429` without a reset     → short cooldown, retry later
 *   - `400 11128`              → our request is wrong, do NOT burn the pool
 *
 * Run: node test/auto-switch.check.mjs
 */

import { AccountPool, eligibility, isQuotaExhausted, quotaResetAt } from '../lib/proxy.js'

const { check, finish } = (await import('./harness.mjs')).createChecker()

const UPSTREAM_QUOTA = {
  status: 429,
  code: 6004,
  message: '您的使用量已超出频率限制，将在 2026-10-20 00:00:00 UTC+8 重置，您也可以切换其他模型继续使用。'
}
const UPSTREAM_LIMIT = { status: 429, code: undefined, message: 'too many requests' }
const UPSTREAM_BAD_REQUEST = { status: 400, code: 11128, message: 'request illegal' }

/** An account as the vault provides it. */
function account(id, site = 'cn') {
  return { id, site, accessToken: 'token', enabled: true, authState: '待验证', expiresAt: 0 }
}

/**
 * Walk the pool the way the adapter does, returning which accounts were tried.
 *
 * Mirrors the adapter's loop: claim the least-busy eligible account, ask the
 * simulated upstream, record the outcome, and continue while the failure is the
 * account's problem.
 */
function serve(pool, upstream, site = 'cn', maxAttempts = 8) {
  const excluded = new Set()
  const tried = []
  let lastOutcome = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const picked = pool.pick(site, excluded)
    if (picked === undefined) {
      return { served: false, tried, lastOutcome, reason: 'no eligible account' }
    }
    excluded.add(picked.id)
    tried.push(picked.id)
    const answer = upstream(picked, tried.length)
    if (answer.ok === true) {
      pool.finish(picked.id, true, '', 0)
      return { served: true, servedBy: picked.id, tried, lastOutcome }
    }
    const exhausted = isQuotaExhausted(answer.status, answer.code, answer.message)
    const reset = quotaResetAt(answer.message)
    // A quota refusal is the account's problem and it steps aside; a malformed
    // request is not, so the caller must stop rather than burn the pool.
    const accountProblem = exhausted || answer.status === 429 || answer.status === 401
    pool.finish(picked.id, false, answer.message, accountProblem ? 60_000 : 0, { code: answer.code })
    lastOutcome = { account: picked.id, exhausted, reset }
    if (!accountProblem) {
      return { served: false, tried, lastOutcome, reason: 'request-shaped failure' }
    }
  }
  return { served: false, tried, lastOutcome, reason: 'attempts exhausted' }
}

console.log('the first account has run out: the request switches and succeeds:')
{
  const pool = new AccountPool([account('a'), account('b'), account('c')])
  const result = serve(pool, (acct) => (acct.id === 'a' ? { ok: false, ...UPSTREAM_QUOTA } : { ok: true }))
  check('it switched away from the exhausted account', result.tried[0] === 'a', result.tried.join(','))
  check('the request still succeeded', result.served === true, String(result.reason))
  check('served by a different account', result.servedBy !== 'a', String(result.servedBy))
  check('exactly two accounts were tried', result.tried.length === 2, String(result.tried.length))

  const a = pool.accounts.find((x) => x.id === 'a')
  check('the exhausted account is out of rotation', eligibility(a, Date.now()).usable === false)
  check('its reason is the spent quota', eligibility(a, Date.now()).reason === 'quota-exhausted')
  check('the reset time was parsed', (a.quotaResetAt ?? 0) > Date.now(), String(a.quotaResetAt))
}

console.log('\nseveral accounts exhausted in a row: it keeps looking:')
{
  const pool = new AccountPool([account('a'), account('b'), account('c'), account('d')])
  const result = serve(pool, (acct) => (acct.id === 'd' ? { ok: true } : { ok: false, ...UPSTREAM_QUOTA }))
  check('it walked past every exhausted account', result.tried.length === 4, result.tried.join(','))
  check('the request succeeded on the last one', result.served === true, String(result.reason))
  check('three accounts are now excluded', pool.poolCounts().cn === 1, String(pool.poolCounts().cn))
}

console.log('\nevery account exhausted: it fails cleanly, and says so next time:')
{
  const pool = new AccountPool([account('a'), account('b')])
  const first = serve(pool, () => ({ ok: false, ...UPSTREAM_QUOTA }))
  check('the first request tried both', first.tried.length === 2, first.tried.join(','))
  check('and did not succeed', first.served === false)

  const second = serve(pool, () => ({ ok: true }))
  check('the next request does not retry an exhausted account', second.tried.length === 0, second.tried.join(','))
  check('it reports that none are eligible', second.reason === 'no eligible account', String(second.reason))
}

console.log('\na plain rate limit is a cooldown, so it also switches:')
{
  const pool = new AccountPool([account('a'), account('b')])
  const result = serve(pool, (acct) => (acct.id === 'a' ? { ok: false, ...UPSTREAM_LIMIT } : { ok: true }))
  check('it switched', result.tried.join(',') === 'a,b', result.tried.join(','))
  check('and served the request', result.served === true)
  const a = pool.accounts.find((x) => x.id === 'a')
  check('without claiming the quota is spent', (a.quotaResetAt ?? 0) === 0, String(a.quotaResetAt))
}

console.log('\na malformed request is not the account\u2019s fault, so the pool is not burned:')
{
  const pool = new AccountPool([account('a'), account('b'), account('c')])
  const result = serve(pool, () => ({ ok: false, ...UPSTREAM_BAD_REQUEST }))
  check('it stops at the first account', result.tried.length === 1, result.tried.join(','))
  check('it reports a request-shaped failure', result.reason === 'request-shaped failure', String(result.reason))
  // Nothing is cooled down, so all three remain usable: a request-shaped refusal
  // must not cost a healthy account its turn.
  check('all accounts stay available', pool.poolCounts().cn === 3, String(pool.poolCounts().cn))
}

console.log('\nregions never fall back to each other:')
{
  const pool = new AccountPool([account('cn-1', 'cn'), account('ai-1', 'ai')])
  const result = serve(pool, () => ({ ok: false, ...UPSTREAM_QUOTA }), 'cn')
  check('only CN accounts were tried', result.tried.join(',') === 'cn-1', result.tried.join(','))
  check('the AI account was untouched', pool.poolCounts().ai === 1, String(pool.poolCounts().ai))
}

console.log('\na recovered account returns to rotation after the window resets:')
{
  // The reset instant comes from the upstream message, so the check uses the
  // parsed value rather than inventing one.
  const reset = quotaResetAt(UPSTREAM_QUOTA.message)
  check('the message names a reset time', reset > Date.now(), new Date(reset).toISOString())
  const pool = new AccountPool([account('a')])
  pool.finish('a', false, UPSTREAM_QUOTA.message, 60_000, { code: 6004 })
  const a = pool.accounts.find((x) => x.id === 'a')
  check('held out now', eligibility(a, Date.now()).usable === false)
  check('still held out just before the reset', eligibility(a, reset - 1000).usable === false)
  check('eligible once its window passes', eligibility(a, reset + 1000).usable === true, String(a.quotaResetAt))
}

finish()
