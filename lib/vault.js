/**
 * Read accounts straight from the daemon's encrypted vault.
 *
 * Accounts are stored as an AES-256-GCM sealed JSON array in
 * `accounts.enc`, with the 32-byte key in `vault.key` beside it. Both files sit
 * in the same data directory, so reading them needs no daemon, no admin key,
 * and no network call.
 *
 * The sealed blob is `{version, iv, tag, data}`, every field base64, exactly as
 * `save_locked()` writes it. `iv` is 12 bytes and the tag is appended by GCM.
 *
 * Reading is deliberately read-only: the plugin never writes this vault, so a
 * daemon running alongside it can never be raced by a half-written file. The
 * proxy re-reads on each pool refresh so an account added or disabled in the
 * the daemon window takes effect without a restart.
 *
 * @module buddy-connect/vault
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './discovery.js'

/** Field layout of the sealed vault blob. */
const NONCE_BYTES = 12
const KEY_BYTES = 32

/**
 * Classify why a vault could not be read, so callers can act on it.
 *
 * @typedef {{ok: boolean, accounts: Array<object>, error?: string, reason?: string}} VaultRead
 */

/**
 * Read and decrypt the account vault.
 *
 * A missing vault is not an error: the daemon may not be running, in which case
 * the plugin still needs to report that clearly rather than fail to load.
 *
 * @param explicitDir - the `dataDir` plugin setting, when set.
 * @returns the decrypted accounts, or a structured reason they are unavailable.
 */
export function readVault(explicitDir) {
  const dir = resolveDataDir(explicitDir)
  const vaultPath = join(dir, 'accounts.enc')
  const keyPath = join(dir, 'vault.key')

  if (!fs.existsSync(vaultPath)) {
    return { ok: false, accounts: [], reason: 'vault-missing', error: `no account vault at ${vaultPath}` }
  }
  if (!fs.existsSync(keyPath)) {
    return { ok: false, accounts: [], reason: 'key-missing', error: `no vault key at ${keyPath}` }
  }

  let key
  try {
    key = fs.readFileSync(keyPath)
  } catch (error) {
    return { ok: false, accounts: [], reason: 'key-unreadable', error: message(error) }
  }
  if (key.length !== KEY_BYTES) {
    return { ok: false, accounts: [], reason: 'key-invalid', error: `vault.key is ${key.length} bytes, expected ${KEY_BYTES}` }
  }

  let blob
  try {
    blob = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
  } catch (error) {
    return { ok: false, accounts: [], reason: 'vault-unreadable', error: message(error) }
  }
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    return { ok: false, accounts: [], reason: 'vault-invalid', error: 'vault is not a JSON object' }
  }

  let plain
  try {
    const iv = Buffer.from(String(blob.iv ?? ''), 'base64')
    if (iv.length !== NONCE_BYTES) throw new Error(`iv is ${iv.length} bytes, expected ${NONCE_BYTES}`)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    decipher.setAuthTag(Buffer.from(String(blob.tag ?? ''), 'base64'))
    plain = Buffer.concat([
      decipher.update(Buffer.from(String(blob.data ?? ''), 'base64')),
      decipher.final()
    ])
  } catch (error) {
    // A decryption failure means the key does not match the vault: report the
    // category, never the ciphertext or the key.
    return { ok: false, accounts: [], reason: 'vault-decrypt-failed', error: message(error) }
  }

  let accounts
  try {
    accounts = JSON.parse(plain.toString('utf8'))
  } catch (error) {
    return { ok: false, accounts: [], reason: 'vault-plaintext-invalid', error: message(error) }
  }
  if (!Array.isArray(accounts)) {
    return { ok: false, accounts: [], reason: 'vault-plaintext-invalid', error: 'decrypted vault is not an array' }
  }
  return { ok: true, accounts: accounts.filter(isUsableAccount) }
}

/**
 * Whether a stored record carries enough to make a call.
 *
 * @param account - one decrypted record.
 * @returns true when the record can be placed in a pool.
 */
function isUsableAccount(account) {
  return account !== null
    && typeof account === 'object'
    && typeof account.id === 'string'
    && (account.site === 'cn' || account.site === 'ai')
    && typeof account.accessToken === 'string'
    && account.accessToken.length > 0
}

/**
 * Report why an account cannot be imported, given a raw credential file.
 *
 * This exists because a sealed CN credential is otherwise indistinguishable
 * from "nothing happened": WorkBuddy seals each credential field into
 * `{$wbEncrypted:1,envelope:"..."}`, and a reader that only accepts a plain
 * string silently drops the file. Users deserve the reason instead.
 *
 * @param raw - the parsed credential file.
 * @returns a diagnosis with a human-readable message, or null when importable.
 */
export function diagnoseCredential(raw) {
  if (raw === null || typeof raw !== 'object') {
    return { reason: 'not_json', message: '凭据文件不是 JSON 对象' }
  }
  const auth = raw.auth ?? raw
  const domain = typeof auth.domain === 'string' ? auth.domain : ''
  const known = [
    'www.workbuddy.ai', 'workbuddy.ai', 'www.codebuddy.ai', 'codebuddy.ai',
    'www.workbuddy.cn', 'workbuddy.cn', 'www.codebuddy.cn', 'codebuddy.cn',
    'copilot.tencent.com'
  ]
  const host = domain.replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!known.includes(host)) {
    return { reason: 'unknown_domain', message: `无法识别的区域域名：${domain || '(空)'}` }
  }
  const account = raw.account ?? raw.user ?? {}
  if ((account.uid ?? auth.uid) === undefined) {
    return { reason: 'no_uid', message: '凭据缺少 uid' }
  }
  if (typeof auth.accessToken !== 'string') {
    return {
      reason: 'encrypted_credential',
      message: '该账号的凭据被客户端加密存放（$wbEncrypted 封装），插件无法直接读取；请在客户端登录后通过抓取请求或导出明文凭据的方式接入'
    }
  }
  return null
}

/** Read one Error's message without assuming the thrown value is an Error. */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}
