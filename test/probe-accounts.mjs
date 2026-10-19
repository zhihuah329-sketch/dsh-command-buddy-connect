/**
 * Probe every pooled account against the upstream, so the panel can be compared
 * with reality rather than with the pool's own bookkeeping.
 *
 * Sends one minimal request per account. Prints the status and the upstream's
 * own wording; never prints token material.
 *
 * Run: node probe-accounts.mjs
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
const accounts = JSON.parse(Buffer.concat([
  decipher.update(Buffer.from(blob.data, 'base64')),
  decipher.final()
]).toString('utf8'))

const now = Date.now()
const live = accounts.filter((a) => a && a.removed !== true && typeof a.accessToken === 'string' && a.accessToken.length > 0)
console.log('accounts with a token:', live.length)

const HOSTS = { cn: 'https://www.workbuddy.cn', ai: 'https://www.workbuddy.ai' }

for (const account of live) {
  const base = HOSTS[account.site] ?? HOSTS.cn
  const headers = {
    authorization: `Bearer ${account.accessToken}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-user-id': account.uid ?? '',
    'x-product': 'SaaS',
    'x-requested-with': 'XMLHttpRequest',
    'x-domain': account.domain ?? '',
    'user-agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    origin: base,
    referer: `${base}/`
  }
  const body = {
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
    stream: true
  }
  const tag = `${account.site}:${account.label}`
  let verdict
  try {
    const response = await fetch(`${base}/v2/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    if (response.status === 200) {
      await response.body?.cancel()
      verdict = 'OK 200'
    } else {
      const text = await response.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      verdict = `HTTP ${response.status} code=${parsed?.code ?? '?'} ${String(parsed?.msg ?? text.slice(0, 120))}`
    }
  } catch (error) {
    verdict = `ERR ${error?.name ?? ''} ${error?.message ?? String(error)}`
  }
  const cooling = typeof account.cooldownUntil === 'number' && account.cooldownUntil > now
  console.log(`\n${tag}`)
  console.log(`  vault says: authState=${account.authState} cooling=${cooling ? new Date(account.cooldownUntil).toISOString() : 'no'} lastError=${JSON.stringify(account.lastError ?? '')}`)
  console.log(`  upstream:   ${verdict}`)
}
