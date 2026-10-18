/**
 * Check in every eligible account, not just the first one.
 *
 * ## Why this exists
 *
 * The original implementation picked a single CN account and checked that one
 * in. With two or three accounts in the pool that silently left the rest
 * unclaimed — the accounts were fine, nothing was broken, they simply were
 * never asked.
 *
 * ## Shape of a run
 *
 * Accounts are processed one at a time, deliberately:
 * - the upstream rate-limits per account, and a parallel burst across accounts
 *   looks like abuse from the same IP;
 * - one account failing must not abort the others, so each result is recorded
 *   independently;
 * - the daily reward can only be claimed once per account, so a partial run is
 *   safe to repeat.
 *
 * The whole run is bounded: an account that hangs cannot hold the rest hostage
 * past `PER_ACCOUNT_TIMEOUT_MS`.
 *
 * @module dsh-command-buddy-connect/checkin-all
 */

/** How long one account may take before it is recorded as timed out. */
const PER_ACCOUNT_TIMEOUT_MS = 30_000

/** Outcomes an account can have in one run. */
export const CHECKIN_OUTCOMES = {
  claimed: 'claimed',
  already: 'already',
  inactive: 'inactive',
  failed: 'failed',
  skipped: 'skipped'
}

/**
 * Select the accounts a check-in run should visit.
 *
 * Eligibility mirrors what the billing call requires: a plaintext token that has
 * not expired. Region is not filtered here — the caller decides which sites it
 * can serve — but the AI region is excluded by default because its billing
 * endpoint rejects these calls.
 *
 * @param accounts - the vault's account list.
 * @param options - `now`, `sites` (default `['cn']`).
 * @returns the accounts to visit, in a stable order.
 */
export function selectCheckinAccounts(accounts, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const sites = Array.isArray(options.sites) && options.sites.length > 0 ? options.sites : ['cn']
  return (accounts ?? []).filter((a) => {
    if (a === null || typeof a !== 'object') return false
    if (!sites.includes(a.site)) return false
    // A tombstone left behind by a delete: kept only so the daemon cannot
    // re-import the credential. It is not an account.
    if (a.removed === true) return false
    if (a.enabled === false) return false
    if (typeof a.accessToken !== 'string' || a.accessToken.length === 0) return false
    if (typeof a.expiresAt === 'number' && a.expiresAt > 0 && a.expiresAt <= now) return false
    return true
  })
}

/** Read one Error's message without assuming the thrown value is an Error. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Check in every selected account.
 *
 * @param options - `accounts`, `now`, `status`, `claim`, `balance`, `signal`.
 *   `status`/`claim`/`balance` are the workbuddy helpers; passing them in keeps
 *   this testable without a network.
 * @returns per-account results plus a summary.
 */
export async function checkinAll(options = {}) {
  const targets = selectCheckinAccounts(options.accounts, { now: options.now, sites: options.sites })
  const results = []
  const startedAt = Date.now()

  for (const account of targets) {
    if (options.signal?.aborted === true) {
      results.push({
        id: account.id,
        site: account.site,
        label: account.label ?? account.id,
        outcome: CHECKIN_OUTCOMES.skipped,
        error: '运行已取消'
      })
      continue
    }

    const credential = {
      accessToken: account.accessToken,
      uid: account.uid,
      domain: account.domain ?? 'copilot.tencent.com',
      ...(account.enterpriseId ? { enterpriseId: account.enterpriseId } : {})
    }
    const base = {
      id: account.id,
      site: account.site,
      uid: account.uid,
      label: options.label?.(credential) ?? account.label ?? account.id
    }

    // One account's failure is recorded, not thrown: the remaining accounts
    // still deserve their reward.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PER_ACCOUNT_TIMEOUT_MS)
    const signal = options.signal === undefined
      ? controller.signal
      : anySignal([options.signal, controller.signal])

    try {
      const status = await options.status(credential, signal)
      if (status.ok !== true) {
        results.push({ ...base, outcome: CHECKIN_OUTCOMES.failed, error: status.error })
        continue
      }
      if (status.active !== true) {
        results.push({ ...base, outcome: CHECKIN_OUTCOMES.inactive, error: '签到活动当前未开放' })
        continue
      }
      if (status.checkedIn === true) {
        const balance = await options.balance(credential, signal).catch(() => null)
        results.push({
          ...base,
          outcome: CHECKIN_OUTCOMES.already,
          credits: status.todayCredit,
          totalCredits: status.totalCredits,
          balance: balance?.ok === true ? balance.balance : undefined
        })
        continue
      }

      const claim = await options.claim(credential, signal)
      if (claim.ok !== true) {
        results.push({ ...base, outcome: CHECKIN_OUTCOMES.failed, error: claim.error })
        continue
      }
      // The reward only counts once the server says so; re-reads are cheap and
      // this is what makes "claimed" a fact rather than an assumption.
      const after = await options.status(credential, signal).catch(() => null)
      const balance = await options.balance(credential, signal).catch(() => null)
      results.push({
        ...base,
        outcome: claim.claimed === true ? CHECKIN_OUTCOMES.claimed : CHECKIN_OUTCOMES.already,
        credits: after?.ok === true ? after.todayCredit : undefined,
        totalCredits: after?.ok === true ? after.totalCredits : undefined,
        balance: balance?.ok === true ? balance.balance : undefined
      })
    } catch (error) {
      results.push({ ...base, outcome: CHECKIN_OUTCOMES.failed, error: messageOf(error) })
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    ok: results.some((r) => r.outcome === CHECKIN_OUTCOMES.claimed || r.outcome === CHECKIN_OUTCOMES.already
      || r.outcome === CHECKIN_OUTCOMES.inactive),
    startedAt,
    finishedAt: Date.now(),
    visited: results.length,
    results,
    summary: summarise(results)
  }
}

/** A one-line summary for the page and for logs. */
export function summarise(results) {
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length
  const parts = []
  if (count(CHECKIN_OUTCOMES.claimed) > 0) parts.push(`签到成功 ${count(CHECKIN_OUTCOMES.claimed)}`)
  if (count(CHECKIN_OUTCOMES.already) > 0) parts.push(`今日已签 ${count(CHECKIN_OUTCOMES.already)}`)
  if (count(CHECKIN_OUTCOMES.inactive) > 0) parts.push(`活动未开放 ${count(CHECKIN_OUTCOMES.inactive)}`)
  if (count(CHECKIN_OUTCOMES.failed) > 0) parts.push(`失败 ${count(CHECKIN_OUTCOMES.failed)}`)
  if (count(CHECKIN_OUTCOMES.skipped) > 0) parts.push(`跳过 ${count(CHECKIN_OUTCOMES.skipped)}`)
  return parts.length === 0 ? '没有可签到的账号' : parts.join(' · ')
}

/** Abort as soon as either signal aborts. */
function anySignal(signals) {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted === true) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}
