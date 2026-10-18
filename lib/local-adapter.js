/**
 * The `LlmAdapter` that serves region pools using the in-process proxy rules.
 *
 * This is the "works without 守护进程" half: it reads the same encrypted vault
 * 守护进程 writes, then applies the same routing in JavaScript. When 守护进程
 * *is* running, both paths can coexist — this one needs no daemon, and the
 * `buddyhub` provider route from `adapter.js` calls the daemon directly.
 *
 * The provider id is deliberately distinct from the daemon route so a user can
 * tell which implementation served a call.
 *
 * @module buddy-connect/local-adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  INVALID_CREDENTIAL_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  ToolCallId
} from '@deepseek-ai/dsh-llm'
import {
  AccountPool,
  COOLDOWN_MS,
  EFFORT_IDS,
  HOSTS,
  MAX_ACCOUNTS,
  MODEL_IDS,
  dashify,
  failureBody,
  normalizeFrame,
  parseModel,
  preparePayload,
  requestContext,
  shouldRotate,
  sseFrames,
  upstreamHeaders,
  uuid7Hex
} from './proxy.js'
import { wireContentOf } from './image-wire.js'
import { diagnoseCredential, readVault } from './vault.js'

/** Provider route owned by this adapter. */
export const LOCAL_PROVIDER_ID = 'buddy-connect'

/** Display name shown in the model picker. */
export const LOCAL_PROVIDER_NAME = 'Buddy Connect'

/** Per-call idle timeout: the upstream may think for a long time. */
const IDLE_TIMEOUT_MS = 300_000

const EFFORT_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

/**
 * `off` is absent on purpose: the upstream has no separate switch, so offering
 * it would advertise a control that cannot do what it says.
 */
export const REASONING_EFFORTS = EFFORT_IDS.map((id) => ({
  id: ReasoningEffortId(id),
  name: EFFORT_LABELS[id] ?? id
}))

/**
 * Serves both region routes from the local vault.
 */
export class LocalPoolAdapter extends LlmAdapter {
  /**
   * @param options - data directory, advertised context window, and a logger.
   */
  constructor(options = {}) {
    super()
    this.dataDir = options.dataDir
    this.contextWindow = options.contextWindow
    this.logger = options.logger
    /** Returns whether this route may serve; the page's switch drives it. */
    this.isEnabled = options.isEnabled ?? (() => true)
    /** Resolves an ImageAttachmentRef into provider-ready request bytes. */
    this.attachments = options.attachments
    this.pool = new AccountPool()
    this.poolLoadedAt = 0
    /** Conversation metadata cache, keyed by account + client session. */
    this.ids = new Map()
  }

  /**
   * Refresh the pool from the vault.
   *
   * Reading is cheap (two small files) and a daemon may have written the vault
   * since the last call, so this runs per request rather than on a timer: an
   * account added in the 守护进程窗口 then works on the very next call.
   *
   * @returns the vault read result.
   */
  refreshPool() {
    const result = readVault(this.dataDir)
    if (result.ok) {
      this.pool.replace(result.accounts)
      this.poolLoadedAt = Date.now()
    }
    return result
  }

  /** A diagnostic snapshot for the status route and the health tool. */
  poolStatus() {
    const vault = this.refreshPool()
    return {
      provider: LOCAL_PROVIDER_ID,
      ok: vault.ok,
      reason: vault.reason,
      error: vault.error,
      accounts: this.pool.snapshot(),
      pools: this.pool.poolCounts(),
      models: MODEL_IDS
    }
  }

  /**
   * Reuse or mint the conversation ids for one (account, session) pair.
   *
   * 守护进程保存 these stable per account so independently rotated pools do
   * not share ids, and mints a fresh message id per call.
   *
   * @param accountId - the chosen account.
   * @param context - session and turn digests.
   * @returns the ids to send upstream.
   */
  claimIds(accountId, context) {
    const sessionKey = `session:${accountId}:${context.session}`
    let session = this.ids.get(sessionKey)
    if (session === undefined) {
      session = uuid7Hex()
      this.ids.set(sessionKey, session)
      // Bound the cache: 2048 conversations is far more than a session needs.
      if (this.ids.size > 2048) {
        const oldest = this.ids.keys().next()
        if (!oldest.done) this.ids.delete(oldest.value)
      }
    }
    const turnKey = `turn:${accountId}:${context.session}:${context.turn}`
    let turn = this.ids.get(turnKey)
    if (turn === undefined) {
      turn = uuid7Hex()
      this.ids.set(turnKey, turn)
    }
    return { conversation: dashify(session), turn, message: uuid7Hex() }
  }

  /** @inheritdoc */
  providerInfo(provider) {
    return { id: provider, name: LOCAL_PROVIDER_NAME }
  }

  /** @inheritdoc */
  providerRetryPolicy() {
    return undefined
  }

