/**
 * A scoped credential-capture session, for regions whose client seals its token.
 *
 * ## Why a capture exists at all
 *
 * A CN WorkBuddy client stores its credential behind `$wbEncrypted`, whose key is
 * produced by its own native layer and never touches disk. No amount of file
 * reading recovers it. The only reliable source is the request the client itself
 * sends, so this module stands up a local TLS-terminating proxy for exactly the
 * WorkBuddy hosts, reads the `authorization` header off that traffic, and tears
 * everything down again.
 *
 * ## What it deliberately does not do
 *
 * Only the WorkBuddy hosts are intercepted; every other CONNECT is tunnelled
 * untouched. The temporary CA is installed into the *current user* store and
 * removed when the session ends. Nothing is written to disk except the captured
 * credential, and the proxy never runs longer than the session's time limit.
 *
 * The user has to be told all of that before it starts, which is what the
 * `describe()` call is for.
 *
 * @module buddy-connect/capture
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { generateCaptureCertificates } from './cert-gen.js'
import { resolveStateDir } from './state-dir.js'

/** Hosts worth intercepting. Anything else is tunnelled. */
const INTERCEPT_HOSTS = new Set([
  'copilot.tencent.com',
  'www.workbuddy.cn',
  'workbuddy.cn',
  'api.workbuddy.cn'
])

/** Where generated certificates are cached between sessions. */
const USER_STATE_DIR = resolveStateDir({ create: true })

/** A capture session ends on its own rather than lingering. */
const SESSION_LIMIT_MS = 10 * 60 * 1000

/**
 * Describe what a capture session will do, so the page can ask for consent.
 *
 * @returns a plain-language list of the side effects.
 */
export function describeCapture() {
  return {
    intercepts: [...INTERCEPT_HOSTS],
    installsCa: '临时把本插件的根证书装入「当前用户」信任库，会话结束立即删除',
    proxyScope: '只拦截上面这些域名的流量，其他连接原样转发',
    sideEffects: [
      '需要暂时重启 WorkBuddy 客户端，让它走本地代理',
      '期间 WorkBuddy 的流量经过本机代理，不会离开这台电脑',
      '会话最长 10 分钟后自动结束'
    ]
  }
}

/**
 * A capture session, started in the background and polled by the page.
 *
 * Keeping the session here rather than inside one long request is what makes
 * "waiting for you" distinguishable from "hung": the page can ask for the
 * current stage at any moment, and can abort.
 */
export class CaptureSession {
  constructor() {
    this.state = { running: false, stage: 'idle', message: null, ok: null, error: null, written: null }
    this.abort = null
  }

  /** The state to show, without the token. */
  snapshot() {
    return { ...this.state }
  }

  /**
   * Start a session if one is not already running.
   *
   * @param options - `pluginDir` and `onCaptured` (imports the credential).
   * @returns the current state.
   */
  async start(options = {}) {
    if (this.state.running === true) return this.snapshot()
    this.state = { running: true, stage: 'starting', message: '正在准备抓包…', ok: null, error: null, written: null }
    const controller = new AbortController()
    this.abort = controller

    // Run detached: the caller returns immediately so the page can poll.
    void this.#run(options, controller).catch((error) => {
      this.state = {
        running: false,
        stage: 'failed',
        message: null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        written: null
      }
    })
    return this.snapshot()
  }

  async #run(options, controller) {
    const result = await runCapture({
      pluginDir: options.pluginDir,
      signal: controller.signal,
      onProgress: (progress) => {
        this.state = {
          ...this.state,
          stage: progress.stage,
          message: progress.message ?? null
        }
        options.onProgress?.(progress)
      }
    })
    if (result.ok !== true) {
      this.state = { running: false, stage: 'failed', message: null, ok: false, error: result.error, written: null }
      return
    }
    this.state = { ...this.state, stage: 'writing', message: '正在写入号池…' }
    const written = await options.onCaptured?.(result)
    this.state = {
      running: false,
      stage: 'done',
      message: null,
      ok: true,
      error: null,
      written: written ?? null
    }
  }

  /** Abort a running session; the run's own cleanup removes CA and proxy. */
  cancel() {
    if (this.state.running !== true) return this.snapshot()
    this.abort?.abort()
    this.state = { running: false, stage: 'cancelled', message: null, ok: false, error: '已取消抓取。', written: null }
    return this.snapshot()
  }
}

