/**
 * The plugin's on-disk state directory.
 *
 * ## Why the old name is still first
 *
 * The package was renamed, but the directory was never a package name — it is
 * where the user's Command Code key and route switches already live. Moving it
 * would silently orphan a key the user typed in, and the plugin would report
 * "not configured" for something they had already set up.
 *
 * So the legacy directory stays authoritative when it exists, and the new name
 * is used only on a fresh install. A later migration can move the files; right
 * now reading the old location is strictly better than losing the data.
 *
 * @module dsh-command-buddy-connect/state-dir
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where state lived before the rename. */
const LEGACY_NAME = '.buddy-connect'

/** Where state goes on a fresh install. */
const CURRENT_NAME = '.dsh-command-buddy-connect'

/**
 * Resolve the state directory.
 *
 * @param options - `env` override for tests, `create` to make the directory.
 * @returns the directory path.
 */
export function resolveStateDir(options = {}) {
  const env = options.env ?? process.env

  // An explicit override always wins: tests and portable installs rely on it.
  const explicit = env.BUDDY_CONNECT_STATE_DIR
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (options.create === true) fs.mkdirSync(explicit, { recursive: true })
    return explicit
  }

  const home = env.USERPROFILE || homedir()
  const legacy = join(home, LEGACY_NAME)
  const current = join(home, CURRENT_NAME)

  // Keep using the pre-rename directory while it holds the user's data.
  const chosen = fs.existsSync(legacy) ? legacy : current
  if (options.create === true) fs.mkdirSync(chosen, { recursive: true })
  return chosen
}
