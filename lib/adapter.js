/**
 * The BuddyHub `LlmAdapter`: streams model calls from BuddyHub's local
 * OpenAI-compatible proxy into the harness stream protocol.
 *
 * BuddyHub's proxy is a normalising reverse proxy in front of the WorkBuddy
 * desktop client. Two properties shape this adapter:
 *
 * 1. The upstream is *always* called with `stream: true`; the proxy decides the
 *    client-side encoding from the client's own `stream` boolean. This adapter
 *    always streams, which is the path the proxy is built around.
 * 2. The proxy rewrites the `model` field to its single upstream id and echoes
 *    the *requested* alias back in every SSE frame, so chunk `model` values are
 *    informational and the requested alias is what this adapter reports.
 *
 * Failures are classified onto harness codes rather than string-matched by
 * callers: `invalid_api_key` becomes `INVALID_CREDENTIAL`, a pool-exhaustion or
 * quota response becomes `QUOTA`, and everything else surfaces as a provider
 * failure whose text is the proxy's own message.
 *
 * @module dsh-buddyhub/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  isContextWindowExceededError
} from '@deepseek-ai/dsh-llm'
import { BUDDYHUB_EFFORTS, BUDDYHUB_MODEL_IDS, readConfig, resolveDataDir } from './discovery.js'
import { wireContentOf } from './image-wire.js'

/**
 * Provider route this adapter owns. One route carries both region models: the
 * proxy is a single endpoint whose region is chosen by the model id, so two
 * routes would only duplicate one configuration surface.
 */
export const PROVIDER_ID = 'buddyhub'

/** Display name for the provider group in the model picker. */
export const PROVIDER_NAME = 'BuddyHub'

/** Longest single model-call idle gap tolerated before the stream is abandoned. */
const STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Human-readable effort labels. BuddyHub's six efforts are its own vocabulary —
 * they are not the harness's `ReasoningEffortId` set — but the spellings are
 * shared, so the id passes through unchanged and only the label is authored.
 */
const EFFORT_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/**
 * `off` is deliberately absent.
 *
 * BuddyHub keeps a `reasoning_effort` only when it is one of its six known
 * values and silently drops anything else, and it has no separate switch for
 * disabling thinking. Advertising `off` would therefore offer a control that
 * cannot do what it says: it would be byte-for-byte the same request as naming
 * no effort, leaving the upstream's own default in force. Omitting the level
 * keeps the surface honest.
 */
export const REASONING_EFFORTS = BUDDYHUB_EFFORTS.map((id) => ({
  id: ReasoningEffortId(id),
  name: EFFORT_LABELS[id] ?? id
}))

/**
 * Read the live BuddyHub settings for this request.
 *
 * `config.json` is re-read on every operation rather than cached, because the
 * daemon rewrites it when the user changes a port, a key, or the default
 * region, and a stale port or key would fail every subsequent call. Reading a
 * small file per request is the cost of never needing a restart.
 *
 * @param dataDir - the configured data directory, when the deployment set one.
 * @returns the current settings plus a diagnostic when the file was unreadable.
 */
function settings(dataDir) {
  const result = readConfig(resolveDataDir(dataDir))
  return {
    ...result.config,
    path: result.path,
    exists: result.exists,
    error: result.error
  }
}

/**
 * Build the failure for a non-2xx proxy response.
 *
 * @param status - HTTP status the proxy returned.
 * @param body - decoded JSON body, when the response was JSON.
 * @returns an `LlmError` carrying the closest harness failure class.
 */
function httpFailure(status, body) {
  const error = body !== null && typeof body === 'object' ? body.error : undefined
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
  const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : `BuddyHub proxy returned HTTP ${status}`
  const type = error !== null && typeof error === 'object' && typeof error.type === 'string' ? error.type : undefined

  if (code === 'invalid_api_key' || status === 401 || status === 403) {
    return new LlmError(
      `BuddyHub rejected the local API key (${message}). The key is generated at first launch and stored in config.json; read it again with the buddyhub_client_config tool.`,
      INVALID_CREDENTIAL_CODE
    )
  }
  if (code === 'model_not_found') {
    return new LlmError(
      `BuddyHub does not serve this model (${message}). It serves exactly ${BUDDYHUB_MODEL_IDS.join(' and ')}.`,
      'UNKNOWN_MODEL'
    )
  }
  if (type === 'pool_unavailable' || status === 503) {
    return new LlmError(
      `BuddyHub has no usable account in this region's pool (${message}). Regions are independent and never fall back to each other, so sign in another account for this region in the BuddyHub window.`,
      QUOTA_EXCEEDED_CODE
    )
  }
  if (isContextWindowExceededError(message)) {
    return new LlmError(`BuddyHub rejected the request as too large: ${message}`, CONTEXT_WINDOW_EXCEEDED_CODE)
  }
  return new LlmError(`BuddyHub proxy error (HTTP ${status}): ${message}`, 'PROVIDER_ERROR')
}

