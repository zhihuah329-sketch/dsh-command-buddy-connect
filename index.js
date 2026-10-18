/**
 * dsh-command-buddy-connect — WorkBuddy check-in, plus local region pools served
 * either by the local daemon or entirely inside this process.
 *
 * Opening DSH performs the day's WorkBuddy check-in, repeats it while DSH runs
 * so a session left open rolls into the new day, and reports the result on the
 * plugin's own page in the Web GUI.
 *
 * ## Two model routes, on purpose
 *
 * - `buddyhub` (from `lib/adapter.js`) calls the local daemon's
 *   OpenAI-compatible proxy. That is the right route when the product is
 *   installed and running, because the daemon owns token refresh, rotation, and
 *   its own check-in scheduler.
 * - `buddy-connect` (from `lib/local-adapter.js`) needs no daemon: it reads the
 *   same encrypted account vault and applies the same routing rules in-process.
 *   This is what makes the pools usable when the daemon is not running, and it
 *   is where the reverse-proxy semantics live: region isolation,
 *   least-in-flight rotation, account-scoped conversation ids,
 *   rotate-only-on-retryable errors, and SSE normalisation.
 *
 * Both can be enabled together: they are separate providers, so the model
 * picker shows which implementation served a call.
 *
 * ## Why the check-in does not go through the daemon
 *
 * An earlier version delegated check-in to the daemon, which made the plugin do
 * nothing at all wherever the daemon was absent. Check-in now calls WorkBuddy's
 * billing API directly, reusing the credential reader in `lib/workbuddy.js`.
 *
 * ## Shape
 *
 * - `lib/workbuddy.js` — credential access and the billing endpoints.
 * - `lib/scheduler.js` — when to check, and the status snapshot.
 * - `lib/vault.js` — read (never write) the daemon's encrypted account vault.
 * - `lib/proxy.js` — the reverse-proxy rules, pure and unit-tested.
 * - `lib/local-adapter.js` — serves `buddy-connect` from the vault.
 * - `lib/adapter.js` + `lib/discovery.js` — the `buddyhub` daemon provider.
 * - `lib/pool-tools.js` — pool health and import diagnostics.
 * - `client.js` — the status card rendered on the plugin page.
 *
 * @module buddy-connect
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaemonAdapter, PROVIDER_ID, PROVIDER_NAME } from './lib/adapter.js'
import { LocalPoolAdapter, LOCAL_PROVIDER_ID, LOCAL_PROVIDER_NAME } from './lib/local-adapter.js'
import { CheckinScheduler, nextOccurrence } from './lib/scheduler.js'
import { CheckinPrefs } from './lib/checkin-prefs.js'
import { removeAccount, updateAccountCredential } from './lib/vault-edit.js'
import { daemonTools } from './lib/tools.js'
import { poolTools } from './lib/pool-tools.js'
import { accountOverview, authorizationPlan, discoverCredentials, importCredentialFile, importCredentials, resolveClientForSite, resolveWorkBuddyPath } from './lib/account-status.js'
import { CaptureSession, describeCapture, runCapture } from './lib/capture.js'
import { CommandCodeAdapter, CC_PROVIDER_ID, CC_PROVIDER_NAME } from './lib/cc-adapter.js'
import { RouteSwitches } from './lib/router-state.js'
import { readConfig, resolveDataDir } from './lib/discovery.js'
import {
  maskKey,
  readCommandCodeKey,
  testCommandCodeKey,
  validateKeyShape,
  writeCommandCodeKey
} from './lib/cc-credentials.js'

/** The installed plugin directory, used to find the capture assets. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** Cordis plugin name. */
export const name = 'dsh-command-buddy-connect'

/**
 * Services this plugin needs. `webServer` carries the status route the UI
 * reads; `tools` publishes state to the agent; `timer` drives the recurring
 * check; `llm` registers the model providers.
 *
 * `attachments` is deliberately *not* listed: it is only needed to turn an
 * image reference into request bytes, and requiring it would make the whole
 * plugin unloadable in a composition that lacks it. It is fetched optionally at
 * mount, and its absence degrades image input to text rather than taking the
 * panel down with it.
 */
export const inject = ['webServer', 'tools', 'timer', 'llm']

/** Path the status card and the tools read. */
const STATUS_PATH = '/api/dsh-command-buddy-connect/status'

