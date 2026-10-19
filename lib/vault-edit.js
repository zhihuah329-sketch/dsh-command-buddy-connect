/**
 * Editing the account vault: remove an account, or refresh a credential.
 *
 * ## Why the plugin writes the vault itself
 *
 * The daemon's admin API can change an account's label, its enabled flag, and
 * clear its cooldown state — but it cannot delete one, and it cannot replace a
 * token wholesale. Those two operations have to touch `accounts.enc` directly.
 *
 * ## The hazard this module exists to contain
 *
 * The daemon holds the vault in memory and rewrites the whole file on every
 * save. A write from here while it is running is silently reverted at the next
 * save, or worse, races and corrupts the file. So every mutation follows the
 * same order:
 *
 *   1. stop the daemon
 *   2. copy `accounts.enc`, `vault.key` and `config.json` to a backup
 *   3. write the new vault atomically (temp file, then rename)
 *   4. restart the daemon
 *
 * A failure at any step restores the backup, so the pool is never left in a
 * state nobody asked for. Every backup is kept on disk, so an unwanted deletion
 * is recoverable even after the process exits.
 *
 * @module dsh-command-buddy-connect/vault-edit
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Where the daemon keeps its state. */
function vaultDir(explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const env = process.env.BUDDYHUB_DATA
  if (typeof env === 'string' && env.length > 0) return env
  return join(homedir(), '.buddyhub')
}

