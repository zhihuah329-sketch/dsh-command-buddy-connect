/**
 * The daemon-log reader.
 *
 * The daemon's `/admin/logs` route answers `{"text": "<whole log>"}`, not an
 * array. The reader used to accept only arrays, so it always reported an empty
 * log against a file of hundreds of kilobytes — which made the plugin's most
 * useful diagnostic useless.
 *
 * Run: node test/logs.check.mjs
 */

import { normalizeLogRows as readLogRows } from '../lib/log-parse.js'
import { createChecker } from './harness.mjs'

const { check, finish } = createChecker()

console.log('a newline-joined text blob:')
const blob = readLogRows({
  text: [
    '2026-10-19T02:12:32.697750900+00:00 号池切换 cn en HTTP 429',
    '2026-10-19T02:12:33.273329000+00:00 号池切换 cn 账号 ea33fc HTTP 401'
  ].join('\n')
})
check('is split into one entry per line', blob.length === 2, String(blob.length))
check('category is parsed', blob[0].kind === '号池切换', blob[0].kind)
check('detail is parsed', blob[0].detail === 'cn en HTTP 429', blob[0].detail)
check('timestamp is parsed', blob[0].time === '2026-10-19T02:12:32.697750900+00:00', blob[0].time)

console.log('\nother response shapes:')
check('empty blob yields nothing', readLogRows({ text: '' }).length === 0)
check('whitespace blob yields nothing', readLogRows({ text: '\n\n  \n' }).length === 0)
check('array body passes through', readLogRows([{ detail: 'd' }]).length === 1)
check('logs wrapper is understood', readLogRows({ logs: ['a'] }).length === 1)
check('entries wrapper is understood', readLogRows({ entries: ['a', 'b'] }).length === 2)
check('null body yields nothing', readLogRows(null).length === 0)
check('unrecognisable body yields nothing', readLogRows({ unexpected: 1 }).length === 0)

console.log('\na line the parser cannot fully understand:')
const partial = readLogRows({ text: 'something went wrong' })
check('is kept rather than dropped', partial.length === 1, String(partial.length))
check('keeps the whole line as detail', partial[0]?.detail === 'something went wrong', partial[0]?.detail)

finish()
