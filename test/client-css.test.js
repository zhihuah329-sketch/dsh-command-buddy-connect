/**
 * Guard the client bundle against the failure that produced "the buttons do
 * nothing".
 *
 * The stylesheet is a template literal. Writing a class name in a comment
 * inside it — `` `.bh-acct` is a flex row `` — closes the template early, and
 * everything after it is parsed as JavaScript. The file then fails to load, the
 * page keeps the *previous* render, and buttons that were just added appear to
 * be dead: no error is shown to the user, because a client bundle that fails to
 * evaluate cannot report its own failure.
 *
 * A syntax check does not catch this. `node --check` passed on the broken file,
 * because the mangled remainder was still valid JavaScript — it just declared a
 * different program.
 *
 * So the invariant is checked structurally: the CSS template must contain no
 * backtick, and the classes the UI relies on must exist in the sheet.
 */
import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const CLIENT = new URL('../client.js', import.meta.url)
const source = fs.readFileSync(CLIENT, 'utf8').replace(/^\uFEFF/, '')

/** The CSS template literal body, without its delimiters. */
function cssBody() {
  const start = source.indexOf('const CSS = `')
  assert.notEqual(start, -1, 'the CSS template was not found')
  const from = start + 'const CSS = `'.length
  const end = source.indexOf('\n`', from)
  assert.notEqual(end, -1, 'the CSS template is not terminated')
  return source.slice(from, end)
}

test('the stylesheet template contains no stray backtick', () => {
  const body = cssBody()
  const offending = body.split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes('`'))
  assert.deepEqual(
    offending.map(({ line, i }) => `${i + 1}: ${line.trim()}`),
    [],
    'a backtick inside the CSS template ends it early and breaks the whole bundle'
  )
})

test('the stylesheet does not contain template interpolation', () => {
  // `${` would also be evaluated, with the same effect on anything after it.
  assert.equal(cssBody().includes('${'), false, 'unexpected interpolation in CSS')
})

test('classes the account UI depends on are present', () => {
  const css = cssBody()
  for (const name of [
    '.bh-modal-back',
    '.bh-modal',
    '.bh-modal-title',
    '.bh-modal-body',
    '.bh-modal-warn',
    '.bh-textarea',
    '.bh-btn-danger',
    '.bh-acct-acts',
    '.bh-btn-sm',
    '.bh-switch-sm',
    '.bh-checkin-bulk'
  ]) {
    assert.ok(
      new RegExp(`${name.replace('.', '\\.')}\\s*[,{]`).test(css),
      `${name} has no rule — its element renders unstyled`
    )
  }
})

test('the dialog backdrop actually covers the viewport', () => {
  const rule = /\.bh-modal-back\s*\{([^}]*)\}/.exec(cssBody())
  assert.ok(rule, 'no .bh-modal-back rule')
  assert.match(rule[1], /position:\s*fixed/, 'without fixed it flows inline and is missed')
  assert.match(rule[1], /inset:\s*0/, 'must cover the viewport')
  assert.match(rule[1], /z-index/, 'must sit above the page')
})
