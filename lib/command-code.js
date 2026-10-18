/**
 * Command Code → OpenAI-compatible translation, ported from ProxyDesk's
 * `proxy.mjs`.
 *
 * ## What Command Code actually speaks
 *
 * It is *not* OpenAI-shaped. `POST /alpha/generate` takes a CLI request
 * envelope and answers with NDJSON events, so two translations are needed:
 *
 * 1. **Request**: OpenAI `messages` → CC content blocks. A `system` prompt must
 *    be a *string* on `params.system`; an array is rejected outright. Tool
 *    calls become `tool-call` blocks and tool results become `tool-result`
 *    blocks, and a tool result has to carry the tool's *name*, which is
 *    recovered from the earlier assistant message that made the call.
 * 2. **Response**: NDJSON events (`text-delta`, `reasoning-delta`, `tool-call`,
 *    `finish-step`, `finish`, `error`) → OpenAI SSE chunks.
 *
 * ## Two behaviours worth preserving exactly
 *
 * - **Empty system placeholder.** When a client sends no system prompt, CC
 *   injects roughly 7.5K tokens of its own instructions *and* bills them as
 *   cached input. Sending a single space keeps `prompt_tokens` near zero. This
 *   is a deliberate workaround, not a bug.
 * - **Usage normalisation.** CC sometimes reports `outputTokens: 0` alongside a
 *   non-zero input count. Treating that as real overstates usage, so a zero
 *   output zeroes the input and cached counters too.
 *
 * @module buddy-connect/command-code
 */

import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'

/** Upstream root. */
export const CC_API_BASE = 'https://api.commandcode.ai'

/** CLI version the upstream expects on every request. */
const CC_VERSION_FALLBACK = '0.32.3'

/**
 * Models Command Code serves. The catalogue is refreshed from the upstream when
 * an API key is available; this list is the fallback shown before that.
 */
export const CC_MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'zai-org/GLM-5.1', name: 'GLM 5.1' },
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'stepfun/Step-3.7-Flash', name: 'Step 3.7 Flash' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' }
]

/** Default model when the client names none. */
export const CC_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash'

/** How long one upstream session id is reused (with jitter). */
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000
const SESSION_JITTER_MS = 60 * 60 * 1000

/** Upstream status → OpenAI status/type. */
const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' }
}

/** Parse JSON, returning an empty object on failure. */
function tryParseJSON(value) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

/**
 * Build a fake project slug the way the real CLI derives one.
 *
 * The upstream reports the project name on every request; inventing a plausible
 * one keeps a session's requests self-consistent without inventing a directory.
 *
 * @param sessionId - the session id being used.
 * @returns a slug such as `users-dev-projects-app-a3f2`.
 */
export function fakeProjectSlug(sessionId) {
  const names = ['app', 'api', 'backend', 'bot', 'cli', 'core', 'data', 'frontend',
    'lib', 'plugin', 'proxy', 'server', 'service', 'tool', 'web', 'worker']
  const id = String(sessionId ?? '')
  const head = id.slice(0, 4)
  let index = Number.parseInt(head, 16)
  if (!Number.isFinite(index)) {
    // A client-supplied cache key is not hexadecimal, so fall back to a
    // deterministic hash instead of producing "…-undefined-…".
    let h = 0
    for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
    index = h
  }
  const name = names[index % names.length]
  const suffix = head || '0000'
  return `C:\\Users\\dev\\projects\\${name}-${suffix}`
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A W3C traceparent value, so the upstream sees a plausible trace. */
export function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex')
  const parentId = crypto.randomBytes(8).toString('hex')
  return `00-${traceId}-${parentId}-01`
}

/**
 * Convert an OpenAI chat request into Command Code's CLI envelope.
 *
 * @param openaiRequest - the client body.
 * @param options - `emptySystemPlaceholder` toggles the space workaround.
 * @returns the upstream request body.
 */