/** Plugin configuration. */
export const Config = z.object({
  autoCheckin: z.boolean()
    .default(true)
    .description('Perform the WorkBuddy check-in automatically while DSH runs.'),
  checkinTime: z.string()
    .default('09:00')
    .description('CN-time HH:mm boundary reported as the next scheduled check-in.'),
  intervalMinutes: z.natural()
    .default(30)
    .description('Minutes between automatic checks while DSH is running.'),
  enableTools: z.boolean()
    .default(true)
    .description('Publish the buddy_* tools to the agent.'),
  enableProvider: z.boolean()
    .default(true)
    .description('Register the local daemon as a model provider when it is runntalled.'),
  enableLocalPool: z.boolean()
    .default(true)
    .description('Serve the region pools from the account vault directly, without needing the 本地守护进程.'),
  enableCommandCode: z.boolean()
    .default(true)
    .description('Offer Command Code as a provider. The API key is entered on the plugin page, not here.'),
  commandCodeApiBase: z.string()
    .default('https://api.commandcode.ai')
    .description('Command Code API base URL. Change only for a staging endpoint.'),
  dataDir: z.string()
    .description('守护进程数据目录。留空则依次使用 BUDDYHUB_DATA、%USERPROFILE%\\.buddyhub.'),
  workbuddyPath: z.string()
    .description('Path to the WorkBuddy desktop client, used by the "authorize account" button. Leave unset to use the vendor default, then a search of the usual install roots.'),
  authDirs: z.array(z.string())
    .default([])
    .description('Extra directories to scan for WorkBuddy credential files when authorizing an account.'),
  contextWindow: z.natural()
    .default(1_000_000)
    .description('Context window advertised for the daemon models.')
})

/**
 * Register the check-in scheduler, its status route, the agent tools, and the
 * optional daemon model provider.
 *
 * @param ctx - the plugin context.
 * @param config - the validated deployment configuration.
 */
