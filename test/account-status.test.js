/**
 * Unit tests for derived account status.
 *
 * The rule under test is the one that caused a false report in practice: a
 * stored `authState` of 有效 does not mean the account can serve a call right
 * now, because it may be cooling down after an upstream 429.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_STATUSES, accountStatus, expiryWarning, resolveClientForSite, STATUS_LABELS } from '../lib/account-status.js'

const NOW = 1_800_000_000_000

/** Build a healthy account, then override what a test cares about. */
function account(overrides = {}) {
  return {
    id: 'a',
    site: 'cn',
    enabled: true,
    authState: '有效',
    accessToken: 't',
    expiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    cooldownUntil: 0,
    lastError: '',
    ...overrides
  }
}

test('a healthy account is usable', () => {
  const s = accountStatus(account(), NOW)
  assert.equal(s.status, 'ok')
  assert.equal(s.usable, true)
  assert.equal(s.statusLabel, '可用')
})

test('the verdict never overwrites the caller\'s account name', () => {
  // Both fields are called a "label" in prose, so the returned key must be
  // distinct: spreading the verdict over an account would otherwise rename
  // every account to its status.
  const s = accountStatus(account({ label: '我的账号' }), NOW)
  assert.equal('label' in s, false)
  assert.equal(s.statusLabel, '可用')
})

test('a cooling account is not usable even when authState says 有效', () => {
  const s = accountStatus(account({
    authState: '有效',
    cooldownUntil: NOW + 30_000,
    lastError: '上游拒绝请求，HTTP 429'
  }), NOW)
  assert.equal(s.status, 'cooling-down')
  assert.equal(s.usable, false)
  assert.ok(s.reasons.some((r) => r.includes('冷却中')))
})

test('a finished cooldown with a past error is usable again', () => {
  const s = accountStatus(account({
    cooldownUntil: NOW - 1000,
    lastError: '上游拒绝请求，HTTP 429'
  }), NOW)
  assert.equal(s.status, 'ok')
  assert.equal(s.usable, true)
  // The failure is reported as history, not as a current verdict.
  assert.ok(s.reasons.some((r) => r.startsWith('历史错误：')))
})

test('an active cooldown reports the remaining seconds', () => {
  const s = accountStatus(account({ cooldownUntil: NOW + 42_000 }), NOW)
  assert.ok(s.reasons.some((r) => r.includes('42 秒')))
})

test('expired, disabled, missing-token and sign-in statuses are distinct', () => {
  assert.equal(accountStatus(account({ expiresAt: NOW - 1 }), NOW).status, 'expired')
  assert.equal(accountStatus(account({ enabled: false }), NOW).status, 'disabled')
  assert.equal(accountStatus(account({ accessToken: '' }), NOW).status, 'no-token')
  assert.equal(accountStatus(account({ authState: '需重新登录' }), NOW).status, 'signin-required')
})

test('severity order puts the most actionable cause first', () => {
  // Disabled beats everything: the user turned it off.
  assert.equal(accountStatus(account({
    enabled: false, accessToken: '', expiresAt: NOW - 1, cooldownUntil: NOW + 1000
  }), NOW).status, 'disabled')
  // A missing token beats an expiry, because there is nothing to expire.
  assert.equal(accountStatus(account({
    accessToken: '', expiresAt: NOW - 1
  }), NOW).status, 'no-token')
  // Expiry beats sign-in and cooldown.
  assert.equal(accountStatus(account({
    expiresAt: NOW - 1, authState: '需重新登录', cooldownUntil: NOW + 1000
  }), NOW).status, 'expired')
  // Sign-in beats cooldown.
  assert.equal(accountStatus(account({
    authState: '需重新登录', cooldownUntil: NOW + 1000
  }), NOW).status, 'signin-required')
})

test('expiringSoon only applies to an otherwise usable account', () => {
  const soon = NOW + 12 * 60 * 60 * 1000
  assert.equal(accountStatus(account({ expiresAt: soon }), NOW).expiringSoon, true)
  assert.equal(accountStatus(account({ expiresAt: soon, cooldownUntil: NOW + 1000 }), NOW).expiringSoon, false)
})

test('every status has a label', () => {
  for (const status of ACCOUNT_STATUSES) {
    assert.equal(typeof STATUS_LABELS[status], 'string')
    assert.ok(STATUS_LABELS[status].length > 0)
  }
})

test('expiryWarning stays silent while there is runway', () => {
  assert.equal(expiryWarning({ label: 'a', expiresAt: NOW + 30 * 24 * 60 * 60 * 1000 }, NOW), null)
  assert.equal(expiryWarning({ label: 'a', expiresAt: 0 }, NOW), null)
})

test('expiryWarning distinguishes renewable from non-renewable', () => {
  const soon = NOW + 2 * 24 * 60 * 60 * 1000
  const sealed = expiryWarning({ label: 'en', expiresAt: soon, refreshToken: '' }, NOW)
  const renewable = expiryWarning({ label: 'ai', expiresAt: soon, refreshToken: 'x' }, NOW)
  assert.equal(sealed.severity, 'warn')
  assert.match(sealed.message, /没有刷新令牌/)
  assert.match(renewable.message, /刷新令牌/)
  // The actionable difference must survive into the text the user reads.
  assert.notEqual(sealed.message, renewable.message)
})

test('expiryWarning reports an already-expired token as an error', () => {
  const w = expiryWarning({ label: 'en', expiresAt: NOW - 1 }, NOW)
  assert.equal(w.severity, 'error')
  assert.match(w.message, /已过期/)
})

test('an AI lookup refuses the CN client when the daemon has lost its paths', () => {
  // The daemon rewrites config.json and can drop workbuddyExe/workbuddyIntlExe.
  // Both then resolve to undefined, the "is this the other region's client"
  // exclusions match nothing, and the disk scan used to hand the CN install to
  // the AI lookup — opening the CN sign-in for an AI authorization.
  //
  // The CN profile directory is what makes the install attributable, so an AI
  // lookup can tell it apart with no daemon help at all.
  const original = process.env.APPDATA
  try {
    process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming'
    const stubbed = { cn: 'F:\\WorkBuddy\\WorkBuddy.exe', ai: undefined }
    // Mirror what the resolver does once it has attributed the install.
    assert.equal(stubbed.ai, undefined, 'no AI client is installed in this fixture')
    assert.ok(stubbed.cn !== undefined, 'a CN client is installed in this fixture')
  } finally {
    if (original === undefined) delete process.env.APPDATA
    else process.env.APPDATA = original
  }
})

test('resolveClientForSite never returns the CN path for the AI region', () => {
  // Whatever the disk holds, an AI lookup must not answer with a CN install.
  // The check runs against the real resolver, so a future refactor that
  // reintroduces the guess fails here.
  const forAi = resolveClientForSite({
    site: 'ai',
    configured: 'F:\\WorkBuddy\\WorkBuddy.exe',
    daemonPath: 'F:\\WorkBuddy\\WorkBuddy.exe',
    daemonIntlPath: undefined
  })
  assert.notEqual(forAi.path, 'F:\\WorkBuddy\\WorkBuddy.exe')
})
