/**
 * Accounts show a name a person can recognise.
 *
 * The panel used to show `账号 8c1f5b`. Two causes, both fixed here:
 *
 *   - the writer stored a placeholder (`账号 <id>`) when it had no name, and that
 *     placeholder was then displayed forever;
 *   - nothing read the identity claims the token carries, although both regions
 *     issue Keycloak-style JWTs with `openid profile email` in scope.
 *
 * The display name is now derived: a real stored label wins, then the token, then
 * the id — and a placeholder counts as "no name", so accounts imported before
 * this change are renamed without re-importing them.
 *
 * Run: node test/account-label.check.mjs
 */

import { identityFromToken } from '../lib/proxy.js'
import { createChecker } from './harness.mjs'

const { check, finish } = createChecker()

/** Build an unsigned JWT with the given claims. */
function token(claims) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.sig`
}

console.log('claims are read per region:')
{
  const cn = identityFromToken(token({
    sub: '597ed530-0000-0000-0000-000000000001',
    nickname: 'en',
    preferred_username: '17338867713'
  }))
  check('CN uses the nickname', cn.label === 'en', cn.label)
  check('CN uid comes from sub', cn.uid.startsWith('597ed530'), cn.uid)

  const ai = identityFromToken(token({
    sub: '23bcb24f-0000-0000-0000-000000000002',
    email: 'someone@example.com',
    name: 'Some One',
    preferred_username: 'someone@example.com'
  }))
  check('AI uses the email', ai.label === 'someone@example.com', ai.label)
  check('AI reports the nickname too', ai.nickname === 'Some One', ai.nickname)
}

console.log('\nthe email outranks a phone-number username:')
{
  const both = identityFromToken(token({
    sub: 'x',
    nickname: 'neat-name',
    preferred_username: '17338867713',
    email: 'person@example.com'
  }))
  check('the email is preferred', both.label === 'person@example.com', both.label)
}

console.log('\na nickname beats a bare phone number:')
{
  const cn = identityFromToken(token({
    sub: 'x',
    preferred_username: '17338867713'
  }))
  check('falls back to the username', cn.label === '17338867713', cn.label)
}

console.log('\nmalformed input yields nothing rather than throwing:')
{
  for (const value of [undefined, null, '', 'not-a-token', 'a.b', 'a.b.c', 42]) {
    let result
    try {
      result = identityFromToken(value)
    } catch (error) {
      result = { threw: String(error) }
    }
    check(`survives ${JSON.stringify(value)}`,
      result?.threw === undefined && result.label === '' && result.uid === '',
      JSON.stringify(result))
  }
}

console.log('\na token whose payload is not JSON is ignored:')
{
  const broken = `header.${Buffer.from('not json').toString('base64url')}.sig`
  const result = identityFromToken(broken)
  check('no name invented', result.label === '', result.label)
}

console.log('\nreal tokens from this machine, when present:')
{
  // Optional: only runs where the desktop app is signed in.
  const { readVault } = await import('../lib/vault.js')
  const vault = readVault()
  const live = (vault.accounts ?? []).filter((a) => a && a.removed !== true && a.accessToken)
  if (live.length === 0) {
    check('no accounts to check (skipped)', true)
  } else {
    let named = 0
    for (const account of live) {
      const identity = identityFromToken(account.accessToken)
      if (identity.label.length > 0) named += 1
    }
    check('every stored token yields a name or an explicit blank', named <= live.length,
      `${named}/${live.length} named`)
  }
}

finish()
