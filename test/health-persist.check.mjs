/**
 * A spent quota must survive a restart.
 *
 * The panel showed exhausted accounts as 可用 because the outcome lived only in
 * the in-memory pool: the vault has no field for it, so the next process started
 * clean and reported every account as available again while the upstream was
 * still refusing until its window reset.
 *
 * These checks use a throwaway state directory, so they never touch the real
 * account-health file.
 *
 * Run: node test/health-persist.check.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const dir = fs.mkdtempSync(join(os.tmpdir(), 'buddy-health-check-'))
// The state directory is resolved through this variable, so both the writer and
// the reader land in the same throwaway place.
process.env.BUDDY_CONNECT_STATE_DIR = dir

const { readHealth, recordHealth, clearHealth } = await import('../lib/account-health.js')
const { AccountPool, eligibility } = await import('../lib/proxy.js')
const { createChecker } = await import('./harness.mjs')

const { check, finish } = createChecker()

const RESET = Date.UTC(2026, 9, 19, 8, 35, 58) // 16:35:58 +08:00
const BEFORE = RESET - 60_000
const MESSAGE = '您的使用量已超出频率限制，将在 2026-10-19 16:35:58 UTC+8 重置'

console.log('recording an exhausted quota:')
recordHealth('acct-1', { quotaResetAt: RESET, lastError: MESSAGE, at: BEFORE })
{
  const stored = readHealth(BEFORE)
  check('the entry is written', stored['acct-1'] !== undefined)
  check('the reset time is kept', stored['acct-1']?.quotaResetAt === RESET, String(stored['acct-1']?.quotaResetAt))
  check('the upstream wording is kept', stored['acct-1']?.lastError === MESSAGE)
}

console.log('\na fresh process still knows the account is exhausted:')
{
  // A brand-new pool is exactly what a restarted plugin has: vault records only.
  const pool = new AccountPool([
    { id: 'acct-1', site: 'cn', accessToken: 'token', enabled: true, expiresAt: 0 },
    { id: 'acct-2', site: 'cn', accessToken: 'token', enabled: true, expiresAt: 0 }
  ])
  check('before hydrating, both look available', pool.poolCounts(BEFORE).cn === 2, String(pool.poolCounts(BEFORE).cn))

  pool.hydrate(readHealth(BEFORE), BEFORE)
  check('after hydrating, the exhausted one is excluded', pool.poolCounts(BEFORE).cn === 1, String(pool.poolCounts(BEFORE).cn))

  const exhausted = pool.accounts.find((a) => a.id === 'acct-1')
  const verdict = eligibility(exhausted, BEFORE)
  check('reported unusable', verdict.usable === false)
  check('reason is the spent quota', verdict.reason === 'quota-exhausted', verdict.reason)
  check('the last error is restored', exhausted.lastError === MESSAGE)
}

console.log('\nafter the window resets the account returns by itself:')
{
  const later = RESET + 60_000
  // The window is dropped rather than trusted forever. The entry may remain for
  // a while, because the error text is still useful history — what must not
  // survive is the claim that the account is unusable.
  const stored = readHealth(later)['acct-1']
  check('the spent window is no longer claimed', (stored?.quotaResetAt ?? 0) === 0, String(stored?.quotaResetAt))

  const pool = new AccountPool([
    { id: 'acct-1', site: 'cn', accessToken: 'token', enabled: true, expiresAt: 0 }
  ])
  pool.hydrate(readHealth(later), later)
  check('the account is eligible again', pool.poolCounts(later).cn === 1, String(pool.poolCounts(later).cn))
}

console.log('\na success clears the stored verdict:')
{
  recordHealth('acct-3', { quotaResetAt: RESET, lastError: MESSAGE, at: BEFORE })
  check('written', readHealth(BEFORE)['acct-3'] !== undefined)
  clearHealth('acct-3')
  check('cleared', readHealth(BEFORE)['acct-3'] === undefined)
}

console.log('\nthe pool persists what it learns through the hook:')
{
  const seen = []
  const pool = new AccountPool(
    [{ id: 'acct-4', site: 'cn', accessToken: 'token', enabled: true, expiresAt: 0 }],
    { onFinish: (account) => seen.push({ id: account.id, quotaResetAt: account.quotaResetAt ?? 0 }) }
  )
  pool.pick('cn')
  pool.finish('acct-4', false, MESSAGE, 60_000, { code: 6004 })
  check('the hook received the exhausted account', seen.length === 1, String(seen.length))
  check('and the parsed reset time', seen[0]?.quotaResetAt === RESET, String(seen[0]?.quotaResetAt))
}

console.log('\na missing or malformed store is not fatal:')
{
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  check('no file means nothing known', Object.keys(readHealth()).length === 0)
  fs.writeFileSync(join(dir, 'account-health.json'), '{ not json')
  check('malformed is ignored', Object.keys(readHealth()).length === 0)
}

fs.rmSync(dir, { recursive: true, force: true })
finish()
