/**
 * Account status and authorization: one authority, shared by the page and the
 * agent.
 *
 * ## Why this exists
 *
 * A stored `authState` alone cannot answer "can this account serve a call right
 * now". An account can be marked "valid" while its token has already expired, or
 * while it sits in a cooldown after an upstream 429. Showing "valid" as "usable" in
 * that situation is a false report, and the user then cannot tell a broken pool
 * from a healthy one.
 *
 * So the status here is *derived*: enabled, auth state, cooldown, and token
 * expiry are combined into one verdict per account, with the reasons listed.
 * The page and `buddy_connect_pools` both read this, so they cannot disagree.
 *
 * ## Authorization
 *
 * "Authorize an account" means opening WorkBuddy so the user can sign in, then
 * importing the result. Both halves are host actions:
 *
 * - `openWorkBuddy` launches the desktop client, so the user can log in there.
 * - `discover` scans the credential files WorkBuddy writes and reports, per
 *   file, whether it can be imported — including the sealed-CN case, which no
 *   reader can open offline.
 *
 * Neither guesses a path: the client location comes from configuration, then
 * the vendor default, then a search of the usual install roots.
 *
 * @module buddy-connect/account-status
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readVault, diagnoseCredential } from './vault.js'
import { adminRequest, readConfig, resolveDataDir } from './discovery.js'
import { eligibility } from './proxy.js'
import { readHealth } from './account-health.js'

/** Every status an account can report, most severe first. */
export const ACCOUNT_STATUSES = [
  'disabled',
  'no-token',
  'expired',
  'signin-required',
  'cooling-down',
  'ok'
]

/**
 * How long before expiry an account is worth warning about.
 *
 * A CN credential imported from a captured token carries no refresh token, so
 * when it lapses the account simply stops working. Three days is enough notice
 * to capture a fresh one without nagging for a month.
 */
const EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Describe the expiry runway in terms a user can act on.
 *
 * The distinction that matters is *renewable or not*: an account with a refresh
 * token recovers on its own, while one without it needs the user to authorize
 * again. Reporting only a date hides that difference — and a token that quietly
 * stops working in four weeks is exactly the failure this plugin should prevent.
 *
 * @param account - a vault record.
 * @param now - the instant to judge against.
 * @returns a warning to surface, or null when there is nothing to say.
 */
export function expiryWarning(account, now = Date.now()) {
  const expiresAt = typeof account.expiresAt === 'number' ? account.expiresAt : 0
  if (expiresAt <= 0) return null
  const remaining = expiresAt - now
  const name = account.label ?? account.id ?? '账号'
  if (remaining <= 0) {
    return {
      severity: 'error',
      message: `${name} 的登录令牌已过期，签到与模型调用都会失败。`
    }
  }
  if (remaining > EXPIRING_SOON_MS) return null
  const days = Math.max(1, Math.round(remaining / (24 * 60 * 60 * 1000)))
  const renewable = typeof account.refreshToken === 'string' && account.refreshToken.length > 0
  return {
    severity: 'warn',
    message: `${name} 的登录令牌约 ${days} 天后到期，`
      + (renewable
        ? '有刷新令牌，通常会自行续期；届时若失败请重新授权。'
        : '且没有刷新令牌，无法自动续期，需要重新授权。')
  }
}

/**
 * The single verdict for one account, with the reasons behind it.
 *
 * Usability comes from `proxy.js` `eligibility()`, which is also what the pool
 * counts and the rotation use. Duplicating that rule here is how the page and
 * the pool would end up disagreeing about whether a region is alive; this
 * function only adds the human-readable explanation on top of it.
 *
 * @param account - a decrypted vault record.
 * @param now - the instant to judge against.
 * @returns the status, its display label, and the reasons that applied.
 */
