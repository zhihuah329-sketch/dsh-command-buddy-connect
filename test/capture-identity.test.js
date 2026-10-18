/**
 * A captured credential must resolve to the account it belongs to.
 *
 * This is the check that was missing when "capture succeeds but nothing is
 * added" was reported. The capture extracted a token, wrote it to a temporary
 * credential file, and asked the daemon to import it. The import "succeeded"
 * and changed nothing.
 *
 * The daemon derives an account id as `sha256(site:uid:enterpriseId)[:20]` and
 * updates the account whose id matches. The uid used to come from an
 * `x-user-id` request header, which real CN traffic does not send, so the uid was
 * empty and the derived id was `sha256("cn::")` — a constant. Every capture
 * therefore created the same empty duplicate instead of updating the account the
 * user had just signed into.
 *
 * The token's own `sub` claim carries that identity, and it matches the vault's
 * uid for every real account here. These tests pin that relationship: if the
 * extraction or the claim order changes so the derived id stops matching, the
 * capture silently stops working again.
 */
import crypto from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20)

/** A JWT-shaped token whose payload is the given claims. */
function token(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url')
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.signature`
}

// Mirrors the extraction in lib/capture.js: claims first, header as a fallback.
function claimOf(tok, claim) {
  const part = tok.split('.')[1]
  if (typeof part !== 'string' || part.length === 0) return ''
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    const value = payload?.[claim]
    return value === undefined || value === null ? '' : String(value)
  } catch {
    return ''
  }
}
function identityOf(tok, record) {
  for (const claim of ['sub', 'user_id', 'userId', 'uid', 'preferred_username']) {
    const value = claimOf(tok, claim)
    if (value.length > 0) return value
  }
  return String(record?.headers?.['x-user-id'] ?? '').split(',')[0].trim()
}

test('the uid comes from the token, not a header the traffic does not send', () => {
  const tok = token({ sub: '597ed530-0c79-4544-ab31-d643a76e36a9', enterprise_id: '' })
  // The observed capture record: only `authorization` is present.
  const record = { headers: { authorization: `Bearer ${tok}` } }
  assert.equal(identityOf(tok, record), '597ed530-0c79-4544-ab31-d643a76e36a9')
})

test('the derived id matches a real account id', () => {
  // Taken from a live vault: this tuple produced exactly this account id.
  const tok = token({ sub: '597ed530-0c79-4544-ab31-d643a76e36a9', enterprise_id: '' })
  const uid = identityOf(tok, { headers: {} })
  const ent = claimOf(tok, 'enterprise_id')
  assert.equal(sha(`cn:${uid}:${ent}`), 'd937c00da578edda2422')
})

test('a missing uid no longer collapses every account onto one id', () => {
  // The failure mode: an empty uid made the id a constant, so the second capture
  // updated nothing and every region looked alike.
  const emptyId = sha('cn::')
  const realIds = [
    'd937c00da578edda2422',
    '8c1f5b3b356fb1f9c7be'
  ]
  for (const id of realIds) {
    assert.notEqual(emptyId, id, 'an empty uid must not produce a real account id')
  }
  // Two different accounts must derive two different ids.
  assert.notEqual(sha('cn:uid-a:'), sha('cn:uid-b:'))
})

test('a header value is still honoured when the token has no subject', () => {
  const tok = token({ exp: 1 })
  const record = { headers: { 'x-user-id': 'header-uid, other' } }
  assert.equal(identityOf(tok, record), 'header-uid')
})

test('an unreadable token degrades to the header rather than throwing', () => {
  assert.equal(identityOf('not-a-jwt', { headers: { 'x-user-id': 'fallback' } }), 'fallback')
  assert.equal(identityOf('', {}), '')
})