export function buildCcRequest(openaiRequest, options = {}) {
  const {
    model, messages, max_tokens, temperature, tools,
    reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key
  } = openaiRequest

  // `params.system` must be a string; an array is rejected by the upstream
  // schema, so array content is flattened to text rather than forwarded.
  const systemMessages = (messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer')
  const systemPrompt = systemMessages.map((m) => {
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) return m.content.map((c) => c?.text ?? c?.content ?? '').join('\n')
    return m.content === null || m.content === undefined ? '' : String(m.content)
  }).join('\n')
  const chatMessages = (messages ?? []).filter((m) => m.role !== 'system' && m.role !== 'developer')

  // A tool result has to name its tool, but OpenAI only carries the call id, so
  // the name is recovered from the assistant message that issued the call.
  const toolNameMap = {}
  for (const message of chatMessages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) toolNameMap[call.id] = call.function?.name ?? ''
      }
    }
  }

  const ccMessages = chatMessages.map((message) => {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: message.content }] }
      }
      if (Array.isArray(message.content)) {
        const parts = message.content.map((part) => {
          if (part?.type === 'image_url') {
            return { type: 'image', image: part.image_url?.url ?? '' }
          }
          return part
        }).filter(Boolean)
        return { role: 'user', content: parts }
      }
      return { role: 'user', content: [{ type: 'text', text: String(message.content ?? '') }] }
    }
    if (message.role === 'assistant') {
      const parts = []
      if (typeof message.content === 'string' && message.content.length > 0) {
        parts.push({ type: 'text', text: message.content })
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === 'text') parts.push(part)
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.function?.name ?? '',
            input: typeof call.function?.arguments === 'string'
              ? tryParseJSON(call.function.arguments)
              : (call.function?.arguments ?? {})
          })
        }
      }
      return { role: 'assistant', content: parts }
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: message.tool_call_id,
          toolName: toolNameMap[message.tool_call_id] ?? message.name ?? '',
          output: {
            type: 'text',
            value: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
          }
        }]
      }
    }
    // Any unknown role is normalised to a user message so the upstream
    // validator never rejects the whole request over it.
    return { role: 'user', content: [{ type: 'text', text: String(message.content ?? '') }] }
  })

  // Put the cache boundary where the client asked for it, if it has not placed
  // one itself.
  const hasCacheMarker = ccMessages.some((m) =>
    Array.isArray(m.content) && m.content.some((p) => p?.cache_control))
  if (prompt_cache_key && !hasCacheMarker) {
    const firstUser = ccMessages.find((m) => m.role === 'user' && Array.isArray(m.content))
    if (firstUser) {
      for (let i = firstUser.content.length - 1; i >= 0; i -= 1) {
        if (firstUser.content[i]?.type === 'text') {
          firstUser.content[i].cache_control = { type: 'ephemeral' }
          break
        }
      }
    }
  }

  const body = {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: `${process.platform}-${process.arch}, Node.js ${process.version.slice(1)}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: []
    },
    memory: null,
    taste: null,
    skills: '',
    permissionMode: 'standard',
    params: {
      model: model || CC_DEFAULT_MODEL,
      messages: ccMessages,
      max_tokens: Math.min(max_tokens || 64000, 200000),
      // The upstream always streams; the client-facing encoding is decided here.
      stream: true
    }
  }

  if (systemPrompt) {
    body.params.system = systemPrompt
  } else if (options.emptySystemPlaceholder !== false) {
    // A single space suppresses the upstream's own ~7.5K-token default prompt,
    // which would otherwise be billed as cached input on every call.
    body.params.system = ' '
  }
  if (temperature !== undefined) body.params.temperature = temperature
  if (reasoning_effort !== undefined) body.params.reasoning_effort = reasoning_effort
  if (Array.isArray(tools) && tools.length > 0) {
    body.params.tools = tools.map((t) => ({
      type: t.type ?? 'function',
      name: t.function?.name ?? t.name ?? '',
      description: t.function?.description ?? t.description ?? '',
      input_schema: t.function?.parameters ?? t.input_schema ?? { type: 'object', properties: {} }
    }))
  }
  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      const map = { auto: 'auto', none: 'none', required: 'any' }
      body.params.tool_choice = { type: map[tool_choice] ?? 'auto' }
    } else if (tool_choice?.type === 'function') {
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name }
    } else {
      body.params.tool_choice = tool_choice
    }
  }
  if (parallel_tool_calls !== undefined) body.params.parallel_tool_calls = parallel_tool_calls

  return body
}

/** Map an upstream finish reason onto OpenAI's vocabulary. */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls'
    case 'length': return 'length'
    case 'stop': return 'stop'
    default: return reason || 'stop'
  }
}

/**
 * Normalise upstream usage before reporting it.
 *
 * A zero output count alongside a non-zero input count is an upstream artifact,
 * and billing it would overstate cost, so all counters are zeroed together.
 *
 * @param usage - the upstream usage object, mutated in place.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return
  if (!Number(usage.outputTokens)) {
    usage.inputTokens = 0
    usage.cachedInputTokens = 0
  }
}

/** Map an upstream HTTP failure onto an OpenAI-shaped error. */
export function mapCcError(status, bodyText) {
  const mapped = CC_STATUS_MAP[status] ?? { status: 502, type: 'upstream_error' }
  let message = `Command Code 返回 HTTP ${status}`
  if (typeof bodyText === 'string' && bodyText.length > 0) {
    try {
      const parsed = JSON.parse(bodyText)
      message = parsed.error?.message ?? parsed.message ?? message
    } catch {
      message = bodyText.slice(0, 200) || message
    }
  }
  if (mapped.status === 429) {
    return { status: 429, body: { error: { message, type: 'rate_limit_error' }, retry_after: 30 } }
  }
  return { status: mapped.status, body: { error: { message, type: mapped.type } } }
}

/**
 * Translate one NDJSON event into zero or more OpenAI SSE frames.
 *
 * Stateful across a stream because the first chunk must carry `role`, tool
 * calls are numbered in arrival order, and the finish frame reports the usage
 * accumulated from earlier `finish-step` events.
 */
export class CcStreamTranslator {
  /**
   * @param model - the model id to report to the client.
   */
  constructor(model) {
    this.model = model
    this.completionId = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`
    this.created = Math.floor(Date.now() / 1000)
    this.sentRole = false
    this.finishReason = null
    this.usage = null
    this.toolCallIndex = 0
    this.inputTokens = 0
    this.outputTokens = 0
    this.cachedInputTokens = 0
    /** Set when the upstream reported an in-band failure. */
    this.upstreamError = null
    this.lastEvent = ''
  }

  /** Build one SSE `data:` frame. */
  frame(delta, finishReason, usage) {
    const chunk = {
      id: this.completionId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }]
    }
    if (usage) chunk.usage = usage
    return `data: ${JSON.stringify(chunk)}\n\n`
  }

  /**
   * Parse one NDJSON line.
   *
   * @param line - a raw line from the upstream body.
   * @returns the SSE frames to emit, or null when the line carries nothing.
   */
  parseLine(line) {
    const trimmed = String(line ?? '').trim()
    if (trimmed.length === 0 || trimmed === '[DONE]' || trimmed.startsWith(':')) return null
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      return null
    }
    if (!event?.type) return null
    this.lastEvent = event.type
    const out = []

    switch (event.type) {
      case 'text-start':
      case 'reasoning-start':
      case 'start':
      case 'start-step':
      case 'reasoning-end':
      case 'provider-metadata':
      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'text-end':
        break

      case 'text-delta': {
        const text = event.text ?? event.delta ?? ''
        if (!text) break
        const delta = this.sentRole ? { content: text } : { role: 'assistant', content: text }
        this.sentRole = true
        out.push(this.frame(delta, null, null))
        break
      }

      case 'reasoning-delta': {
        const text = event.text ?? ''
        if (!text) break
        const delta = this.sentRole
          ? { reasoning_content: text }
          : { role: 'assistant', reasoning_content: text }
        this.sentRole = true
        out.push(this.frame(delta, null, null))
        break
      }

      case 'tool-call': {
        const id = event.toolCallId ?? `call_${Date.now()}_${this.toolCallIndex}`
        const name = event.toolName ?? ''
        const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input ?? {})
        const entry = {
          index: this.toolCallIndex,
          id,
          type: 'function',
          function: { name, arguments: args }
        }
        this.toolCallIndex += 1
        const delta = this.sentRole
          ? { tool_calls: [entry] }
          : { role: 'assistant', content: null, tool_calls: [entry] }
        this.sentRole = true
        out.push(this.frame(delta, null, null))
        break
      }

      case 'finish-step': {
        if (event.finishReason) this.finishReason = mapFinishReason(event.finishReason)
        if (event.usage) {
          this.usage = event.usage
          this.inputTokens = event.usage.inputTokens ?? 0
          this.outputTokens = event.usage.outputTokens ?? 0
          this.cachedInputTokens = event.usage.cachedInputTokens ?? 0
        }
        break
      }

      case 'finish': {
        const reason = this.finishReason ?? mapFinishReason(event.finishReason ?? 'stop')
        // Remember the resolved reason: the harness reads it after the stream
        // ends to decide whether the turn produced tool calls.
        this.finishReason = reason
        const usage = event.totalUsage ?? this.usage ?? {}
        normalizeUsage(usage)
        this.inputTokens = usage.inputTokens ?? 0
        this.outputTokens = usage.outputTokens ?? 0
        this.cachedInputTokens = usage.cachedInputTokens ?? 0
        out.push(this.frame({}, reason, {
          prompt_tokens: this.inputTokens,
          completion_tokens: this.outputTokens,
          total_tokens: this.inputTokens + this.outputTokens,
          prompt_tokens_details: { cached_tokens: this.cachedInputTokens }
        }))
        break
      }

      case 'error': {
        const message = event.error?.message ?? event.message ?? 'Unknown error'
        // A finish frame is deliberately *not* emitted here: a downstream agent
        // loop stops at the first finish_reason, so closing the stream early
        // would silently truncate the turn.
        this.upstreamError = mapCcError(Number((message.match(/^<(\d{3})>/)?.[1]) ?? 502), message)
        break
      }

      case 'tool-error':
        break

      default:
        break
    }

    return out.length > 0 ? out : null
  }

  /** The terminal frame every stream ends with. */
  done() {
    return 'data: [DONE]\n\n'
  }
}