/**
 * Map BuddyHub's `finish_reason` onto the harness finish vocabulary.
 *
 * An absent or unrecognised reason is reported as a normal stop: BuddyHub has
 * already completed the response, and inventing an error would turn a usable
 * answer into a failure.
 *
 * @param reason - the provider's finish reason, when present.
 * @returns the harness finish reason.
 */
function finishReason(reason) {
  switch (reason) {
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'stop' }
  }
}

/**
 * Convert harness messages into an OpenAI Chat Completions `messages` array.
 *
 * Only the fields BuddyHub forwards are emitted. `developer` messages are sent
 * as `developer` and the proxy rewrites them to `system`; doing the rewrite here
 * as well would hide that behaviour from anyone reading a packet capture.
 *
 * @param options - the harness request being dispatched.
 * @returns the provider-shaped message array.
 */
async function toWireMessages(options, attachments) {
  const messages = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const text = textOf(message.content)
    if (message.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: String(message.toolCallId ?? ''), content: text })
      continue
    }
    if (message.role === 'assistant') {
      const calls = toolCallsOf(message.content)
      messages.push({
        role: 'assistant',
        content: text.length === 0 ? null : text,
        ...(calls.length === 0 ? {} : { tool_calls: calls })
      })
      continue
    }
    if (message.role === 'developer' || message.role === 'system') {
      messages.push({ role: message.role, content: text })
      continue
    }
    // Image blocks are resolved into `image_url` parts; text-only content stays
    // a plain string because the upstream rejects the array form when unused.
    const content = await wireContentOf(message.content, attachments)
    messages.push({ role: 'user', content: content ?? '' })
  }
  return messages
}

/**
 * Flatten typed content blocks into the single text string this route sends.
 *
 * This route declares text-only input, so the harness has already replaced
 * image and file blocks with their textual placeholders before dispatch; any
 * block type that still reaches here is one the route has no wire form for, and
 * dropping it silently would lose model context. Reasoning blocks are omitted
 * because BuddyHub's upstream has no field to receive prior thinking.
 *
 * @param content - typed content blocks.
 * @returns the concatenated text.
 */
function textOf(content) {
  const parts = []
  for (const block of content ?? []) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * Extract assistant tool calls into the OpenAI wire shape.
 *
 * @param content - typed content blocks of one assistant message.
 * @returns the `tool_calls` array, empty when the message made no calls.
 */
function toolCallsOf(content) {
  const calls = []
  for (const block of content ?? []) {
    if (block.type !== 'tool-call') continue
    calls.push({
      id: String(block.id),
      type: 'function',
      function: { name: block.name, arguments: block.arguments }
    })
  }
  return calls
}

/**
 * Convert harness tool schemas into OpenAI `tools` entries.
 *
 * @param tools - the schemas active for this call.
 * @returns the provider-shaped tool array, or undefined when none are active.
 */
function toWireTools(tools) {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

/**
 * Parse one `data:` line from the proxy's SSE body.
 *
 * The proxy emits exactly `data: {json}\n\n` frames and terminates with
 * `data: [DONE]\n\n`. Frames it cannot parse are skipped rather than fatal: a
 * keep-alive or an unknown event must not abandon a healthy stream.
 *
 * @param line - one raw line from the response body.
 * @returns the decoded frame, `done` for the terminator, or undefined to skip.
 */
function parseFrame(line) {
  if (!line.startsWith('data:')) return undefined
  const payload = line.slice('data:'.length).trim()
  if (payload === '[DONE]') return { done: true }
  try {
    return { value: JSON.parse(payload) }
  } catch {
    return undefined
  }
}

/**
 * Incremental reader over a `fetch` response body's SSE frames.
 *
 * Chunk boundaries do not align with line boundaries, so a partial trailing
 * line is retained across reads.
 *
 * @param body - the response body stream.
 * @returns an async iterator of decoded frames.
 */
async function* frames(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const frame = parseFrame(line.trim())
      if (frame !== undefined) yield frame
    }
  }
  buffer += decoder.decode()
  const tail = parseFrame(buffer.trim())
  if (tail !== undefined) yield tail
}

