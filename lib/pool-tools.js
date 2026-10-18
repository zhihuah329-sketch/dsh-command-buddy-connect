/**
 * Model-facing diagnostics for the local region pools and account import.
 *
 * Two questions an agent cannot answer by guessing, and which wasted a lot of
 * time before these tools existed:
 *
 * 1. *Why is a region empty?* A pool with zero accounts and a pool whose only
 *    account is cooling down look identical from a failed call. The health tool
 *    reports per-account state, cooldown, expiry, and whether the vault itself
 *    is even readable.
 * 2. *Why did an import do nothing?* A sealed credential file is silently
 *    dropped by a reader that only accepts plain strings. The import tool names
 *    the reason per file instead.
 *
 * Both are read-only. Neither can change a running account's token.
 *
 * @module buddy-connect/pool-tools
 */

import { readFileSync, existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODEL_IDS } from './proxy.js'
import { diagnoseCredential, readVault } from './vault.js'
import { resolveDataDir } from './discovery.js'

/** Render a plain-text tool result. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Format a millisecond timestamp as an ISO instant, or undefined. */
function instant(ms) {
  return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined
}

/**
 * Build the pool-health and import-diagnostic tools.
 *
 * @param options - the data-directory override and a logger.
 * @returns the tool definitions to register.
 */
export function poolTools(options = {}) {
  const { dataDir, logger } = options

  const health = defineTool({
    name: 'buddy_connect_pools',
    description: 'Report the state of the Buddy Connect region account pools: how many CN and international accounts are usable, each account\'s auth state, cooldown, and token expiry, and whether the encrypted account vault could be read. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'One-line human-readable status.' },
          vaultOk: { type: 'boolean', required: true, description: 'Whether the encrypted vault could be decrypted.' },
          vaultReason: { type: 'string', description: 'Why the vault was unreadable, when it was not.' },
          dataDir: { type: 'string', required: true, description: '守护进程 data directory consulted.' },
          models: { type: 'array', required: true, items: { type: 'string' }, description: 'Model ids served.' },
          pools: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              cn: { type: 'integer', required: true, description: 'Usable CN accounts.' },
              ai: { type: 'integer', required: true, description: 'Usable international accounts.' }
            }
          },
          accounts: {
            type: 'array',
            required: true,
            description: 'One entry per imported account; never includes the token.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                site: { type: 'string', required: true, description: 'Region: cn or ai.' },
                label: { type: 'string', required: true, description: 'Account label.' },
                authState: { type: 'string', required: true, description: 'Upstream auth state.' },
                enabled: { type: 'boolean', required: true, description: 'Whether the account is enabled.' },
                usable: { type: 'boolean', required: true, description: 'Whether a call would use it right now.' },
                expiresAt: { type: 'string', description: 'Token expiry, as an ISO instant.' },
                cooldownUntil: { type: 'string', description: 'Cooldown end, as an ISO instant.' },
                lastError: { type: 'string', description: 'Last failure recorded for the account.' }
              }
            }
          },
          error: { type: 'string', description: 'Diagnostic when the vault was unreadable.' }
        }
      },
      render: (_args, value) => text(value.summary)
    },
    execute() {
      const dir = resolveDataDir(dataDir)
      const vault = readVault(dataDir)
      const now = Date.now()
      const accounts = vault.accounts.map((a) => {
        const cooling = typeof a.cooldownUntil === 'number' && a.cooldownUntil > now
        const expired = typeof a.expiresAt === 'number' && a.expiresAt > 0 && a.expiresAt <= now
        const usable = a.enabled !== false && a.authState !== '需重新登录' && !cooling && !expired
        return {
          site: a.site,
          label: a.label ?? a.id.slice(0, 6),
          authState: a.authState ?? '未知',
          enabled: a.enabled !== false,
          usable,
          ...(instant(a.expiresAt) === undefined ? {} : { expiresAt: instant(a.expiresAt) }),
          ...(instant(a.cooldownUntil) === undefined ? {} : { cooldownUntil: instant(a.cooldownUntil) }),
          ...(typeof a.lastError === 'string' && a.lastError.length > 0 ? { lastError: a.lastError } : {})
        }
      })
      const counts = {
        cn: accounts.filter((a) => a.site === 'cn' && a.usable).length,
        ai: accounts.filter((a) => a.site === 'ai' && a.usable).length
      }
      let summary
      if (!vault.ok) {
        summary = `无法读取账号库（${vault.reason}）：${vault.error ?? '未知原因'}。目录 ${dir}`
      } else if (accounts.length === 0) {
        summary = `账号库可读，但没有任何已导入账号（${dir}）。`
      } else {
        summary = `CN 可用 ${counts.cn} 个、国际版可用 ${counts.ai} 个；共 ${accounts.length} 个账号。`
        const blocked = accounts.filter((a) => !a.usable)
        if (blocked.length > 0) {
          summary += ` 其中 ${blocked.length} 个暂不可用：${blocked.map((a) => `${a.label}(${a.authState})`).join('、')}。`
        }
      }
      return {
        summary,
        vaultOk: vault.ok,
        ...(vault.reason === undefined ? {} : { vaultReason: vault.reason }),
        dataDir: dir,
        models: [...MODEL_IDS],
        pools: counts,
        accounts,
        ...(vault.error === undefined ? {} : { error: vault.error })
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check Buddy Connect account pools', kind: 'other' })
  })

  const diagnose = defineTool({
    name: 'buddy_connect_diagnose_import',
    description: 'Explain why a WorkBuddy credential file cannot be imported: unknown region, missing uid, or a credential the client sealed in its encrypted envelope. Read-only; never prints token material.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path of a WorkBuddy .info or .json credential file to inspect.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'One-line diagnosis.' },
          importable: { type: 'boolean', required: true, description: 'Whether the file could be imported as-is.' },
          reason: { type: 'string', description: 'Stable reason code when not importable.' },
          message: { type: 'string', description: 'Human-readable explanation.' },
          site: { type: 'string', description: 'Detected region, when the domain is recognised.' }
        }
      },
      render: (_args, value) => text(value.summary)
    },
    execute(args) {
      const file = String(args.path ?? '')
      if (!existsSync(file)) {
        return {
          summary: `文件不存在：${file}`,
          importable: false,
          reason: 'not_found',
          message: `文件不存在：${file}`
        }
      }
      let raw
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return {
          summary: `无法解析为 JSON：${detail}`,
          importable: false,
          reason: 'not_json',
          message: `无法解析为 JSON：${detail}`
        }
      }
      const problem = diagnoseCredential(raw)
      const auth = raw.auth ?? raw
      const domain = String(auth.domain ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
      const site = domain.includes('tencent') || domain.includes('.cn') ? 'cn'
        : domain.includes('codebuddy.ai') || domain.includes('.ai') ? 'ai'
          : undefined
      if (problem === null) {
        return {
          summary: `可导入${site === undefined ? '' : `（${site.toUpperCase()}）`}：凭据为明文，region 与 uid 均可识别。`,
          importable: true,
          ...(site === undefined ? {} : { site })
        }
      }
      if (logger !== undefined) logger.debug?.(`buddy-connect: import diagnosis for ${file} = ${problem.reason}`)
      return {
        summary: `无法导入（${problem.reason}）：${problem.message}`,
        importable: false,
        reason: problem.reason,
        message: problem.message,
        ...(site === undefined ? {} : { site })
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Diagnose a WorkBuddy credential import', kind: 'other' })
  })

  return [health, diagnose]
}