export function accountStatus(account, now = Date.now()) {
  const reasons = []
  const expiresAt = typeof account.expiresAt === 'number' ? account.expiresAt : 0
  const cooling = typeof account.cooldownUntil === 'number' && account.cooldownUntil > now
  const quotaResetAt = typeof account.quotaResetAt === 'number' ? account.quotaResetAt : 0
  const exhausted = quotaResetAt > now
  const expired = expiresAt > 0 && expiresAt <= now
  const expiringSoon = expiresAt > 0 && !expired && expiresAt - now <= EXPIRING_SOON_MS

  const verdict = eligibility(account, now)
  // The status is the first rule from `eligibility()` that rejected the
  // account; every rule is still described, so a user sees the full picture
  // rather than only the most severe symptom.
  const status = verdict.usable ? 'ok' : verdict.reason

  if (account.enabled === false) reasons.push('账号已停用')
  if (typeof account.accessToken !== 'string' || account.accessToken.length === 0) {
    reasons.push('没有可用的访问令牌')
  }
  if (expired) reasons.push(`令牌已于 ${new Date(expiresAt).toISOString().slice(0, 10)} 过期`)
  if (account.authState === '需重新登录') reasons.push('上游要求重新登录')
  // Reported before the cooldown because it is the stronger statement: an
  // exhausted account cannot serve a call at all until its window resets, and a
  // cooldown that happens to have lapsed says nothing about that.
  if (exhausted) {
    reasons.push(`额度已用尽，上游将在 ${formatInstant(quotaResetAt)} 重置`)
  }
  if (cooling) {
    const seconds = Math.max(0, Math.round((account.cooldownUntil - now) / 1000))
    reasons.push(`请求失败冷却中，约 ${seconds} 秒后自动恢复`)
  }
  if (typeof account.lastError === 'string' && account.lastError.length > 0) {
    // A past failure is history, not a current verdict: an account that served
    // hundreds of calls and cooled down once is healthy, and calling it broken
    // would teach the user to ignore the panel.
    reasons.push(`${cooling || exhausted ? '' : '历史错误：'}${account.lastError}`)
  }

  return {
    status,
    usable: verdict.usable,
    // `statusLabel`, not `label`: the caller's account name is also a `label`,
    // and spreading this over it would rename every account to its verdict.
    statusLabel: STATUS_LABELS[status] ?? status,
    reasons,
    quotaResetAt: exhausted ? quotaResetAt : 0,
    expiringSoon: expiringSoon && verdict.usable
  }
}

/** Render an epoch-millisecond instant as a local clock time. */
function formatInstant(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '未知时间'
  try {
    return date.toLocaleString()
  } catch {
    return date.toISOString()
  }
}

/** Human-readable label per status. */
export const STATUS_LABELS = {
  ok: '可用',
  'quota-exhausted': '额度用尽',
  'cooling-down': '冷却中',
  expired: '已过期',
  'signin-required': '需重新登录',
  'no-token': '缺少令牌',
  disabled: '已停用'
}

/**
 * Which region an installed client belongs to.
 *
 * ## Why the path alone cannot answer this
 *
 * Both products install to a directory called `WorkBuddy`, so `F:\WorkBuddy\
 * WorkBuddy.exe` is a valid answer for either region. Earlier versions guessed
 * from the path and could therefore offer the CN client when authorizing an AI
 * account, which signs in the wrong product.
 *
 * The reliable signal is the client's own user-data directory: the CN build
 * keeps its profile in `%APPDATA%\CodeBuddy CN`, and the international build
 * uses a different name. Each install is matched to a region only by the
 * profile directory that shares its install date, so an install with no profile
 * yet stays unattributed instead of being assigned to the wrong region.
 *
 * @returns one path per region where known.
 */
function clientsByRegion() {
  const found = { cn: undefined, ai: undefined }
  const roaming = process.env.APPDATA
  if (typeof roaming === 'string' && roaming.length > 0) {
    // The CN desktop build's profile directory. Its name carries the region,
    // which the executable's own metadata does not.
    const cnProfile = join(roaming, 'CodeBuddy CN')
    if (existsSync(cnProfile)) {
      for (const candidate of workbuddyCandidates()) {
        found.cn = candidate
        break
      }
    }
  }
  return found
}

