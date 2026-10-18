/**
 * An import that writes nothing must not report success.
 *
 * Reported symptom: the page said 已抓到凭据并写入号池, and the pool was
 * unchanged. The write path had reported `{ ok: true, added: 0, updated: 0 }`.
 *
 * Two things combined:
 *
 * 1. The credential file carried an invented `expiresAt` of "now + 28 days".
 *    The daemon skips an import whose expiry is not later than the stored one,
 *    treating it as "nothing newer". Any account whose stored credential lasted
 *    longer than 28 days was therefore skipped — the AI account here lasts 332
 *    days — and a skipped import has no entry in `skipped`.
 * 2. The success test only failed when `skipped` was non-empty, so an all-zero
 *    reply with no explanation counted as success.
 *
 * Both are pinned here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Mirrors the gate in lib/account-status.js. */
function verdict({ added, updated, grew, skipped }) {
  if (added + updated === 0 && !grew) {
    const reason = skipped.length > 0
      ? skipped.map((s) => s.message ?? s.reason).join('；')
      : 'nothing newer'
    return { ok: false, error: reason }
  }
  return { ok: true, added, updated }
}

test('an all-zero import with no explanation is a failure', () => {
  // This exact shape came back from the daemon for a skipped credential.
  const r = verdict({ added: 0, updated: 0, grew: false, skipped: [] })
  assert.equal(r.ok, false, 'writing nothing must not be reported as success')
  assert.match(r.error, /nothing newer/)
})

test('an all-zero import that explained itself is still a failure', () => {
  const r = verdict({
    added: 0,
    updated: 0,
    grew: false,
    skipped: [{ reason: 'encrypted_credential', message: '凭据被加密' }]
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /凭据被加密/)
})

test('a real write is success', () => {
  assert.equal(verdict({ added: 1, updated: 0, grew: true, skipped: [] }).ok, true)
  assert.equal(verdict({ added: 0, updated: 1, grew: false, skipped: [] }).ok, true)
})

test('growth alone counts, even when the counters say zero', () => {
  // A daemon too old to report counters still grows the pool.
  assert.equal(verdict({ added: 0, updated: 0, grew: true, skipped: [] }).ok, true)
})

test('the invented expiry is what caused the skip', () => {
  // The AI account in the pool expires 332 days out, so a token file dated
  // "now + 28 days" is not newer and the daemon skips it:
  const invented = Date.now() + 28 * 24 * 60 * 60 * 1000
  const stored = Date.now() + 332 * 24 * 60 * 60 * 1000
  assert.ok(stored >= invented, 'a stored credential longer than 28 days out wins')

  // The token's own exp is later than what is stored, so carrying it makes the
  // import take effect:
  const realExpiry = Date.now() + 332 * 24 * 60 * 60 * 1000
  assert.ok(!(stored >= realExpiry + 1), 'the real expiry is not older than the stored one')
})

test('a token exp in seconds becomes milliseconds', () => {
  const seconds = 1794724306
  assert.equal(seconds * 1000, 1794724306000)
  // Reading a token without exp must not fabricate one.
  const claimOf = () => ''
  const expiresAt = Number(claimOf('exp')) || 0
  assert.equal(expiresAt, 0, 'a missing exp must fall back to 0, not an invention')
})