export function apply(ctx, config) {
  // Per-account check-in opt-out. Kept separate from the vault's own `enabled`
  // flag, which means "may serve model calls" — sharing it would force a user
  // to disable an account entirely just to stop auto-claiming its reward.
  const checkinPrefs = new CheckinPrefs({ logger: ctx.logger })

  const scheduler = new CheckinScheduler({
    enabled: config.autoCheckin !== false,
    intervalMs: (config.intervalMinutes ?? 30) * 60 * 1000,
    logger: ctx.logger,
    prefs: checkinPrefs,
    // Check-in prefers the CN account already imported into the daemon, which
    // needs no other plugin and no Electron binary.
    dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined,
    // Every CN account in the pool is visited, not just the first one. AI is
    // excluded because its billing endpoint rejects these calls with 401.
    sites: ['cn']
  })

  ctx.effect(
    () => scheduler.start({
      // `timeout` fires once; `interval` repeats. The recurring check must use
      // `interval`, or a long-running session would never roll into the next day.
      once: (fn, ms) => ctx.timer.timeout(fn, ms),
      every: (fn, ms) => ctx.timer.interval(fn, ms)
    }),
    'dsh-command-buddy-connect: check-in schedule'
  )

  const dataDir = config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined

  // Optional: without it, images degrade to text instead of failing the call.
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    ctx.logger.info('dsh-command-buddy-connect: 没有 attachments 服务，图片输入将按文本处理')
  }
  // The two clients the daemon recorded. Read once at mount: these are install
  // paths that do not change while DSH runs, and reading them per request would
  // mean touching the daemon's config on every page poll.
  const daemonClients = readDaemonConfig()

  // One capture at a time: a second session would install a second CA and could
  // leave one behind if the first is still unwinding.
  const captureSession = new CaptureSession()

  // The switches decide whether a route answers calls, and they are consulted
  // per call rather than at mount time. Unregistering an `llm` adapter would
  // require remounting the plugin, so a switch that works instantly has to be
  // enforced at dispatch instead.
  //
  // CN and AI have one switch each: the pools never share accounts, so a single
  // provider-level switch would make turning off one region disable the other.
  const switches = new RouteSwitches({
    cn: config.enableLocalPool !== false,
    ai: config.enableLocalPool !== false,
    [PROVIDER_ID]: config.enableProvider !== false,
    [CC_PROVIDER_ID]: config.enableCommandCode !== false
  }, ctx.logger)

  // The local pool is constructed before the status route so that route can
  // report its state alongside the check-in result.
  let localPool
  if (config.enableLocalPool !== false) {
    localPool = new LocalPoolAdapter({
      dataDir,
      contextWindow: config.contextWindow,
      logger: ctx.logger,
      // Takes the region, because one adapter serves both pools.
      isEnabled: (site) => switches.get(site === 'ai' ? 'ai' : 'cn'),
      attachments
    })
    ctx.effect(
      () => ctx.llm.registerAdapter([LOCAL_PROVIDER_ID], localPool),
      'dsh-command-buddy-connect: local pool provider registration'
    )
    ctx.logger.info(`dsh-command-buddy-connect: registered provider "${LOCAL_PROVIDER_ID}" (${LOCAL_PROVIDER_NAME})`)
  }

  // Command Code's key belongs to the user, not to the deployment: it is read
  // from this plugin's own state directory, where the page writes it. Plugin
  // config only supplies an endpoint override, so no install ships a key.
  const ccApiKey = readCommandCodeKey()
  let commandCode
  if (ccApiKey !== undefined) {
    commandCode = new CommandCodeAdapter({
      apiKey: ccApiKey,
      apiBase: config.commandCodeApiBase,
      contextWindow: config.contextWindow,
      logger: ctx.logger,
      isEnabled: () => switches.get(CC_PROVIDER_ID)
    })
    ctx.effect(
      () => ctx.llm.registerAdapter([CC_PROVIDER_ID], commandCode),
      'dsh-command-buddy-connect: command code provider registration'
    )
    ctx.logger.info(`dsh-command-buddy-connect: registered provider "${CC_PROVIDER_ID}" (${CC_PROVIDER_NAME})`)
  } else {
    ctx.logger.info('dsh-command-buddy-connect: Command Code 未配置 API Key，请在插件页面填写后自动接入')
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      const send = (status, payload) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store'
        })
        res.end(JSON.stringify(payload))
      }
      try {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (body?.action === 'checkin') await scheduler.run({ force: true })
          else if (body?.action === 'refresh') await scheduler.run()
          else if (body?.action === 'checkin-prefs') {
            // Which accounts take part in the daily run. This is separate from
            // the vault's own `enabled` flag, which governs model calls.
            if (body?.all === true) {
              const vault = readVault(config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined)
              const ids = vault.ok === true ? vault.accounts.map((a) => a.id) : []
              checkinPrefs.setAll(ids, body.enabled !== false)
            } else {
              if (typeof body?.id !== 'string' || body.id.length === 0) {
                return send(400, { ...scheduler.snapshot(), error: '缺少账号 id。' })
              }
              checkinPrefs.set(body.id, body.enabled !== false)
            }
          } else if (body?.action === 'account-remove') {
            // The daemon's admin API cannot delete an account, so the plugin
            // writes the vault itself: stop the daemon, back up, write, restart.
            const result = await removeAccount({
              dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined,
              accountId: body?.id
            })
            if (result.ok === true) {
              // A removed account must not linger in the check-in preference
              // file either.
              checkinPrefs.set(body.id, true)
              ctx.logger.info(`dsh-command-buddy-connect: 已删除账号 ${result.removed?.label ?? body.id}`)
            }
            return send(result.ok === true ? 200 : 400, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              accounts: accountOverview({
                dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
              }),
              accountEdit: result
            })
          } else if (body?.action === 'account-refresh') {
            // Replace one account's token without touching anything else about
            // it. Used when a credential was re-captured or re-exported.
            const result = await updateAccountCredential({
              dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined,
              accountId: body?.id,
              accessToken: body?.accessToken,
              uid: body?.uid,
              domain: body?.domain,
              expiresAt: body?.expiresAt,
              refreshToken: body?.refreshToken
            })
            if (result.ok === true) {
              ctx.logger.info(`dsh-command-buddy-connect: 已刷新账号 ${result.updated?.label ?? body.id} 的凭据`)
            }
            return send(result.ok === true ? 200 : 400, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              accounts: accountOverview({
                dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
              }),
              accountEdit: result
            })
          } else if (body?.action === 'authorize') {
            // Authorization is per region: the two clients are separate
            // installs, and opening the CN client to authorize an AI account
            // would show the wrong sign-in screen.
            const site = body?.site === 'ai' ? 'ai' : 'cn'
            const opened = await openWorkBuddyForSite(site, config.workbuddyPath)
            return send(opened.ok ? 200 : 400, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              authorize: opened
            })
          } else if (body?.action === 'capture-describe') {
            // Consent comes first: the page must be able to state exactly what
            // a capture installs and intercepts before the user agrees to it.
            return send(200, { ...scheduler.snapshot(), capture: describeCapture() })
          } else if (body?.action === 'capture-start') {
            // Non-blocking on purpose. A capture waits for the user to restart
            // the client and sign in, which can take minutes; holding one HTTP
            // request open for that gave the page no way to show progress or
            // offer cancel. The session runs in the background instead.
            const state = await captureSession.start({
              pluginDir: PLUGIN_DIR,
              onProgress: (p) => ctx.logger.info(`dsh-command-buddy-connect: ${p.message ?? p.stage}`),
              onCaptured: (result) => writeCapturedCredential(result, config)
            })
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              captureState: state
            })
          } else if (body?.action === 'capture-cancel') {
            const state = captureSession.cancel()
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              captureState: state
            })
          } else if (body?.action === 'capture') {
            // Kept for compatibility: run one capture to completion. The UI no
            // longer uses it, but a script that calls it still works.
            const result = await runCapture({
              pluginDir: PLUGIN_DIR,
              onProgress: (p) => ctx.logger.info(`dsh-command-buddy-connect: ${p.message ?? p.stage}`)
            })
            if (result.ok !== true) {
              return send(200, {
                ...scheduler.snapshot(),
                ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
                captureResult: result
              })
            }
            // Persist through the daemon's own import route so the new
            // account appears in the same pool the page shows.
            const written = await writeCapturedCredential(result, config)
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              accounts: accountOverview({
                dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
              }),
              captureResult: { ...result, token: undefined, written }
            })
          } else if (body?.action === 'discover') {
            const discovery = discoverCredentials({
              authDirs: config.authDirs,
              dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
            })
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              discovery: {
                ...discovery,
                plan: authorizationPlan(discovery)
              }
            })
          } else if (body?.action === 'toggle') {
            // Live switch: the adapters read it per call, so no remount and no
            // restart is needed. The value is persisted so it survives one.
            const id = String(body.route ?? '')
            const value = body.enabled === true
            try {
              await switches.set(id, value)
            } catch (error) {
              return send(500, {
                ...scheduler.snapshot(),
                error: `无法保存线路开关：${error instanceof Error ? error.message : String(error)}`
              })
            }
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              accounts: accountOverview({
                dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
              }),
              workbuddy: resolveWorkBuddyPath(config.workbuddyPath),
              routes: routeStates(config, {
                localPool,
                switches,
                commandCodeRegistered: commandCode !== undefined
              })
            })
          } else if (body?.action === 'cc-key') {
            // Save (or clear) the user's Command Code key. The response never
            // echoes the key: the page only ever sees a masked form.
            const submitted = typeof body.apiKey === 'string' ? body.apiKey : ''
            if (body.clear === true || submitted.trim().length === 0) {
              writeCommandCodeKey('')
              return send(200, {
                ...scheduler.snapshot(),
                ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
                commandCode: { configured: false, cleared: true, message: '已清除 API Key。' }
              })
            }
            const shapeError = validateKeyShape(submitted)
            if (shapeError !== null) {
              return send(400, {
                ...scheduler.snapshot(),
                error: shapeError,
                commandCode: { configured: readCommandCodeKey() !== undefined, message: shapeError }
              })
            }
            try {
              writeCommandCodeKey(submitted)
            } catch (error) {
              return send(500, {
                ...scheduler.snapshot(),
                error: `无法保存 API Key：${error instanceof Error ? error.message : String(error)}`
              })
            }
            // The adapter is created at mount, so a newly saved key takes
            // effect on the next DSH start. Say so rather than implying it is
            // already serving.
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              commandCode: {
                configured: true,
                key: maskKey(submitted),
                restartRequired: commandCode === undefined,
                message: commandCode === undefined
                  ? '已保存。重启 DSH 后该线路才会出现在模型列表里。'
                  : '已保存。'
              }
            })
          } else if (body?.action === 'cc-test') {
            // Connectivity only: it requests the model catalogue, never a
            // completion, so testing a key costs no credit.
            const candidate = typeof body.apiKey === 'string' && body.apiKey.trim().length > 0
              ? body.apiKey
              : readCommandCodeKey()
            if (candidate === undefined) {
              return send(200, {
                ...scheduler.snapshot(),
                commandCodeTest: { ok: false, reason: 'missing', message: '还没有填写 API Key。' }
              })
            }
            const verdict = await testCommandCodeKey({
              apiKey: candidate,
              apiBase: config.commandCodeApiBase
            })
            return send(200, { ...scheduler.snapshot(), commandCodeTest: verdict })
          } else if (body?.action === 'import') {
            // Delegated to the daemon's own route: it owns and caches the vault,
            // so an outside write would be overwritten on its next save.
            const result = await importCredentials({
              authDirs: config.authDirs,
              dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
            })
            return send(200, {
              ...scheduler.snapshot(),
              ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
              importResult: result,
              accounts: accountOverview({
                dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
              })
            })
          }
        }
        send(200, {
          ...scheduler.snapshot(),
          nextCheckinAt: config.autoCheckin === false ? null : describeNext(config.checkinTime),
          ...(localPool === undefined ? {} : { pools: localPool.poolStatus() }),
          // Derived status is the authority the page and the tools both read.
          // Each account also carries its check-in preference, so the page can
          // render the switch without a second request.
          accounts: (() => {
            const overview = accountOverview({
              dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
            })
            return {
              ...overview,
              accounts: (overview.accounts ?? []).map((a) => ({
                ...a,
                checkinEnabled: checkinPrefs.includes(a.id)
              }))
            }
          })(),
          workbuddy: {
            ...resolveWorkBuddyPath(config.workbuddyPath),
            // Per-region client resolution, so each region's authorize button
            // can say which client it will open before it is pressed.
            cn: resolveClientForSite({ site: 'cn', configured: config.workbuddyPath, ...daemonClients }),
            ai: resolveClientForSite({ site: 'ai', configured: config.workbuddyPath, ...daemonClients })
          },
          // The page owns the key field, so it needs to know whether one is
          // stored without ever receiving it. Read from disk on every request:
          // the mount-time value would be stale the moment the key changes.
          commandCode: (() => {
            const current = readCommandCodeKey()
            return {
              configured: current !== undefined,
              ...(current === undefined ? {} : { key: maskKey(current) }),
              apiBase: config.commandCodeApiBase,
              registered: commandCode !== undefined
            }
          })(),
          // The page polls this while a capture runs, so "waiting for you" is
          // distinguishable from a hung request. The token is never included.
          captureState: captureSession.snapshot(),
          routes: routeStates(config, {
            localPool,
            switches,
            commandCodeRegistered: commandCode !== undefined
          })
        })
      } catch (error) {
        send(500, {
          ...scheduler.snapshot(),
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }), 'dsh-command-buddy-connect: status route')

  if (config.enableTools !== false) {
    // Check-in tools read the scheduler's own snapshot; the daemon and pool
    // tools describe separate products and separate state.
    const definitions = [
      ...checkinTools(scheduler, config),
      ...daemonTools({ dataDir, logger: ctx.logger }),
      ...poolTools({ dataDir, logger: ctx.logger })
    ]
    for (const tool of definitions) {
      ctx.effect(() => ctx.tools.register(tool), `dsh-command-buddy-connect: tool ${tool.name}`)
    }
  }

  if (config.enableProvider !== false) {
    const adapter = new DaemonAdapter({
      dataDir,
      contextWindow: config.contextWindow,
      logger: ctx.logger,
      attachments
    })
    ctx.effect(
      () => ctx.llm.registerAdapter([PROVIDER_ID], adapter),
      'dsh-command-buddy-connect: daemon provider registration'
    )
    ctx.logger.info(`dsh-command-buddy-connect: registered provider "${PROVIDER_ID}" (${PROVIDER_NAME})`)
  }

  ctx.logger.info(
    `dsh-command-buddy-connect: WorkBuddy check-in ${config.autoCheckin === false ? 'disabled' : 'enabled'}; `
    + `local pool ${localPool === undefined ? 'disabled' : 'enabled'}; status at ${STATUS_PATH}`
  )
}