/** Where the WorkBuddy desktop client is usually installed. */
function workbuddyCandidates() {
  const local = process.env.LOCALAPPDATA
  const list = []
  if (typeof local === 'string' && local.length > 0) {
    list.push(join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'))
  }
  // Installs moved to another drive are common; look one level deep in the
  // usual roots rather than scanning the whole filesystem.
  for (const root of ['C:\\', 'D:\\', 'E:\\', 'F:\\']) {
    try {
      for (const entry of readdirSync(root)) {
        if (!/^workbuddy$/i.test(entry)) continue
        const candidate = join(root, entry, 'WorkBuddy.exe')
        if (existsSync(candidate)) list.push(candidate)
      }
    } catch {
      // An unreadable root is not an error; skip it.
    }
  }
  return list
}

/**
 * Resolve a WorkBuddy desktop client path for one region.
 *
 * The two regions are separate products with separate installs, so resolution
 * is per region: CN uses the daemon's `workbuddyExe`, AI uses `workbuddyIntlExe`,
 * and neither falls back to the other. Opening the CN client to authorize an AI
 * account would show the wrong sign-in screen and produce a credential for the
 * wrong pool.
 *
 * @param options - `site` ('cn' or 'ai'), `configured` path, daemon paths.
 * @returns the resolved path and where it came from.
 */
export function resolveClientForSite(options = {}) {
  const site = options.site === 'ai' ? 'ai' : 'cn'

  // A path the daemon recorded for this region is the most precise answer: it
  // is the install the daemon itself uses, so a credential from it lands in the
  // pool the user is looking at.
  const fromDaemon = site === 'ai' ? options.daemonIntlPath : options.daemonPath
  if (typeof fromDaemon === 'string' && fromDaemon.length > 0 && existsSync(fromDaemon)) {
    return { path: fromDaemon, source: 'buddyhub', site }
  }

  // The plugin's own `workbuddyPath` is a single, region-agnostic setting, so it
  // can only answer for CN. Letting it satisfy an AI lookup would point the AI
  // authorize button at the CN client, which is the exact mistake this function
  // exists to prevent.
  const configured = options.configured
  const configuredUsable = typeof configured === 'string' && configured.length > 0
  if (site === 'cn' && configuredUsable && existsSync(configured)) {
    return { path: configured, source: 'configured', site }
  }

  // The two regions are distinct products. Falling back to "any WorkBuddy.exe"
  // would open the CN client for an AI authorization, which signs in the wrong
  // account — worse than reporting that the client is not installed.
  //
  // The exclusion below only works when the *other* region's path is known. When
  // the daemon has lost its `workbuddyExe` entries the paths are all undefined,
  // the exclusions match nothing, and the scan hands the CN install to an AI
  // lookup. So attribute a discovered install to a region by its profile
  // directory instead of assuming the first hit belongs to whoever asked.
  const other = site === 'ai' ? options.daemonPath : options.daemonIntlPath
  const attributed = clientsByRegion()
  if (site === 'ai' && attributed.cn !== undefined) {
    // A CN install exists, and no AI one was attributed: this is not an AI
    // client, and pretending otherwise sends the user to the wrong sign-in.
    return {
      path: undefined,
      source: 'missing',
      site,
      hint: '只检测到国内版 WorkBuddy。国际版是另一个产品，请从 workbuddy.ai 下载安装，或在插件配置里填写它的路径。'
    }
  }
  for (const candidate of workbuddyCandidates()) {
    if (!existsSync(candidate)) continue
    if (typeof other === 'string' && candidate.toLowerCase() === other.toLowerCase()) continue
    // The configured path is the CN client, so it must not satisfy an AI lookup.
    if (site === 'ai' && configuredUsable && candidate.toLowerCase() === configured.toLowerCase()) continue
    return { path: candidate, source: 'discovered', site }
  }
  return {
    path: undefined,
    source: 'missing',
    site,
    hint: site === 'ai'
      ? '尚未安装国际版 WorkBuddy。请从 workbuddy.ai 下载安装并登录，或在插件配置里填写路径。'
      : '尚未安装国内版 WorkBuddy。请从 workbuddy.cn 下载安装并登录，或在插件配置里填写路径。'
  }
}

/**
 * Resolve the WorkBuddy desktop client path.
 *
 * @param configured - the path stored in plugin configuration, when set.
 * @returns the first existing path, and where it came from.
 */
export function resolveWorkBuddyPath(configured) {
  if (typeof configured === 'string' && configured.length > 0 && existsSync(configured)) {
    return { path: configured, source: 'configured' }
  }
  for (const candidate of workbuddyCandidates()) {
    if (existsSync(candidate)) return { path: candidate, source: 'discovered' }
  }
  return { path: undefined, source: 'missing' }
}

/** The directories WorkBuddy and its extensions write credentials into. */
function credentialDirs(configured) {
  const home = homedir()
  const dirs = []
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local.length > 0) {
    dirs.push(join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'))
  }
  dirs.push(join(home, '.codebuddy', 'auth'))
  dirs.push(join(home, '.workbuddy', 'auth'))
  if (Array.isArray(configured)) {
    for (const dir of configured) {
      if (typeof dir === 'string' && dir.length > 0) dirs.push(dir)
    }
  }
  return dirs
}

/**
 * Scan for importable credential files and report each one's verdict.
 *
/**
 * Say what the user has to do, for one region.
 *
 * This exists because the two regions cannot be authorized the same way: an AI
 * client writes its token in the clear and the file can simply be imported,
 * while a CN client seals it and only a live capture can read it. Telling both
 * "点导入即可" would be wrong for CN; telling both "必须抓包" would be needless
 * work for AI.
 *
 * @param site - 'cn' or 'ai', or null when the domain was unrecognised.
 * @param importable - whether the file can be read offline.
 * @returns one sentence of next-step guidance, or null.
 */
export function credentialAction(site, importable) {
  if (importable === true) {
    return site === 'ai'
      ? '国际版凭据是明文，点「导入到号池」即可。'
      : '凭据是明文，点「导入到号池」即可。'
  }
  if (site === 'cn') {
    return '国内版客户端会加密凭据，文件读不到明文：只能在本机登录后用「抓取凭据」接入。'
  }
  if (site === 'ai') {
    return '国际版凭据通常可读；这个文件读不出来，可能是客户端正在写入，稍后重试或重新登录。'
  }
  return null
}

/**
 * A per-region summary of what authorization is possible right now.
 *
 * @param discovery - the `discoverCredentials` result.
 * @returns one entry per region, describing the route that actually works.
 */
export function authorizationPlan(discovery) {
  const forSite = (site) => discovery.files.filter((f) => f.site === site)
  const cn = forSite('cn')
  const ai = forSite('ai')
  return {
    cn: {
      site: 'cn',
      // Files exist but are sealed: the honest answer is "capture needed".
      fileImport: cn.some((f) => f.importable === true),
      captureRequired: cn.length > 0 && !cn.some((f) => f.importable === true),
      files: cn.length,
      route: cn.some((f) => f.importable === true)
        ? 'file'
        : cn.length > 0 ? 'capture' : 'signin'
    },
    ai: {
      site: 'ai',
      fileImport: ai.some((f) => f.importable === true),
      captureRequired: ai.length > 0 && !ai.some((f) => f.importable === true),
      files: ai.length,
      route: ai.some((f) => f.importable === true)
        ? 'file'
        : ai.length > 0 ? 'capture' : 'signin'
    }
  }
}

/**
 * A CN client seals its credential fields, so the file is present but not
 * readable offline. Saying so per file is the point: "nothing was found" and
 * "found, but sealed" need completely different user action.
 *
 * @param options - `dataDir` for the vault, and any extra `authDirs`.
 * @returns per-file findings and a summary.
 */
export function discoverCredentials(options = {}) {
  const files = []
  const seen = new Set()
  for (const dir of credentialDirs(options.authDirs)) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.info') && !name.endsWith('.json')) continue
      // Observation sidecars describe a session; they are not credentials.
      if (name.includes('.observation.')) continue
      const full = join(dir, name)
      if (seen.has(full)) continue
      seen.add(full)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (!stat.isFile()) continue

      let verdict
      try {
        const raw = JSON.parse(readFileSync(full, 'utf8'))
        const problem = diagnoseCredential(raw)
        const auth = raw.auth ?? raw
        const domain = String(auth.domain ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
        const site = siteOf(domain)
        verdict = problem === null
          ? { importable: true, reason: 'ok', message: '凭据为明文，可直接导入' }
          : { importable: false, reason: problem.reason, message: problem.message }
        verdict.site = site
        verdict.domain = domain
        // Per-region guidance: the two regions fail in different ways, so one
        // shared instruction would be wrong for one of them.
        verdict.action = credentialAction(site, problem === null)
      } catch (error) {
        verdict = {
          importable: false,
          reason: 'unreadable',
          message: `无法解析：${error instanceof Error ? error.message : String(error)}`,
          action: null
        }
      }
      files.push({
        name,
        path: full,
        modifiedAt: stat.mtimeMs,
        size: stat.size,
        ...verdict
      })
    }
  }
  // Restrict to one region when asked.
  //
  // Without this, "import this region" read every region's files and sent them
  // all to the importer: clicking it under 国内版 also rewrote the 国际版 account,
  // which is exactly the surprise this filter removes. Filtering happens here
  // rather than at the call site so every caller — page, tools, capture fallback
  // — gets the same scoping for free.
  const scopedTo = options.site === 'cn' || options.site === 'ai' ? options.site : undefined
  const scoped = scopedTo === undefined ? files : files.filter((f) => f.site === scopedTo)
  scoped.sort((a, b) => b.modifiedAt - a.modifiedAt)
  const importable = scoped.filter((f) => f.importable === true)
  const sealed = scoped.filter((f) => f.reason === 'encrypted_credential')
  // The summary describes the scoped set, not every file on disk: telling a user
  // "found 1 importable file" while filtering to a region with none would be the
  // same kind of false report this module exists to avoid.
  const regionName = scopedTo === undefined ? '' : scopedTo === 'ai' ? '国际版' : '国内版'
  return {
    files: scoped,
    scopedTo,
    importable: importable.length,
    sealed: sealed.length,
    summary: scoped.length === 0
      ? `${regionName}没有找到 WorkBuddy 凭据文件。请先打开并登录对应区域的 WorkBuddy 客户端。`
      : importable.length > 0
        ? `${regionName}找到 ${importable.length} 个可导入的凭据文件。`
        : sealed.length > 0
          ? `${regionName}找到 ${sealed.length} 个凭据文件，但都被客户端加密，无法离线读取。`
          : `${regionName}找到 ${scoped.length} 个文件，但都不含可用凭据。`
  }
}

