/**
 * Model-facing diagnostics for the optional local BuddyHub daemon.
 *
 * The check-in itself no longer lives here: it is performed by
 * `lib/scheduler.js` directly against WorkBuddy, because BuddyHub is a separate
 * product that may not be installed. What remains useful is *visibility* into
 * the daemon when it does exist — whether it is running, which region pools
 * have live accounts, and what its own log says — so an agent can explain a
 * failed model call without guessing.
 *
 * These tools never duplicate the check-in the plugin already performs, so they
 * cannot disagree with it.
 *
 * @module dsh-buddyhub/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  BUDDYHUB_MODEL_IDS,
  adminRequest,
  probeProxy,
  readConfig,
  resolveDataDir
} from './discovery.js'

/** Render a plain-text tool result. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * Describe the daemon's connection state in one sentence.
 *
 * @param config - current settings.
 * @param health - the probe outcome.
 * @returns a human-readable status line.
 */
function statusLine(config, health) {
  if (!config.exists) {
    return `The local BuddyHub daemon is not installed: no config.json at ${config.path}. `
      + 'This does not affect WorkBuddy check-in, which this plugin performs directly.'
  }
  if (health.ok !== true) {
    return `BuddyHub is installed (${config.path}) but its proxy on port ${config.port} is not answering: ${health.error}`
  }
  const pools = health.health?.pools
  const cn = typeof pools?.cn === 'number' ? pools.cn : 'unknown'
  const ai = typeof pools?.ai === 'number' ? pools.ai : 'unknown'
  return `BuddyHub proxy is running on port ${config.port} with ${cn} CN and ${ai} international account(s) enabled.`
}

/**
 * Build the daemon diagnostic tools.
 *
 * @param options - data-directory override and a logger.
 * @returns the tool definitions to register.
 */
export function buddyhubTools(options = {}) {
  const { dataDir, logger } = options

  /** Current settings plus a fresh liveness probe. */
  const snapshot = async (signal) => {
    const read = readConfig(resolveDataDir(dataDir))
    const config = { ...read.config, path: read.path, exists: read.exists, error: read.error }
    const health = read.exists
      ? await probeProxy(`http://127.0.0.1:${config.port}`, signal)
      : { ok: false, error: 'not installed' }
    return { config, health }
  }

  const status = defineTool({
    name: 'buddyhub_daemon_status',
    description: 'Report whether the optional local BuddyHub daemon is installed and running, which region account pools have enabled accounts, and the proxy/admin endpoints it uses. Read-only; does not affect WorkBuddy check-in.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true, description: 'Whether a BuddyHub config.json was found.' },
          running: { type: 'boolean', required: true, description: 'Whether the proxy answered its health route.' },
          summary: { type: 'string', required: true, description: 'One-line human-readable status.' },
          configPath: { type: 'string', required: true, description: 'Path of the config.json consulted.' },
          proxyUrl: { type: 'string', required: true, description: 'OpenAI-compatible base URL of the proxy.' },
          models: { type: 'array', required: true, items: { type: 'string' }, description: 'Model ids the proxy serves.' },
          pools: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              cn: { type: 'integer', required: true, description: 'Enabled CN accounts.' },
              ai: { type: 'integer', required: true, description: 'Enabled international accounts.' }
            }
          },
          error: { type: 'string', description: 'Diagnostic when the settings could not be read or the proxy did not answer.' }
        }
      },
      render: (_args, value) => text(value.summary)
    },
    async execute(_args, exec) {
      const { config, health } = await snapshot(exec.signal)
      const pools = health.ok === true ? health.health?.pools : undefined
      return {
        installed: config.exists,
        running: health.ok === true,
        summary: statusLine(config, health),
        configPath: config.path,
        proxyUrl: `http://127.0.0.1:${config.port}/v1`,
        models: [...BUDDYHUB_MODEL_IDS],
        pools: {
          cn: typeof pools?.cn === 'number' ? pools.cn : 0,
          ai: typeof pools?.ai === 'number' ? pools.ai : 0
        },
        ...(config.error === undefined && health.ok === true ? {} : { error: config.error ?? health.error ?? 'unknown' })
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check BuddyHub daemon status', kind: 'other' })
  })

  const logs = defineTool({
    name: 'buddyhub_logs',
    description: 'Read the most recent entries from the optional BuddyHub daemon event log, newest last, to diagnose model-call failures. Read-only.',
    parameters: {
      limit: {
        type: 'integer',
        description: 'How many recent entries to return. Defaults to 20, maximum 200.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            required: true,
            description: 'Recent log entries, oldest first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                time: { type: 'string', description: 'Timestamp as the daemon recorded it.' },
                kind: { type: 'string', description: 'Event category.' },
                detail: { type: 'string', description: 'Event text.' }
              }
            }
          },
          total: { type: 'integer', required: true, description: 'Entries returned.' }
        }
      },
      render: (_args, value) => {
        if (value.entries.length === 0) return text('The BuddyHub daemon log is empty.')
        return text(value.entries
          .map((entry) => `${entry.time ?? ''} [${entry.kind ?? 'event'}] ${entry.detail ?? ''}`.trim())
          .join('\n'))
      }
    },
    async execute(args, exec) {
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20
      const read = readConfig(resolveDataDir(dataDir))
      const config = { ...read.config, path: read.path, exists: read.exists, error: read.error }
      const response = await adminRequest({
        adminBaseUrl: `http://127.0.0.1:${config.adminPort}`,
        adminKey: config.adminKey,
        path: '/admin/logs',
        signal: exec.signal
      })
      if (response.ok !== true) throw new Error(response.error)
      const raw = response.data
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.logs)
          ? raw.logs
          : Array.isArray(raw?.entries)
            ? raw.entries
            : []
      const entries = rows.slice(-limit).map((row) => {
        if (typeof row === 'string') return { detail: row }
        return {
          ...(stringOr(row?.time ?? row?.at ?? row?.ts, undefined) === undefined
            ? {}
            : { time: stringOr(row.time ?? row.at ?? row.ts, '') }),
          ...(stringOr(row?.kind ?? row?.type ?? row?.level, undefined) === undefined
            ? {}
            : { kind: stringOr(row.kind ?? row.type ?? row.level, '') }),
          ...(stringOr(row?.detail ?? row?.message ?? row?.text, undefined) === undefined
            ? {}
            : { detail: stringOr(row.detail ?? row.message ?? row.text, '') })
        }
      })
      if (logger !== undefined && rows.length === 0) {
        logger.debug?.('dsh-buddyhub: the daemon log route returned no recognisable entries')
      }
      return { entries, total: entries.length }
    },
    presentCall: () => ({ card: 'generic', title: 'Read BuddyHub daemon logs', kind: 'other' })
  })

  return [status, logs]
}

/** Narrow an unknown value to a trimmed non-empty string, or a fallback. */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}
