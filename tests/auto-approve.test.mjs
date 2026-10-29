/**
 * `auto-approve` 的三态映射。
 *
 * 这组用例存在的理由：三态是状态层的核心卖点，但之前**零覆盖**——
 * 把 `deny` 分支删掉、或整块 `ctx.on('approval/request')` 删掉，测试仍全绿。
 * 这里用一个假 ctx 把注册的 handler 抓出来，直接喂 `(req, next)`。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../auto-approve/index.js'

/** 把 DSH_HOME 指到临时目录并写一份 state.json。 */
function withApproval(approval, enabled = true) {
  const home = mkdtempSync(join(tmpdir(), 'enhance-approve-'))
  mkdirSync(join(home, 'enhance'), { recursive: true })
  writeFileSync(join(home, 'enhance', 'state.json'), JSON.stringify({ version: 3, enabled, contentScope: true, approval }))
  process.env.DSH_HOME = home
}

/** 假 ctx：抓下注册的事件处理器与其选项。 */
function captureHandler() {
  let captured
  const ctx = {
    on(event, handler, options) {
      captured = { event, handler, options }
    },
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  apply(ctx)
  assert.ok(captured !== undefined, 'apply 没有注册 approval/request')
  return captured
}

test('allow：回 allowed-once，且不把决定交还下游', async () => {
  withApproval('allow')
  const { event, handler, options } = captureHandler()
  assert.equal(event, 'approval/request')
  assert.deepEqual(options, { prepend: true })

  let downstreamCalled = false
  const outcome = await handler({}, () => {
    downstreamCalled = true
    return 'DOWNSTREAM'
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(downstreamCalled, false)
})

test('ask：调 next() 交还下游', async () => {
  withApproval('ask')
  const { handler } = captureHandler()
  let downstreamCalled = false
  const outcome = await handler({}, () => {
    downstreamCalled = true
    return 'DOWNSTREAM'
  })
  assert.equal(outcome, 'DOWNSTREAM')
  assert.equal(downstreamCalled, true)
})

test('deny：回 rejected，不问也不交还', async () => {
  withApproval('deny')
  const { handler } = captureHandler()
  let downstreamCalled = false
  const outcome = await handler({}, () => {
    downstreamCalled = true
    return 'DOWNSTREAM'
  })
  assert.equal(outcome, 'rejected')
  assert.equal(downstreamCalled, false)
})

test('ask 且没有下游：明确回 unavailable（不是静默失败）', async () => {
  withApproval('ask')
  const { handler } = captureHandler()
  assert.equal(await handler({}, undefined), 'unavailable')
})

test('总开关关：即使 approval 是 allow，也把决定交还下游', async () => {
  withApproval('allow', false)
  const { handler } = captureHandler()
  let downstream = false
  const outcome = await handler({}, () => {
    downstream = true
    return 'DOWNSTREAM'
  })
  assert.equal(outcome, 'DOWNSTREAM')
  assert.equal(downstream, true)
})