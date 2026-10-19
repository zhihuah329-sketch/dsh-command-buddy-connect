/**
 * Per-region client resolution.
 *
 * The 国际版 authorize button reported "未安装客户端" on machines that had the
 * client, because `clientsByRegion()` read only the 国内版 profile directory
 * (`CodeBuddy CN`) and attributed every executable it found to 国内版 — the
 * international profile (`CodeBuddy`) was never consulted, so `ai` stayed
 * undefined forever.
 *
 * The regions are separate products. Opening the 国内版 client to authorize an
 * international account shows the wrong sign-in screen and yields a credential
 * for the wrong pool, so getting this wrong is worse than reporting "missing".
 *
 * `candidates` and `appData` are injected so a real install on the machine
 * running the tests cannot satisfy or break a check.
 *
 * Run: node test/client-region.check.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const { resolveClientForSite } = await import('../lib/account-status.js')
const { createChecker } = await import('./harness.mjs')

const { check, finish } = createChecker()

const root = fs.mkdtempSync(join(os.tmpdir(), 'buddy-client-check-'))
const roaming = join(root, 'Roaming')
const installs = join(root, 'Installs')
fs.mkdirSync(roaming, { recursive: true })
fs.mkdirSync(installs, { recursive: true })

const cnExe = join(installs, 'WorkBuddy.exe')
fs.writeFileSync(cnExe, 'stub')

const cnProfile = join(roaming, 'CodeBuddy CN')
const aiProfile = join(roaming, 'CodeBuddy')

/** Resolve with the temp layout and only the given candidates. */
function resolve(options) {
  return resolveClientForSite({
    appData: roaming,
    candidates: [cnExe],
    ...options
  })
}

console.log('only the 国内版 profile present:')
{
  fs.mkdirSync(cnProfile, { recursive: true })
  const cn = resolve({ site: 'cn' })
  check('CN resolves to the install', cn.path === cnExe, String(cn.path))
  check('CN came from discovery', cn.source === 'discovered', cn.source)

  const ai = resolve({ site: 'ai' })
  check('AI does not borrow the CN client', ai.path === undefined, String(ai.path))
  check('AI reports missing', ai.source === 'missing', ai.source)
  check('AI hint names the right setting', String(ai.hint).includes('workbuddyIntlPath'), String(ai.hint))
}

console.log('\nboth profiles present with a single install:')
{
  fs.mkdirSync(aiProfile, { recursive: true })
  // One executable cannot be both products. With two profiles and one install,
  // the install is only evidence for the region it was first attributed to, so
  // the other region must not silently borrow it.
  const ai = resolve({ site: 'ai' })
  check('AI does not reuse the single install', ai.path !== cnExe, String(ai.path))
  const cn = resolve({ site: 'cn' })
  check('CN keeps the install', cn.path === cnExe, String(cn.path))
}

console.log('\nboth profiles with an install each:')
{
  fs.mkdirSync(join(root, 'Intl'), { recursive: true })
  const aiExe = join(root, 'Intl', 'WorkBuddy.exe')
  fs.writeFileSync(aiExe, 'stub')
  const ai = resolveClientForSite({
    site: 'ai',
    appData: roaming,
    candidates: [cnExe, aiExe]
  })
  check('AI resolves to its own install', ai.path === aiExe, String(ai.path))
  check('AI source is discovery', ai.source === 'discovered', ai.source)
  const cn = resolveClientForSite({ site: 'cn', appData: roaming, candidates: [cnExe, aiExe] })
  check('CN keeps its own install', cn.path === cnExe, String(cn.path))
}

console.log('\nan explicit international path wins over detection:')
{
  const intl = join(installs, 'WorkBuddyIntl.exe')
  fs.writeFileSync(intl, 'stub')
  const ai = resolve({ site: 'ai', intlPath: intl })
  check('the configured path is used', ai.path === intl, String(ai.path))
  check('and is reported as configured', ai.source === 'configured', ai.source)
}

console.log('\na configured path that does not exist is reported, not silently replaced:')
{
  const ai = resolve({ site: 'ai', intlPath: join(root, 'nope', 'WorkBuddy.exe') })
  check('no fallback to another client', ai.path === undefined, String(ai.path))
  check('still reported as missing', ai.source === 'missing', ai.source)
  check('the hint names the bad path', String(ai.hint).includes('nope'), String(ai.hint))
}

console.log('\nthe CN setting never satisfies an international lookup:')
{
  const ai = resolve({ site: 'ai', configured: cnExe })
  check('AI did not resolve to the CN-configured client', ai.path !== cnExe, String(ai.path))
}

console.log('\nthe 国际版 profile alone does not make the CN client international:')
{
  // Remove the CN profile, leaving only the international one. The single
  // install on disk cannot be proven to be the international client, so it must
  // not be handed to CN either.
  fs.rmSync(cnProfile, { recursive: true, force: true })
  const cn = resolve({ site: 'cn' })
  check('CN does not claim the AI-attributed install', cn.path !== cnExe, String(cn.path))
}

fs.rmSync(root, { recursive: true, force: true })
finish()