/**
 * A BuddyHub-backed adapter for the single `buddyhub` provider route.
 *
 * Every operation reads the live configuration, so changing the proxy port or
 * rotating a key in the BuddyHub window takes effect on the next request
 * without reloading the plugin.
 */
export class BuddyHubAdapter extends LlmAdapter {
  /**
   * @param options - the deployment's data-directory and context-window
   *   settings, plus a logger for diagnostics.
   */
  constructor(options = {}) {
    super()
    this.dataDir = options.dataDir
    this.contextWindow = options.contextWindow
    this.logger = options.logger
    /** Resolves an ImageAttachmentRef into provider-ready request bytes. */
    this.attachments = options.attachments
  }

  /** The proxy root for the current settings, e.g. `http://127.0.0.1:8787/v1`. */
  baseUrl() {
    return `http://127.0.0.1:${settings(this.dataDir).port}/v1`
  }

  /** @inheritdoc */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /** @inheritdoc */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * Advertise both region routes.
   *
   * A non-empty catalog is required: the harness filters out provider groups
   * with no models, which would hide BuddyHub from the picker entirely.
   *
   * @inheritdoc
   */
  listModels(provider) {
    return Promise.resolve(BUDDYHUB_MODEL_IDS.map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text', 'image']
    })))
  }

  /**
   * Describe one model.
   *
   * The context window is a deployment setting rather than a discovered fact:
   * BuddyHub's proxy publishes no model metadata beyond the id, so the capacity
   * is whatever the operator states. Declaring it here keeps the number in one
   * place instead of hard-coding it into the catalog listing.
   *
   * @inheritdoc
   */
  resolveModel(provider, model) {
    if (!BUDDYHUB_MODEL_IDS.includes(model)) {
      return Promise.reject(new LlmError(
        `BuddyHub has no model "${model}"; it serves ${BUDDYHUB_MODEL_IDS.join(' and ')}.`,
        'UNKNOWN_MODEL'
      ))
    }
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: this.contextWindow },
      reasoning: { efforts: REASONING_EFFORTS }
    })
  }

  /**
   * Bind the model metadata and the eventual dispatch to one settings snapshot.
   *
   * @inheritdoc
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    }
  }

  /**
   * Stream one model call.
   *
   * @inheritdoc
   */
  async *stream(options) {
    if (options.stop !== undefined) {
      throw new LlmError('the BuddyHub route does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const config = settings(this.dataDir)
    if (config.localKey === undefined) {
      throw new LlmError(
        config.error ?? `no BuddyHub API key is available: ${config.path ?? 'config.json'} was not readable. Launch BuddyHub once so it generates its keys.`,
        INVALID_CREDENTIAL_CODE
      )
    }

    const body = {
      model: options.model,
      messages: await toWireMessages(options, this.attachments),
      stream: true,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens })
    }
    const tools = toWireTools(options.tools)
    if (tools !== undefined) body.tools = tools
    if (options.reasoningEffort !== undefined) {
      // The harness validated this against the advertised set, so it is one of
      // BuddyHub's own six spellings and passes through unchanged.
      body.reasoning_effort = String(options.reasoningEffort)
    }

    const headers = new Headers(attributionHeaders())
    headers.set('authorization', `Bearer ${config.localKey}`)
    headers.set('content-type', 'application/json')
    headers.set('accept', 'text/event-stream')

    let response
    try {
      response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal })
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('BuddyHub request aborted by caller', 'ABORTED', { cause: error })
      throw new LlmError(
        `cannot reach the BuddyHub proxy at ${this.baseUrl()}. Start BuddyHub, or correct the data directory if it stores its config elsewhere.`,
        'CONNECTION_FAILED',
        { cause: error }
      )
    }

    if (!response.ok) {
      const raw = await response.text()
      let decoded
      try {
        decoded = JSON.parse(raw)
      } catch {
        decoded = undefined
      }
      throw httpFailure(response.status, decoded)
    }
    if (response.body === null) {
      throw new LlmError('the BuddyHub proxy returned no response body', 'PROVIDER_ERROR')
    }

    yield* this.translate(frames(response.body), options)
  }

  /**
   * Translate BuddyHub's SSE frames into harness stream chunks.
   *
   * Text and reasoning each occupy a single block whose index is allocated on
   * first appearance; tool calls are keyed by the provider's per-choice call
   * index, because a provider may open several and interleave their argument
   * deltas. Every opened block is closed with its fully accumulated content,
   * since a `block-end` replaces whatever the deltas built.
   *
   * @param source - decoded provider frames.
   * @param options - the request, for cancellation and model attribution.
   * @returns the harness chunk stream.
   */
  async *translate(source, options) {
    const open = new Map()
    const order = []
    let nextIndex = 0
    let usage
    let reason
    let sawContent = false

    const openBlock = (key, blockType) => {
      const block = { index: nextIndex++, blockType, text: '', arguments: '', id: undefined, name: undefined }
      open.set(key, block)
      order.push(block)
      return block
    }

    for await (const frame of source) {
      if (frame.done === true) break
      const value = frame.value
      if (value === null || typeof value !== 'object') continue

      // The proxy delivers a mid-stream upstream failure as a 200 response
      // containing an `error` frame followed by `[DONE]`, so an in-band error is
      // the only signal that the answer is incomplete.
      if (value.error !== undefined && value.error !== null) {
        const detail = typeof value.error === 'object' && typeof value.error.message === 'string'
          ? value.error.message
          : JSON.stringify(value.error)
        throw new LlmError(`BuddyHub upstream failed mid-stream: ${detail}`, 'PROVIDER_ERROR')
      }

      if (value.usage !== undefined && value.usage !== null) usage = toUsage(value.usage)
      const choice = Array.isArray(value.choices) ? value.choices[0] : undefined
      if (choice === undefined || choice === null) continue
      const delta = choice.delta ?? {}

      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
      if (reasoning.length > 0) {
        let block = open.get('reasoning')
        if (block === undefined) {
          block = openBlock('reasoning', 'reasoning')
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += reasoning
        sawContent = true
        yield { type: 'reasoning-delta', index: block.index, text: reasoning }
      }

      const text = typeof delta.content === 'string' ? delta.content : ''
      if (text.length > 0) {
        let block = open.get('text')
        if (block === undefined) {
          block = openBlock('text', 'text')
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += text
        sawContent = true
        yield { type: 'text-delta', index: block.index, text }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (call === null || typeof call !== 'object') continue
          const wireIndex = typeof call.index === 'number' ? call.index : 0
          const key = `tool:${wireIndex}`
          let block = open.get(key)
          if (block === undefined) {
            block = openBlock(key, 'tool-call')
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
          // The id arrives on the first delta for a call and the name usually on
          // the same one; later deltas carry arguments only.
          if (typeof call.id === 'string' && call.id.length > 0) block.id = call.id
          const fn = call.function
          if (fn !== null && typeof fn === 'object') {
            if (typeof fn.name === 'string' && fn.name.length > 0) block.name = fn.name
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
              block.arguments += fn.arguments
              sawContent = true
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: ToolCallId(block.id ?? `call-${block.index}`),
                ...(block.name === undefined ? {} : { name: block.name }),
                argumentsDelta: fn.arguments
              }
            }
          }
        }
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        reason = finishReason(choice.finish_reason)
      }
    }

    for (const block of order) {
      if (block.blockType === 'text') {
        yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      } else if (block.blockType === 'reasoning') {
        yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      } else {
        yield {
          type: 'block-end',
          index: block.index,
          block: {
            type: 'tool-call',
            id: ToolCallId(block.id ?? `call-${block.index}`),
            name: block.name ?? '',
            arguments: block.arguments
          }
        }
      }
    }

    const resolved = reason ?? { kind: 'stop' }
    if (!sawContent && resolved.kind === 'stop') {
      // A terminal stop with no content would end the turn with nothing for the
      // user or the loop to act on, so it is reported as the failure it is.
      throw new LlmError('BuddyHub returned an empty completion', EMPTY_RESPONSE_CODE)
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: resolved }
  }
}

/**
 * Convert BuddyHub's OpenAI-style usage into harness token usage.
 *
 * @param raw - the provider's `usage` object.
 * @returns harness token usage with a derived total.
 */
function toUsage(raw) {
  const input = number(raw.prompt_tokens)
  const output = number(raw.completion_tokens)
  const usage = { inputTokens: input, outputTokens: output }
  const total = number(raw.total_tokens, input + output)
  usage.totalTokens = total
  const cached = number(raw.prompt_tokens_details?.cached_tokens, 0)
  if (cached > 0) usage.cacheReadTokens = cached
  const reasoning = number(raw.completion_tokens_details?.reasoning_tokens, 0)
  if (reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

/** Coerce a provider-reported number, falling back when it is absent or unusable. */
function number(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
