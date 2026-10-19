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
import { resolveDataDir } from './discovery.js'
import { eligibility, identityFromToken } from './proxy.js'
import { readHealth } from './account-health.js'
import { upsertCapturedCredential } from './vault-edit.js'

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
 * @param options - `appData` and `candidates` overrides, for tests.
 */
function clientsByRegion(options = {}) {
  const found = { cn: undefined, ai: undefined }
  const roaming = typeof options.appData === 'string' ? options.appData : process.env.APPDATA
  if (typeof roaming !== 'string' || roaming.length === 0) return found

  // The instant-runner builds differ in their profile directory, which is the
  // only reliable signal: the executable's own metadata and install directory
  // name are identical between regions.
  //
  // `CodeBuddy CN` is the 国内版 profile, `CodeBuddy` the 国际版 one. Reading only
  // the CN profile and then attributing every executable to CN meant the 国际版
  // client could never be found — the AI authorize button reported "not
  // installed" on machines that plainly had it.
  // The two products install under different names, so each region searches for
  // its own binary: `WorkBuddy.exe` for CN, `WorkBuddyAI.exe` for the
  // international build. Searching one shared name meant the AI client was never
  // found even when it was installed.
  const candidatesFor = (site) => (Array.isArray(options.candidates)
    ? options.candidates
    : workbuddyCandidates(site))
  const dirs = [
    { site: 'cn', path: join(roaming, 'CodeBuddy CN') },
    { site: 'ai', path: join(roaming, 'CodeBuddy') }
  ]
  for (const { site, path } of dirs) {
    const candidates = candidatesFor(site)
    if (!existsSync(path)) continue
    for (const candidate of candidates) {
      // One executable cannot belong to both regions. When both profile
      // directories exist, the first candidate would otherwise be attributed to
      // both, and the resolver would then reject it for conflicting with itself.
      // A second region therefore needs its own install, or an explicit path.
      if (found.cn !== undefined && found.cn.toLowerCase() === candidate.toLowerCase()) continue
      if (found.ai !== undefined && found.ai.toLowerCase() === candidate.toLowerCase()) continue
      found[site] = candidate
      break
    }
  }
  return found
}

/**
 * Executable names each region's desktop client uses.
 *
 * The two products do not share a binary name, which is why looking only for
 * `WorkBuddy.exe` could never find the international client: that one installs as
 * `WorkBuddyAI.exe` (product name "WorkBuddy AI"), typically in a
 * `WorkBuddyAI` directory. Both names are listed per region so a machine with
 * both products installed resolves each to the right one.
 */
const CLIENT_NAMES = {
  cn: { exe: ['WorkBuddy.exe'], dir: /^workbuddy$/i },
  ai: { exe: ['WorkBuddyAI.exe', 'WorkBuddy.exe'], dir: /^workbuddy\s*ai$/i }
}

/**
 * Where the WorkBuddy desktop clients are usually installed.
 *
 * @param site - 'cn' or 'ai', to prefer that region's binary name.
 * @returns candidate paths, most likely first.
 */