/** Decrypt `accounts.enc` with `vault.key`. */
export function readVaultAccounts(dir) {
  const base = vaultDir(dir)
  const keyPath = join(base, 'vault.key')
  const vaultPath = join(base, 'accounts.enc')
  try {
    const key = fs.readFileSync(keyPath)
    const blob = JSON.parse(fs.readFileSync(vaultPath, 'utf8'))
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'), { authTagLength: 16 })
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()])
    const accounts = JSON.parse(plain.toString('utf8'))
    if (!Array.isArray(accounts)) return { ok: false, error: '账号库内容不是数组', accounts: [] }
    return { ok: true, accounts, base }
  } catch (error) {
    // An absent vault is not a failure to report: it is a machine that has never
    // imported an account. Failing here made the very first import on a fresh
    // install answer 「无法读取账号库：ENOENT ... vault.key」 — a dead end with no
    // action the user could take, on the one path a new user always starts with.
    if (error?.code === 'ENOENT') {
      return {
        ok: true,
        accounts: [],
        base,
        created: true,
        // The key and the encrypted file are both created on the first save, so
        // the writer must know it is starting from nothing.
        needsInit: true
      }
    }
    return {
      ok: false,
      accounts: [],
      base,
      error: `无法读取账号库：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/** Encrypt and atomically write the account list. */
function writeVaultAccounts(base, accounts) {
  // A brand-new vault has no key yet. Generate one on first write rather than
  // reading a file that does not exist; every later write reuses it.
  let key
  try {
    key = fs.readFileSync(join(base, 'vault.key'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    fs.mkdirSync(base, { recursive: true })
    key = crypto.randomBytes(32)
    fs.writeFileSync(join(base, 'vault.key'), key, { mode: 0o600 })
  }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  const data = Buffer.concat([cipher.update(JSON.stringify(accounts), 'utf8'), cipher.final()])
  const sealed = {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
  const target = join(base, 'accounts.enc')
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(sealed), { mode: 0o600 })
  fs.renameSync(temp, target)
}

/** Whether the daemon process is running. */
function daemonRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq buddyhub-service.exe', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    return out.toLowerCase().includes('buddyhub-service.exe')
  } catch {
    return false
  }
}

/** Copy the vault files aside, returning the backup directory. */
function backup(base) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(base, 'backups', `plugin-edit-${stamp}`)
  fs.mkdirSync(dir, { recursive: true })
  for (const name of ['accounts.enc', 'vault.key', 'config.json']) {
    const from = join(base, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, join(dir, name))
  }
  return dir
}

/** Put a backup back over the live vault. */
function restore(backupDir, base) {
  for (const name of ['accounts.enc', 'vault.key', 'config.json']) {
    const from = join(backupDir, name)
    if (fs.existsSync(from)) fs.copyFileSync(from, join(base, name))
  }
}

/** Ask the daemon to exit, and wait for it to actually go. */
async function stopDaemon(timeoutMs = 10_000) {
  if (!daemonRunning()) return true
  try {
    const out = execFileSync('wmic', [
      'process', 'where', "name='buddyhub-service.exe'", 'get', 'ProcessId', '/value'
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const ids = [...out.matchAll(/ProcessId=(\d+)/g)].map((m) => Number(m[1]))
    for (const id of ids) {
      try {
        execFileSync('taskkill', ['/PID', String(id), '/F'], { windowsHide: true, timeout: 5000 })
      } catch {
        // Already gone.
      }
    }
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!daemonRunning()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return !daemonRunning()
}

/** Start the daemon again, using the path it was running from. */
async function startDaemon() {
  const candidates = [
    process.env.BUDDYHUB_EXE,
    'D:\\BuddyHub\\buddyhub-service.exe',
    join(homedir(), 'BuddyHub', 'buddyhub-service.exe')
  ].filter((p) => typeof p === 'string' && p.length > 0)
  const exe = candidates.find((p) => fs.existsSync(p))
  if (exe === undefined) return false
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    return false
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (daemonRunning()) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return daemonRunning()
}

/**
 * Mutate the vault with the daemon stopped, restoring on any failure.
 *
 * @param options - `dataDir`, and `mutate` which receives the account array and
 *   returns the new one (or throws to abort).
 * @returns what happened, including the backup path.
 */
async function withVaultLocked(options, mutate) {
  const base = vaultDir(options.dataDir)
  const read = readVaultAccounts(base)
  if (!read.ok) return { ok: false, error: read.error }

  const wasRunning = daemonRunning()
  if (wasRunning) {
    const stopped = await stopDaemon()
    if (!stopped) {
      return { ok: false, error: '无法停止本地守护进程，账号库正在被它占用。请先退出守护进程再试。' }
    }
  }

  const backupDir = backup(base)
  let next
  try {
    next = mutate(read.accounts.slice())
    if (!Array.isArray(next)) throw new Error('内部错误：变更结果不是账号数组')
  } catch (error) {
    if (wasRunning) await startDaemon()
    return {
      ok: false,
      backupDir,
      error: `变更未生效：${error instanceof Error ? error.message : String(error)}`
    }
  }

  try {
    writeVaultAccounts(base, next)
  } catch (error) {
    restore(backupDir, base)
    if (wasRunning) await startDaemon()
    return {
      ok: false,
      backupDir,
      error: `写入账号库失败，已从备份恢复：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const restarted = wasRunning ? await startDaemon() : true
  return {
    ok: true,
    backupDir,
    accounts: next,
    restarted,
    ...(restarted ? {} : { warning: '账号库已更新，但守护进程没能自动重启，请手动启动一次。' })
  }
}

/**
 * Write a freshly captured credential straight into the vault.
 *
 * ## Why this does not go through `/admin/import`
 *
 * The import route refuses an incoming credential whose `expiresAt` is not
 * later than the stored one (`main.rs`: `old.expiresAt >= new.expiresAt`), and
 * it does so *silently* — no `skipped` entry, all counts zero. A capture is
 * exactly the case that trips this: the user re-signs-in because the pool holds
 * a stale or rate-limited token, but the new token's lifetime is counted from
 * now, so its `exp` is usually *earlier* than a stored credential that was
 * imported near the start of its own (longer, enterprise) window.
 *
 * The result was a deadlock: the capture succeeded, the token was valid, and
 * the pool never changed. Refreshing was impossible by construction until the
 * stored credential expired. Writing the account directly is the only path that
 * reflects what the user actually asked for, and it is the same mechanism the
 * manual 「刷新凭证」 button already uses.
 *
 * Matching is by `sha256(site:uid:enterpriseId)[:20]`, the daemon's own id
 * derivation, so a re-capture updates the account it belongs to instead of
 * creating a duplicate. A tombstoned account is revived, because handing a
 * deleted entry a fresh token means the user wants it back.
 *
 * @param options - `dataDir`, `site`, `uid`, `enterpriseId`, `accessToken`,
 *   optional `domain`, `expiresAt`, `refreshToken`, and `label`.
 * @returns the outcome, with the account id that was written.
 */
export async function upsertCapturedCredential(options = {}) {
  const site = options.site === 'ai' ? 'ai' : 'cn'
  const uid = options.uid
  const token = options.accessToken
  if (typeof uid !== 'string' || uid.length === 0) {
    return { ok: false, error: '抓到的凭据里没有 uid，无法定位账号。' }
  }
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: '缺少新的 accessToken。' }
  }
  const suspicious = tokenProblem(token)
  if (suspicious !== null) return { ok: false, error: suspicious }

  const enterpriseId = typeof options.enterpriseId === 'string' ? options.enterpriseId : ''
  const id = crypto.createHash('sha256')
    .update(`${site}:${uid}:${enterpriseId}`)
    .digest('hex')
    .slice(0, 20)

  let written = null
  const result = await withVaultLocked(options, (accounts) => {
    const existing = accounts.find((a) => a && a.id === id)
    const expiry = typeof options.expiresAt === 'number' && options.expiresAt > 0
      ? options.expiresAt
      : 0
    if (existing === undefined) {
      accounts.push({
        id,
        site,
        uid,
        enterpriseId,
        domain: typeof options.domain === 'string' && options.domain.length > 0
          ? options.domain
          : site === 'ai' ? 'www.workbuddy.ai' : 'copilot.tencent.com',
        label: typeof options.label === 'string' && options.label.length > 0
          ? options.label
          : `账号 ${id.slice(0, 6)}`,
        accessToken: token,
        refreshToken: typeof options.refreshToken === 'string' ? options.refreshToken : '',
        expiresAt: expiry,
        refreshExpiresAt: 0,
        enabled: true,
        authState: '待验证',
        cooldownUntil: 0,
        lastError: '',
        requests: 0,
        successes: 0,
        failures: 0,
        checkin: {},
        source: 'capture',
        importedAt: Date.now(),
        refreshedAt: Date.now(),
        phoneSuffix: ''
      })
      written = { id, created: true }
      return accounts
    }
    existing.accessToken = token
    if (typeof options.refreshToken === 'string' && options.refreshToken.length > 0) {
      existing.refreshToken = options.refreshToken
    }
    if (typeof options.domain === 'string' && options.domain.length > 0) existing.domain = options.domain
    // The captured `exp` is authoritative. It may legitimately be earlier than
    // the value left behind by an earlier import; keeping the old one would
    // make the account look healthier than its token is.
    existing.expiresAt = expiry
    if (existing.removed === true) {
      delete existing.removed
      delete existing.removedAt
      existing.enabled = true
    }
    // A fresh token has not been proven yet: let the next call establish its
    // health instead of inheriting a stale verdict, and clear the rate-limit
    // cooldown that made the user re-capture in the first place.
    existing.authState = '待验证'
    existing.cooldownUntil = 0
    existing.lastError = ''
    existing.refreshedAt = Date.now()
    if (existing.enabled === false) existing.enabled = true
    written = { id, created: false }
    return accounts
  })
  return { ...result, written }
}