/**
 * Quote a model list into the OpenAI catalogue shape.
 *
 * @param models - `{id, name}` entries.
 * @returns the `{object:'list', data:[...]}` body.
 */
export function ccModelCatalogue(models = CC_MODELS) {
  return {
    object: 'list',
    data: models.map((m) => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'command-code',
      ...(m.name ? { name: m.name } : {})
    }))
  }
}

/**
 * Build the upstream header set for one generate call.
 *
 * @param apiKey - the Command Code API key.
 * @param sessionId - the session id to report.
 * @param options - `version`, `zdr`.
 * @returns the header record.
 */
export function ccHeaders(apiKey, sessionId, options = {}) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': options.version ?? CC_VERSION_FALLBACK,
    'x-session-id': sessionId,
    'x-co-flag': 'false',
    'x-taste-learning': 'false',
    'x-project-slug': fakeProjectSlug(sessionId),
    traceparent: generateTraceparent()
  }
  if (options.zdr === true) headers['x-cmd-zdr'] = '1'
  return headers
}

/**
 * Per-key session ids, kept alive for a day with jitter.
 *
 * The upstream treats the session id as conversation identity, so recycling it
 * too eagerly looks like a new client every hour; recycling it never looks like
 * an unbounded session.
 */
export class SessionStore {
  constructor() {
    this.entries = new Map()
  }

  /**
   * Resolve the session id for one request.
   *
   * @param headers - the incoming request headers.
   * @param apiKey - the upstream key the request is billed to.
   * @param promptCacheKey - a client-supplied cache key, when present.
   * @returns a stable session id.
   */
  resolve(headers, apiKey, promptCacheKey) {
    for (const candidate of [
      headers?.['x-session-id'],
      headers?.['x-claude-code-session-id'],
      headers?.['session_id'],
      promptCacheKey
    ]) {
      if (typeof candidate === 'string' && candidate.length >= 8) return candidate
    }
    const now = Date.now()
    const entry = this.entries.get(apiKey)
    if (entry !== undefined && now < entry.expiresAt) return entry.sessionId
    const sessionId = randomUUID()
    const jitter = Math.floor(Math.random() * SESSION_JITTER_MS)
    this.entries.set(apiKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter })
    return sessionId
  }

  /** Drop expired entries so the map cannot grow without bound. */
  sweep(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key)
    }
  }
}
