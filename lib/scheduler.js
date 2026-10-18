/**
 * Automatic WorkBuddy check-in, driven by this plugin rather than by an
 * external daemon.
 *
 * A separate daemon used to provide these pools; it is an independent product
 * that may not be installed. The requirement is that check-in happens whenever
 * DSH runs, so the scheduler lives here.
 *
 * ## When it runs
 *
 * Three triggers, because a machine that is asleep or shut down at the
 * scheduled minute would otherwise skip the day entirely:
 *
 * 1. **Shortly after startup**, so opening DSH performs the day's check-in.
 * 2. **On a timer** (default 30 minutes) while DSH is running, so a session
 *    left open overnight rolls over into the new day.
 * 3. **On demand**, through the status route's `checkin` action.
 *
 * ## Why it re-checks instead of trusting a stored flag
 *
 * The upstream is the only authority on whether today's reward was claimed: a
 * second device, the WorkBuddy client itself, or a manual claim all change that
 * answer without this plugin knowing. Every tick therefore asks the server
 * (`checkin-activity-status`) and only claims when the server says today is
 * unclaimed. The cost is one cheap status call per tick; the benefit is that a
 * stale local flag can never cause a missed or duplicated check-in.
 *
 * `checkin-activity-status` is also a read: calling it never consumes a reward,
 * so an idle tick is harmless.
 *
 * @module dsh-workbuddy-checkin/scheduler
 */

import { claimCheckin, checkinStatus, readBalance, resolveCredential, accountLabel } from './workbuddy.js'
import { CHECKIN_OUTCOMES, checkinAll } from './checkin-all.js'
import { readVault } from './vault.js'

/** Default interval between automatic checks, in milliseconds. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000

/** Delay before the first check after startup, so boot is not blocked. */
const STARTUP_DELAY_MS = 20 * 1000

/**
 * Today's date in China Standard Time, as `YYYY-MM-DD`.
 *
 * The reward day is defined by the upstream's own calendar, which is CN time;
 * using the host's local zone would claim the wrong day for a machine set to
 * another region.
 *
 * @param now - the instant to render.
 * @returns the CN calendar date.
 */
export function cnDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(now))
  return parts
}

/**
 * The next occurrence of a `HH:mm` CN-time boundary, as an epoch millisecond.
 *
 * Computed by scanning CN-local minute labels rather than by offset arithmetic:
 * China has a single fixed offset with no daylight saving, but deriving the
 * boundary from the same formatter that defines "CN time" keeps the answer
 * correct even if that ever changes, and avoids reimplementing timezone maths.
 * The result is truncated to the start of the matching minute so it reads as a
 * clock boundary rather than "09:00 and 56 seconds".
 *
 * @param time - `HH:mm` in CN time.
 * @param now - the instant to measure from.
 * @returns the next matching instant, always strictly in the future.
 */
export function nextOccurrence(time, now = Date.now()) {
  const [hour, minute] = String(time).split(':').map((part) => Number(part))
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
  const target = `${pad(hour)}:${pad(minute)}`
  // Start at the next whole minute, then walk forward at most one day.
  const start = Math.floor(now / 60_000) * 60_000 + 60_000
  for (let candidate = start; candidate <= start + 24 * 60 * 60_000; candidate += 60_000) {
    if (formatter.format(new Date(candidate)) === target) return candidate
  }
  return undefined
}

/** Zero-pad a two-digit clock field. */
function pad(value) {
  return String(value).padStart(2, '0')
}

/**
 * Owns the check-in state and its timers for one plugin instance.
 *
 * The scheduler keeps a small status snapshot so the HTTP route can answer
 * instantly without re-reading credentials on every poll. It refreshes that
 * snapshot after each real check, so the UI reflects what actually happened.
 */