/**
 * Report every model route and whether it is actually serving.
 *
 * `enabled` is the user's switch; `active` is whether it produced a usable
 * registration. They differ for a real reason — a route can be switched on but
 * have no credential — and the page must be able to say which of those it is,
 * or "on but broken" looks identical to "off".
 *
 * @param config - the plugin configuration.
 * @param state - the adapters that were actually constructed.
 * @returns one row per route.
 */
function routeStates(config, state) {
  const on = (id, fallback) => (state.switches === undefined ? fallback : state.switches.get(id))
  const ccConfigured = readCommandCodeKey() !== undefined
  const localReady = state.localPool !== undefined
  return [
    {
      id: 'cn',
      name: LOCAL_PROVIDER_NAME,
      region: 'cn',
      // Per-region, not per-provider: one adapter serves both pools.
      enabled: on('cn', config.enableLocalPool !== false),
      active: localReady && on('cn', config.enableLocalPool !== false),
      detail: localReady ? '中国版账号池 · 签到与调用' : '未注册'
    },
    {
      id: 'ai',
      name: LOCAL_PROVIDER_NAME,
      region: 'ai',
      enabled: on('ai', config.enableLocalPool !== false),
      active: localReady && on('ai', config.enableLocalPool !== false),
      detail: localReady ? '国际版账号池 · 仅调用' : '未注册'
    },
    {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      region: null,
      enabled: on(PROVIDER_ID, config.enableProvider !== false),
      active: on(PROVIDER_ID, config.enableProvider !== false),
      detail: '调用本机 本地守护进程（未运行时调用失败）'
    },
    {
      id: CC_PROVIDER_ID,
      name: CC_PROVIDER_NAME,
      region: null,
      enabled: on(CC_PROVIDER_ID, config.enableCommandCode !== false),
      active: state.commandCodeRegistered === true,
      // The distinction the page must show: switched on but no key is a
      // different fix from switched off.
      needsKey: !ccConfigured,
      detail: ccConfigured
        ? 'Command Code 直接对接'
        : '还没有填写 API Key，请在本页填写'
    }
  ]
}

