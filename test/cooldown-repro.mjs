/**
 * Reproduction for the cooldown-reset defect.
 *
 * The pool keeps live counters in memory, but `replace()` merges the vault's
 * copy of each record over them. The vault stores `cooldownUntil: 0` (the
 * daemon never persists a cooldown), so every status poll — and the page polls
 * on a timer — wipes the cooldown and the failure streak that a 429 had just
 * recorded. The account is immediately eligible again, is picked, and answers
 * 429 again: the rotation loop the event log shows hundreds of times.
 *
 * Run: node test/cooldown-repro.mjs
 */

import { AccountPool, eligibility } from '../lib/proxy.js'

/** One vault-shaped record, as a fresh read would return it. */
function vaultRecord() {
  return {
    id: 'a1',
    site: 'cn',
    label: 'en',
    accessToken: 'token-value',
    cooldownUntil: 0,
    expiresAt: 0,
    enabled: true,
    authState: '有效'
  }
}

const failures = []

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(`${name}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

console.log('cooldown after a 429:')
const pool = new AccountPool([vaultRecord()])
pool.pick('cn')
pool.finish('a1', false, 'HTTP 429', 60_000)
const cooling = pool.accounts[0].cooldownUntil - Date.now()
check('cooldown is recorded', cooling > 50_000, `${Math.round(cooling / 1000)}s`)
check('a cooling account is not picked', pool.pick('cn') === undefined)

console.log('\nafter a status poll (replace with the vault copy):')
pool.replace([vaultRecord()])
const afterReplace = pool.accounts[0].cooldownUntil - Date.now()
check(
  'cooldown survives a status poll',
  afterReplace > 50_000,
  `cooldown reset to ${Math.round(afterReplace / 1000)}s`
)
check('the account is still not picked', pool.pick('cn') === undefined, 'poll re-armed the account')
check('failure streak survives a status poll', (pool.accounts[0].failureStreak ?? 0) > 0, 'streak lost')

console.log('\nescalation across repeated 429s:')
const pool2 = new AccountPool([vaultRecord()])
const spans = []
for (let i = 0; i < 6; i += 1) {
  pool2.accounts[0].cooldownUntil = 0
  pool2.pick('cn')
  pool2.finish('a1', false, 'HTTP 429', 60_000)
  spans.push(Math.round((pool2.accounts[0].cooldownUntil - Date.now()) / 1000))
}
check('later failures cool down longer', spans[spans.length - 1] > spans[0], spans.join('s → ') + 's')
check('cooldown is capped', spans[spans.length - 1] <= 900, `${spans[spans.length - 1]}s`)

console.log('\nsuccess clears the streak:')
pool2.pick('cn')
pool2.finish('a1', true, '', 0)
check('streak cleared on success', (pool2.accounts[0].failureStreak ?? 0) === 0, String(pool2.accounts[0].failureStreak))
check('account immediately eligible again', eligibility(pool2.accounts[0]).usable === true)

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
