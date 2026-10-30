/**
 * 「哪些文件进语法门禁」的唯一答案。
 *
 * 单独成文件是因为这个集合本身是**判据**：门禁报的「N files」必须等于仓库里真实的
 * `.mjs/.js` 数。两边各写一套遍历，读数就会分叉——`design/` 被 `.gitignore` 排除，
 * 走盘会把它算进去，于是两边对不上（曾出现两边读数不一致：门禁报 33 而 tracked 只有 32；现在是 33 / 33）。
 *
 * 所以这里是唯一实现，`scripts/check.mjs` 与测试都从它取：
 *   1. 优先 `git ls-files '*.mjs' '*.js'` —— tracked 就是权威，被忽略的目录天然不在里面；
 *   2. 不是 git 检出（或没有 git）时退回走盘，跳过 `.git` / `node_modules` / `design`
 *      这几个已知的不属于核心仓的目录。
 *
 * 注意走盘与 git 的口径**本来就不完全相等**：走盘看得见未跟踪的新文件，git 不会。
 * 所以「等于 tracked」这条只在 git 路径上成立；走盘路径的不变量是「跳过忽略目录」。
 *
 * @module enhance/scripts/code-files
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 走盘时跳过的目录：`.git` 是仓库元数据，`node_modules` 是依赖，其余是被 `.gitignore`
 * 排除的本地件（`design/`、代码索引 `.codegraph/`、草稿区 `.zhll/`、本地克隆的 `ZCode/`、
 * 临时件 `.tmp/`）——它们不属于核心仓，数进来会让门禁读数与 tracked 对不上。
 */
export const SKIP_DIRS = new Set(['.git', 'node_modules', 'design', '.codegraph', '.zhll', '.tmp', 'ZCode'])

/**
 * @param {string} base 项目根
 * @returns {string[]} 绝对路径，已排序
 */
export function codeFiles(base) {
  const tracked = spawnSync('git', ['ls-files', '-z', '*.mjs', '*.js'], { cwd: base, encoding: 'utf8' })
  if (tracked.status === 0 && typeof tracked.stdout === 'string' && tracked.stdout !== '') {
    return tracked.stdout.split('\u0000').filter(Boolean).map((rel) => join(base, rel)).sort()
  }
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) out.push(path)
    }
  }
  walk(base)
  return out.sort()
}
