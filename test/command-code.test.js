/**
 * Unit tests for the Command Code translation.
 *
 * These run entirely offline. That matters here: the account's subscription can
 * lapse at any time, and the protocol contract must stay verifiable even then.
 * Every expectation below is traceable to observed upstream behaviour recorded
 * in ProxyDesk's `proxy.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CC_DEFAULT_MODEL,
  CC_MODELS,
  CcStreamTranslator,
  SessionStore,
  buildCcRequest,
  ccHeaders,
  ccModelCatalogue,
  fakeProjectSlug,
  mapCcError,
  mapFinishReason,
  normalizeUsage
} from '../lib/command-code.js'

test('system prompts are flattened to a string on params.system', () => {
  // The upstream rejects an array here, so array content has to be joined.
  const body = buildCcRequest({
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'developer', content: 'c' },
      { role: 'user', content: 'hi' }
    ]
  })
  assert.equal(typeof body.params.system, 'string')
  assert.equal(body.params.system, 'a\nb\nc')
})

test('an absent system prompt becomes a single-space placeholder', () => {
  // Without this the upstream injects ~7.5K tokens of its own prompt and bills
  // them as cached input.
  const body = buildCcRequest({ messages: [{ role: 'user', content: 'x' }] })
  assert.equal(body.params.system, ' ')

  const disabled = buildCcRequest({ messages: [{ role: 'user', content: 'x' }] }, {
    emptySystemPlaceholder: false
  })
  assert.equal('system' in disabled.params, false)
})

test('tool results recover their tool name from the earlier assistant call', () => {
  const body = buildCcRequest({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"p":"a"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'contents' }
    ]
  })
  const toolMessage = body.params.messages.find((m) => m.role === 'tool')
  assert.equal(toolMessage.content[0].type, 'tool-result')
  assert.equal(toolMessage.content[0].toolName, 'read_file')
  assert.equal(toolMessage.content[0].output.value, 'contents')
})

test('assistant tool calls become tool-call blocks with parsed input', () => {
  const body = buildCcRequest({
    messages: [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]
      }
    ]
  })
  const assistant = body.params.messages.find((m) => m.role === 'assistant')
  assert.deepEqual(assistant.content[0], { type: 'text', text: 'thinking' })
  assert.deepEqual(assistant.content[1], {
    type: 'tool-call', toolCallId: 'c', toolName: 'f', input: { a: 1 }
  })
})

test('images are translated to the upstream image block shape', () => {
  const body = buildCcRequest({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
      ]
    }]
  })
  const parts = body.params.messages[0].content
  assert.deepEqual(parts[1], { type: 'image', image: 'data:image/png;base64,AAA' })
})

test('tool_choice maps onto the Anthropic-style vocabulary', () => {
  const required = buildCcRequest({ messages: [], tool_choice: 'required' })
  assert.deepEqual(required.params.tool_choice, { type: 'any' })

  const named = buildCcRequest({
    messages: [],
    tool_choice: { type: 'function', function: { name: 'f' } }
  })
  assert.deepEqual(named.params.tool_choice, { type: 'tool', name: 'f' })
})

test('tools are flattened to name + input_schema', () => {
  const body = buildCcRequest({
    messages: [],
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }]
  })
  assert.deepEqual(body.params.tools[0], {
    type: 'function', name: 'f', description: 'd', input_schema: { type: 'object' }
  })
})

test('max_tokens is capped and the upstream is always streamed', () => {
  const body = buildCcRequest({ messages: [], max_tokens: 999_999 })
  assert.equal(body.params.max_tokens, 200_000)
  assert.equal(body.params.stream, true)
})

test('an unknown role is normalised rather than rejecting the request', () => {
  const body = buildCcRequest({ messages: [{ role: 'weird', content: 'x' }] })
  assert.equal(body.params.messages[0].role, 'user')
  assert.ok(Array.isArray(body.params.messages[0].content))
})

test('the stream translator emits role on the first chunk only', () => {
  const t = new CcStreamTranslator('m')
  const first = t.parseLine('{"type":"text-delta","text":"a"}')
  const second = t.parseLine('{"type":"text-delta","text":"b"}')
  const parse = (f) => JSON.parse(f[0].replace(/^data: /, '').trim())
  assert.equal(parse(first).choices[0].delta.role, 'assistant')
  assert.equal('role' in parse(second).choices[0].delta, false)
  assert.equal(parse(second).choices[0].delta.content, 'b')
})

test('reasoning deltas become reasoning_content', () => {
  const t = new CcStreamTranslator('m')
  const frames = t.parseLine('{"type":"reasoning-delta","text":"why"}')
  const chunk = JSON.parse(frames[0].replace(/^data: /, '').trim())
  assert.equal(chunk.choices[0].delta.reasoning_content, 'why')
})

test('tool calls are numbered in arrival order', () => {
  const t = new CcStreamTranslator('m')
  t.parseLine('{"type":"tool-call","toolCallId":"a","toolName":"f","input":{"x":1}}')
  const frames = t.parseLine('{"type":"tool-call","toolCallId":"b","toolName":"g","input":{}}')
  const chunk = JSON.parse(frames[0].replace(/^data: /, '').trim())
  assert.equal(chunk.choices[0].delta.tool_calls[0].index, 1)
  assert.equal(chunk.choices[0].delta.tool_calls[0].id, 'b')
})

test('finish records the resolved finish reason and usage', () => {
  const t = new CcStreamTranslator('m')
  t.parseLine('{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":5}}')
  assert.equal(t.finishReason, 'tool_calls')
  assert.equal(t.inputTokens, 10)
  assert.equal(t.outputTokens, 5)
})

test('an in-band error is captured and emits no finish frame', () => {
  // A finish_reason closes the downstream agent loop, so emitting one here
  // would silently truncate the turn instead of reporting the failure.
  const t = new CcStreamTranslator('m')
  const frames = t.parseLine('{"type":"error","error":{"message":"<429> slow down"}}')
  assert.equal(frames, null)
  assert.notEqual(t.upstreamError, null)
  assert.equal(t.upstreamError.status, 429)
})

test('sparse and unknown events produce nothing', () => {
  const t = new CcStreamTranslator('m')
  assert.equal(t.parseLine('{"type":"text-delta","text":""}'), null)
  assert.equal(t.parseLine('{"type":"provider-metadata"}'), null)
  assert.equal(t.parseLine('not json'), null)
  assert.equal(t.parseLine(''), null)
  assert.equal(t.parseLine(': keep-alive'), null)
})

test('zero output tokens zeroes the input counters too', () => {
  // Otherwise an upstream artifact is reported as billable cached input.
  const usage = { inputTokens: 100, outputTokens: 0, cachedInputTokens: 50 }
  normalizeUsage(usage)
  assert.deepEqual(usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })
})

test('finish reasons map onto the OpenAI vocabulary', () => {
  assert.equal(mapFinishReason('tool-calls'), 'tool_calls')
  assert.equal(mapFinishReason('length'), 'length')
  assert.equal(mapFinishReason('stop'), 'stop')
  assert.equal(mapFinishReason(undefined), 'stop')
})

test('402 becomes a rate-limit error with a retry hint', () => {
  const mapped = mapCcError(402, '{"error":{"message":"insufficient credits"}}')
  assert.equal(mapped.status, 429)
  assert.equal(mapped.body.retry_after, 30)
  assert.equal(mapped.body.error.message, 'insufficient credits')
})

test('401 and 403 both become authentication errors', () => {
  assert.equal(mapCcError(401, '').status, 401)
  assert.equal(mapCcError(403, '').status, 401)
})

test('an unknown status falls back to 502', () => {
  assert.equal(mapCcError(418, '').status, 502)
})

test('the project slug is deterministic and slug-shaped', () => {
  const a = fakeProjectSlug('abcdef12-3456-7890')
  const b = fakeProjectSlug('abcdef12-3456-7890')
  assert.equal(a, b)
  assert.match(a, /^[a-z0-9-]+$/)
  assert.equal(a.includes('undefined'), false)
  // A non-hexadecimal client cache key must still produce a usable slug.
  const custom = fakeProjectSlug('my-stable-cache-key-001')
  assert.equal(custom.includes('undefined'), false)
  assert.match(custom, /^[a-z0-9-]+$/)
})

test('upstream headers carry the CLI identity fields', () => {
  const h = ccHeaders('key', 'session-1234')
  for (const name of ['authorization', 'x-cli-environment', 'x-command-code-version',
    'x-session-id', 'x-co-flag', 'x-project-slug', 'traceparent']) {
    assert.ok(name in h, `missing ${name}`)
  }
  assert.equal(h.authorization, 'Bearer key')
  assert.match(h.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
})

test('zdr is only sent when enabled', () => {
  assert.equal('x-cmd-zdr' in ccHeaders('k', 's'.repeat(8)), false)
  assert.equal(ccHeaders('k', 's'.repeat(8), { zdr: true })['x-cmd-zdr'], '1')
})

test('sessions are stable per key and honour a client header', () => {
  const store = new SessionStore()
  const first = store.resolve({}, 'keyA')
  assert.equal(store.resolve({}, 'keyA'), first)
  assert.notEqual(store.resolve({}, 'keyB'), first)
  assert.equal(store.resolve({ 'x-session-id': 'client-session-1' }, 'keyA'), 'client-session-1')
})

test('sweep drops only expired sessions', () => {
  const store = new SessionStore()
  const id = store.resolve({}, 'k')
  store.sweep(Date.now() + 24 * 60 * 60 * 1000 + 1)
  assert.notEqual(store.resolve({}, 'k'), id)
})

test('the static catalogue is non-empty and well shaped', () => {
  assert.ok(CC_MODELS.length >= 10)
  for (const m of CC_MODELS) {
    assert.equal(typeof m.id, 'string')
    assert.ok(m.id.length > 0)
  }
  assert.ok(CC_MODELS.some((m) => m.id === CC_DEFAULT_MODEL))
})

test('the OpenAI catalogue shape wraps the model list', () => {
  const catalogue = ccModelCatalogue()
  assert.equal(catalogue.object, 'list')
  assert.equal(catalogue.data.length, CC_MODELS.length)
  assert.equal(catalogue.data[0].object, 'model')
})