/** Map a credential domain onto its region. */
function siteOf(domain) {
  const d = String(domain ?? '').toLowerCase()
  if (d.includes('codebuddy.ai') || d.includes('workbuddy.ai')) return 'ai'
  if (d.includes('copilot.tencent.com') || d.includes('workbuddy.cn') || d.includes('codebuddy.cn')) return 'cn'
  return undefined
}

/**
 * Import one credential file by path, without going through discovery.
 *
 * `importCredentials` only considers files it discovered in the standard
 * directories, which is right for "scan and import everything" but useless when
 * the caller already has one exact file — a captured token written to a temp
 * file, for instance. This sends that path straight to the daemon.
 *
 * The same caution applies as elsewhere: the daemon's reply is treated as a
 * claim, and the account count is the evidence.
 *
 * @param filePath - the credential file to import.
 * @param options - `dataDir` and cancellation.
 * @returns whether the pool grew, and the daemon's own report.
 */
export async function importCredentialFile(filePath, options = {}) {
  const read = readConfig(resolveDataDir(options.dataDir))
  if (!read.exists) {
    return { ok: false, error: `读取不到守护进程配置：${read.path}。` }
  }
  const config = { ...read.config, path: read.path }
  const before = await countAccounts(config, options.signal)
  const response = await adminRequest({
    adminBaseUrl: `http://127.0.0.1:${config.adminPort}`,
    adminKey: config.adminKey,
    path: '/admin/import',
    method: 'POST',
    body: { file: filePath },
    signal: options.signal
  })
  if (response.ok !== true) {
    return { ok: false, error: response.error }
  }
  const body = response.data ?? {}
  const after = await countAccounts(config, options.signal)
  const skipped = Array.isArray(body.skipped) ? body.skipped : []
  const added = Number(body.added ?? 0)
  const updated = Number(body.updated ?? 0)
  const grew = before !== null && after !== null && after > before

  // Nothing written is a failure, whether or not the daemon explained why.
  //
  // The daemon reports 200 with all counts at zero both when it had nothing to
  // do and when it decided an incoming credential was not newer than the stored
  // one — that "not newer" branch is a silent skip with no entry in `skipped`.
  // Treating every zero as success made a capture that changed nothing look
  // like it had been written, which is exactly the report the user got.
  if (added + updated === 0 && !grew) {
    const reason = skipped.length > 0
      ? skipped.map((s) => s.message ?? s.reason).join('；')
      : '守护进程没有写入任何账号。常见原因：这份凭据的过期时间不比号池里已有的更晚，被判定为「没有更新的凭据」而跳过。'
    return { ok: false, before, after, skipped, error: reason }
  }
  return { ok: true, added, updated, before, after, skipped }
}