/**
 * Remove one account from the vault.
 *
 * @param options - `dataDir` and `accountId`.
 * @returns the outcome, with the removed account so the caller can report it.
 */
export async function removeAccount(options = {}) {
  const id = options.accountId
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, error: '缺少账号 id。' }
  }
  let removed = null
  const result = await withVaultLocked(options, (accounts) => {
    const index = accounts.findIndex((a) => a && a.id === id)
    if (index < 0) throw new Error('账号库里没有这个账号，可能已经被移除。')
    removed = accounts[index]
    accounts[index] = tombstone(accounts[index])
    return accounts
  })
  return { ...result, removed: removed === null ? null : { id: removed.id, label: removed.label, site: removed.site } }
}

/**
 * Turn an account into a tombstone instead of dropping it from the array.
 *
 * ## Why not just remove the entry
 *
 * The daemon re-imports credentials from the desktop client on every start. Its
 * account id is a hash of `site:uid:enterpriseId`, so a re-import lands on the
 * same id — which means a deleted entry simply reappears a second later, fully
 * working, and the delete looks broken.
 *
 * The re-import only overwrites an existing entry when the incoming credential
 * expires later than the stored one. So the entry is kept, emptied and dated far
 * in the future: the import finds the id taken, decides it has nothing newer,
 * and leaves it alone. The account is gone from the pool without the vault
 * fighting the importer on every restart.
 *
 * @param account - the account to retire.
 * @returns the tombstone.
 */
