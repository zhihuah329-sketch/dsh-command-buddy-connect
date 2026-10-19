/**
 * Model-facing diagnostics for the optional local daemon.
 *
 * The check-in itself no longer lives here: it is performed by
 * `lib/scheduler.js` directly against WorkBuddy, because the daemon is a separate
 * product that may not be installed. What remains useful is *visibility* into
 * the daemon when it does exist — whether it is running, which region pools
 * have live accounts, and what its own log says — so an agent can explain a
 * failed model call without guessing.
 *
 * These tools never duplicate the check-in the plugin already performs, so they
 * cannot disagree with it.
 *
 * @module dsh-command-buddy-connect/daemon-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  DAEMON_MODEL_IDS,
  adminRequest,
  probeProxy,
  readConfig,
  resolveDataDir
} from './discovery.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeLogRows, stringOr } from './log-parse.js'

/** Render a plain-text tool result. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/**
 * Whether the daemon's own executable is still on disk.
 *
 * `config.json` outlives the program: deleting the daemon leaves the data
 * directory behind, because that directory is where the account vault lives. So
 * "the config exists" is not the same question as "the daemon is installed", and
 * conflating them reported a deleted daemon as merely unresponsive.
 *
 * @returns whether an executable was found.
 */
function daemonBinaryPresent() {
  const configured = process.env.BUDDYHUB_EXE
  const candidates = []
  if (typeof configured === 'string' && configured.length > 0) candidates.push(configured)
  candidates.push('D:\\BuddyHub\\buddyhub-service.exe')
  candidates.push(join(homedir(), 'BuddyHub', 'buddyhub-service.exe'))
  return candidates.some((path) => existsSync(path))
}

/**
 * Describe the daemon's connection state in one sentence.
 *
 * @param config - current settings.
 * @param health - the probe outcome.
 * @param binary - whether the executable is still installed.
 * @returns a human-readable status line.
 */
function statusLine(config, health, binary) {
  if (binary !== true) {
    return '本地守护进程已卸载。账号库仍可读，区域号池由本插件直接从账号库提供，模型调用不受影响。'
  }
  if (!config.exists) {
    return `本地守护进程未安装：${config.path} 下没有 config.json。`
  }
  if (health.ok !== true) {
    return `守护进程已安装（${config.path}），但端口 ${config.port} 没有响应：${health.error}`
  }
  const pools = health.health?.pools
  const cn = typeof pools?.cn === 'number' ? pools.cn : 'unknown'
  const ai = typeof pools?.ai === 'number' ? pools.ai : 'unknown'
  return `本地代理运行在端口 ${config.port}，CN ${cn} 个、AI ${ai} 个可用账号。`
}

/**
 * Build the daemon diagnostic tools.
 *
 * @param options - data-directory override and a logger.
 * @returns the tool definitions to register.
 */
export function daemonTools(options = {}) {
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
    name: 'daemon_status',
    description: 'Report whether the optional local daemon is running and whenning, which region account pools have enabled accounts, and the proxy/admin endpoints it uses. Read-only; does not affect WorkBuddy check-in.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true, description: 'Whether a 守护进程 config.json was found.' },
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
      const binary = daemonBinaryPresent()
      return {
        // `installed` answers "is the daemon on this machine", not "is there a
        // config left behind" — the data directory survives uninstall because it
        // holds the account vault.
        installed: binary === true,
        running: health.ok === true,
        summary: statusLine(config, health, binary),
        configPath: config.path,
        proxyUrl: `http://127.0.0.1:${config.port}/v1`,
        models: [...DAEMON_MODEL_IDS],
        pools: {
          cn: typeof pools?.cn === 'number' ? pools.cn : 0,
          ai: typeof pools?.ai === 'number' ? pools.ai : 0
        },
        ...(config.error === undefined && health.ok === true ? {} : {
          error: binary === true ? (config.error ?? health.error ?? 'unknown') : 'daemon not installed'
        })
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check daemon status', kind: 'other' })
  })

  const logs = defineTool({
    name: 'daemon_logs',
    description: 'Read the most recent entries from the local daemon eventt log, newest last, to diagnose model-call failures. Read-only.',
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
        if (value.entries.length === 0) return text('The daemon log is empty.')
        return text(value.entries
          .map((entry) => `${entry.time ?? ''} [${entry.kind ?? 'event'}] ${entry.detail ?? ''}`.trim())
          .join('\n'))
      }
    },
    async execute(args, exec) {
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 200) : 20
      const read = readConfig(resolveDataDir(dataDir))
      const config = { ...read.config, path: read.path, exists: read.exists, error: read.error }
      // The log lives inside the daemon, so there is nothing to read once it is
      // gone. Saying that plainly is more useful than a bare "fetch failed":
      // the daemon's absence does not mean model calls are broken, because the
      // pools are served from the vault directly.
      if (daemonBinaryPresent() !== true) {
        throw new Error(
          '本地守护进程已卸载，因此没有守护进程日志可读。区域号池由本插件直接从账号库提供，'
          + `不受影响；账号事件可用 buddy_connect_pools 查看。账号库目录：${resolveDataDir(dataDir)}`
        )
      }
      const response = await adminRequest({
        adminBaseUrl: `http://127.0.0.1:${config.adminPort}`,
        adminKey: config.adminKey,
        path: '/admin/logs',
        signal: exec.signal
      })
      if (response.ok !== true) throw new Error(response.error)
      const rows = normalizeLogRows(response.data)
      if (logger !== undefined && rows.length === 0) {
        logger.debug?.('dsh-command-buddy-connect: the daemon log route returned no recognisable entries')
      }
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
      return { entries, total: entries.length }
    },
    presentCall: () => ({ card: 'generic', title: 'Read daemon logs', kind: 'other' })
  })

  return [status, logs]
}