/**
 * Whether an import changed nothing but also could not be improved.
 *
 * A capture that re-reads the *same* token the pool already holds legitimately
 * changes nothing. That is distinguishable from a failed write: the stored token
 * matches and the stored expiry is not older. Callers use this to report "already
 * up to date" instead of a failure, without weakening the failure path above.
 *
 * @param options - `dataDir`, `accountId`, and the captured token/expiry.
 * @returns whether the pool already holds exactly this credential.
 */
export function poolAlreadyHas(options = {}) {
  const vault = readVault(options.dataDir)
  if (vault.ok !== true) return false
  const account = (vault.accounts ?? []).find((a) => a && a.id === options.accountId)
  if (account === undefined) return false
  if (String(account.accessToken ?? '') !== String(options.accessToken ?? '')) return false
  if (account.removed === true) return false
  return true
}

/**
 * Import the importable credential files into the daemon account pool.
 *
 * The import is delegated to the daemon's own `/admin/import` route rather than
 * writing the encrypted vault from here: the daemon owns that file, caches it in
 * memory, and rewrites it on every save, so an outside write would be
 * overwritten on its next save.
 *
 * ## Why the reply is not trusted
 *
 * A daemon older than the "report skipped files" patch answers 200 with every
 * count at zero for a file it silently ignored — identical to "nothing to do".
 * Trusting that reply made a failed import look successful. So the account
 * count is measured before and after, and an all-zero reply with no growth and
 * no `skipped` detail is reported as a failure with its cause, not a success.
 *
 * @param options - `dataDir`, `authDirs`, and cancellation.
 * @returns the per-file outcomes, the observed account delta, and a summary.
 */
