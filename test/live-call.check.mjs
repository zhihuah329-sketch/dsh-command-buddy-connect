/**
 * Live proof: does the vault credential actually serve a model call now that the
 * daemon is gone?
 *
 * Reads the CN account straight from the vault (no daemon, no capture) and makes
 * one minimal upstream request with the same headers the plugin sends. Prints the
 * status and a short excerpt; never prints token material.
 *
 * Run: node verify-live-call.mjs
 */

import fs from 'node:fs'
import crypto from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.buddyhub')
const key = fs.readFileSync(join(dir, 'vault.key'))
const blob = JSON.parse(fs.readFileSync(join(dir, 'accounts.enc'), 'utf8'))

const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'), { authTagLength: 16 })
decipher.setAuthTag(Buffer.from(blob.tag, 'base64'))
const plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()])
const accounts = JSON.parse(plain.toString('utf8'))

const now = Date.now()
const usable = accounts.filter((a) => a
  && a.removed !== true
  && a.enabled !== false
  && typeof a.accessToken === 'string'
  && a.accessToken.length > 0
  && !(typeof a.expiresAt === 'number' && a.expiresAt > 0 && a.expiresAt <= now))

console.log('usable accounts:', usable.map((a) => `${a.site}:${a.label}`).join(', ') || '(none)')

const cn = usable.find((a) => a.site === 'cn')
if (cn === undefined) {
  console.log('no usable CN account; skipping the call')
  process.exit(1)
}

// The same header set the plugin builds (see proxy.js upstreamHeaders).
const base = 'https://www.workbuddy.cn'
const headers = {
  authorization: `Bearer ${cn.accessToken}`,
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'x-user-id': cn.uid ?? '',
  'x-product': 'SaaS',
  'x-requested-with': 'XMLHttpRequest',
  'x-domain': cn.domain ?? '',
  'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
  origin: base,
  referer: `${base}/`,
  'x-conversation-id': '00000000-0000-7000-8000-000000000001',
  'x-conversation-request-id': '00000000-0000-7000-8000-000000000002',
  'x-conversation-message-id': '00000000-0000-7000-8000-000000000003',
  'x-request-id': '00000000-0000-7000-8000-000000000003',
  'x-request-trace-id': crypto.randomBytes(16).toString('hex')
}

const body = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: '回复两个字：可用' }],
  max_tokens: 16,
  stream: true
}

const started = Date.now()
let response
try {
  response = await fetch(`${base}/v2/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) })
} catch (error) {
  console.log('CALL FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
const ms = Date.now() - started
console.log(`HTTP ${response.status} in ${ms}ms`)

if (response.status >= 400) {
  const text = await response.text()
  console.log('upstream said:', text.slice(0, 300))
  process.exit(1)
}

let sawContent = false
let excerpt = ''
for await (const chunk of response.body) {
  const text = Buffer.from(chunk).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      const frame = JSON.parse(payload)
      if (frame?.error !== undefined) {
        console.log('STREAM ERROR:', JSON.stringify(frame.error).slice(0, 300))
        process.exit(1)
      }
      const delta = frame?.choices?.[0]?.delta?.content
      if (typeof delta === 'string' && delta.length > 0) {
        sawContent = true
        excerpt += delta
      }
    } catch {
      // keep-alive
    }
  }
}

console.log('content received:', sawContent, '| excerpt:', JSON.stringify(excerpt.slice(0, 40)))
console.log(sawContent ? '\nRESULT: the credential serves calls without any daemon.' : '\nRESULT: HTTP ok but no content — inspect the upstream answer.')
process.exit(sawContent ? 0 : 1)