/**
 * Launch the desktop client for one region, and confirm it actually started.
 *
 * ## Why not `spawn`
 *
 * WorkBuddy is an Electron app whose executable is a launcher. Launching it with
 * `spawn` succeeds as a call and reports a pid, but the process exits with code
 * 0 within a second and no window appears — the real app is only started when
 * Windows resolves the launch through the shell (app paths, single-instance
 * handoff, elevation). So the previous version reported "opened", the user saw
 * nothing, and every step after it was unreachable.
 *
 * The shell is asked instead: `explorer.exe <path>` performs a normal shell
 * launch. Because that call also returns immediately, the result is only
 * reported as success after a process with the expected image name is observed.
 *
 * @param site - 'cn' or 'ai'.
 * @param configured - the plugin's configured client path, when set.
 * @returns whether a client is now running, with the path used.
 */
async function openWorkBuddyForSite(site, configured) {
  const read = readDaemonConfig()
  const resolved = resolveClientForSite({
    site,
    configured,
    daemonPath: read.workbuddyExe,
    daemonIntlPath: read.workbuddyIntlExe
  })
  const name = site === 'ai' ? '国际版 WorkBuddy' : '国内版 WorkBuddy'
  if (resolved.path === undefined) {
    return {
      ok: false,
      site,
      source: resolved.source,
      error: `找不到${name}客户端。请先安装并登录对应版本，或在插件配置里填写 workbuddyPath。`
    }
  }

  const image = basename(resolved.path).replace(/\.exe$/i, '')
  // Already running: bringing it to the foreground is the client's own job, and
  // launching a second copy would just hand off anyway.
  if (isProcessRunning(image)) {
    return { ok: true, site, path: resolved.path, source: resolved.source, name, alreadyRunning: true }
  }

  try {
    // `explorer` performs a shell launch and exits; its own exit code says
    // nothing about the target, which is why the process check below decides.
    const launcher = spawn('explorer.exe', [resolved.path], { detached: true, stdio: 'ignore', windowsHide: true })
    launcher.unref()
  } catch (error) {
    return {
      ok: false,
      site,
      path: resolved.path,
      source: resolved.source,
      name,
      error: `无法启动${name}：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const started = await waitForProcess(image, START_PROCESS_TIMEOUT_MS)
  if (!started) {
    return {
      ok: false,
      site,
      path: resolved.path,
      source: resolved.source,
      name,
      error: `${name}没有启动。路径是 ${resolved.path}，请手动打开一次确认它能运行，或检查是否被安全软件拦截。`
    }
  }
  return { ok: true, site, path: resolved.path, source: resolved.source, name }
}

/** How long to wait for the launched client to appear. */
const START_PROCESS_TIMEOUT_MS = 20_000

/** Whether a process with this image name is running. */
function isProcessRunning(image) {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}.exe`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    })
    // tasklist prints a "no tasks" line when the filter matches nothing.
    return out.toLowerCase().includes(`${image.toLowerCase()}.exe`)
  } catch {
    return false
  }
}

