/**
 * Per-account check-in preference.
 *
 * ## Why this is separate from the vault's `enabled` flag
 *
 * The account vault has one `enabled` field, and it means "may serve model
 * calls". Using it to also mean "takes part in check-in" would make two very
 * different decisions inseparable: a user who wants an account to serve traffic
 * but not auto-claim its daily reward would have to disable it entirely and
 * lose the pool slot too.
 *
 * So check-in eligibility is the plugin's own state, keyed by the vault's
 * account id. It is stored beside the other plugin state, which keeps the
 * vault read-only — the daemon owns that file and rewrites it on every save.
 *
 * ## Defaults
 *
 * An account with no stored preference takes part. That keeps existing installs
 * working unchanged: before this feature existed every account was checked in,
 * so defaulting to "off" would silently stop claiming rewards on upgrade.
 *
 * @module dsh-command-buddy-connect/checkin-prefs
 */

import fs from 'node:fs'
import { join } from 'node:path'
import { resolveStateDir } from './state-dir.js'

/** The persisted shape: `{ "checkin": { "<accountId>": false } }`. */
const FILE_NAME = 'checkin.json'

/** Path of the preference file. */
function statePath() {
  return join(resolveStateDir({ create: true }), FILE_NAME)
}

/**
 * Holds the per-account check-in preference.
 *
 * Only accounts the user explicitly turned off are stored, so an account added
 * later is included automatically without a migration.
 */
export class CheckinPrefs {
  /**
   * @param options - `logger` for write failures.
   */
  constructor(options = {}) {
    this.logger = options.logger
    /** Account id to a boolean. Only `false` entries are meaningful. */
    this.values = {}
    this.load()
  }

  /** Read persisted preferences, ignoring a missing or malformed file. */
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'))
      const map = parsed?.checkin
      if (map === null || typeof map !== 'object' || Array.isArray(map)) return
      for (const [id, value] of Object.entries(map)) {
        if (typeof value === 'boolean') this.values[id] = value
      }
    } catch {
      // No saved state, or an unreadable one: every account takes part.
    }
  }

  /**
   * Whether an account takes part in check-in.
   *
   * @param accountId - the vault's account id.
   * @returns true unless the user turned this account off.
   */
  includes(accountId) {
    return this.values[accountId] !== false
  }

  /**
   * Record one account's preference and persist it.
   *
   * Writing on every change keeps the file and memory in step: a crash cannot
   * leave the page showing a switch that was never saved.
   *
   * @param accountId - the vault's account id.
   * @param enabled - whether it should take part.
   * @returns whether the write succeeded.
   */
  set(accountId, enabled) {
    if (typeof accountId !== 'string' || accountId.length === 0) return false
    if (enabled === true) {
      // Defaults are inclusive, so an enabled account needs no entry.
      delete this.values[accountId]
    } else {
      this.values[accountId] = false
    }
    return this.save()
  }

  /** Whether every known account is included (used for the "select all" state). */
  allIncluded(accountIds) {
    return accountIds.every((id) => this.includes(id))
  }

  /**
   * Set every listed account at once.
   *
   * @param accountIds - ids to change.
   * @param enabled - whether they should take part.
   * @returns whether the write succeeded.
   */
  setAll(accountIds, enabled) {
    for (const id of accountIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (enabled === true) delete this.values[id]
      else this.values[id] = false
    }
    return this.save()
  }

  /** Persist atomically: write a sibling, then rename over the target. */
  save() {
    const path = statePath()
    const temp = `${path}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, checkin: this.values }, null, 2), { mode: 0o600 })
      fs.renameSync(temp, path)
      return true
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // Already gone.
      }
      this.logger?.warn?.(`无法保存签到偏好：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
}

/**
 * Filter a list of vault accounts down to those taking part in check-in.
 *
 * @param accounts - vault accounts.
 * @param prefs - a `CheckinPrefs` instance, or undefined to include everything.
 * @returns the accounts that should be visited.
 */
export function applyCheckinPrefs(accounts, prefs) {
  if (prefs === undefined || prefs === null) return accounts ?? []
  return (accounts ?? []).filter((a) => prefs.includes(a.id))
}
