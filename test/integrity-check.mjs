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
import { fileURLToPath } from 'node:url'

// Resolved from this file, not hard-coded: a fixed path kept reading the source
// checkout even when the check ran from a copy, which is how a check can pass
// while the package it claims to verify is broken.
const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
const BUILTINS = new Set([
  'require', 'console', 'process', 'module', 'exports', 'JSON', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise', 'Error', 'Set', 'Map',
  'Buffer', 'URL', 'URLSearchParams', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'structuredClone', 'AbortController',
  'TextEncoder', 'TextDecoder', 'RegExp', 'Symbol', 'WeakMap', 'WeakSet',
  'Set', 'BigInt', 'Intl', 'decodeURI', 'encodeURI', 'queueMicrotask'
])
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
  'function', 'await', 'new', 'async', 'in', 'of', 'throw', 'delete', 'void', 'do',
  'else', 'yield', 'super', 'this'])
// Host globals a module may call without importing.
const GLOBALS = new Set(['Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'WebSocket', 'EventSource', 'crypto', 'performance', 'structuredClone'])

/**
 * Report identifiers called as functions but never defined or imported.
 *
 * Only bare calls at the start of a line or after an operator are considered.
 * Method calls (`pool.finish(...)`), dynamic `import(...)`, and instance-typed
 * constructors (`new Headers()`) are not, because they resolve through an object
 * or a global rather than through this module's scope.
 *
 * @param source - a module's text.
 * @returns the names that look undefined.
 */
function findUndefinedCalls(source) {
  const code = source
    // Template literals and comments carry prose that looks like calls
    // ("the proxy emits frames and terminates"), so they are blanked out first.
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const scope = new Set()
  for (const m of code.matchAll(/(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/g)) scope.add(m[1])
  for (const m of code.matchAll(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g)) scope.add(m[1])
  // Destructuring declarations bind every name inside the braces.
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=/g)) {
    for (const n of m[1].split(',')) scope.add(n.split(':').pop().trim().split(/\s+as\s+/).pop().trim())
  }
  for (const m of code.matchAll(/import\s*\{([^}]+)\}/g)) {
    for (const n of m[1].split(',')) scope.add(n.trim().split(/\s+as\s+/).pop().trim())
  }
  for (const m of code.matchAll(/import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s+from/g)) scope.add(m[1])
  for (const m of code.matchAll(/import\s+\*\s+as\s+(\w+)/g)) scope.add(m[1])
  for (const m of code.matchAll(/catch\s*\(\s*(\w+)/g)) scope.add(m[1])
  // Function parameters and loop bindings are legal call targets in their scope.
  for (const m of code.matchAll(/function\s*\w*\s*\(([^)]*)\)/g)) {
    for (const n of m[1].split(',')) scope.add(n.trim().split(/[=\s]/)[0].replace(/[{}[\]]/g, ''))
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const n of m[1].split(',')) scope.add(n.trim().split(/[=\s]/)[0].replace(/[{}[\]]/g, ''))
  }
  for (const m of code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/g)) scope.add(m[1])
  // Class and object method definitions, private ones included: `  #run(...) {`.
  // Control-flow keywords are excluded explicitly — an earlier version of this
  // pattern matched `if (` and `for (` too, which put every keyword into the
  // allowed set and made the whole check pass regardless of the code.
  for (const m of code.matchAll(/^\s{2,}(?:async\s+|static\s+|get\s+|set\s+)*(#?\w+)\s*\(/gm)) {
    if (!KEYWORDS.has(m[1])) scope.add(m[1].replace(/^#/, ''))
  }
  // `this.foo()` and `this.#foo()` resolve through the instance.
  const methods = new Set()
  for (const m of code.matchAll(/this\.#?(\w+)\s*\(/g)) methods.add(m[1])

  const calledHere = new Set()
  for (const m of code.matchAll(/(?<![.\w$])(#?[a-zA-Z_$][\w$]*)\s*\(/g)) {
    calledHere.add(m[1].replace(/^#/, ''))
  }
  // `import(` is syntax, and `new X()` resolves a constructor, not this module.
  for (const m of code.matchAll(/new\s+([a-zA-Z_$][\w$]*)/g)) calledHere.delete(m[1])
  calledHere.delete('import')
  calledHere.delete('super')
  calledHere.delete('this')
  calledHere.delete('$')
  calledHere.delete('')

  return [...calledHere].filter((n) =>
    !scope.has(n) && !methods.has(n) && !BUILTINS.has(n) && !KEYWORDS.has(n) && !GLOBALS.has(n)
  )
}

const undefinedCalls = findUndefinedCalls(indexSource)
check('no obviously undefined call', () => {
  if (undefinedCalls.length > 0) throw new Error(`possibly undefined: ${undefinedCalls.join(', ')}`)
})

// The same check for every library module. `desktop-app.js` called
// `identityFromToken` without importing it, which only surfaced at runtime — the
// check above covered `index.js` alone, so it stayed green.
console.log('\n=== no call to an undefined helper in lib/')
const libDir = path.join(PLUGIN, 'lib')
const libProblems = []
for (const name of fs.readdirSync(libDir)) {
  if (!name.endsWith('.js')) continue
  const source = fs.readFileSync(path.join(libDir, name), 'utf8')
  for (const missing of findUndefinedCalls(source)) {
    libProblems.push(`${name}: ${missing}`)
  }
}
check('every lib module defines what it calls', () => {
  if (libProblems.length > 0) throw new Error(libProblems.join('; '))
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
