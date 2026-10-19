/**
 * Region isolation for authorization.
 *
 * Pressing "导入本区域凭据" under 国内版 also rewrote the 国际版 account, because
 * `discover`/`import` took no region and processed every credential file they
 * could find. The user's report was exactly that: 为什么国内版授权账号同时国际版也动.
 *
 * These checks pin the scoping at the discovery layer, which is where both the
 * page and the import path get their file list.
 *
 * Run: node test/region-scope.check.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const { discoverCredentials } = await import('../lib/account-status.js')
const { createChecker } = await import('./harness.mjs')

const { check, finish } = createChecker()

// A throwaway credential directory with one file per region.
const dir = fs.mkdtempSync(join(os.tmpdir(), 'buddy-region-check-'))

/** A plaintext credential as the international client writes it. */
function aiFile(name) {
  fs.writeFileSync(join(dir, name), JSON.stringify({
    auth: { accessToken: 'ai-token', domain: 'www.workbuddy.ai' },
    account: { uid: 'ai-uid' }
  }))
}

/** A CN credential whose token the client sealed. */
function cnFile(name) {
  fs.writeFileSync(join(dir, name), JSON.stringify({
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'sealed' }, domain: 'www.workbuddy.cn' },
    account: { uid: 'cn-uid' }
  }))
}

aiFile('workbuddy-desktop-ai.info')
cnFile('workbuddy-desktop.info')

// Discovery reads the configured directories *plus* the machine's own default
// locations, and this machine has real WorkBuddy credentials there. Every
// assertion therefore looks only at files this test created, so a real credential
// on the developer's disk can neither satisfy nor break a check.
const ours = (file) => file.path.startsWith(dir)

// Discovery reads the configured directories plus its defaults; pointing it at
// the temp dir keeps the real credential files out of the assertions.
const base = { authDirs: [dir], dataDir: join(dir, 'no-vault') }

console.log('an unscoped scan still sees every region:')
{
  const all = discoverCredentials(base)
  const mine = all.files.filter(ours)
  const sites = new Set(mine.map((f) => f.site).filter(Boolean))
  check('both regions present in the temp dir', sites.has('cn') && sites.has('ai'), [...sites].join(','))
  check('scopedTo is unset', all.scopedTo === undefined, String(all.scopedTo))
}

console.log('\nscoping to CN excludes the international file:')
{
  const cn = discoverCredentials({ ...base, site: 'cn' })
  const mine = cn.files.filter(ours)
  check('our CN file is kept', mine.some((f) => f.name === 'workbuddy-desktop.info'), mine.map((f) => f.name).join(','))
  check('our AI file is gone', mine.some((f) => f.name.includes('-ai')) === false, mine.map((f) => f.name).join(','))
  check('no AI file from anywhere is included', cn.files.some((f) => f.site === 'ai') === false, cn.files.map((f) => `${f.site}:${f.name}`).join(','))
  check('scopedTo reports cn', cn.scopedTo === 'cn', String(cn.scopedTo))
  check('the summary names the region', cn.summary.includes('国内版'), cn.summary)
}

console.log('\nscoping to AI excludes the CN file:')
{
  const ai = discoverCredentials({ ...base, site: 'ai' })
  const mine = ai.files.filter(ours)
  check('our AI file is kept', mine.some((f) => f.name.includes('-ai')), mine.map((f) => f.name).join(','))
  check('our CN file is gone', mine.some((f) => f.name === 'workbuddy-desktop.info') === false)
  check('no CN file from anywhere is included', ai.files.some((f) => f.site === 'cn') === false, ai.files.map((f) => `${f.site}:${f.name}`).join(','))
  check('scopedTo reports ai', ai.scopedTo === 'ai', String(ai.scopedTo))
  check('the summary names the region', ai.summary.includes('国际版'), ai.summary)
}

console.log('\na region with no files says so, rather than reporting the other region:')
{
  // Move our AI file aside; the machine may still have a real one, so this check
  // only asserts that *our* file no longer appears under the AI scope.
  fs.rmSync(join(dir, 'workbuddy-desktop-ai.info'))
  const ai = discoverCredentials({ ...base, site: 'ai' })
  check('our AI file is no longer found', ai.files.filter(ours).length === 0, String(ai.files.filter(ours).length))
  check('the CN file did not leak into the AI scope', ai.files.some((f) => f.name === 'workbuddy-desktop.info') === false)
}

console.log('\nan unknown site value does not silently mean "all":')
{
  const weird = discoverCredentials({ ...base, site: 'both' })
  check('scopedTo is unset for an invalid value', weird.scopedTo === undefined, String(weird.scopedTo))
  check('and our files are not filtered away', weird.files.filter(ours).length > 0, String(weird.files.filter(ours).length))
}

fs.rmSync(dir, { recursive: true, force: true })
finish()
