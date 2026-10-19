/**
 * Switching accounts when one runs out of quota.
 *
 * A quota refusal reaches the adapter as an SSE `error` event inside an HTTP 200,
 * so the status check never sees it. That path used to record the failure with a
 * *zero* cooldown and return, leaving the account eligible: the next request
 * picked it again and the pool never rotated. An exhausted account was reused
 * indefinitely — "it does not switch accounts when this one runs out".
 *
 * The decision is `streamFailurePlan` in proxy.js. It is tested here rather than
 * through the adapter because local-adapter.js imports harness packages
 * (`ToolCallId`) that only exist from 0.2, so it cannot be loaded on its own.
 *
 * Run: node test/quota-rotation.check.mjs
 */

import { streamFailurePlan } from '../lib/proxy.js'
import { createChecker } from './harness.mjs'

const { check, finish } = createChecker()

console.log('a quota refusal before anything was emitted:')
{
  const plan = streamFailurePlan({ emitted: 0, message: 'insufficient quota: 额度不足，请充值' })
  check('the request is retried on another account', plan.retry === true)
  check('the exhausted account is cooled down', plan.cooldownMs > 0, String(plan.cooldownMs))
  check('the failure is reported as a quota problem', plan.code === 'QUOTA_EXCEEDED', plan.code)
}

console.log('\nrate-limit wording is treated the same way:')
{
  const plan = streamFailurePlan({ emitted: 0, message: 'rate limit exceeded, please slow down' })
  check('rotation is attempted', plan.retry === true)
  check('cooldown applied', plan.cooldownMs > 0, String(plan.cooldownMs))
}

console.log('\nChinese quota wording is recognised:')
{
  for (const message of ['积分不足', '账户余额不足', '请求超限', '当前额度已用尽']) {
    const plan = streamFailurePlan({ emitted: 0, message })
    check(`"${message}" counts as quota`, plan.retry === true && plan.cooldownMs > 0)
  }
}

console.log('\na quota refusal after content was already emitted:')
{
  const plan = streamFailurePlan({ emitted: 3, message: 'insufficient quota' })
  check('the request is not retried mid-stream', plan.retry === false)
  check('the account still steps aside for the next request', plan.cooldownMs > 0, String(plan.cooldownMs))
  check('the failure is reported as a quota problem', plan.code === 'QUOTA_EXCEEDED', plan.code)
}

console.log('\na request-shaped failure is not another account\u2019s problem:')
{
  const plan = streamFailurePlan({ emitted: 0, message: 'malformed request body' })
  check('no rotation', plan.retry === false)
  check('no cooldown, so the account is not punished', plan.cooldownMs === 0, String(plan.cooldownMs))
  check('reported as a provider error', plan.code === 'PROVIDER_ERROR', plan.code)
}

console.log('\nmissing or odd input does not throw:')
{
  for (const input of [undefined, {}, { emitted: -1 }, { message: null }, { emitted: '3', message: '' }]) {
    let ok = true
    try {
      const plan = streamFailurePlan(input)
      ok = typeof plan.retry === 'boolean' && typeof plan.cooldownMs === 'number'
    } catch {
      ok = false
    }
    check(`survives ${JSON.stringify(input)}`, ok)
  }
}

finish()