export class CheckinScheduler {
  /**
   * @param options - configuration and diagnostics sink.
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs >= 60_000
      ? options.intervalMs
      : DEFAULT_INTERVAL_MS
    this.logger = options.logger
    this.signal = options.signal
    /** Data directory, so check-in can use a pooled CN account. */
    this.dataDir = options.dataDir
    /**
     * Regions whose accounts take part.
     *
     * CN only by default: the international billing endpoint rejects these
     * calls with 401, so including it would report a failure on every run
     * without anything being wrong here.
     */
    this.sites = Array.isArray(options.sites) && options.sites.length > 0 ? options.sites : ['cn']
    /** Last observed status, or undefined before the first successful read. */
    this.state = undefined
    /** Whether a check is in flight, so ticks cannot overlap. */
    this.busy = false
    /** The most recent failure, cleared by the next success. */
    this.error = undefined
    /** Resolves once the first check has settled; used by the status route. */
    this.firstCheck = undefined
  }

  /** Record one diagnostic line, tolerating a missing logger. */
  log(message) {
    this.logger?.info?.(`dsh-workbuddy-checkin: ${message}`)
  }

  /**
   * Run one check-in cycle.
   *
   * Reads the account state, claims the reward only when the server reports it
   * unclaimed, and refreshes the credit balance. A failure is recorded rather
   * than thrown: an unattended timer must not reject into the host.
   *
   * @param options - `force` claims without consulting the day guard.
   * @returns the resulting status snapshot.
   */
  async run(options = {}) {
    if (this.busy) return this.snapshot()
    this.busy = true
    try {
      // Read the pool once and visit every eligible account. Checking only the
      // first one left the rest of the pool unclaimed, which looked like the
      // other accounts were broken when they had simply never been asked.
      const vault = readVault(this.dataDir)
      if (!vault.ok) {
        const resolved = await resolveCredential(this.dataDir)
        if (!resolved.ok) {
          this.error = resolved.error
          this.state = undefined
          this.log(`check-in skipped: ${resolved.error}`)
          return this.snapshot()
        }
        // A single credential from elsewhere still deserves a run.
        return this.#runSingle(resolved.credential, options)
      }

      const run = await checkinAll({
        accounts: vault.accounts,
        sites: this.sites,
        signal: this.signal,
        status: checkinStatus,
        claim: claimCheckin,
        balance: readBalance,
        label: accountLabel
      })

      this.error = undefined
      const now = Date.now()
      this.state = {
        date: cnDate(now),
        // The first account keeps the old single-account fields, so the page and
        // the tools that read them keep working while the full list lives in
        // `accounts`.
        account: run.results.length > 0
          ? { label: run.results[0].label, uid: run.results[0].uid }
          : undefined,
        checkedIn: run.results.some((r) => r.outcome === CHECKIN_OUTCOMES.claimed
          || r.outcome === CHECKIN_OUTCOMES.already),
        active: run.results.some((r) => r.outcome !== CHECKIN_OUTCOMES.failed),
        status: run.summary,
        credits: run.results.reduce((sum, r) => sum + (Number(r.credits) || 0), 0) || undefined,
        totalCredits: run.results.reduce((sum, r) => sum + (Number(r.totalCredits) || 0), 0) || undefined,
        streakDays: undefined,
        balance: run.results.reduce((sum, r) => sum + (Number(r.balance) || 0), 0) || null,
        balanceError: undefined,
        claimedThisRun: run.results.some((r) => r.outcome === CHECKIN_OUTCOMES.claimed),
        accounts: run.results.map((r) => ({
          id: r.id,
          site: r.site,
          label: r.label,
          outcome: r.outcome,
          credits: r.credits,
          totalCredits: r.totalCredits,
          balance: r.balance,
          error: r.error
        })),
        visited: run.visited,
        at: now,
        forced: options.force === true
      }
      this.log(run.summary)
      return this.snapshot()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return this.snapshot()
    } finally {
      this.busy = false
    }
  }

  /** Run the original single-credential path, for a credential not from the vault. */
  async #runSingle(credential, options) {
    const label = accountLabel(credential)
    const status = await checkinStatus(credential, this.signal)
    if (!status.ok) {
      this.error = status.error
      return this.snapshot()
    }

    let claimed = false
    let outcome = status
    if (status.active && !status.checkedIn) {
      const claim = await claimCheckin(credential, this.signal)
      if (!claim.ok) {
        this.error = claim.error
        return this.snapshot()
      }
      claimed = claim.claimed
      // Re-read rather than assuming: the reward is only real once the server
      // reports it.
      const after = await checkinStatus(credential, this.signal)
      if (after.ok) outcome = after
      this.log(claimed ? `checked in for ${label}` : `${label} had already checked in today`)
    } else if (!status.active) {
      this.log('the check-in activity is not open right now')
    }

    const balance = await readBalance(credential, this.signal)
    const now = Date.now()
    this.error = undefined
    this.state = {
      date: cnDate(now),
      account: { label, uid: typeof credential.uid === 'string' ? credential.uid : undefined },
      checkedIn: outcome.checkedIn === true,
      active: outcome.active === true,
      status: outcome.checkedIn === true
        ? (claimed ? '签到成功' : '今日已签到')
        : (outcome.active === true ? '签到未完成' : '活动未开放'),
      credits: outcome.todayCredit,
      totalCredits: outcome.totalCredits,
      streakDays: outcome.streakDays,
      balance: balance.ok ? balance.balance : null,
      balanceError: balance.ok ? undefined : balance.error,
      claimedThisRun: claimed,
      accounts: [{
        id: credential.uid,
        site: 'cn',
        label,
        outcome: outcome.checkedIn === true
          ? (claimed ? CHECKIN_OUTCOMES.claimed : CHECKIN_OUTCOMES.already)
          : CHECKIN_OUTCOMES.inactive,
        credits: outcome.todayCredit,
        totalCredits: outcome.totalCredits,
        balance: balance.ok ? balance.balance : undefined
      }],
      visited: 1,
      at: now,
      forced: options.force === true
    }
    return this.snapshot()
  }

  /**
   * The current status, in the shape the UI and the tools consume.
   *
   * @returns a detached snapshot.
   */
  snapshot() {
    return {
      installed: true,
      signedIn: this.state !== undefined,
      account: this.state?.account,
      checkin: this.state === undefined ? null : {
        date: this.state.date,
        checkedIn: this.state.checkedIn,
        active: this.state.active,
        status: this.state.status,
        credits: this.state.credits,
        totalCredits: this.state.totalCredits,
        streakDays: this.state.streakDays,
        at: this.state.at
      },
      // Per-account results of the last run. The single-account fields above
      // stay for compatibility, but this is what the page lists.
      checkinAccounts: this.state?.accounts ?? [],
      checkinVisited: this.state?.visited ?? 0,
      balance: this.state?.balance ?? null,
      autoCheckin: this.enabled,
      busy: this.busy,
      error: this.error ?? this.state?.balanceError ?? null
    }
  }

  /**
   * Start the startup check and the recurring timer.
   *
   * The two triggers need different timer kinds, and confusing them is silent:
   * `timeout` fires once, so using it for the recurring check would perform
   * exactly one check-in per DSH launch and never roll over into the next day.
   * They are therefore separate injected functions rather than one callback.
   *
   * Timers are registered through the caller's `ctx.effect`, so unloading the
   * plugin stops them without this class tracking disposers itself.
   *
   * @param timers - the host's `{ once, every }` registrars, each returning a disposer.
   * @returns a disposer stopping both triggers.
   */
  start(timers) {
    if (!this.enabled) {
      this.log('automatic check-in is disabled by configuration')
      return () => {}
    }
    const tick = () => {
      this.run().catch(() => {})
    }
    const startup = timers.once(tick, STARTUP_DELAY_MS)
    const recurring = timers.every(tick, this.intervalMs)
    return () => {
      startup()
      recurring()
    }
  }
}
