/**
 * The Command Code `LlmAdapter`: serves Command Code models through the
 * translation in `lib/command-code.js`.
 *
 * This is what makes the ProxyDesk proxy unnecessary as a separate process:
 * the same OpenAI-shaped surface is produced in-process, so DSH can pick a
 * Command Code model without a daemon listening on another port.
 *
 * @module buddy-connect/cc-adapter
 */

import {
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import {
  CC_API_BASE,
  CC_DEFAULT_MODEL,
  CC_MODELS,
  CcStreamTranslator,
  SessionStore,
  buildCcRequest,
  ccHeaders,
  ccModelCatalogue,
  mapCcError
} from './command-code.js'
import { wireContentOf } from './image-wire.js'

/** Provider route owned by this adapter. */
export const CC_PROVIDER_ID = 'command-code'

/** Display name shown in the model picker. */
export const CC_PROVIDER_NAME = 'Command Code'

/** Reasoning efforts Command Code accepts. */
const CC_EFFORTS = ['low', 'medium', 'high']

const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High' }

export const CC_REASONING_EFFORTS = CC_EFFORTS.map((id) => ({
  id: ReasoningEffortId(id),
  name: EFFORT_LABELS[id]
}))

/** A single call may not exceed this; the upstream caps it too. */
const MAX_TOKENS_CAP = 200_000

/**
 * Serves Command Code models from one API key.
 */
export class CommandCodeAdapter extends LlmAdapter {
  /**
   * @param options - `apiKey`, `apiBase`, `contextWindow`, `zdr`, `logger`.
   */
  constructor(options = {}) {
    super()
    this.apiKey = options.apiKey
    this.apiBase = options.apiBase ?? CC_API_BASE
    this.contextWindow = options.contextWindow
    this.zdr = options.zdr === true
    this.logger = options.logger
    /** Returns whether this route may serve; the page's switch drives it. */
    this.isEnabled = options.isEnabled ?? (() => true)
    /** Resolves an ImageAttachmentRef into provider-ready request bytes. */
    this.attachments = options.attachments
    this.sessions = new SessionStore()
    /** Catalogue discovered from the upstream, when a key works. */
    this.discovered = null
    this.discoveredAt = 0
  }

  /** Whether this route can serve calls at all. */
  configured() {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  /**
   * Read the upstream catalogue, caching it for five minutes.
   *
   * The static list is used until the first successful read, so the picker is
   * never empty just because the network is briefly unavailable.
   *
   * @returns `{id, name}` entries.
   */
  async catalogue() {
    if (!this.configured()) return CC_MODELS
    if (this.discovered !== null && Date.now() - this.discoveredAt < 5 * 60 * 1000) {
      return this.discovered
    }
    try {
      const response = await fetch(`${this.apiBase}/provider/v1/models`, {
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(15_000)
      })
      if (response.ok) {
        const body = await response.json()
        const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
        const models = rows
          .map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m?.id, name: m?.name ?? m?.id }))
          .filter((m) => typeof m.id === 'string' && m.id.length > 0)
        if (models.length > 0) {
          this.discovered = models
          this.discoveredAt = Date.now()
          return models
        }
      }
    } catch (error) {
      this.logger?.debug?.(`buddy-connect: Command Code 模型目录读取失败：${messageOf(error)}`)
    }
    return CC_MODELS
  }

  /** @inheritdoc */
  providerInfo(provider) {
    return { id: provider, name: CC_PROVIDER_NAME }
  }

  /** @inheritdoc */
  providerRetryPolicy() {
    return undefined
  }

  /**
   * Advertise the catalogue, prefixing nothing: these are Command Code's own
   * model ids and clients may already know them.
   *
   * @inheritdoc
   */
  async listModels(provider) {
    const models = await this.catalogue()
    return models.map((m) => ({
      provider,
      id: m.id,
      name: m.name ?? m.id,
      inputModalities: ['text', 'image']
    }))
  }

  /** @inheritdoc */
  async resolveModel(provider, model) {
    const models = await this.catalogue()
    const known = models.find((m) => m.id === model)
    if (known === undefined) {
      return Promise.reject(new LlmError(
        `Command Code 没有模型 "${model}"。可用模型可在设置中查看，或直接使用 ${CC_DEFAULT_MODEL}。`,
        'UNKNOWN_MODEL'
      ))
    }
    return {
      provider,
      id: model,
      name: known.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: this.contextWindow },
      reasoning: { efforts: CC_REASONING_EFFORTS }
    }
  }

  /** @inheritdoc */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    }
  }

  /**
   * Stream one call.
   *
   * The upstream is always streamed; a client that asked for a non-streaming
   * answer is served by collapsing the same event stream, so there is one code
   * path rather than two that can drift apart.
   *
   * @inheritdoc
   */
  async *stream(options) {
    if (this.isEnabled() !== true) {
      throw new LlmError('Command Code 线路已在插件页面停用，启用后才能调用。', 'PROVIDER_ERROR')
    }
    if (!this.configured()) {
      throw new LlmError(
        'Command Code 尚未配置 API Key。请在插件页面的「模型线路」中填写 API Key。',
        INVALID_CREDENTIAL_CODE
      )
    }
    if (options.stop !== undefined) {
      throw new LlmError('Command Code 线路不支持 GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }

    const body = buildCcRequest({
      model: options.model ?? CC_DEFAULT_MODEL,
      messages: await this.toWireMessages(options),
      max_tokens: Math.min(options.maxTokens ?? 64_000, MAX_TOKENS_CAP),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.tools === undefined || options.tools.length === 0 ? {} : {
        tools: options.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        }))
      }),
      ...(options.reasoningEffort === undefined ? {} : { reasoning_effort: String(options.reasoningEffort) })
    }, { emptySystemPlaceholder: true })

    const sessionId = this.sessions.resolve({}, this.apiKey, options.sessionId)

    let response
    try {
      response = await fetch(`${this.apiBase}/alpha/generate`, {
        method: 'POST',
        headers: ccHeaders(this.apiKey, sessionId, { zdr: this.zdr }),
        body: JSON.stringify(body),
        signal: options.signal
      })
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new LlmError('请求已取消', 'ABORTED', { cause: error })
      }
      throw new LlmError(`无法连接 Command Code：${messageOf(error)}`, 'CONNECTION_FAILED', { cause: error })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const mapped = mapCcError(response.status, text)
      throw this.toLlmError(mapped)
    }
    if (response.body === null) {
      throw new LlmError('Command Code 没有返回响应体', 'PROVIDER_ERROR')
    }

    yield* this.translate(response.body, options)
  }

  /**
   * Translate the upstream NDJSON stream into harness chunks.
   *
   * @param source - the upstream body stream.
   * @param options - the request, for cancellation and attribution.
   * @returns the harness chunk stream.
   */
  async *translate(source, options) {
    const translator = new CcStreamTranslator(options.model ?? CC_DEFAULT_MODEL)
    const decoder = new TextDecoder()
    let buffer = ''
    let sawContent = false

    // Blocks are tracked so each one is closed with its accumulated text: the
    // harness replaces a block's content on block-end, so a partial close would
    // truncate the answer.
    const blocks = []
    let textBlock = null
    let reasoningBlock = null
    const toolBlocks = new Map()
    let nextIndex = 0

    for await (const chunk of source) {
      if (options.signal?.aborted === true) return
      buffer += decoder.decode(chunk, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const frames = translator.parseLine(line)
        if (frames === null) continue
        for (const frame of frames) {
          const payload = frame.replace(/^data:\s*/, '').trim()
          if (payload === '[DONE]') continue
          let value
          try {
            value = JSON.parse(payload)
          } catch {
            continue
          }
          const delta = value.choices?.[0]?.delta
          if (delta === undefined || delta === null) continue

          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            if (reasoningBlock === null) {
              reasoningBlock = { index: nextIndex, text: '' }
              nextIndex += 1
              blocks.push({ type: 'reasoning', ref: reasoningBlock })
              yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
            }
            reasoningBlock.text += delta.reasoning_content
            sawContent = true
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.reasoning_content }
          }

          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (textBlock === null) {
              textBlock = { index: nextIndex, text: '' }
              nextIndex += 1
              blocks.push({ type: 'text', ref: textBlock })
              yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
            }
            textBlock.text += delta.content
            sawContent = true
            yield { type: 'text-delta', index: textBlock.index, text: delta.content }
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const key = String(call?.index ?? 0)
              let block = toolBlocks.get(key)
              if (block === undefined) {
                block = { index: nextIndex, id: call?.id, name: undefined, arguments: '' }
                nextIndex += 1
                toolBlocks.set(key, block)
                blocks.push({ type: 'tool-call', ref: block })
                yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              }
              if (typeof call?.id === 'string' && call.id.length > 0) block.id = call.id
              const fn = call?.function
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
        }
        if (translator.upstreamError !== null) {
          throw this.toLlmError(translator.upstreamError)
        }
      }
    }

    for (const block of blocks) {
      if (block.type === 'text') {
        yield { type: 'block-end', index: block.ref.index, block: { type: 'text', text: block.ref.text } }
      } else if (block.type === 'reasoning') {
        yield { type: 'block-end', index: block.ref.index, block: { type: 'reasoning', text: block.ref.text } }
      } else {
        yield {
          type: 'block-end',
          index: block.ref.index,
          block: {
            type: 'tool-call',
            id: ToolCallId(block.ref.id ?? `call-${block.ref.index}`),
            name: block.ref.name ?? '',
            arguments: block.ref.arguments
          }
        }
      }
    }

    if (!sawContent) {
      throw new LlmError('Command Code 返回了空回复', EMPTY_RESPONSE_CODE)
    }
    if (translator.inputTokens + translator.outputTokens > 0) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: translator.inputTokens,
          outputTokens: translator.outputTokens,
          totalTokens: translator.inputTokens + translator.outputTokens,
          ...(translator.cachedInputTokens > 0
            ? { cacheReadTokens: translator.cachedInputTokens }
            : {})
        }
      }
    }
    yield {
      type: 'finish',
      reason: translator.finishReason === 'tool_calls'
        ? { kind: 'tool-calls' }
        : translator.finishReason === 'length'
          ? { kind: 'max-tokens' }
          : { kind: 'stop' }
    }
  }

  /**
   * Convert harness messages into the OpenAI shape the translator consumes.
   *
   * @param options - the harness request.
   * @returns wire messages.
   */
  async toWireMessages(options) {
    const messages = []
    if (typeof options.system === 'string' && options.system.length > 0) {
      messages.push({ role: 'system', content: options.system })
    }
    for (const m of options.messages) {
      if (m.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: String(m.toolCallId ?? ''), content: this.textOf(m.content) })
        continue
      }
      if (m.role === 'assistant') {
        const calls = this.toolCallsOf(m.content)
        messages.push({
          role: 'assistant',
          content: this.textOf(m.content) || null,
          ...(calls.length === 0 ? {} : { tool_calls: calls })
        })
        continue
      }
      if (m.role === 'developer' || m.role === 'system') {
        messages.push({ role: m.role, content: this.textOf(m.content) })
        continue
      }
      // Command Code accepts OpenAI-style `image_url` parts; `buildCcRequest`
      // then converts them to the upstream's own image block shape.
      const content = await wireContentOf(m.content, this.attachments)
      messages.push({ role: 'user', content: content ?? '' })
    }
    return messages
  }

  /** Flatten typed content into the text this route sends. */
  textOf(content) {
    const parts = []
    for (const block of content ?? []) {
      if (block.type === 'text') parts.push(block.text)
    }
    return parts.join('')
  }

  /** Extract assistant tool calls into the OpenAI wire shape. */
  toolCallsOf(content) {
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
   * Map a translated upstream failure onto the closest harness class.
   *
   * @param mapped - the `{status, body}` pair from `mapCcError`.
   * @returns the error to throw.
   */
  toLlmError(mapped) {
    const message = mapped.body?.error?.message ?? 'Command Code 请求失败'
    const type = mapped.body?.error?.type
    if (mapped.status === 401) {
      return new LlmError(
        `${message}。Command Code 的 API Key 可能已失效，请在插件页面重新填写 API Key。`,
        INVALID_CREDENTIAL_CODE
      )
    }
    if (mapped.status === 429) {
      return new LlmError(`${message}。Command Code 额度或频率受限，请稍后重试。`, QUOTA_EXCEEDED_CODE)
    }
    return new LlmError(`${message}（${type ?? 'upstream_error'}）`, 'PROVIDER_ERROR')
  }
}

/** Expose the catalogue helper for the settings page. */
export { ccModelCatalogue }

/** Read any thrown value as a message string. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
