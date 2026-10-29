/**
 * 首次数据目录的种子。
 *
 * 两条安装路径的落盘形态不同：
 *   - 完整安装（`install.mjs`）：把插件拷进 `<home>/enhance/`，自己种文本与状态；
 *   - bundle 安装（`dsh plugin --profile <p> add …`）：host 直接加载包里的插件，
 *     installer 不参与 —— 插件第一次 `apply()` 时把 `<home>/enhance/` 的两份文件补齐。
 *
 * 所以这里只做两件事：复用「审批种子规则」，以及一个**幂等**的补文件函数。
 * 已有内容一律不覆盖；任何 IO 失败都吞掉并回报，让插件继续走「读不到」的诊断路径，
 * 而不是启动即崩。
 *
 * @module enhance/shared/seed
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { paths, readState, writeState } from './state.mjs'
import { defaultPresetApproval } from './patch-rows.mjs'

/**
 * 首装该种哪一档审批。
 *
 * 宿主在 `user-approval` 里先判档位策略：`approval: never` 的档位在分发前就 `rejected`，
 * 我们种的 `allow` 永远轮不到。所以播种必须看这台机器的实际默认档位，不能无条件种 `allow`：
 * 只要有一个目标 profile 的 `defaultPreset` 是 `never`，就种 `ask`（问人，语义诚实）并带出是谁。
 *
 * @param {{ profile?: string, text: string }[]} patches
 * @returns {{ approval: 'allow' | 'ask', blockedBy: string | undefined }}
 */
export function decideApprovalSeed(patches) {
  for (const patch of patches) {
    const preset = defaultPresetApproval(String(patch?.text ?? ''))
    if (preset?.approval === 'never') {
      return { approval: 'ask', blockedBy: `${patch.profile ?? '?'}:${preset.name}` }
    }
  }
  return { approval: 'allow', blockedBy: undefined }
}

/** 扫 `<home>/profiles/<name>/cordis.patch.yml`，按同一规则决定种子。 */
export function seedApprovalForHome(home) {
  const dir = join(home, 'profiles')
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        let text = ''
        try {
          text = readFileSync(join(dir, entry.name, 'cordis.patch.yml'), 'utf8')
        } catch {
          // 没有 patch 的 profile 不参与判断
        }
        return { profile: entry.name, text }
      })
  } catch {
    return 'allow'
  }
  return decideApprovalSeed(entries).approval
}

/**
 * 补齐 `<home>/enhance/`：
 *   - 目录不存在就建；
 *   - `content-scope.txt` 不存在时，从 `defaultTextPath`（包内默认文本）复制一份；
 *   - `state.json` 不存在时，按 `seedApprovalForHome()` 种下三个开关。
 *
 * 已存在的文件一个字节都不动。返回实际种了哪些，以及（如果有）失败原因。
 *
 * @param {string} home
 * @param {string} [defaultTextPath]
 * @returns {{ textSeeded: boolean, stateSeeded: boolean, error?: string }}
 */
export function ensureEnhanceData(home, defaultTextPath) {
  const p = paths(home)
  const result = { textSeeded: false, stateSeeded: false }
  try {
    if (!existsSync(p.text) && typeof defaultTextPath === 'string' && existsSync(defaultTextPath)) {
      mkdirSync(p.dir, { recursive: true })
      copyFileSync(defaultTextPath, p.text)
      result.textSeeded = true
    }
  } catch (error) {
    result.error = `content-scope: ${String(error?.message ?? error)}`
  }
  try {
    const state = readState(p)
    if (state.degradedReason === 'missing') {
      writeState(p, { enabled: true, contentScope: true, approval: seedApprovalForHome(home) })
      result.stateSeeded = true
    }
  } catch (error) {
    result.error = `${result.error === undefined ? '' : `${result.error}; `}state: ${String(error?.message ?? error)}`
  }
  return result
}