export async function importCredentials(options = {}) {
  const discovery = discoverCredentials(options)
  const importable = discovery.files.filter((f) => f.importable === true)
  if (importable.length === 0) {
    return {
      ok: false,
      imported: [],
      skipped: discovery.files.map((f) => ({ name: f.name, reason: f.reason, message: f.message })),
      error: explainNoImportable(discovery)
    }
  }

  const read = readConfig(resolveDataDir(options.dataDir))
  const config = { ...read.config, path: read.path, exists: read.exists, error: read.error }
  if (!read.exists) {
    return {
      ok: false,
      imported: [],
      skipped: [],
      error: `读取不到守护进程配置：${read.path}。请先确认守护进程正在运行。`
    }
  }

  const before = await countAccounts(config, options.signal)

  let added = 0
  let updated = 0
  const imported = []
  const failures = []
  for (const file of importable) {
    const response = await adminRequest({
      adminBaseUrl: `http://127.0.0.1:${config.adminPort}`,
      adminKey: config.adminKey,
      path: '/admin/import',
      method: 'POST',
      body: { file: file.path },
      signal: options.signal
    })
    if (response.ok !== true) {
      failures.push({ name: file.name, message: response.error })
      continue
    }
    const body = response.data ?? {}
    const skipped = Array.isArray(body.skipped) ? body.skipped : []
    added += Number(body.added ?? 0)
    updated += Number(body.updated ?? 0)
    imported.push({
      name: file.name,
      site: file.site,
      added: Number(body.added ?? 0),
      updated: Number(body.updated ?? 0),
      // A reply without `skipped` comes from a daemon that cannot say why it
      // ignored a file, which changes what the plugin may claim.
      detailed: body.skipped !== undefined,
      skipped
    })
  }

  // The reply is a claim; the account count is evidence.
  const after = await countAccounts(config, options.signal)
  const grew = before !== null && after !== null && after > before

  const sealed = discovery.files
    .filter((f) => f.reason === 'encrypted_credential')
    .map((f) => ({ name: f.name, reason: f.reason, message: f.message }))

  const daemonSkipped = imported.flatMap((f) => f.skipped)
  const result = {
    ok: failures.length === 0,
    added,
    updated,
    before,
    after,
    imported,
    skipped: [...sealed, ...daemonSkipped],
    ...(failures.length === 0 ? {} : {
      error: `${failures.length} 个文件导入失败：${failures.map((f) => `${f.name}（${f.message}）`).join('；')}`
    })
  }

  const silent = imported.length > 0
    && imported.every((f) => f.detailed === false)
    && added + updated === 0
    && !grew
  if (silent) {
    result.ok = false
    result.needsDaemonUpgrade = true
    result.error = explainSilentImport(sealed)
  }
  return result
}