  /** @inheritdoc */
  listModels(provider) {
    return Promise.resolve(MODEL_IDS.map((id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text', 'image']
    })))
  }

  /** @inheritdoc */
  resolveModel(provider, model) {
    const parsed = parseModel(model, 'cn')
    if (parsed === null) {
      return Promise.reject(new LlmError(
        `Buddy Connect has no model "${model}"; it serves ${MODEL_IDS.join(' and ')}.`,
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

  /** @inheritdoc */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options)
    }
  }

  /**
   * Send one request, walking the region pool until an account answers.
   *
   * @inheritdoc
   */
  async *stream(options) {
    if (options.stop !== undefined) {
      throw new LlmError('the Buddy Connect route does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const parsed = parseModel(options.model, 'cn')
    if (parsed === null) {
      throw new LlmError(`Buddy Connect has no model "${options.model}"`, 'UNKNOWN_MODEL')
    }
    const { site } = parsed

    // The switch is per region, not per provider: CN and AI are independent
    // pools that share this adapter, so one being switched off must not disable
    // the other. Checking only a provider-level flag would do exactly that.
    if (this.isEnabled(site) !== true) {
      throw new LlmError(
        `${site === 'cn' ? '国内版' : '国际版'}线路已在插件页面停用，启用后才能调用。`,
        'PROVIDER_ERROR'
      )
    }

    const vault = this.refreshPool()
    if (!vault.ok) {
      throw new LlmError(
        vault.error ?? 'no readable 守护进程 account vault',
        vault.reason === 'vault-decrypt-failed' ? INVALID_CREDENTIAL_CODE : 'CONNECTION_FAILED'
      )
    }

    // Build the upstream body once: every account in the pool gets the same one.
    const body = preparePayload({
      model: parsed.upstream,
      messages: await this.toWireMessages(options),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.tools === undefined || options.tools.length === 0 ? {} : {
        tools: options.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        }))
      })
    })
    if (options.reasoningEffort !== undefined) {
      // An effort spelled in the model alias is a default; an explicit setting
      // from the client wins, exactly as the reference proxy orders it.
      if (body.reasoning_effort === undefined) body.reasoning_effort = String(options.reasoningEffort)
    }
    const context = requestContext(body, options.sessionId ?? '')

    const excluded = new Set()
    let lastStatus = 503
    let lastCode
    let lastMessage = ''

    for (let attempt = 0; attempt < MAX_ACCOUNTS; attempt += 1) {
      const account = this.pool.pick(site, excluded)
      if (account === undefined) break
      excluded.add(account.id)

      const ids = this.claimIds(account.id, context)
      let response
      try {
        response = await this.requestUpstream(account, body, ids, options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) {
          this.pool.finish(account.id, false, 'aborted', 0)
          throw new LlmError('request aborted by caller', 'ABORTED', { cause: error })
        }
        this.pool.finish(account.id, false, messageOf(error), COOLDOWN_MS)
        lastStatus = 502
        lastMessage = messageOf(error)
        continue
      }

      if (response.status >= 400) {
        const failure = await this.readFailure(response)
        lastStatus = response.status
        lastCode = failure.code
        lastMessage = failure.message
        const rotate = shouldRotate(response.status, failure.code, failure.message)
        this.pool.finish(account.id, false, lastMessage, rotate ? COOLDOWN_MS : 0)
        if (rotate) continue
        throw this.toLlmError(response.status, failure)
      }
      if (response.body === null) {
        this.pool.finish(account.id, false, 'empty body', COOLDOWN_MS)
        lastStatus = 502
        continue
      }

      // The account worked far enough to answer; hand the stream to the caller.
      // Its outcome is recorded when the stream ends so the counters stay true.
      const result = yield* this.translate(sseFrames(response.body), options)
      this.pool.finish(account.id, result.completed, result.error ?? '', 0)
      return
    }

    if (excluded.size === 0) {
      throw new LlmError(
        `Buddy Connect has no usable ${site.toUpperCase()} account. Regions are independent and never fall back to each other, so add or re-enable a ${site.toUpperCase()} account in 守护进程.`,
        QUOTA_EXCEEDED_CODE
      )
    }
    throw this.toLlmError(lastStatus, { code: lastCode, message: lastMessage })
  }

  /**
   * Call the upstream for one account across its base hosts.
   *
   * @param account - the pooled account.
   * @param body - the prepared upstream body.
   * @param ids - conversation metadata.
   * @param signal - cancellation.
   * @returns the first non-network-error response.
   */
  async requestUpstream(account, body, ids, signal) {
    let lastError
    for (const base of HOSTS[account.site] ?? HOSTS.cn) {
      try {
        return await fetch(`${base}/v2/chat/completions`, {
          method: 'POST',
          headers: upstreamHeaders(account, base, ids),
          body: JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(IDLE_TIMEOUT_MS)
        })
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('no upstream host reachable')
  }

  /**
   * Decode a non-2xx upstream body into a code and message.
   *
   * @param response - the failed response.
   * @returns the business code and any message text.
   */
  async readFailure(response) {
    const raw = await response.text().catch(() => '')
    let decoded
    try {
      decoded = raw.length === 0 ? undefined : JSON.parse(raw)
    } catch {
      decoded = undefined
    }
    const code = decoded?.code ?? decoded?.error?.code
    const text = decoded?.msg ?? decoded?.error?.message ?? decoded?.message
      ?? (typeof decoded === 'string' ? decoded : '')
    return { code, message: typeof text === 'string' ? text : '' }
  }

  /**
   * Map an upstream failure onto the closest harness failure class.
   *
   * @param status - HTTP status.
   * @param failure - the decoded failure.
   * @returns the error to throw.
   */
  toLlmError(status, failure) {
    const detail = failureBody(status, failure.code).error.message
    if (status === 401 || status === 403) {
      return new LlmError(
        `${detail}. The account token was rejected; sign in again in the WorkBuddy client and re-import.`,
        INVALID_CREDENTIAL_CODE
      )
    }
    if (status === 429 || shouldRotate(status, failure.code, failure.message)) {
      return new LlmError(`${detail}. The pool is cooling down; try again shortly.`, QUOTA_EXCEEDED_CODE)
    }
    if (/too large|context/i.test(failure.message ?? '')) {
      return new LlmError(`${detail}: ${failure.message}`, CONTEXT_WINDOW_EXCEEDED_CODE)
    }
    return new LlmError(`${detail}${failure.code === undefined ? '' : ` (code ${failure.code})`}`, 'PROVIDER_ERROR')
  }

  /**
   * Convert harness messages into the OpenAI wire shape.
   *
   * User messages keep their images: they become `image_url` parts, and a
   * message with no images stays a plain string because some upstream
   * validators reject the array form when nothing needs it.
   *
   * @param options - the harness request being dispatched.
   * @returns the provider-shaped message array.
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
      // Only user turns carry images today; the attachment is resolved into
      // request bytes here so the upstream receives a data URL it accepts.
      const content = await wireContentOf(m.content, this.attachments)
      messages.push({ role: 'user', content: content ?? '' })
    }
    return messages
  }

  /**
   * Flatten content blocks into the text this route sends.
   *
   * @param content - typed content blocks.
   * @returns the concatenated text.
   */
  textOf(content) {
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
   * @returns the `tool_calls` array.
   */
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
   * Translate normalised upstream frames into harness stream chunks.
   *
   * Yields the harness chunk stream, and returns whether the answer completed
   * so the caller can record the account's real outcome.
   *
   * @param source - decoded upstream frames.
   * @param options - the request, for cancellation.
   * @returns the completion state.
   */
  async *translate(source, options) {
    const open = new Map()
    const order = []
    let nextIndex = 0
    let usage
    let reason
    let sawContent = false

    const openBlock = (key, blockType) => {
      const block = { index: nextIndex, blockType, text: '', arguments: '', id: undefined, name: undefined }
      nextIndex += 1
      open.set(key, block)
      order.push(block)
      return block
    }

    for await (const raw of source) {
      if (options.signal?.aborted === true) {
        return { completed: false, error: 'aborted' }
      }
      // A mid-stream error arrives inside a 200 response, so it is the only
      // signal that the answer is incomplete.
      if (raw?.error !== undefined && raw?.error !== null) {
        const detail = typeof raw.error === 'object' && typeof raw.error.message === 'string'
          ? raw.error.message
          : JSON.stringify(raw.error)
        return { completed: false, error: detail }
      }
      const frame = normalizeFrame(raw, options.model)
      if (frame === null) continue
      if (frame.usage !== undefined) usage = toUsage(frame.usage)
      const choice = frame.choices?.[0]
      if (choice === undefined) continue
      const delta = choice.delta

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        let block = open.get('reasoning')
        if (block === undefined) {
          block = openBlock('reasoning', 'reasoning')
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += delta.reasoning_content
        sawContent = true
        yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning_content }
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        let block = open.get('text')
        if (block === undefined) {
          block = openBlock('text', 'text')
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        block.text += delta.content
        sawContent = true
        yield { type: 'text-delta', index: block.index, text: delta.content }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          if (call === null || typeof call !== 'object') continue
          const key = `tool:${typeof call.index === 'number' ? call.index : 0}`
          let block = open.get(key)
          if (block === undefined) {
            block = openBlock(key, 'tool-call')
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
          }
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
      throw new LlmError('Buddy Connect returned an empty completion', EMPTY_RESPONSE_CODE)
    }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: resolved }
    return { completed: true, error: '' }
  }
}

/**
 * Re-export so callers can diagnose a credential file without importing vault.
 */
export { diagnoseCredential }

/**
 * Map an upstream finish reason onto the harness vocabulary.
 *
 * @param reason - the provider's finish reason.
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
 * Convert OpenAI-style usage into harness token usage.
 *
 * @param raw - the provider's usage object.
 * @returns harness token usage with a derived total.
 */
function toUsage(raw) {
  const input = number(raw.prompt_tokens)
  const output = number(raw.completion_tokens)
  const usage = { inputTokens: input, outputTokens: output }
  usage.totalTokens = number(raw.total_tokens, input + output)
  const cached = number(raw.prompt_tokens_details?.cached_tokens, 0)
  if (cached > 0) usage.cacheReadTokens = cached
  const reasoning = number(raw.completion_tokens_details?.reasoning_tokens, 0)
  if (reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

/** Coerce a provider-reported number, falling back when unusable. */
function number(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Read any thrown value as a message string. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
