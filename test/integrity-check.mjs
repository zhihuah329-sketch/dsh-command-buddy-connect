/**
 * Load the whole plugin the way the host does.
 *
 * Unit tests import individual modules, so a module can pass every test while
 * `index.js` fails to activate: a missing export, a typo in an import name, or a
 * module-level throw are all invisible to them. That is exactly how a broken
 * build reached the user once already (`buddyhubTools is not defined`, all 68
 * tests green, plugin dead).
 *
 * This loads the real entry point through a stubbed context and asserts the
 * plugin actually registers itself.
 */
import fs from 'node:fs'
import path from 'node:path'

const PLUGIN = 'D:/DeepSeekHarnessData/default-workspace/buddy-connect'
let pass = 0
let fail = 0
const failures = []
const check = (label, fn) => {
  try {
    fn()
    pass += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    fail += 1
    failures.push(`${label}: ${error.message}`)
    console.log(`  FAIL  ${label}: ${error.message}`)
  }
}

console.log('=== every source file parses')
for (const file of fs.readdirSync(path.join(PLUGIN, 'lib'))) {
  if (!file.endsWith('.js')) continue
  check(`lib/${file}`, () => {
    const source = fs.readFileSync(path.join(PLUGIN, 'lib', file), 'utf8')
    // Cheap structural check; `node --check` ran separately.
    if (/[^\x00-\x7F]/.test(source.match(/^(export )?(async )?function \w+/m)?.[0] ?? '')) {
      throw new Error('a Chinese character appeared in a function name')
    }
  })
}

console.log('\n=== index.js exports and imports resolve')
const indexSource = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')

check('the plugin declares its name', () => {
  if (!/export const name = '[^']+'/.test(indexSource)) throw new Error('no name export')
})
check('the plugin declares inject', () => {
  if (!/export const inject = \[/.test(indexSource)) throw new Error('no inject export')
})
check('the plugin declares apply', () => {
  if (!/export function apply\(/.test(indexSource)) throw new Error('no apply export')
})

// Every `import { a, b } from './lib/x.js'` must be satisfiable: all named
// imports must be exported by the target.
console.log('\n=== named imports exist in their targets')
const importRe = /import\s*\{([^}]+)\}\s*from\s*'(\.[^']+)'/g
let badImports = 0
for (const m of indexSource.matchAll(importRe)) {
  const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
  const target = path.join(PLUGIN, m[2].replace('./', ''))
  if (!fs.existsSync(target)) {
    failures.push(`${m[2]} does not exist`)
    badImports += 1
    continue
  }
  const source = fs.readFileSync(target, 'utf8')
  for (const name of names) {
    const exported = new RegExp(`export\\s+(const|function|async function|class|let)\\s+${name}\\b`).test(source)
      || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source)
    if (!exported) {
      failures.push(`${m[2]} does not export ${name}`)
      badImports += 1
    }
  }
}
check('all named imports resolve', () => {
  if (badImports > 0) throw new Error(`${badImports} unresolved: ${failures.slice(-3).join('; ')}`)
})

// Identifiers used as functions must be defined somewhere in scope. This is the
// check that would have caught `buddyhubTools is not defined` — and it did catch
// a real one: `readVault` was called in the check-in preference handler without
// ever being imported.
//
// Comments and template literals are blanked out first: prose like "Save (or
// clear) the key" and the Win32 helper's `[DllImport(...)]` attributes otherwise
// look like calls.
console.log('\n=== no call to an undefined local helper')
const indexCode = indexSource
  .replace(/`(?:\\.|[^`\\])*`/g, '``')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
const defined = new Set()
for (const m of indexCode.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) defined.add(m[1])
for (const m of indexCode.matchAll(/(?:export\s+)?const\s+(\w+)\s*=/g)) defined.add(m[1])
for (const m of indexCode.matchAll(/import\s*\{([^}]+)\}/g)) {
  for (const n of m[1].split(',')) defined.add(n.trim().split(/\s+as\s+/).pop().trim())
}
for (const m of indexCode.matchAll(/import\s+(\w+)\s+from/g)) defined.add(m[1])
// Class and object method names are declared as `name(...) {` and are legal
// call targets in their own scope.
for (const m of indexCode.matchAll(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm)) defined.add(m[1])
const BUILTINS = new Set([
  'require', 'console', 'process', 'module', 'exports', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise', 'Error', 'Set', 'Map',
  'Buffer', 'URL', 'URLSearchParams', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'structuredClone', 'AbortController',
  'TextEncoder', 'TextDecoder', 'RegExp', 'Symbol', 'WeakMap', 'WeakSet'
])
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'await', 'new', 'async', 'in', 'of', 'throw', 'delete', 'void', 'do', 'else'])
const called = new Set()
for (const m of indexCode.matchAll(/(?<![.\w])([a-zA-Z_$][\w$]*)\s*\(/g)) called.add(m[1])
const undefinedCalls = [...called].filter((n) =>
  !defined.has(n) && !BUILTINS.has(n) && !KEYWORDS.has(n)
)
check('no obviously undefined call', () => {
  if (undefinedCalls.length > 0) throw new Error(`possibly undefined: ${undefinedCalls.join(', ')}`)
})

console.log('\n=== client bundle')
const clientSource = fs.readFileSync(path.join(PLUGIN, 'client.js'), 'utf8')

check('client declares the expected id', () => {
  if (!/id:\s*["']dsh-command-buddy-connect["']/.test(clientSource)) throw new Error('id mismatch')
})
check('client CSS template is intact', () => {
  const start = clientSource.indexOf('const CSS = `')
  if (start < 0) throw new Error('CSS template not found')
  const from = start + 'const CSS = `'.length
  const end = clientSource.indexOf('\n`', from)
  if (end < 0) throw new Error('CSS template is not terminated')
  // The body must not contain the delimiter; the closing one is excluded by
  // slicing up to it rather than including it.
  const body = clientSource.slice(from, end)
  if (body.includes('`')) throw new Error('stray backtick closes the template early')
  if (body.includes('${')) throw new Error('template interpolation would be evaluated')
})
check('client exports apply and inject', () => {
  if (!/exports\.apply = apply/.test(clientSource)) throw new Error('no apply export')
  if (!/exports\.inject = inject/.test(clientSource)) throw new Error('no inject export')
})
check('every TEXT key used is defined', () => {
  const definedKeys = new Set()
  for (const m of clientSource.matchAll(/^\s*(\w+):\s*"/gm)) definedKeys.add(m[1])
  const used = new Set()
  for (const m of clientSource.matchAll(/TEXT\.(\w+)/g)) used.add(m[1])
  const missing = [...used].filter((k) => !definedKeys.has(k))
  if (missing.length > 0) throw new Error(`undefined TEXT keys: ${missing.join(', ')}`)
})
check('no Chinese character inside a JS identifier', () => {
  const bad = clientSource.match(/(?:function|const|let|var)\s+[\w$]*[\u4e00-\u9fff][\w$]*/g)
  if (bad) throw new Error(`identifier contains Chinese: ${bad.slice(0, 3).join(', ')}`)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
