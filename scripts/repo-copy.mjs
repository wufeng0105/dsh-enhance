/**
 * 「把仓库复制一份」的唯一实现。
 *
 * 为什么需要它：门禁自检与 `gate-counts` 都要一个**一次性副本**去改坏、去跑。
 * 早期实现是 `cpSync(repo, dir, { recursive: true, filter: 排除 node_modules })`——
 * 它只排除 `node_modules`，于是被 `.gitignore` 排除的大目录（本地克隆的 `ZCode/`、
 * 代码索引 `.codegraph/`、草稿区 `.zhll/`）统统跟着复制。
 *
 * 实测代价：`ZCode/` 有 35,912 个文件 / 3 GB，一次 `copyRepo()` 要 200 秒以上，
 * 把 `node --test` 从 15 秒拖到 4 分钟，进而让 `scripts/check.mjs` 的 tests 门禁
 * 在 120 秒超时处误报「0 tests ran, floor is 50」。**慢本身就是一种坏**：
 * 它把「门禁红了」和「门禁没跑完」混成同一个信号。
 *
 * @module scripts/repo-copy
 */

import { cpSync, mkdirSync } from 'node:fs'
import { relative, sep } from 'node:path'

/**
 * 复制一份仓库副本。
 *
 * - 走盘复制，但**跳过所有被 `.gitignore` 排除的本地件**（见 `IGNORED_TOP_LEVEL`）；
 * - `includeGit` 为真时连 `.git` 一起复制（副本里要跑 `git ls-files` /
 *   `git check-ignore` 的用例需要它）；
 * - 未跟踪的新文件**要跟着复制**：自检造负例、新增模块都属于这一类，按 `git ls-files`
 *   复制会把它们丢掉（早期版本踩过：自检复制出的树缺 `scripts/repo-copy.mjs` 本身，
 *   于是 tests 门禁在副本里全红，而 `tests red` 那条负例反而绿了）。
 *
 * @param {string} from 源仓库根
 * @param {string} to 目标目录（不存在会被建）
 * @param {{ includeGit?: boolean }} [options]
 * @returns {string} 目标目录
 */
export function copyRepoTree(from, to, options = {}) {
  mkdirSync(to, { recursive: true })
  const includeGit = options.includeGit === true
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src).split(sep).filter(Boolean)
      if (rel.length === 0) return true
      const top = rel[0]
      if (top === '.git') return includeGit
      return !IGNORED_TOP_LEVEL.has(top)
    },
  })
  return to
}

/** 走盘兜底时跳过的一级目录：全都是被 `.gitignore` 排除的本地件。 */
export const IGNORED_TOP_LEVEL = new Set([
  '.git',
  'node_modules',
  'design',
  '.codegraph',
  '.zhll',
  '.tmp',
  '.dsh',
  'ZCode',
])
