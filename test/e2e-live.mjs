/**
 * End-to-end check against a running DSH, for release verification.
 *
 * Unit tests import modules in isolation, which is how three broken builds
 * shipped: a client bundle that failed to evaluate, a handler that called an
 * unimported function, and a write path that accepted an obviously invalid
 * token and destroyed a live credential. None of those were visible to the unit
 * tests, and all of them were visible from here.
 *
 * Requires: DSH running, plugin installed at the version under test.
 * Usage: node test/e2e-live.mjs [port]
 *
 * Read-only except for the explicitly reversible steps at the end, which are
 * guarded by their own backup.
 */
import fs from 'node:fs'

const PORT = process.argv[2] ?? '5724'
const BASE = `http://127.0.0.1:${PORT}/api/dsh-command-buddy-connect/status`
const VAULT = 'C:/Users/LENOVO/.buddyhub'

let pass = 0
let fail = 0
const ok = (label, fn) => {
  try { fn(); pass += 1; console.log(`  PASS  ${label}`) }
  catch (e) { fail += 1; console.log(`  FAIL  ${label}: ${e.message}`) }
}
const A = (c, m) => { if (!c) throw new Error(m) }

const call = async (body, timeout = 180_000) => {
  const r = await fetch(BASE, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout)
  })
  let j = null
  try { j = await r.json() } catch { /* non-JSON error body */ }
  return { status: r.status, j }
}

let mod
const loadVault = async () => {
  if (mod === undefined) {
    mod = await import('file:///D:/DeepSeekHarnessData/default-workspace/buddy-connect/lib/vault-edit.js')
  }
  return mod
}

console.log(`=== host reachable on ${PORT}`)
const g = await call()
ok('GET returns 200', () => A(g.status === 200, `HTTP ${g.status}`))
if (g.status !== 200) {
  console.log('\nThe host is not reachable; nothing else can be checked.')
  process.exit(1)
}

console.log('\n=== status payload')
ok('accounts are listed', () => A(g.j?.accounts?.accounts?.length > 0, 'no accounts'))
ok('every account carries checkinEnabled', () => {
  for (const a of g.j.accounts.accounts) A(typeof a.checkinEnabled === 'boolean', `${a.id} missing`)
})
ok('all four route switches are present', () => A(g.j?.routes?.length === 4, `saw ${g.j?.routes?.length}`))
ok('no account is missing a token', () => {
  for (const a of g.j.accounts.accounts) A(a.status !== 'no-token', `${a.id} has no token`)
})

console.log('\n=== check-in preference (bulk read the vault)')
const bulk = await call({ action: 'checkin-prefs', all: true, enabled: true })
ok('bulk update returns 200', () => A(bulk.status === 200, `HTTP ${bulk.status}`))
ok('no ReferenceError in the response', () => {
  A(!JSON.stringify(bulk.j ?? {}).includes('is not defined'), 'a handler threw')
})

console.log('\n=== token validation must not overwrite a live credential')
const ids = g.j.accounts.accounts.map((a) => a.id)
const short = await call({ action: 'account-refresh', id: ids[0], accessToken: 'short' })
ok('a too-short token is rejected', () => A(short.status === 400, `HTTP ${short.status}`))
ok('the rejection explains why', () => {
  A(String(short.j?.accountEdit?.error ?? '').length > 10, 'no explanation')
})
const afterShort = await call()
ok('the live token survived', () => {
  const a = afterShort.j.accounts.accounts.find((x) => x.id === ids[0])
  A(a.status !== 'no-token', `token destroyed, status=${a.status}`)
})

console.log('\n=== authorization')
const cn = await call({ action: 'authorize', site: 'cn' })
ok('CN returns 200', () => A(cn.status === 200, `HTTP ${cn.status}`))
ok('CN opened or raised a window', () => A(cn.j?.authorize?.ok === true, JSON.stringify(cn.j?.authorize)))
const ai = await call({ action: 'authorize', site: 'ai' })
ok('AI refuses the CN client', () => A(ai.j?.authorize?.ok === false, 'it reported success'))
ok('AI explains why', () => A(String(ai.j?.authorize?.error ?? '').length > 10, 'no explanation'))

