/**
 * Live check: read the real daemon log through the fixed parser.
 *
 * Proves the defect end to end — the route answers `{"text": ...}` and the
 * parser now turns that into entries instead of an empty list. Read-only: it
 * uses the daemon's own admin key from `config.json` and prints only counts and
 * the last few lines, never token material.
 *
 * Run: node test/logs.live.mjs
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeLogRows } from '../lib/log-parse.js'

const dir = join(homedir(), '.buddyhub')
const configPath = join(dir, 'config.json')

if (!fs.existsSync(configPath)) {
  console.log('no daemon config; skipped')
  process.exit(0)
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const url = `http://127.0.0.1:${config.adminPort}/admin/logs`

let body
try {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.adminKey}` }
  })
  if (!response.ok) {
    console.error(`admin log route answered ${response.status}`)
    process.exit(1)
  }
  body = await response.json()
} catch (error) {
  console.error(`could not reach the daemon: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const shape = Array.isArray(body)
  ? 'array'
  : typeof body?.text === 'string' ? `{text: string, ${body.text.length} chars}` : Object.keys(body ?? {}).join(',')
console.log(`response shape: ${shape}`)

const rows = normalizeLogRows(body)
console.log(`parsed entries: ${rows.length}`)

if (rows.length === 0) {
  console.error('FAIL: the parser still reports an empty log')
  process.exit(1)
}

const kinds = new Map()
for (const row of rows) kinds.set(row.kind ?? '(none)', (kinds.get(row.kind ?? '(none)') ?? 0) + 1)
console.log('entry categories:')
for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${count}\t${kind}`)
}

console.log('last 5 entries:')
for (const row of rows.slice(-5)) {
  console.log(`  ${row.time ?? ''} [${row.kind ?? 'event'}] ${row.detail ?? ''}`)
}
