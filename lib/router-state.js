/**
 * Persistence for the per-route switches.
 *
 * ## Why this is not just model config
 *
 * The switches are a user preference that must survive a restart, but they also
 * have to change behaviour *live* — a route cannot be unregistered from an
 * `llm` adapter registry after the fact without unmounting the plugin. So the
 * switch is consulted at call time, and its value is persisted here.
 *
 * The store is deliberately tiny and dependency-free: one JSON file beside the
 * plugin's own data, written atomically. Using the host's storage domain would
 * be the other option, but it would make the plugin fail to load in a profile
 * where that service is not mounted, and a preference store is not worth that
 * coupling.
 *
 * @module buddy-connect/router-state
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveStateDir } from './state-dir.js'

/**
 * Every switch the page can flip.
 *
 * `cn` and `ai` are separate switches even though one adapter serves both
 * regions: the pools are independent, so a single provider-level switch would
 * make turning off CN silently disable AI as well.
 */
export const ROUTE_IDS = ['cn', 'ai', 'buddyhub', 'command-code']

/**
 * Where the switches live.
 *
 * The directory is resolved so a rename of the package does not move the file
 * out from under switches the user already set.
 */
function statePath() {
  return join(resolveStateDir({ create: true }), 'routes.json')
}

/**
 * Holds the live switch values, seeded from disk and the plugin config.
 *
 * Precedence: an explicit switch the user flipped wins; otherwise the plugin
 * configuration decides. That ordering matters because the config is the
 * deployment's intent while the switch is a runtime override, and re-reading
 * the config after every restart would silently undo a user's choice.
 */
export class RouteSwitches {
  /**
   * @param defaults - the config-derived defaults per route id.
   * @param logger - a logger for write failures.
   */
  constructor(defaults = {}, logger) {
    this.logger = logger
    this.values = { ...defaults }
    this.load()
  }

  /** Read persisted overrides, ignoring a missing or malformed file. */
  load() {
    try {
      const raw = fs.readFileSync(statePath(), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      for (const id of ROUTE_IDS) {
        if (typeof parsed[id] === 'boolean') this.values[id] = parsed[id]
      }
      // Files written before CN and AI were split hold one switch for both.
      // Carry it to each region rather than silently re-enabling a pool the
      // user had turned off.
      if (typeof parsed['buddy-connect'] === 'boolean') {
        for (const site of ['cn', 'ai']) {
          if (typeof parsed[site] !== 'boolean') this.values[site] = parsed['buddy-connect']
        }
      }
    } catch {
      // No saved state, or an unreadable one: the config defaults stand.
    }
  }

  /**
   * Whether a route is switched on.
   *
   * @param id - the route id.
   * @returns the current value, defaulting to false for an unknown id.
   */
  get(id) {
    return this.values[id] === true
  }

  /** Every switch as a plain object. */
  all() {
    return Object.fromEntries(ROUTE_IDS.map((id) => [id, this.get(id)]))
  }

  /**
   * Set one switch and persist it.
   *
   * @param id - the route id.
   * @param value - the new value.
   * @returns the persisted values.
   */
  async set(id, value) {
    if (!ROUTE_IDS.includes(id)) throw new Error(`未知的线路：${id}`)
    this.values[id] = value === true
    await this.save()
    return this.all()
  }

  /** Write the whole state atomically. */
  async save() {
    const path = statePath()
    try {
      fs.mkdirSync(join(path, '..'), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2))
      fs.renameSync(tmp, path)
    } catch (error) {
      // A failed preference write must not break the request: the switch still
      // applied in memory, and the user sees the error in the response.
      this.logger?.warn?.(`buddy-connect: 无法保存线路开关：${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }
}