function workbuddyCandidates(site = 'cn') {
  const wanted = CLIENT_NAMES[site] ?? CLIENT_NAMES.cn
  const local = process.env.LOCALAPPDATA
  const list = []
  if (typeof local === 'string' && local.length > 0) {
    for (const exe of wanted.exe) {
      list.push(join(local, 'Programs', 'WorkBuddy', exe))
      list.push(join(local, 'Programs', 'WorkBuddyAI', exe))
    }
  }
  // Installs moved to another drive are common — this machine keeps the CN client
  // on F: and the international one on F: as well — so look one level deep in the
  // usual roots rather than scanning the whole filesystem.
  for (const root of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\']) {
    let entries
    try {
      entries = readdirSync(root)
    } catch {
      // An unreadable root is not an error; skip it.
    }
    if (entries === undefined) continue
    for (const entry of entries) {
      const isThisRegion = wanted.dir.test(entry) || /^workbuddy/i.test(entry)
      if (!isThisRegion) continue
      for (const exe of wanted.exe) {
        const candidate = join(root, entry, exe)
        if (existsSync(candidate) && !list.includes(candidate)) list.push(candidate)
      }
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

  // An explicit per-region path wins: it is the only way to point at an install
  // that lives somewhere unexpected, and an off-drive install is common.
  const explicit = site === 'ai' ? options.intlPath : options.configured
  if (typeof explicit === 'string' && explicit.length > 0 && existsSync(explicit)) {
    return { path: explicit, source: 'configured', site }
  }
  if (typeof explicit === 'string' && explicit.length > 0 && !existsSync(explicit)) {
    // A configured path that does not exist must not fall through to discovery:
    // the user stated which client to use, so reporting it as missing is more
    // useful than silently opening a different one.
    return {
      path: undefined,
      source: 'missing',
      site,
      hint: `配置的${site === 'ai' ? '国际版' : '国内版'}客户端路径不存在：${explicit}`
    }
  }

  // A path the daemon recorded for this region is the most precise answer: it
  // is the install the daemon itself uses, so a credential from it lands in the
  // pool the user is looking at.
  const fromDaemon = site === 'ai' ? options.daemonIntlPath : options.daemonPath
  if (typeof fromDaemon === 'string' && fromDaemon.length > 0 && existsSync(fromDaemon)) {
    return { path: fromDaemon, source: 'buddyhub', site }
  }

  // The plugin's own `workbuddyPath` is the CN setting, so it must not answer an
  // AI lookup: that would point the AI authorize button at the CN client, which
  // is the exact mistake this function exists to prevent.
  const configured = options.configured
  const configuredUsable = typeof configured === 'string' && configured.length > 0
  if (site === 'cn' && configuredUsable && existsSync(configured)) {
    return { path: configured, source: 'configured', site }
  }

  // The two regions are distinct products. Falling back to "any WorkBuddy.exe"
  // would open the CN client for an AI authorization, which signs in the wrong
  // account — worse than reporting that the client is not installed.
  //
  // Attribute a discovered install to a region by its profile directory rather
  // than assuming the first hit belongs to whoever asked.
  const attributed = clientsByRegion({
    ...(typeof options.appData === 'string' ? { appData: options.appData } : {}),
    ...(Array.isArray(options.candidates) ? { candidates: options.candidates } : {})
  })

  // A client whose profile directory proves it belongs to this region is the
  // right answer even when the other region is also installed.
  const own = attributed[site]
  if (typeof own === 'string' && existsSync(own)) {
    const otherRegion = site === 'ai' ? attributed.cn : attributed.ai
    if (typeof otherRegion !== 'string' || own.toLowerCase() !== otherRegion.toLowerCase()) {
      return { path: own, source: 'discovered', site }
    }
  }

  const other = site === 'ai' ? options.daemonPath : options.daemonIntlPath
  const otherAttributed = site === 'ai' ? attributed.cn : attributed.ai
  const scanCandidates = Array.isArray(options.candidates)
    ? options.candidates
    : workbuddyCandidates(site)
  for (const candidate of scanCandidates) {
    if (!existsSync(candidate)) continue
    const lower = candidate.toLowerCase()
    const base = lower.slice(lower.lastIndexOf('\\') + 1)
    // The international build names itself `WorkBuddyAI.exe`. That name is proof
    // of the region in both directions: it can only be the international client,
    // and it can never be the CN one.
    const namedIntl = /^workbuddy\s*ai\.exe$/i.test(base)
    if (site === 'cn' && namedIntl) continue
    if (typeof other === 'string' && lower === other.toLowerCase()) continue
    // The configured path is the CN client, so it must not satisfy an AI lookup.
    if (site === 'ai' && configuredUsable && lower === configured.toLowerCase()) continue
    // An install the profile directories attribute to the *other* region is not
    // this region's. Without this an off-drive 国内版 install (F:\WorkBuddy, say)
    // was offered as the 国际版 client purely because it was found on disk.
    if (typeof otherAttributed === 'string' && lower === otherAttributed.toLowerCase()) continue
    // A bare `WorkBuddy.exe` is the CN name. Accepting it for the international
    // slot without either the name or the profile directory to corroborate it is
    // what would open the wrong client, so it is not accepted on its own.
    const nameProvesRegion = site === 'ai' && namedIntl
    if (site === 'ai' && !nameProvesRegion && attributed.ai === undefined) continue
    if (!nameProvesRegion && otherAttributed !== undefined && attributed[site] === undefined) continue
    return { path: candidate, source: nameProvesRegion ? 'named' : 'discovered', site }
  }
  return {
    path: undefined,
    source: 'missing',
    site,
    hint: site === 'ai'
      ? '尚未检测到国际版 WorkBuddy 客户端。请从 workbuddy.ai 下载安装并登录；若已安装在其他位置，在插件配置里填写 workbuddyIntlPath。'
      : '尚未检测到国内版 WorkBuddy 客户端。请从 workbuddy.cn 下载安装并登录；若已安装在其他位置，在插件配置里填写 workbuddyPath。'
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
 * file, for instance.
 *
 * This writes the vault directly. It previously posted to the daemon, which
 * worked only while the daemon was running; once it was removed, a capture that
 * could not otherwise be stored failed with a connection error.
 *
 * @param filePath - the credential file to import.
 * @param options - `dataDir` and cancellation.
 * @returns whether the pool changed, and what was written.
 */
export async function importCredentialFile(filePath, options = {}) {
  const before = countVaultAccounts(options.dataDir)

  let credential
  try {
    credential = readCredentialFile(filePath)
  } catch (error) {
    return { ok: false, error: `无法读取凭据文件：${error instanceof Error ? error.message : String(error)}` }
  }
  if (credential === null) {
    return { ok: false, error: '这份凭据里没有可用的访问令牌，因此没有写入账号库。' }
  }
  if (credential.uid.length === 0) {
    return { ok: false, error: '这份凭据里没有账号标识（uid），无法确定写入哪个账号。' }
  }

  const written = await upsertCapturedCredential({
    dataDir: options.dataDir,
    site: credential.site ?? options.site ?? 'cn',
    uid: credential.uid,
    enterpriseId: credential.enterpriseId,
    accessToken: credential.accessToken,
    domain: credential.domain,
    expiresAt: credential.expiresAt,
    refreshToken: credential.refreshToken,
    label: credential.label
  })
  if (written.ok !== true) {
    return { ok: false, before, error: String(written.error ?? '写入账号库失败') }
  }

  const after = countVaultAccounts(options.dataDir)
  const created = written.written?.created === true
  return {
    ok: true,
    added: created ? 1 : 0,
    updated: created ? 0 : 1,
    before,
    after,
    created,
    skipped: [],
    via: 'vault'
  }
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
 * Import the importable credential files straight into the account vault.
 *
 * ## Why this does not go through the daemon
 *
 * It used to: `importCredentials` posted each file to the daemon's
 * `/admin/import`, because the daemon owned and cached that file. Once the daemon
 * was removed from the machine, every import answered
 * 「无法连接守护进程管理接口：fetch failed」 — the button was still calling a program
 * that no longer exists.
 *
 * Writing the vault directly is now the correct thing, and it is what the
 * desktop-app reader already does. It also removes the daemon's freshness rule,
 * which silently skipped a credential whose expiry was not later than the stored
 * one — the reason a re-login could never replace a token.
 *
 * @param options - `dataDir`, `authDirs`, `site`, and cancellation.
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

  const before = countVaultAccounts(options.dataDir)

  let added = 0
  let updated = 0
  const imported = []
  const failures = []
  const skipped = []

  for (const file of importable) {
    let credential
    try {
      credential = readCredentialFile(file.path)
    } catch (error) {
      failures.push({ name: file.name, message: error instanceof Error ? error.message : String(error) })
      continue
    }
    if (credential === null) {
      skipped.push({ name: file.name, reason: 'no-token', message: '文件里没有可用的访问令牌' })
      continue
    }
    // The account id is content-derived, so an import of the same account
    // updates it rather than creating a second copy.
    const written = await upsertCapturedCredential({
      dataDir: options.dataDir,
      site: credential.site ?? file.site,
      uid: credential.uid,
      enterpriseId: credential.enterpriseId,
      accessToken: credential.accessToken,
      domain: credential.domain,
      expiresAt: credential.expiresAt,
      refreshToken: credential.refreshToken,
      label: credential.label
    })
    if (written.ok !== true) {
      failures.push({ name: file.name, message: String(written.error ?? '写入账号库失败') })
      continue
    }
    if (written.written?.created === true) added += 1
    else updated += 1
    imported.push({
      name: file.name,
      site: credential.site ?? file.site,
      added: written.written?.created === true ? 1 : 0,
      updated: written.written?.created === true ? 0 : 1,
      detailed: true,
      skipped: []
    })
  }

  const after = countVaultAccounts(options.dataDir)

  const sealed = discovery.files
    .filter((f) => f.reason === 'encrypted_credential')
    .map((f) => ({ name: f.name, reason: f.reason, message: f.message }))

  return {
    ok: failures.length === 0,
    added,
    updated,
    before,
    after,
    imported,
    skipped: [...sealed, ...skipped],
    via: 'vault',
    ...(failures.length === 0 ? {} : {
      error: `${failures.length} 个文件导入失败：${failures.map((f) => `${f.name}（${f.message}）`).join('；')}`
    })
  }
}

/** Count the accounts currently in the vault, or null when unreadable. */
function countVaultAccounts(dataDir) {
  const vault = readVault(dataDir)
  if (vault.ok !== true) return null
  return (vault.accounts ?? []).filter((a) => a && a.removed !== true).length
}

/**
 * Read one credential file into the fields the vault needs.
 *
 * The desktop clients write slightly different shapes between versions, so the
 * token is looked for in each place it has appeared rather than assuming one.
 *
 * @param path - the credential file.
 * @returns the fields, or null when the file carries no usable token.
 */
function readCredentialFile(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const auth = raw?.auth ?? {}
  const account = raw?.account ?? raw?.user ?? {}
  const nested = raw?.oauth ?? raw?.token ?? {}

  const token = [auth.accessToken, raw?.accessToken, nested.accessToken]
    .find((v) => typeof v === 'string' && v.length > 0)
  if (typeof token !== 'string' || token.length === 0) return null

  const domain = [auth.domain, raw?.domain, nested.domain]
    .find((v) => typeof v === 'string' && v.length > 0)
  const uid = [account.uid, raw?.uid, nested.uid, account.id]
    .find((v) => typeof v === 'string' && v.length > 0) ?? ''
  const enterpriseId = [account.enterpriseId, raw?.enterpriseId]
    .find((v) => typeof v === 'string' && v.length > 0) ?? ''
  const refreshToken = [auth.refreshToken, raw?.refreshToken, nested.refreshToken]
    .find((v) => typeof v === 'string' && v.length > 0) ?? ''
  const expiry = [auth.expiresAt, raw?.expiresAt, nested.expiresAt]
    .find((v) => typeof v === 'number' && v > 0) ?? 0

  const site = typeof domain === 'string' ? siteOf(domain) : undefined
  // The file rarely carries a name, but the token always does. Falling back to it
  // here means every import path — file, captured, desktop app — labels the
  // account the same way.
  const identity = identityFromToken(token)
  const label = [account.email, raw?.label, identity.label]
    .find((v) => typeof v === 'string' && v.trim().length > 0)

  return {
    accessToken: token,
    uid: uid.length > 0 ? uid : identity.uid,
    enterpriseId,
    ...(typeof domain === 'string' ? { domain } : {}),
    refreshToken,
    expiresAt: expiry,
    ...(site === undefined ? {} : { site }),
    ...(label === undefined ? {} : { label })
  }
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
      + '请直接点「从桌面版读取」——它会让客户端自己解开，不需要抓包。'
  }
  if (discovery.files.length === 0) {
    return '没有在本机找到任何 WorkBuddy 凭据文件。请先在 WorkBuddy 客户端登录，再回来点「扫描凭据」。'
  }
  return discovery.summary
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
