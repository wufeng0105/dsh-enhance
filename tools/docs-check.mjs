#!/usr/bin/env node
/**
 * 文档门禁：把「机械残渣」变成红灯。
 *
 * 为什么要有它：代码侧的门禁（`node --check` / `--test` / `graph --check` / `bundle`）
 * 都只管代码与结构，文档侧一条都没有——`graph` 只比 SVG，`bundle` 只看 patch 声明。
 * 于是文档里能躺一整行字面反斜杠 n、能用死链接、能把同一件事写出三个版本，
 * 而所有闸都绿（历史上真实发生过，才有了这道门）。
 *
 * 三条检查，都只读：
 *   1. 正文（代码块与行内代码之外）里的字面 `反斜杠+n` / `反斜杠+t`——写盘转义没生效的痕迹
 *   2. 相对链接指向的文件必须存在
 *   3. 反引号里点名的 `docs/...` 路径必须存在
 *
 * 收集范围：README.md、CHANGELOG.md、CONTRIBUTING.md、`docs/**` 下的 markdown。
 * 后两份是 2026-11-02 补进来的（审计 §3.3：`CHANGELOG.md`、`CONTRIBUTING.md` 根本不在
 * 收集范围，于是它们里面的死路径与字面转义没人管）。三份根文档必须存在：删掉一份不是
 * 「没写坏」，是门禁瞎了——所以缺文件也判红。
 * 草稿区 `.zhll/` 仍不在收集范围（不入库、不随包发布）。只扫正文（代码块里的命令
 * 不按路径查），带 `<...>` 或 `*` 占位的不查，带 `:行号` 的按路径查
 *
 * 退出码：0 全过；1 有问题或用法错（用法错只打一行消息，不吐栈）。
 *
 * 用法：node tools/docs-check.mjs [--root <项目根>]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)

/** 用法错（缺值/未知参数）只给一行、exit 1；`resolve(undefined)` 的 TypeError 栈没有信息。 */
function parseArgs(argv) {
  const options = { root: resolve(here, '..') }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--root 需要一个值')
      options.root = resolve(value)
      index += 1
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

let options
try {
  options = parseArgs(args)
} catch (error) {
  console.error(`docs-check: ${String(error?.message ?? error)}`)
  process.exit(1)
}

const projectRoot = options.root

/** 必须存在的根文档：少一份就是门禁瞎了，不是「没写坏」。 */
const REQUIRED_DOCS = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md']

/** 参与检查的文档。 */
function collectDocs() {
  const out = []
  const add = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        add(path)
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.md')) out.push(path)
    }
  }
  for (const name of REQUIRED_DOCS) {
    const path = join(projectRoot, name)
    if (existsSync(path)) out.push(path)
  }
  if (existsSync(join(projectRoot, 'docs'))) add(join(projectRoot, 'docs'))
  // 草稿区（.zhll/）与宿主仓库不在收集范围，本来就不会被扫到
  return out
}

/** 去掉代码块，返回正文行与行号。 */
function proseLines(text) {
  const out = []
  let fenced = false
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      return
    }
    if (!fenced) out.push({ line, number: index + 1 })
  })
  return out
}

const problems = []

// 缺必需文档 = 门禁静默失效，先判红：后面三条检查都只对「收到的文件」负责
for (const name of REQUIRED_DOCS) {
  if (!existsSync(join(projectRoot, name))) problems.push(`缺必需文档：${name}（不在收集范围不是「没写坏」，是门禁瞎了）`)
}

for (const file of collectDocs()) {
  const text = readFileSync(file, 'utf8')
  const relative = file.slice(projectRoot.length + 1).replace(/\\/g, '/')

  // 1 字面转义：先抹掉行内代码，避免把 `` `\n` `` 这种"正在讲转义"的句子误判
  for (const { line, number } of proseLines(text)) {
    const withoutCode = line.replace(/`[^`]*`/g, '')
    if (/\\[nt]/.test(withoutCode)) problems.push(`${relative}:${number} 正文里有字面反斜杠转义（写盘转义没生效？）`)
  }

  // 2 相对链接
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    if (/[<>*]/.test(target)) continue
    const path = resolve(dirname(file), target.split('#')[0])
    if (!existsSync(path)) problems.push(`${relative} 链接指向不存在的文件：${target}`)
  }

  // 3 反引号里的仓库路径（只扫正文：代码块里的命令按命令看，不按路径看）
  for (const { line } of proseLines(text)) {
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      const token = match[1].trim()
      // 只校验随包发布的 `docs/`。`.zhll/` 是 gitignore 的草稿区：本地有、干净 checkout 里
      // 永远没有，拿它做「路径存在」判据会让这道门在 CI 上必红——实测：`CONTRIBUTING.md` 那句
      // 「不要提交 `.zhll/`」的提醒把 docs 门判红，而本机全绿。门禁不该依赖未被跟踪的本地状态。
      if (!/^docs\//.test(token)) continue
      if (/[<>*{}]/.test(token)) continue
      if (!token.includes('.') && !token.endsWith('/')) continue
      const bare = token.split('#')[0].replace(/(:\d+(-\d+)?(,\d+)*)+$/, '')
      if (!existsSync(join(projectRoot, bare))) problems.push(`${relative} 提到不存在的路径：${token}`)
    }
  }
}

if (problems.length > 0) {
  console.error(`[docs] ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`[docs] OK：${collectDocs().length} 份文档（README + CHANGELOG + CONTRIBUTING + docs/**），字面转义 / 死链 / 死路径三项都过`)