/**
 * Resolve the capture assets, generating the certificates on first use.
 *
 * The proxy script ships with the plugin, but the certificates do not: shipping
 * a CA private key would let anyone who downloads the package sign certificates
 * for those hostnames. They are generated on this machine, valid for one day,
 * and reused across sessions until they expire.
 *
 * If generation fails, the capture reports that clearly instead of pretending
 * it can proceed without a certificate.
 *
 * @param pluginDir - the plugin root directory.
 * @returns `{ dir, error }` — `dir` is null when nothing usable exists.
 */
function assetsOf(pluginDir, hostList) {
  const shipped = path.join(pluginDir, 'assets', 'capture')
  const proxy = path.join(shipped, 'proxy.mjs')
  if (!fs.existsSync(proxy)) {
    return { dir: null, error: '这个插件安装里没有抓包组件（assets/capture/proxy.mjs）。' }
  }

  const work = path.join(USER_STATE_DIR, 'capture')
  const needed = ['ca.crt', 'ca.key', 'leaf.crt', 'leaf.key']
  const haveAll = needed.every((n) => fs.existsSync(path.join(work, n)))

  if (!haveAll || certificatesExpired(work)) {
    try {
      generateCaptureCertificates({ dir: work, hosts: hostList, days: 1 })
    } catch (error) {
      return {
        dir: null,
        error: `无法在本机生成抓包证书：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { dir: work, proxy, error: null }
}

/** Whether the cached leaf certificate is missing or about to expire. */
function certificatesExpired(dir) {
  try {
    const pem = fs.readFileSync(path.join(dir, 'leaf.crt'), 'utf8')
    const cert = new crypto.X509Certificate(pem)
    // Regenerate a little early rather than mid-session.
    return new Date(cert.validTo).getTime() - Date.now() < 60 * 60 * 1000
  } catch {
    return true
  }
}

/**
 * Read a certificate file's SHA-1 thumbprint.
 *
 * `certutil -delstore` matches on the SHA-1 thumbprint, which is what the
 * certificate store displays. Node's `fingerprint256` is SHA-256 and will not
 * match — passing it silently fails to delete, which is how the first version
 * left a trusted CA behind after every session.
 *
 * @param caPath - the PEM file.
 * @returns the uppercase hex SHA-1 thumbprint, or null when unreadable.
 */
function thumbprintOf(caPath) {
  try {
    const der = new crypto.X509Certificate(fs.readFileSync(caPath, 'utf8')).raw
    return crypto.createHash('sha1').update(der).digest('hex').toUpperCase()
  } catch {
    return null
  }
}

/** Run certutil and return whether it succeeded. */function certutil(args) {
  return new Promise((resolve) => {
    try {
      const child = spawn('certutil', args, { windowsHide: true, stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

/**
 * Run one capture session: install the CA, start the proxy, wait for a
 * credential, then clean everything up.
 *
 * @param options - `pluginDir`, `onProgress`, `signal`, `expectedHosts`.
 * @returns `{ ok, token, headers }` or a structured failure.
 */
export async function runCapture(options = {}) {
  const assets = assetsOf(options.pluginDir, options.hosts)
  if (assets.dir === null) {
    return { ok: false, reason: 'no-assets', error: assets.error }
  }

  const caPath = path.join(assets.dir, 'ca.crt')
  const installed = await certutil(['-user', '-addstore', '-f', 'Root', caPath])
  if (!installed) {
    return {
      ok: false,
      reason: 'ca-install-failed',
      error: '无法把临时证书装入信任库（certutil 失败）。抓取需要这一步，请以管理员身份重试。'
    }
  }

  // Remember exactly which certificate was trusted, so removal targets that one
  // rather than a name a later session might reuse.
  const caThumbprint = thumbprintOf(caPath)

  // From here on every exit path must remove the CA, restore the proxy setting,
  // and stop the proxy. A capture that leaves a trusted certificate or a stale
  // proxy behind is worse than no capture at all.
  const cleanup = { proxy: null, caRemoved: false, proxyRestore: null }
  const removeCa = async () => {
    if (cleanup.caRemoved) return
    cleanup.caRemoved = true
    await certutil(['-user', '-delstore', 'Root', caThumbprint ?? 'Buddy Connect Capture CA'])
  }

  try {
    const port = await freePort()
    const proxy = spawn(process.execPath, [assets.proxy], {
      env: {
        ...process.env,
        CAP_PORT: String(port),
        CAP_CERT_DIR: assets.dir,
        CAP_OUT: path.join(os.tmpdir(), 'dsh-command-buddy-connect-capture.jsonl'),
        CAP_LOG: path.join(os.tmpdir(), 'dsh-command-buddy-connect-capture.log')
      },
      stdio: 'ignore',
      windowsHide: true
    })
    cleanup.proxy = proxy

    const ready = await waitForPort(port, 8000)
    if (!ready) {
      return { ok: false, reason: 'proxy-failed', error: '抓包代理没能启动。' }
    }

    // Starting the proxy is not enough: nothing routes through it unless the
    // client is told to. Without this the proxy sits idle and the session can
    // only time out — which is exactly how the first version failed.
    cleanup.proxyRestore = await pointSystemProxyAt(port)
    if (cleanup.proxyRestore === null) {
      return {
        ok: false,
        reason: 'proxy-not-applied',
        error: '无法把系统代理指向本地抓包端口，客户端流量不会经过抓包。请检查是否有安全软件禁止修改代理设置。'
      }
    }

    options.onProgress?.({
      stage: 'listening',
      port,
      message: `抓包已就绪（端口 ${port}，系统代理已指向它）。请**完全退出并重新打开** WorkBuddy，登录目标账号，然后发一条消息。`
    })

    const capture = await waitForCredential(port, options)
    if (capture === null) {
      // An abort is a user decision, not a failure to report as one.
      if (options.signal?.aborted === true) {
        return { ok: false, reason: 'cancelled', error: '已取消抓取。' }
      }
      return {
        ok: false,
        reason: 'timeout',
        error: '10 分钟内没有抓到凭据。最常见的原因是 WorkBuddy 没有重启——它只在启动时读取代理设置。'
      }
    }
    return { ok: true, ...capture }
  } finally {
    if (cleanup.proxy !== null) {
      try {
        cleanup.proxy.kill()
      } catch {
        // Already gone.
      }
    }
    // Restore the proxy setting even on failure, or every later request in the
    // machine keeps pointing at a port that no longer listens.
    if (cleanup.proxyRestore !== null) {
      await cleanup.proxyRestore()
    }
    await removeCa()
  }
}

/**
 * Point the current user's system proxy at the capture port.
 *
 * WorkBuddy is an Electron app: it reads the Windows proxy settings on start,
 * so a capture only sees traffic after the client has been restarted. This
 * records the previous setting first and returns a function that puts it back,
 * because leaving the machine pointed at a dead port would break every other
 * request until someone noticed.
 *
 * @param port - the capture proxy port.
 * @returns a restore function, or null when the registry could not be written.
 */
async function pointSystemProxyAt(port) {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  try {
    const before = await regQuery(key)
    const previous = {
      enable: before.ProxyEnable,
      server: before.ProxyServer
    }
    const set = await regAdd(key, [
      ['ProxyEnable', 'REG_DWORD', '1'],
      ['ProxyServer', 'REG_SZ', `127.0.0.1:${port}`],
      ['ProxyOverride', 'REG_SZ', '<local>']
    ])
    if (!set) return null
    return async () => {
      // Restore exactly what was there; an unset value stays unset.
      const restore = []
      if (previous.enable === undefined) {
        restore.push(['ProxyEnable', 'REG_DWORD', '0'])
      } else {
        restore.push(['ProxyEnable', 'REG_DWORD', String(previous.enable)])
      }
      if (previous.server !== undefined) {
        restore.push(['ProxyServer', 'REG_SZ', previous.server])
      }
      await regAdd(key, restore)
    }
  } catch {
    return null
  }
}

/** Read a registry key's values as a flat object. */
function regQuery(key) {
  return new Promise((resolve) => {
    const out = []
    let child
    try {
      child = spawn('reg', ['query', key], { windowsHide: true })
    } catch {
      resolve({})
      return
    }
    child.stdout?.on('data', (c) => out.push(c))
    child.on('error', () => resolve({}))
    child.on('exit', () => {
      const text = Buffer.concat(out).toString('utf8')
      const values = {}
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s+(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line)
        if (m === null) continue
        const name = m[1]
        const raw = m[3].trim()
        values[name] = m[2] === 'REG_DWORD' ? Number.parseInt(raw, 16) : raw
      }
      resolve(values)
    })
  })
}

/** Write several registry values, returning whether every write succeeded. */
function regAdd(key, entries) {
  return Promise.all(entries.map(([name, type, value]) => new Promise((resolve) => {
    let child
    try {
      child = spawn('reg', ['add', key, '/v', name, '/t', type, '/d', value, '/f'], { windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  }))).then((results) => results.every((ok) => ok === true))
}

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Poll until something accepts a connection on the port. */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

/**
 * Read one claim out of a JWT without trusting the signature.
 *
 * Only used to fill in metadata the daemon needs to match an account; the token
 * itself is stored verbatim and validated by the upstream on first use, so
 * nothing here needs to prove authenticity.
 *
 * @param token - the bearer token.
 * @param claim - the claim name.
 * @returns the claim as a string, or an empty string.
 */
function claimOf(token, claim) {
  const part = token.split('.')[1]
  if (typeof part !== 'string' || part.length === 0) return ''
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    const value = payload?.[claim]
    return value === undefined || value === null ? '' : String(value)
  } catch {
    return ''
  }
}

/**
 * The token's real expiry, in epoch milliseconds.
 *
 * Returns 0 when the token carries no usable `exp`, so the caller can fall back
 * to its own estimate instead of inventing a value that happens to be newer than
 * the stored credential — that is what made imports silently skip.
 *
 * @param token - the bearer token.
 * @returns epoch milliseconds, or 0.
 */
function expiryOf(token) {
  const raw = claimOf(token, 'exp')
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return seconds * 1000
}

/**
 * The account identity for a captured token.
 *
 * ## Why the token decides, not the headers
 *
 * The daemon derives an account id from `sha256(site:uid:enterpriseId)[:20]` and
 * matches an import against an existing account by that id. If the uid is wrong
 * the import lands on a *different* id, so instead of updating the account the
 * user just signed into, it creates an empty duplicate — which is what made a
 * successful capture look like "nothing happened".
 *
 * The capture used to read the uid from an `x-user-id` request header. Real CN
 * traffic does not send that header: the observed requests carry only
 * `authorization`, so the uid was empty, the derived id was `sha256("cn::")`, and
 * every capture produced the same useless duplicate.
 *
 * The token itself carries the identity, and its `sub` matches the vault's uid
 * exactly for all three accounts checked. So the token is the primary source,
 * with the header only as a fallback for a build that omits `sub`.
 *
 * @param token - the captured bearer token.
 * @param record - the capture record, for the header fallback.
 * @returns the uid, possibly empty when neither source has one.
 */
function identityOf(token, record) {
  for (const claim of ['sub', 'user_id', 'userId', 'uid', 'preferred_username']) {
    const value = claimOf(token, claim)
    if (value.length > 0) return value
  }
  return String(record?.headers?.['x-user-id'] ?? '').split(',')[0].trim()
}

/**
 * Watch the capture output for a credential belonging to the target region.
 *
 * @param port - the proxy port (unused; kept for messages).
 * @param options - `signal` and `wantedSite`.
 * @returns the credential, or null on timeout.
 */
async function waitForCredential(port, options) {
  const outPath = path.join(os.tmpdir(), 'dsh-command-buddy-connect-capture.jsonl')
  const deadline = Date.now() + SESSION_LIMIT_MS
  let offset = 0
  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) return null
    await new Promise((r) => setTimeout(r, 1000))
    let text
    try {
      text = fs.readFileSync(outPath, 'utf8')
    } catch {
      continue
    }
    if (text.length <= offset) continue
    const fresh = text.slice(offset)
    offset = text.length
    for (const line of fresh.split('\n')) {
      if (line.trim().length === 0) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const bearer = String(record?.headers?.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (bearer.length === 0) continue
      const domain = String(record?.headers?.['x-domain'] ?? record?.host ?? '')
      options.onProgress?.({ stage: 'captured', message: `已抓到 ${domain} 的凭据` })
      return {
        token: bearer,
        domain,
        uid: identityOf(bearer, record),
        enterpriseId: claimOf(bearer, 'enterprise_id'),
        // The daemon drops an import whose expiry is not later than the stored
        // one, so the real `exp` has to travel with the token. Inventing a
        // value here makes the import silently skip whenever the stored
        // credential happens to expire later than the invention.
        expiresAt: expiryOf(bearer),
        at: record?.at ?? new Date().toISOString()
      }
    }
  }
  return null
}
