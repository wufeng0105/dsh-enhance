/**
 * 审批处理（三态，状态可关）。
 *
 * `approval/request` 是 waterfall：返回一个 outcome 即认领该请求，调 `next()` 则交还下游。
 * 三态与宿主 outcome 一一对应：
 *   allow → `allowed-once`（不问人）
 *   ask   → `next()`（GUI 弹窗 / headless 报 no approval channel）
 *   deny  → `rejected`（不问、当场拒）
 *
 * 关掉时必须 `next()`——`return undefined` 会把整条链短路成 `unavailable`，
 * 那不是"不自动放行"，那是"所有审批失败"。
 *
 * 状态从 `../shared/state.mjs` 读（与 `enhance-scope` 同一个文件），每次请求现读，
 * 所以拨开关后下一条需要审批的动作即生效，不用重启。
 */

import { fileURLToPath } from 'node:url'
import { markPluginActive, paths, readState, resolveHome } from '../shared/state.mjs'
import { ensureEnhanceData } from '../shared/seed.mjs'

/** Diagnostics label. */
export const name = 'auto-approve'

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // bundle 安装没有 installer 参与：首次加载时补齐 <home>/enhance/
  ensureEnhanceData(resolveHome(), fileURLToPath(new URL('../shared/content-scope.default.txt', import.meta.url)))

  ctx.on(
    'approval/request',
    (_req, next) => {
      const { enabled, approval } = readState(paths())
      if (enabled === false) return typeof next === 'function' ? next() : Promise.resolve('unavailable')
      if (approval === 'allow') return Promise.resolve('allowed-once')
      if (approval === 'deny') return Promise.resolve('rejected')
      // ask：把决定交还下游；没有下游时说清楚"没有审批通道"，而不是静默失败
      return typeof next === 'function' ? next() : Promise.resolve('unavailable')
    },
    { prepend: true },
  )

  ctx.effect(() => () => markPluginActive('auto-approve', false), 'auto-approve active flag')
  markPluginActive('auto-approve')
}
