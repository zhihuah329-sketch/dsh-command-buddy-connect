/**
 * A spent quota must not read as an available account.
 *
 * The panel showed an account as 可用 while the upstream answered
 * `HTTP 429 code=6004 您的使用量已超出频率限制，将在 2026-10-19 16:35:58 UTC+8 重置`.
 * Two reasons: the vault never learns about a failure (the outcome lives only in
 * the in-memory pool), and even when known, a spent quota looked exactly like a
 * one-minute cooldown — so a lapsed cooldown made the account look healthy again.
 *
 * Run: node test/quota-status.check.mjs
 */

import { eligibility, isQuotaExhausted, quotaResetAt } from '../lib/proxy.js'
import { accountStatus } from '../lib/account-status.js'
import { createChecker } from './harness.mjs'

const { check, finish } = createChecker()

// The exact wording the upstream returns, and its reset time in UTC+8.
const UPSTREAM_MESSAGE = '您的使用量已超出频率限制，将在 2026-10-19 16:35:58 UTC+8 重置，您也可以切换其他模型继续使用。'
// 2026-10-19 16:35:58 +08:00 == 2026-10-19 08:35:58 UTC
const EXPECTED_RESET = Date.UTC(2026, 9, 19, 8, 35, 58)

console.log('recognising an exhausted quota:')
check('business code 6004 is exhaustion', isQuotaExhausted(undefined, 6004, '') === true)
check('the CN message is exhaustion', isQuotaExhausted(429, undefined, UPSTREAM_MESSAGE) === true)
check('a plain rate limit is not exhaustion', isQuotaExhausted(429, undefined, 'too many requests') === false)
check('a malformed request is not exhaustion', isQuotaExhausted(400, 11128, 'request illegal') === false)

console.log('\nparsing the reset instant:')
const reset = quotaResetAt(UPSTREAM_MESSAGE)
check('the UTC offset is honoured', reset === EXPECTED_RESET, `${new Date(reset).toISOString()} vs ${new Date(EXPECTED_RESET).toISOString()}`)
check('a message without a time yields 0', quotaResetAt('quota exceeded') === 0)
check('a bare CN timestamp is read as UTC+8', quotaResetAt('将在 2026-10-19 16:35:58 重置') === EXPECTED_RESET)

console.log('\nan exhausted account is not eligible, even with no cooldown:')
{
  const account = {
    id: 'x',
    site: 'cn',
    accessToken: 'token',
    enabled: true,
    authState: '待验证',
    cooldownUntil: 0,
    quotaResetAt: EXPECTED_RESET,
    expiresAt: 0
  }
  const now = EXPECTED_RESET - 60_000
  const verdict = eligibility(account, now)
  check('reported unusable', verdict.usable === false)
  check('reason is the spent quota', verdict.reason === 'quota-exhausted', verdict.reason)
}

console.log('\nit becomes eligible again once the window resets:')
{
  const account = { id: 'x', site: 'cn', accessToken: 'token', enabled: true, cooldownUntil: 0, quotaResetAt: EXPECTED_RESET, expiresAt: 0 }
  check('usable after the reset time', eligibility(account, EXPECTED_RESET + 1000).usable === true)
}

console.log('\nthe panel says so instead of calling it available:')
{
  const account = {
    id: 'x',
    site: 'cn',
    label: 'en',
    accessToken: 'token',
    enabled: true,
    authState: '待验证',
    cooldownUntil: 0,
    quotaResetAt: EXPECTED_RESET,
    lastError: UPSTREAM_MESSAGE,
    expiresAt: 0
  }
  const status = accountStatus(account, EXPECTED_RESET - 60_000)
  check('not reported as ok', status.status !== 'ok', status.status)
  check('labelled 额度用尽', status.statusLabel === '额度用尽', status.statusLabel)
  check('reported unusable', status.usable === false)
  check('the reset time is passed on', status.quotaResetAt === EXPECTED_RESET, String(status.quotaResetAt))
  check('a reason names the reset', status.reasons.some((r) => r.includes('额度已用尽')), JSON.stringify(status.reasons))
  check('the upstream wording is kept', status.reasons.some((r) => r.includes('超出频率限制')), JSON.stringify(status.reasons))
}

console.log('\na healthy account is still reported as available:')
{
  const account = { id: 'y', site: 'cn', label: 'ok', accessToken: 'token', enabled: true, cooldownUntil: 0, quotaResetAt: 0, lastError: '', expiresAt: 0 }
  const status = accountStatus(account, EXPECTED_RESET)
  check('status ok', status.status === 'ok')
  check('label 可用', status.statusLabel === '可用')
}

finish()
