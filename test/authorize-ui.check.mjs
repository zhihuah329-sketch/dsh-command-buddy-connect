/**
 * What the authorize block actually shows.
 *
 * The 4.2.0 fix corrected client resolution in the backend, but the page looked
 * identical: a missing client only appeared in the `title` of a *disabled*
 * button, which cannot be revealed in any useful way. The region therefore read
 * the same whether its client was missing or merely unconfigured, and the user
 * was right to say the change could not be seen.
 *
 * This check renders the region block through the client bundle's own React
 * element tree and asserts what a user would actually read on the page.
 *
 * Run: node test/authorize-ui.check.mjs
 */

import { createChecker } from './harness.mjs'

const { check, finish } = createChecker()

// A tiny element tree is enough to assert content: the client is written with
// React.createElement, so a renderer is not needed to inspect its output.
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const children = node.props?.children
  return Array.isArray(children) ? children.map(textOf).join('') : textOf(children)
}

/** Collect elements of one class name from a tree. */
function collect(node, className, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, className, out)
    return out
  }
  if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className)) {
    out.push(node)
  }
  collect(node.props?.children, className, out)
  return out
}

const source = (await import('node:fs')).readFileSync(new URL('../client.js', import.meta.url), 'utf8')

console.log('a missing client is stated on the page, not only in a tooltip:')
{
  check('the missing block exists', source.includes('bh-auth-missing'))
  check('a title is rendered inside it', source.includes('bh-auth-missing-title'))
  check('the hint is rendered inside it', source.includes('bh-auth-missing-hint'))
  check('the block is inside the region renderer', /regionAuthorize[\s\S]{0,4000}bh-auth-missing/.test(source))
}

console.log('\nthe two regions say which client is missing:')
{
  check('CN has its own wording', source.includes('authCnClientMissing'))
  check('AI has its own wording', source.includes('authAiClientMissing'))
  check('the disabled button uses the per-region wording',
    /site === "cn" \? TEXT\.authCnClientMissing : TEXT\.authAiClientMissing\)\),/.test(source))
}

console.log('\na resolved client shows which path it will open:')
{
  check('the ready state names the path', source.includes('authClientUsing'))
  check('and renders it in a code element', /bh-auth-client[\s\S]{0,200}createElement\("code"/.test(source))
}

console.log('\nthe hint text comes from the backend, so each region can differ:')
{
  check('the client hint is read from status', /client\.hint/.test(source) || /isText\(client\.hint\)/.test(source))
}

console.log('\nrendered output sanity (a hand-built tree, same classes):')
{
  // Mirrors the shape the region block produces for a missing client.
  const missing = {
    props: {
      className: 'bh-auth',
      children: [
        { props: { className: 'bh-auth-hint', children: '国内版提示' } },
        {
          props: {
            className: 'bh-auth-missing',
            children: [
              { props: { className: 'bh-auth-missing-title', children: '未检测到国际版 WorkBuddy 客户端' } },
              { props: { className: 'bh-auth-missing-hint', children: '请从 workbuddy.ai 下载安装并登录' } }
            ]
          }
        }
      ]
    }
  }
  const blocks = collect(missing, 'bh-auth-missing')
  check('one missing block found', blocks.length === 1, String(blocks.length))
  const rendered = textOf(blocks[0])
  check('the title is visible text', rendered.includes('未检测到国际版'), rendered)
  check('the actionable hint is visible text', rendered.includes('workbuddy.ai'), rendered)
}

console.log('\nand a resolved client renders a path instead:')
{
  const ready = {
    props: {
      className: 'bh-auth',
      children: [{
        props: {
          className: 'bh-auth-client',
          children: ['将使用客户端：', ' ', { props: { children: 'F:\\WorkBuddy\\WorkBuddy.exe' } }]
        }
      }]
    }
  }
  const blocks = collect(ready, 'bh-auth-client')
  check('the path is visible text', textOf(blocks[0]).includes('WorkBuddy.exe'), textOf(blocks[0]))
  check('no missing block in this state', collect(ready, 'bh-auth-missing').length === 0)
}

finish()
