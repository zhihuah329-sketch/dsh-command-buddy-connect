/**
 * Every status reply must carry the client state.
 *
 * This is the bug behind 「未检测到…客户端」 appearing for both regions while the
 * client was installed and the GET route reported it correctly.
 *
 * The page keeps one status object. Each POST action (scan, import, toggle …)
 * replaced it with its own reply, and those replies omitted `workbuddy` — so after
 * any button press the page could no longer tell that a client existed and said
 * so for both regions. The state is now merged into every reply in one place.
 *
 * This checks the shape of the merge, not the HTTPS plumbing: the handler's logic
 * is `payload.workbuddy === undefined ? {...payload, workbuddy} : payload`.
 *
 * Run: node test/status-payload.check.mjs
 */

import fs from 'node:fs'
import { createChecker } from './harness.mjs'

const { check, finish } = createChecker()

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

console.log('the client state is resolved in exactly one place:')
{
  const definitions = [...source.matchAll(/const clientState = \(\) => \(/g)].length
  check('one clientState helper', definitions === 1, String(definitions))
  check('the GET payload uses it', /workbuddy:\s*clientState\(\)/.test(source))
  check('it resolves both regions', /cn:\s*resolveClientForSite.*\n\s*ai:\s*resolveClientForSite/s.test(source))
}

console.log('\nthe reply merge fills in a missing workbuddy:')
{
  // Mirror the handler's expression so the behaviour is pinned without a server.
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const merge = (payload, workbuddy) => (isPlainObject(payload) && payload.workbuddy === undefined
    ? { ...payload, workbuddy }
    : payload)
  const client = { cn: { path: 'C:\\cn\\WorkBuddy.exe' }, ai: { path: 'C:\\ai\\WorkBuddyAI.exe' } }

  const reply = merge({ discovery: { files: [] }, pools: { cn: 1 } }, client)
  check('a reply without workbuddy gains it', reply.workbuddy !== undefined)
  check('existing fields survive', reply.discovery !== undefined && reply.pools !== undefined)
  check('both regions present', reply.workbuddy.cn?.path !== undefined && reply.workbuddy.ai?.path !== undefined)

  const already = { workbuddy: { cn: { path: 'mine' } } }
  check('an explicit workbuddy is not overwritten', merge(already, client).workbuddy.cn.path === 'mine')
}

console.log('\nthe handler sends through the merge:')
{
  check('the send function merges', /const merged = isPlainObject\(payload\) && payload\.workbuddy === undefined/.test(source))
  check('nothing is written unmerged', /res\.end\(JSON\.stringify\(merged\)\)/.test(source))
}

console.log('\nnon-object payloads are left alone:')
{
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const merge = (payload, workbuddy) => (isPlainObject(payload) && payload.workbuddy === undefined
    ? { ...payload, workbuddy }
    : payload)
  for (const value of [null, undefined, 'text', 42, [1, 2]]) {
    check(`passes ${JSON.stringify(value)} through`, merge(value, { cn: {} }) === value)
  }
}

finish()