/** Count the accounts the daemon currently holds, or null when unreadable. */
async function countAccounts(config, signal) {
  const response = await adminRequest({
    adminBaseUrl: `http://127.0.0.1:${config.adminPort}`,
    adminKey: config.adminKey,
    path: '/admin/status',
    signal
  })
  if (response.ok !== true) return null
  const accounts = response.data?.accounts
  return Array.isArray(accounts) ? accounts.length : null
}

/**
 * Say why nothing on this machine can be imported.
 *
 * The reasons need different fixes, so each gets its own sentence rather than a
 * shared "导入失败".
 *
 * @param discovery - the `discoverCredentials` result.
 */
function explainNoImportable(discovery) {
  const sealed = discovery.files.filter((f) => f.reason === 'encrypted_credential')
  if (sealed.length > 0 && discovery.importable === 0) {
    return '本机唯一的凭据文件被 WorkBuddy 加密存放，插件读不到明文。'
      + '中国版客户端把 accessToken 封装成 $wbEncrypted，密钥在其原生层生成，无法离线解开。'
      + '请用「授权账号」打开 WorkBuddy 登录后抓取请求接入，或先导出明文凭据。'
  }
  if (discovery.files.length === 0) {
    return '没有在本机找到任何 WorkBuddy 凭据文件。请先在 WorkBuddy 客户端登录，再回来点「扫描凭据」。'
  }
  return discovery.summary
}

