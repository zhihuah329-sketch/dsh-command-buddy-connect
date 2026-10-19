/**
 * Persisted per-account health: why an account last failed, and until when it is
 * unusable.
 *
 * ## Why this is not in the vault
 *
 * The vault is the credential store, and it is shared with anything else that
 * reads the same file. Run outcomes are this plugin's own knowledge, change on
 * every request, and have no meaning to another reader — writing them into the
 * vault would mean rewriting an encrypted file (with a backup and a full
 * read-modify-write cycle) on every failed call.
 *
 * ## Why it must be persisted at all
 *
 * Because otherwise the panel lies after every restart. A spent quota was known
 * only in the in-memory pool, so the moment DSH restarted the account was
 * reported as available again — while the upstream was still refusing it until
 * its window reset. The user's report was exactly that: accounts that had run
 * out showed as normal.
 *
 * Entries are pruned as they lapse, so the file cannot grow without bound and a
 * stale exhaustion cannot outlive the window it describes.
 *
 * @module dsh-command-buddy-connect/account-health
 */

import fs from 'node:fs'
import { join } from 'node:path'
import { resolveStateDir } from './state-dir.js'

/** Bumped when the shape changes; an unknown version is ignored, not migrated. */
const VERSION = 1

/** How long a failure with no reset time stays interesting. */
const ERROR_TTL_MS = 24 * 60 * 60 * 1000

/** Where the state lives, beside the plugin's other preferences. */
function healthPath() {
  return join(resolveStateDir({ create: true }), 'account-health.json')
}

/**
 * Read the stored health map.
 *
 * A missing or malformed file is not an error: it means nothing is known yet.
 *
 * @param now - the instant to judge entries against.
 * @returns id → `{ quotaResetAt, lastError, at }`, pruned to still-relevant ones.
 */
export function readHealth(now = Date.now()) {
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(healthPath(), 'utf8'))
  } catch {
    return {}
  }
  if (raw === null || typeof raw !== 'object' || raw.version !== VERSION) return {}
  const stored = raw.accounts
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return {}

  const out = {}
  for (const [id, entry] of Object.entries(stored)) {
    if (entry === null || typeof entry !== 'object') continue
    const quotaResetAt = typeof entry.quotaResetAt === 'number' && entry.quotaResetAt > now
      ? entry.quotaResetAt
      : 0
    const at = typeof entry.at === 'number' ? entry.at : 0
    const lastError = typeof entry.lastError === 'string' ? entry.lastError : ''
    // Keep an entry while it still says something: a future quota window, or a
    // recent failure worth explaining.
    if (quotaResetAt > now || (lastError.length > 0 && now - at < ERROR_TTL_MS)) {
      out[id] = { quotaResetAt, lastError, at }
    }
  }
  return out
}

/**
 * Record one account's outcome, merging into the stored map.
 *
 * @param id - the account id.
 * @param entry - `quotaResetAt`, `lastError`, and optionally `at`.
 * @returns whether the write succeeded.
 */
export function recordHealth(id, entry = {}) {
  if (typeof id !== 'string' || id.length === 0) return false
  try {
    const now = typeof entry.at === 'number' ? entry.at : Date.now()
    const accounts = readHealth(now)
    const quotaResetAt = typeof entry.quotaResetAt === 'number' && entry.quotaResetAt > now
      ? entry.quotaResetAt
      : 0
    const lastError = typeof entry.lastError === 'string' ? entry.lastError : ''
    if (quotaResetAt === 0 && lastError.length === 0) {
      // A success clears the entry rather than storing an empty one.
      delete accounts[id]
    } else {
      accounts[id] = { quotaResetAt, lastError, at: now }
    }
    writeHealthFile(accounts, now)
    return true
  } catch {
    // Health is a convenience, never a reason to fail a request.
    return false
  }
}

/**
 * Remove one account's entry.
 *
 * Used when the credential is replaced: the new token has not failed, so
 * inheriting the old verdict would be wrong.
 *
 * @param id - the account id.
 */
export function clearHealth(id) {
  try {
    const now = Date.now()
    const accounts = readHealth(now)
    if (accounts[id] === undefined) return
    delete accounts[id]
    writeHealthFile(accounts, now)
  } catch {
    // best effort
  }
}

/**
 * Write the map atomically, dropping entries that no longer matter.
 *
 * @param accounts - the id → entry map.
 * @param now - the instant to prune against.
 */
function writeHealthFile(accounts, now) {
  const target = healthPath()
  const temp = `${target}.${process.pid}.tmp`
  const payload = { version: VERSION, updatedAt: now, accounts }
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 })
  fs.renameSync(temp, target)
}