/** Poll until the process appears, or the deadline passes. */
async function waitForProcess(image, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isProcessRunning(image)) return true
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  return isProcessRunning(image)
}

/** Read the two client paths the daemon recorded, ignoring an unreadable config. */
function readDaemonConfig() {
  try {
    const config = readConfig(resolveDataDir(undefined)).config
    return {
      workbuddyExe: typeof config.workbuddyExe === 'string' ? config.workbuddyExe : undefined,
      workbuddyIntlExe: typeof config.workbuddyIntlExe === 'string' ? config.workbuddyIntlExe : undefined
    }
  } catch {
    return { workbuddyExe: undefined, workbuddyIntlExe: undefined }
  }
}

/**
 * Persist a captured credential into the daemon's pool.
 *
 * The capture yields a raw bearer token, which is what the proxy needs but not
 * what the import route reads — that route expects a credential *file* in the
 * client's own JSON shape. So the token is written to a temporary file in that
 * shape, imported, and the file removed immediately: leaving a plaintext token
 * on disk would defeat the point of capturing it in memory.
 *
 * @param capture - the `runCapture` result.
 * @param config - the plugin configuration.
 * @returns what the daemon reported, or why nothing was written.
 */
async function writeCapturedCredential(capture, config) {
  const temp = join(tmpdir(), `buddy-connect-captured-${Date.now()}.info`)
  try {
    // `auth.domain` decides the region, so it must be the captured domain.
    const record = {
      account: { uid: capture.uid ?? '' },
      auth: {
        accessToken: capture.token,
        domain: capture.domain ?? 'copilot.tencent.com',
        expiresAt: Date.now() + 28 * 24 * 60 * 60 * 1000
      }
    }
    writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
    return await importCredentialFile(temp, {
      dataDir: config.dataDir !== undefined && config.dataDir.length > 0 ? config.dataDir : undefined
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort: a leftover temp file is still mode 0600.
    }
  }
}

/**
 * Launch the WorkBuddy desktop client so the user can sign in.
 *
 * Detached and unref'd: the plugin must not hold a handle on a GUI process, or
 * restarting DSH would take the client with it. A missing executable is
 * reported rather than treated as success, because "nothing happened" is the
 * exact failure this button exists to remove.
 *
 * @param configured - the configured client path, when set.
 * @returns whether the client was launched, with the path used.
 */
function openWorkBuddy(configured) {
  const resolved = resolveWorkBuddyPath(configured)
  if (resolved.path === undefined) {
    return {
      ok: false,
      source: resolved.source,
      error: '找不到 WorkBuddy 客户端。请在插件配置里填写 workbuddyPath 指向 WorkBuddy.exe。'
    }
  }
  try {
    const child = spawn(resolved.path, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.unref()
    return { ok: true, path: resolved.path, source: resolved.source }
  } catch (error) {
    return {
      ok: false,
      path: resolved.path,
      source: resolved.source,
      error: `无法启动 WorkBuddy：${error instanceof Error ? error.message : String(error)}`
    }
  }
}

/**
 * The next scheduled check, as an ISO instant.
 *
 * @param time - the configured `HH:mm` in CN time.
 * @returns an ISO string, or null when the value is unusable.
 */
function describeNext(time) {
  const next = nextOccurrence(time)
  return next === undefined ? null : new Date(next).toISOString()
}

/**
 * Read a JSON request body, tolerating an empty or oversized one.
 *
 * @param req - the incoming request.
 * @returns the parsed object, or undefined.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // A status action is a few bytes; anything larger is not one, and reading
    // it would only waste memory.
    if (size > 64 * 1024) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the agent-facing tools.
 *
 * These read the same snapshot the UI shows, so the agent and the page can
 * never disagree about whether today's check-in happened.
 *
 * @param scheduler - the live scheduler.
 * @param config - the deployment configuration.
 * @returns the tool definitions.
 */
function checkinTools(scheduler, config) {
  const render = (value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }]

  const status = defineTool({
    name: 'checkin_status',
    description: 'Report the WorkBuddy account and whether today\'s check-in reward has been claimed, including the current credit balance. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'One-line human-readable status.' },
          signedIn: { type: 'boolean', required: true, description: 'Whether a WorkBuddy login was readable.' },
          account: { type: 'string', description: 'Signed-in account label.' },
          checkedInToday: { type: 'boolean', required: true, description: 'Whether today\'s reward is claimed.' },
          status: { type: 'string', description: 'Upstream-reported check-in state.' },
          creditsToday: { type: 'number', description: 'Credits earned today.' },
          creditsTotal: { type: 'number', description: 'Credits earned in the activity so far.' },
          balance: { type: 'number', description: 'Remaining credit balance.' },
          autoCheckin: { type: 'boolean', required: true, description: 'Whether automatic check-in is on.' },
          error: { type: 'string', description: 'Diagnostic when something failed.' }
        }
      },
      render: (_args, value) => render(value.summary)
    },
    execute() {
      const snapshot = scheduler.snapshot()
      const checkin = snapshot.checkin
      const lines = []
      if (snapshot.signedIn !== true) {
        lines.push(snapshot.error ?? 'No WorkBuddy login is available.')
      } else {
        lines.push(`Account: ${snapshot.account?.label ?? 'unknown'}`)
        lines.push(checkin === null || checkin === undefined
          ? 'Check-in state is not known yet; the first check has not completed.'
          : `Today (${checkin.date}): ${checkin.status}${checkin.checkedIn ? `, +${checkin.credits} credits` : ''}`)
        if (typeof snapshot.balance === 'number') lines.push(`Balance: ${snapshot.balance} credits`)
        if (typeof checkin?.streakDays === 'number' && checkin.streakDays > 0) lines.push(`Streak: ${checkin.streakDays} days`)
      }
      return Promise.resolve({
        summary: lines.join(' | '),
        signedIn: snapshot.signedIn === true,
        ...(snapshot.account?.label === undefined ? {} : { account: snapshot.account.label }),
        checkedInToday: checkin?.checkedIn === true,
        ...(checkin?.status === undefined ? {} : { status: checkin.status }),
        ...(typeof checkin?.credits === 'number' ? { creditsToday: checkin.credits } : {}),
        ...(typeof checkin?.totalCredits === 'number' ? { creditsTotal: checkin.totalCredits } : {}),
        ...(typeof snapshot.balance === 'number' ? { balance: snapshot.balance } : {}),
        autoCheckin: snapshot.autoCheckin === true,
        ...(snapshot.error === null || snapshot.error === undefined ? {} : { error: snapshot.error })
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Check WorkBuddy check-in status', kind: 'other' })
  })

  const runNow = defineTool({
    name: 'checkin_now',
    description: 'Run the WorkBuddy daily check-in now instead of waiting for the scheduled time. Claims the reward only if the server reports today as unclaimed, so it is safe to call repeatedly.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true, description: 'One-line outcome.' },
          claimed: { type: 'boolean', required: true, description: 'Whether this call claimed the reward.' },
          checkedInToday: { type: 'boolean', required: true, description: 'Whether today\'s reward is now claimed.' },
          credits: { type: 'number', description: 'Credits earned today.' },
          balance: { type: 'number', description: 'Remaining credit balance.' },
          error: { type: 'string', description: 'Diagnostic when the check-in failed.' }
        }
      },
      render: (_args, value) => render(value.summary)
    },
    async execute(_args, exec) {
      if (exec?.signal?.aborted === true) throw new Error('check-in cancelled')
      const before = scheduler.snapshot()
      const after = await scheduler.run({ force: true })
      const claimed = after.checkin?.checkedIn === true && before.checkin?.checkedIn !== true
      const summary = after.error !== null && after.error !== undefined
        ? `Check-in failed: ${after.error}`
        : claimed
          ? `Checked in successfully; +${after.checkin?.credits ?? 0} credits today.`
          : `Already checked in today (${after.checkin?.status ?? 'no reward due'}).`
      return {
        summary,
        claimed,
        checkedInToday: after.checkin?.checkedIn === true,
        ...(typeof after.checkin?.credits === 'number' ? { credits: after.checkin.credits } : {}),
        ...(typeof after.balance === 'number' ? { balance: after.balance } : {}),
        ...(after.error === null || after.error === undefined ? {} : { error: after.error })
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Run WorkBuddy check-in', kind: 'other' })
  })

  const schedule = defineTool({
    name: 'checkin_schedule',
    description: 'Report the WorkBuddy check-in schedule: whether automatic check-in is enabled, how often it runs, and when the next scheduled check is due. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true, description: 'Whether automatic check-in is on.' },
          intervalMinutes: { type: 'number', required: true, description: 'Minutes between automatic checks.' },
          checkinTime: { type: 'string', required: true, description: 'Configured CN-time boundary.' },
          nextCheckinAt: { type: 'string', description: 'Next scheduled check, as an ISO instant.' },
          summary: { type: 'string', required: true, description: 'One-line description.' }
        }
      },
      render: (_args, value) => render(value.summary)
    },
    execute() {
      const interval = config.intervalMinutes ?? 30
      const enabled = config.autoCheckin !== false
      const next = enabled ? describeNext(config.checkinTime) : null
      return Promise.resolve({
        enabled,
        intervalMinutes: interval,
        checkinTime: config.checkinTime ?? '09:00',
        ...(next === null ? {} : { nextCheckinAt: next }),
        summary: enabled
          ? `Automatic check-in is on: every ${interval} minutes, next due ${next ?? 'unknown'}.`
          : 'Automatic check-in is disabled; use checkin_now to run it manually.'
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Read WorkBuddy check-in schedule', kind: 'other' })
  })

  return [status, runNow, schedule]
}
