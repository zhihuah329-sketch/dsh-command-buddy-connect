/**
 * Unit tests for the BuddyHub-compatible proxy rules.
 *
 * Run with: node --test test/
 *
 * The behaviours under test are the ones that are easy to get subtly wrong and
 * expensive to discover in production: region isolation, rotation eligibility,
 * request normalisation, and SSE frame handling.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  BASE_MODEL,
  MAX_ACCOUNTS,
  MODEL_IDS,
  AccountPool,
  dashify,
  eligibility,
  failureBody,
  looksLikeQuota,
  normalizeFrame,
  parseModel,
  preparePayload,
  requestContext,
  shouldRotate,
  upstreamHeaders,
  uuid7Hex
} from '../lib/proxy.js'

test('parseModel splits region and effort', () => {
  assert.deepEqual(parseModel('deepseek-v4.1-flash-ai', 'cn'), {
    upstream: BASE_MODEL, site: 'ai', effort: undefined
  })
  assert.deepEqual(parseModel('deepseek-v4.1-flash-ai-think-high', 'cn'), {
    upstream: BASE_MODEL, site: 'ai', effort: 'high'
  })
  assert.deepEqual(parseModel('deepseek-v4.1-flash-think', 'ai'), {
    upstream: BASE_MODEL, site: 'ai', effort: 'max'
  })
  // No suffix falls back to the default region.
  assert.deepEqual(parseModel('deepseek-v4.1-flash', 'cn'), {
    upstream: BASE_MODEL, site: 'cn', effort: undefined
  })
})

test('parseModel rejects anything it does not serve', () => {
  assert.equal(parseModel('bad-cn', 'cn'), null)
  assert.equal(parseModel('deepseek-v4-pro-cn', 'cn'), null)
  assert.equal(parseModel('', 'cn'), null)
  assert.equal(parseModel(undefined, 'cn'), null)
})

test('the advertised catalogue is exactly the two region routes', () => {
  assert.equal(MODEL_IDS.length, 2)
  const sites = MODEL_IDS.map((id) => parseModel(id, 'cn').site)
  assert.deepEqual(sites.sort(), ['ai', 'cn'])
  // A region suffix must survive as a distinct runtime model.
  for (const id of MODEL_IDS) assert.equal(parseModel(id, 'cn').effort, undefined)
})

test('shouldRotate moves on retryable failures only', () => {
  assert.equal(shouldRotate(429, undefined, ''), true)
  assert.equal(shouldRotate(500, undefined, ''), true)
  assert.equal(shouldRotate(503, undefined, ''), true)
  assert.equal(shouldRotate(401, undefined, ''), true)
  assert.equal(shouldRotate(403, undefined, ''), true)
  assert.equal(shouldRotate(200, 10001, ''), true)
  assert.equal(shouldRotate(400, undefined, '积分不足'), true)
  assert.equal(shouldRotate(400, undefined, 'quota exceeded'), true)
  // A metadata defect must not rotate: rotating would burn the whole pool.
  assert.equal(shouldRotate(400, 11128, ''), false)
  assert.equal(shouldRotate(200, 11128, 'conversation id missing'), false)
  // An ordinary bad request must not rotate either.
  assert.equal(shouldRotate(400, undefined, 'invalid message role'), false)
})

test('looksLikeQuota recognises both scripts', () => {
  assert.equal(looksLikeQuota('余额不足'), true)
  assert.equal(looksLikeQuota('Rate Limit exceeded'), true)
  assert.equal(looksLikeQuota('模型参数错误'), false)
})

test('preparePayload rewrites the client body for the upstream', () => {
  const p = preparePayload({
    messages: [{ role: 'developer', content: 'test' }],
    reasoning: { enabled: true, effort: 'max' },
    tool_choice: { type: 'function', function: { name: 'f' } }
  })
  assert.equal(p.stream, true)
  assert.equal(p.messages[0].role, 'system')
  assert.equal(p.tool_choice, 'f')
  assert.equal(p.reasoning_effort, 'max')
  assert.equal(p.reasoning, undefined)
})

test('preparePayload drops reasoning_effort entirely when thinking is off', () => {
  // `none` is not an upstream effort spelling, so the reference implementation
  // removes the field rather than sending it: an explicit `enabled: false`
  // therefore becomes "send no effort", not "send none".
  const p = preparePayload({ messages: [], reasoning: { enabled: false, effort: 'max' } })
  assert.equal('reasoning_effort' in p, false)
  assert.equal('reasoning' in p, false)
})

test('preparePayload injects a system message when none leads', () => {
  const p = preparePayload({ messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(p.messages[0].role, 'system')
  assert.equal(p.messages[1].role, 'user')
})

test('preparePayload drops tools for tool_choice none', () => {
  const p = preparePayload({
    messages: [{ role: 'system', content: 's' }],
    tool_choice: 'none',
    tools: [{ type: 'function', function: { name: 'f' } }]
  })
  assert.equal(p.tools, undefined)
  assert.equal(p.tool_choice, undefined)
})

test('preparePayload keeps a valid effort and drops an unknown one', () => {
  assert.equal(preparePayload({ messages: [], reasoning_effort: 'HIGH' }).reasoning_effort, 'high')
  assert.equal(preparePayload({ messages: [], reasoning_effort: 'turbo' }).reasoning_effort, undefined)
})

test('normalizeFrame drops frames with nothing in them', () => {
  const empty = normalizeFrame({
    choices: [{ delta: { content: '', reasoning_content: '', tool_calls: [] } }]
  }, 'm')
  assert.equal(empty, null)
})

test('normalizeFrame keeps a tool_call id even without arguments', () => {
  const f = normalizeFrame({
    choices: [{ delta: { content: '', tool_calls: [{ index: 0, id: 'call' }] } }]
  }, 'm')
  assert.ok(f)
  assert.equal(f.choices[0].delta.tool_calls[0].id, 'call')
  assert.equal(f.choices[0].delta.reasoning_content, undefined)
})

test('normalizeFrame keeps usage-only frames', () => {
  const f = normalizeFrame({ usage: { prompt_tokens: 1 } }, 'm')
  assert.ok(f)
  assert.deepEqual(f.usage, { prompt_tokens: 1 })
})

test('requestContext is stable across tool continuations', () => {
  const base = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' }
  ]
  const a = requestContext({ messages: base }, '')
  const b = requestContext({ messages: [...base, { role: 'assistant', content: 'a' }] }, '')
  assert.equal(a.session, b.session)
  // A new user turn changes only the turn key.
  const c = requestContext({ messages: [...base, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u2' }] }, '')
  assert.equal(a.session, c.session)
  assert.notEqual(a.turn, c.turn)
})

test('requestContext prefers an explicit session header', () => {
  const a = requestContext({ messages: [{ role: 'user', content: 'x' }] }, 'client-session')
  const b = requestContext({ messages: [{ role: 'user', content: 'y' }] }, 'client-session')
  assert.equal(a.session, b.session)
})

test('uuid7Hex is a version-7, RFC-4122-variant, 32-char hex id', () => {
  const id = uuid7Hex()
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.equal(id[12], '7')
  assert.ok(['8', '9', 'a', 'b'].includes(id[16]))
})

test('dashify renders the upstream conversation format', () => {
  assert.equal(
    dashify('0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef'
  )
})

test('AccountPool keeps regions strictly separate', () => {
  const pool = new AccountPool([
    { id: 'cn1', site: 'cn', accessToken: 't', uid: 'u1' },
    { id: 'ai1', site: 'ai', accessToken: 't', uid: 'u2' }
  ])
  assert.equal(pool.pick('cn').id, 'cn1')
  assert.equal(pool.pick('ai').id, 'ai1')
  // An AI account must never serve a CN request.
  pool.finish('cn1', false, 'down', 60_000)
  assert.equal(pool.pick('cn'), undefined)
  assert.equal(pool.pick('ai').id, 'ai1')
})

test('AccountPool prefers the least busy account', () => {
  const pool = new AccountPool([
    { id: 'a', site: 'cn', accessToken: 't', uid: '1' },
    { id: 'b', site: 'cn', accessToken: 't', uid: '2' }
  ])
  const first = pool.pick('cn')
  const second = pool.pick('cn')
  assert.notEqual(first.id, second.id)
  // Both are now busy; a third pick must still return one of them.
  const third = pool.pick('cn')
  assert.ok([first.id, second.id].includes(third.id))
})

test('AccountPool skips disabled, cooled, and signed-out accounts', () => {
  const pool = new AccountPool([
    { id: 'a', site: 'cn', accessToken: 't', uid: '1', enabled: false },
    { id: 'b', site: 'cn', accessToken: 't', uid: '2', authState: '需重新登录' },
    { id: 'c', site: 'cn', accessToken: 't', uid: '3' }
  ])
  assert.equal(pool.pick('cn').id, 'c')
})

test('AccountPool honours exclusions for one request', () => {
  const pool = new AccountPool([
    { id: 'a', site: 'cn', accessToken: 't', uid: '1' },
    { id: 'b', site: 'cn', accessToken: 't', uid: '2' }
  ])
  const first = pool.pick('cn')
  const excluded = new Set([first.id])
  const second = pool.pick('cn', excluded)
  assert.notEqual(first.id, second.id)
})

test('AccountPool counters and cooldown update on finish', () => {
  const pool = new AccountPool([{ id: 'a', site: 'cn', accessToken: 't', uid: '1' }])
  pool.pick('cn')
  pool.finish('a', false, 'boom', 60_000)
  const snap = pool.snapshot()[0]
  assert.equal(snap.failures, 1)
  assert.equal(snap.inflight, 0)
  assert.equal(snap.lastError, 'boom')
  assert.ok(snap.cooldownUntil > Date.now())
  assert.deepEqual(pool.poolCounts(), { cn: 0, ai: 0 })
})

test('AccountPool snapshot never leaks the token', () => {
  const pool = new AccountPool([{ id: 'a', site: 'cn', accessToken: 'secret-token', uid: '1' }])
  const text = JSON.stringify(pool.snapshot())
  assert.equal(text.includes('secret-token'), false)
})

test('AccountPool replace preserves live counters', () => {
  const pool = new AccountPool([{ id: 'a', site: 'cn', accessToken: 't', uid: '1' }])
  pool.pick('cn')
  pool.replace([{ id: 'a', site: 'cn', accessToken: 't2', uid: '1' }])
  assert.equal(pool.snapshot()[0].inflight, 1)
})

test('upstreamHeaders carries the conversation metadata', () => {
  const h = upstreamHeaders(
    { accessToken: 'tok', uid: 'u', domain: 'd.example', enterpriseId: 'e1' },
    'https://base',
    { conversation: 'conv', turn: 'turn', message: 'msg' }
  )
  assert.equal(h.authorization, 'Bearer tok')
  assert.equal(h['x-conversation-id'], 'conv')
  assert.equal(h['x-conversation-request-id'], 'turn')
  assert.equal(h['x-conversation-message-id'], 'msg')
  assert.equal(h['x-request-id'], 'msg')
  assert.equal(h['x-enterprise-id'], 'e1')
  assert.match(h['x-request-trace-id'], /^[0-9a-f]{32}$/)
})

test('upstreamHeaders omits enterprise id when absent', () => {
  const h = upstreamHeaders({ accessToken: 't', uid: 'u', domain: 'd' }, 'https://b', {
    conversation: 'c', turn: 't', message: 'm'
  })
  assert.equal('x-enterprise-id' in h, false)
})

test('failureBody explains 11128 without echoing upstream text', () => {
  const b = failureBody(400, 11128)
  assert.match(b.error.message, /conversation id missing/)
  const generic = failureBody(500, undefined)
  assert.equal(generic.error.message, '上游拒绝请求，HTTP 500')
  assert.equal('code' in generic.error, false)
})

test('MAX_ACCOUNTS bounds one request to a whole pool', () => {
  assert.ok(MAX_ACCOUNTS >= 2)
})

test('poolCounts and accountStatus apply the same eligibility rule', () => {
  // Both answer "can this account serve a call now". If they ever disagree the
  // page shows two different truths, so the shared rule is asserted directly.
  const now = 1_800_000_000_000
  const shapes = [
    { enabled: true, authState: '有效', accessToken: 't', expiresAt: now + 1e9, cooldownUntil: 0 },
    { enabled: true, authState: '有效', accessToken: 't', expiresAt: now - 1, cooldownUntil: 0 },
    { enabled: false, authState: '有效', accessToken: 't', expiresAt: now + 1e9, cooldownUntil: 0 },
    { enabled: true, authState: '需重新登录', accessToken: 't', expiresAt: now + 1e9, cooldownUntil: 0 },
    { enabled: true, authState: '有效', accessToken: 't', expiresAt: now + 1e9, cooldownUntil: now + 1000 },
    { enabled: true, authState: '有效', accessToken: '', expiresAt: now + 1e9, cooldownUntil: 0 }
  ]
  for (const shape of shapes) {
    const pool = new AccountPool([{ id: 'x', site: 'cn', uid: 'u', ...shape }])
    const counted = pool.poolCounts(now).cn === 1
    assert.equal(counted, eligibility(shape, now).usable)
  }
})
