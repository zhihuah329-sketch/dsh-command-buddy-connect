/**
 * The capture-write deadlock.
 *
 * A re-capture used to go through `/admin/import`, which silently refuses a
 * credential whose `expiresAt` is not later than the stored one. Since a new
 * token's lifetime is counted from now, its `exp` normally lands *earlier* than
 * a stored credential imported near the start of a longer window — so the
 * capture could never replace it, and the pool stayed on a token the user had
 * explicitly tried to replace.
 *
 * These checks run the real vault code against a throwaway data directory, so
 * they assert the write path itself rather than restating the rule. Read-only
 * with respect to the live vault: `BUDDYHUB_DATA` is pointed at a temp dir.
 *
 * Run: node test/capture-write.check.mjs
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const dir = fs.mkdtempSync(join(os.tmpdir(), 'buddy-capture-check-'))

// The vault module resolves its data directory from the environment.
process.env.BUDDYHUB_DATA = dir

const { upsertCapturedCredential, readVaultAccounts } = await import('../lib/vault-edit.js')

const failures = []
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok   ${name}`)
  } else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const key = crypto.randomBytes(32)
fs.writeFileSync(join(dir, 'vault.key'), key)
fs.writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 8787, adminPort: 8790 }))

/**
 * Write an accounts array the way the daemon does, so the vault can read it.
 *
 * @param accounts - the records to seal.
 */
function sealVault(accounts) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const data = Buffer.concat([cipher.update(JSON.stringify(accounts), 'utf8'), cipher.final()])
  fs.writeFileSync(join(dir, 'accounts.enc'), JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }))
}

const site = 'cn'
const uid = 'uid-1234'
const id = crypto.createHash('sha256').update(`${site}:${uid}:`).digest('hex').slice(0, 20)
const farFuture = Date.now() + 400 * 24 * 3600 * 1000
const sooner = Date.now() + 10 * 24 * 3600 * 1000

/**
 * A fake but shape-valid token: long enough and made of the characters a real
 * JWT uses, so the pasted-fragment guard does not (correctly) reject it.
 *
 * @param tag - a marker so the assertions can tell tokens apart.
 * @returns a token-shaped string.
 */
function fakeToken(tag) {
  return `eyJ${tag}`.padEnd(400, 'A') + '.eyJhbGciOiJIUzI1NiJ9.' + tag.padEnd(300, 'B')
}

sealVault([{
  id,
  site,
  uid,
  enterpriseId: '',
  domain: 'copilot.tencent.com',
  label: 'en',
  accessToken: fakeToken('OLD'),
  expiresAt: farFuture,
  enabled: true,
  authState: '有效',
  cooldownUntil: Date.now() + 60_000,
  lastError: '上游拒绝请求，HTTP 429',
  requests: 434,
  successes: 354,
  failures: 80
}])

console.log('a capture whose expiry is EARLIER than the stored one:')
const result = await upsertCapturedCredential({
  dataDir: dir,
  site,
  uid,
  accessToken: fakeToken('NEW'),
  expiresAt: sooner
})
check('write reports success', result.ok === true, result.error)
check('no duplicate account created', (readVaultAccounts(dir).accounts ?? []).length === 1)

const stored = (readVaultAccounts(dir).accounts ?? [])[0]
check('token was replaced', stored?.accessToken === fakeToken('NEW'), String(stored?.accessToken))
check('expiry now follows the new token', stored?.expiresAt === sooner, String(stored?.expiresAt))
check('rate-limit cooldown was cleared', (stored?.cooldownUntil ?? 1) === 0, String(stored?.cooldownUntil))
check('auth state reset for revalidation', stored?.authState === '待验证', String(stored?.authState))
check('previous error cleared', stored?.lastError === '', String(stored?.lastError))

console.log('\na tombstoned account is revived by a capture:')
sealVault([{
  id, site, uid, enterpriseId: '', domain: 'copilot.tencent.com', label: 'en',
  accessToken: '', expiresAt: 4102444800000, enabled: false, authState: '已移除',
  removed: true, removedAt: Date.now(), cooldownUntil: 0, lastError: ''
}])
const revived = await upsertCapturedCredential({ dataDir: dir, site, uid, accessToken: fakeToken('FRESH'), expiresAt: sooner })
const revivedRecord = (readVaultAccounts(dir).accounts ?? [])[0]
check('revival reports success', revived.ok === true, revived.error)
check('tombstone lifted', revivedRecord?.removed !== true)
check('account re-enabled', revivedRecord?.enabled === true)
check('token written', revivedRecord?.accessToken === fakeToken('FRESH'))

console.log('\nan unknown uid inserts rather than overwriting:')
const added = await upsertCapturedCredential({ dataDir: dir, site, uid: 'other-uid', accessToken: fakeToken('TOK2'), expiresAt: sooner })
check('insert reports success', added.ok === true, added.error)
check('created flag set', added.written?.created === true, String(added.written?.created))
check('pool now holds two accounts', (readVaultAccounts(dir).accounts ?? []).length === 2)

console.log('\na bad token is refused:')
const refused = await upsertCapturedCredential({ dataDir: dir, site, uid, accessToken: 'short' })
check('short token refused', refused.ok === false)
check('refusal explains why', typeof refused.error === 'string' && refused.error.length > 0, refused.error)

fs.rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