/** Explain an all-zero reply from a daemon that reports no detail. */
function explainSilentImport(sealed) {
  const why = sealed.length > 0
    ? `本机的 ${sealed.length} 个凭据文件是加密的（$wbEncrypted），这类文件会被跳过，但旧版守护进程不说明原因。`
    : '守护进程没有说明任何跳过原因。'
  return '守护进程返回了全 0 结果，且没有报告跳过原因——这是旧版守护进程的行为，'
    + '它在打补丁之前会静默跳过无法读取的文件，因此看起来像「导入成功但账号没变」。'
    + why
    + '升级守护进程 到带「导入跳过」上报的版本后再试。'
}


/**
 * The full account overview: per-account verdicts and per-region counts.
 *
 * @param options - `dataDir` for the vault, `now` for a deterministic test clock.
 * @returns the overview the page and the agent both render.
 */
export function accountOverview(options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const vault = readVault(options.dataDir)
  // Run outcomes are this plugin's knowledge, not the vault's: the vault has no
  // field for "this account's quota is spent until 16:35", and it must not,
  // because it is shared with anything else that reads the file. They are read
  // from the health store and merged in so the page agrees with the pool.
  const health = options.health ?? readHealth(now)
  // Tombstones stay in the vault so a re-import cannot resurrect a deleted
  // account, but they are not accounts any more: hide them.
  const accounts = vault.accounts.filter((a) => a && a.removed !== true).map((a) => {
    const raw = health[a.id]
    const entry = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
    const merged = entry === null
      ? a
      : {
          ...a,
          ...(typeof entry.quotaResetAt === 'number' && entry.quotaResetAt > now
            ? { quotaResetAt: entry.quotaResetAt, cooldownUntil: Math.max(a.cooldownUntil ?? 0, entry.quotaResetAt) }
            : {}),
          ...(typeof entry.lastError === 'string' && entry.lastError.length > 0
            ? { lastError: entry.lastError }
            : {})
        }
    const verdict = accountStatus(merged, now)
    const warning = expiryWarning(merged, now)
    return {
      id: a.id,
      site: a.site,
      label: a.label ?? String(a.id).slice(0, 6),
      enabled: a.enabled !== false,
      authState: merged.authState ?? '未知',
      requests: a.requests ?? 0,
      successes: a.successes ?? 0,
      failures: a.failures ?? 0,
      expiresAt: a.expiresAt ?? 0,
      cooldownUntil: merged.cooldownUntil ?? 0,
      lastError: merged.lastError ?? '',
      // Whether the account can recover on its own. A captured CN token has no
      // refresh token, so once it lapses only the user can fix it.
      renewable: typeof a.refreshToken === 'string' && a.refreshToken.length > 0,
      ...verdict,
      ...(warning === null ? {} : { expiryWarning: warning.message, expirySeverity: warning.severity })
    }
  })
  const count = (site) => accounts.filter((a) => a.site === site && a.usable).length
  // An expiring token is a warning, not a failure: it is surfaced even while
  // every account still works, because that is the whole point of a warning.
  const warnings = accounts
    .filter((a) => typeof a.expiryWarning === 'string')
    .map((a) => ({ site: a.site, label: a.label, severity: a.expirySeverity, message: a.expiryWarning }))
  return {
    vaultOk: vault.ok,
    vaultReason: vault.reason,
    vaultError: vault.error,
    dataDir: resolveDataDir(options.dataDir),
    accounts,
    pools: { cn: count('cn'), ai: count('ai') },
    total: accounts.length,
    warnings,
    // A region with zero usable accounts is the condition worth acting on.
    needsAttention: accounts.some((a) => !a.usable)
      || (vault.ok && count('cn') === 0)
      || warnings.some((w) => w.severity === 'error')
  }
}