function tombstone(account) {
  return {
    ...account,
    // The point of the tombstone: nothing usable is left behind.
    accessToken: '',
    refreshToken: '',
    // Marks the entry so the UI and the tools can tell it apart from a real
    // account, and skip it in the pool.
    removed: true,
    enabled: false,
    authState: '已删除',
    lastError: '',
    cooldownUntil: 0,
    // 2100-01-01: later than any real credential, so the importer's
    // "is the incoming one newer" test fails and the entry is left alone.
    expiresAt: 4102444800000,
    refreshExpiresAt: 0,
    removedAt: Date.now()
  }
}

/**
 * Why a supplied token is obviously not a credential, or null when it looks fine.
 *
 * The threshold is deliberately loose: the point is to catch a pasted fragment,
 * a placeholder, or a stray keystroke, not to validate the issuer. A real token
 * from either region is well over a kilobyte, so a few hundred bytes is still an
 * order of magnitude below anything genuine while leaving room for a format
 * change that shortens them.
 *
 * @param token - the candidate string.
 * @returns an explanation, or null.
 */
function tokenProblem(token) {
  if (token.length < 200) {
    return `这个令牌只有 ${token.length} 个字符，正常令牌有上千个字符。看起来是粘贴不完整，已放弃修改（原凭据未动）。`
  }
  if (/\s/.test(token)) {
    return '令牌里含有空格或换行。请只粘贴令牌本身，不要带引号或解释文字。'
  }
  // A JWT is three base64url segments separated by dots. Both regions issue
  // those, so a string with none is not a token even if it is long.
  if (!/^[A-Za-z0-9_\-.+/=]+$/.test(token)) {
    return '令牌含有不该出现的字符。请只粘贴令牌本身。'
  }
  return null
}

/**
 * Replace one account's token, keeping everything else about it.
 *
 * @param options - `dataDir`, `accountId`, `accessToken`, optional `uid`,
 *   `domain`, `expiresAt`, `refreshToken`.
 * @returns the outcome.
 */
export async function updateAccountCredential(options = {}) {
  const id = options.accountId
  const token = options.accessToken
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: '缺少账号 id。' }
  if (typeof token !== 'string' || token.length === 0) return { ok: false, error: '缺少新的 accessToken。' }

  // Validate before opening the vault. These credentials are JWTs of several
  // hundred bytes; accepting a short string silently replaces a working token
  // with something that cannot authenticate, and because the write is atomic and
  // backed up, that loss is not obvious from the pool's behaviour — the account
  // simply starts failing. The page checks this too, but a check that only
  // exists in the caller is not a check: any other caller, or a future one,
  // reopens the hole.
  const suspicious = tokenProblem(token)
  if (suspicious !== null) return { ok: false, error: suspicious }

  let updated = null
  const result = await withVaultLocked(options, (accounts) => {
    const account = accounts.find((a) => a && a.id === id)
    if (account === undefined) throw new Error('账号库里没有这个账号。')
    account.accessToken = token
    // Handing a deleted account a token means the user wants it back, so the
    // tombstone has to be lifted — otherwise the refresh silently does nothing
    // and the account stays hidden.
    if (account.removed === true) {
      delete account.removed
      delete account.removedAt
      account.enabled = true
      // The tombstone's far-future expiry was only there to defeat the
      // importer's freshness test; it is not a real expiry, so drop it unless
      // the caller supplied one.
      account.expiresAt = 0
    }
    if (typeof options.uid === 'string' && options.uid.length > 0) account.uid = options.uid
    if (typeof options.domain === 'string' && options.domain.length > 0) account.domain = options.domain
    if (typeof options.expiresAt === 'number' && options.expiresAt > 0) account.expiresAt = options.expiresAt
    if (typeof options.refreshToken === 'string' && options.refreshToken.length > 0) {
      account.refreshToken = options.refreshToken
    }
    // A refreshed token has not been proven yet: let the next call establish
    // its health rather than inheriting the old verdict.
    account.authState = '待验证'
    account.cooldownUntil = 0
    account.lastError = ''
    account.refreshedAt = Date.now()
    updated = { id: account.id, label: account.label, site: account.site }
    return accounts
  })
  return { ...result, updated }
}