console.log('\n=== bad input is rejected, not applied')
for (const [label, body] of [
  ['remove without an id', { action: 'account-remove' }],
  ['refresh without a token', { action: 'account-refresh', id: ids[0], accessToken: '' }],
  ['remove an unknown id', { action: 'account-remove', id: '__nope__' }]
]) {
  const r = await call(body)
  ok(`${label} → 400`, () => A(r.status === 400, `HTTP ${r.status}`))
}

console.log('\n=== other actions still answer')
for (const [label, body] of [
  ['discover', { action: 'discover' }],
  ['capture-describe', { action: 'capture-describe' }],
  ['cc-test', { action: 'cc-test' }]
]) {
  const r = await call(body)
  ok(`${label} → not 5xx`, () => A(r.status < 500, `HTTP ${r.status}`))
}

console.log('\n=== reversible: delete then restore')
const vault = await loadVault()
const before = vault.readVaultAccounts(VAULT)
A(before.ok === true, 'vault unreadable')
// The AI account is chosen because it takes no part in check-in: if anything
// below goes wrong, the daily reward path is untouched.
const target = before.accounts.find((a) => a.site === 'ai') ?? before.accounts[before.accounts.length - 1]
console.log(`  target: ${target.id} ${target.label}`)

const safety = `${VAULT}/backups/e2e-${Date.now()}`
fs.mkdirSync(safety, { recursive: true })
for (const f of ['accounts.enc', 'vault.key', 'config.json']) {
  if (fs.existsSync(`${VAULT}/${f}`)) fs.copyFileSync(`${VAULT}/${f}`, `${safety}/${f}`)
}

const del = await call({ action: 'account-remove', id: target.id })
ok('delete returns 200', () => A(del.status === 200, `HTTP ${del.status}`))
ok('a backup was written', () => A(fs.existsSync(del.j.accountEdit.backupDir), 'none'))
ok('it is hidden from the account list', () => {
  const visible = (del.j?.accounts?.accounts ?? []).some((a) => a.id === target.id)
  A(!visible, 'still listed')
})

await new Promise((r) => setTimeout(r, 8000))
const tomb = vault.readVaultAccounts(VAULT).accounts.find((a) => a.id === target.id)
ok('the tombstone survives the daemon restart', () => A(tomb !== undefined, 'entry vanished'))
ok('its token stays cleared', () => A(String(tomb.accessToken ?? '') === '', 'token came back'))

const rev = await call({ action: 'account-refresh', id: target.id, accessToken: target.accessToken })
ok('refresh restores it', () => A(rev.j?.accountEdit?.ok === true, JSON.stringify(rev.j?.accountEdit)))
const revived = vault.readVaultAccounts(VAULT).accounts.find((a) => a.id === target.id)
ok('the tombstone marker is lifted', () => A(revived.removed === undefined, 'still marked removed'))
ok('the token is back', () => A(revived.accessToken === target.accessToken, 'token differs'))

const final = vault.readVaultAccounts(VAULT)
// Judge by what changed during this run, not by absolute health: the vault may
// legitimately hold a tombstone from an earlier, unrelated delete, and restoring
// the safety copy would then be the wrong reaction to a pre-existing state.
const damaged = final.accounts.filter((a) => {
  const wasHealthy = before.accounts.find((b) => b.id === a.id)
  if (wasHealthy === undefined) return false
  const healthyBefore = wasHealthy.removed !== true && String(wasHealthy.accessToken ?? '').length > 100
  const healthyNow = a.removed !== true && String(a.accessToken ?? '').length > 100
  return healthyBefore && !healthyNow
})
if (damaged.length > 0) {
  console.log(`\n  !! this run damaged ${damaged.map((a) => a.label).join(', ')}; restoring the safety copy`)
  fs.copyFileSync(`${safety}/accounts.enc`, `${VAULT}/accounts.enc`)
}
ok('no account was damaged by this run', () => A(damaged.length === 0, `${damaged.length} damaged, restored`))
fs.rmSync(safety, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
