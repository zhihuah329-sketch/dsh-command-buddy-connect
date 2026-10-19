/**
 * Importing a credential file must not require the daemon.
 *
 * The daemon was removed from this machine, but `importCredentials` and
 * `importCredentialFile` still posted each file to its `/admin/import` route. The
 * result was the report the user saw:
 *
 *   1 个文件导入失败：workbuddy-desktop-ai.info（无法连接守护进程管理接口：fetch failed）
 *
 * The button was still calling a program that no longer exists. Both paths now
 * write the vault directly, the way the desktop-app reader already did.
 *
 * Run: node test/import-without-daemon.check.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const { importCredentials, discoverCredentials } = await import('../lib/account-status.js')
const { createChecker } = await import('./harness.mjs')

const { check, finish } = createChecker()

const root = fs.mkdtempSync(join(os.tmpdir(), 'buddy-import-check-'))
const authDir = join(root, 'auth')
const dataDir = join(root, 'data')
fs.mkdirSync(authDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })

/**
 * A token shaped like the real thing.
 *
 * The writer rejects a short token on purpose —「这个令牌只有 14 个字符，正常令牌有上千个
 * 字符」—— so a stub value cannot exercise the success path. This is a plausible
 * three-part JWT of realistic length, not a credential.
 */
function fakeToken(seed = 'original') {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify({
    sub: 'ai-uid-1',
    exp: 2_000_000_000,
    note: `${seed}-${'x'.repeat(900)}`
  })).toString('base64url')
  return `${header}.${body}.${'s'.repeat(340)}`
}

/**
 * A filename that cannot collide with a real credential on this machine.
 *
 * Discovery also reads the machine's own credential directories, and a real
 * `workbuddy-desktop-ai.info` exists there — importing both made a count-based
 * assertion ambiguous. A unique name keeps the checks about this test's file.
 */
const AI_FILE = 'workbuddy-desktop-ai.regioncheck.info'

/** A plaintext credential as the international client writes it. */
function writeAi(name, overrides = {}) {
  const body = {
    auth: { accessToken: fakeToken(), domain: 'www.workbuddy.ai', ...(overrides.auth ?? {}) },
    account: { uid: 'ai-uid-1', ...(overrides.account ?? {}) }
  }
  fs.writeFileSync(join(authDir, name), JSON.stringify(body))
}

console.log('an importable file is written without any daemon:')
{
  writeAi(AI_FILE)
  const scope = { authDirs: [authDir], dataDir, site: 'ai' }
  const found = discoverCredentials(scope)
  check('the file is discovered', found.files.filter((f) => f.importable === true).length >= 1, String(found.importable))

  const result = await importCredentials(scope)
  check('the import reports success', result.ok === true, String(result.error ?? result.ok))
  check('it wrote through the vault', result.via === 'vault', String(result.via))
  check('no daemon connection error', !String(result.error ?? '').includes('守护进程'), String(result.error ?? ''))
  // The scope also covers the machine's own credential directories, so the count
  // is not fixed — what matters is that our file was among those written.
  const ours = result.imported.filter((f) => f.name === AI_FILE)
  check('our file was imported', ours.length === 1, String(ours.length))
  check('at least one account added', result.added >= 1, `added=${result.added}`)
  check('the vault grew', (result.after ?? 0) > (result.before ?? 0), `${result.before}->${result.after}`)
}

console.log('\nimporting the same file again updates rather than duplicates:')
{
  const scope = { authDirs: [authDir], dataDir, site: 'ai' }
  const again = await importCredentials(scope)
  check('still succeeds', again.ok === true, String(again.error ?? again.ok))
  check('counted as an update', again.updated >= 1, `updated=${again.updated}`)
  check('no second account created', again.after === again.before, `${again.before}->${again.after}`)
}

console.log('\na changed token replaces the stored one:')
{
  const rotated = fakeToken('rotated')
  writeAi(AI_FILE, { auth: { accessToken: rotated } })
  const scope = { authDirs: [authDir], dataDir, site: 'ai' }
  const result = await importCredentials(scope)
  check('succeeds', result.ok === true, String(result.error ?? result.ok))
  const { readVault } = await import('../lib/vault.js')
  const vault = readVault(dataDir)
  const account = (vault.accounts ?? []).find((a) => a && a.removed !== true)
  check('the new token is stored', account?.accessToken === rotated, String(account?.accessToken).slice(0, 20))
}

console.log('\na sealed CN file is reported, not silently skipped:')
{
  fs.writeFileSync(join(authDir, 'workbuddy-desktop.info'), JSON.stringify({
    auth: { accessToken: { $wbEncrypted: 1, envelope: 'sealed' }, domain: 'www.workbuddy.cn' },
    account: { uid: 'cn-uid' }
  }))
  const scope = { authDirs: [authDir], dataDir, site: 'cn' }
  const cn = await importCredentials(scope)
  check('reports failure rather than success', cn.ok === false, String(cn.ok))
  check('the message points at the desktop-app route', String(cn.error).includes('从桌面版读取'), String(cn.error))
}

console.log('\nnothing importable still explains itself:')
{
  const empty = fs.mkdtempSync(join(os.tmpdir(), 'buddy-import-empty-'))
  const scope = { authDirs: [empty], dataDir, site: 'cn' }
  const none = await importCredentials(scope)
  check('reports failure', none.ok === false)
  check('with an explanation', typeof none.error === 'string' && none.error.length > 0, String(none.error))
  fs.rmSync(empty, { recursive: true, force: true })
}

console.log('\nthe module no longer reaches for the daemon at all:')
{
  const source = fs.readFileSync(new URL('../lib/account-status.js', import.meta.url), 'utf8')
  const importSection = source.slice(0, source.indexOf('*/') + 2)
  check('no adminRequest import', !/import\s*\{[^}]*adminRequest/.test(importSection))
  check('no /admin/import call', !source.includes("path: '/admin/import'"))
  // The phrase may appear in prose explaining the history; what must not exist is
  // a failure path that returns it to the user.
  check('no daemon-unreachable error is returned',
    !/error:\s*`?[^`\n]*无法连接守护进程/.test(source))
}

fs.rmSync(root, { recursive: true, force: true })
finish()
