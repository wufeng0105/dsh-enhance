#!/usr/bin/env node
/**
 * 文档门禁：把「机械残渣」变成红灯。
 *
 * 为什么要有它：代码侧的门禁（`node --check` / `--test` / `graph --check` / `bundle`）
 * 都只管代码与结构，文档侧一条都没有——`graph` 只比 SVG，`bundle` 只看 patch 声明。
 * 于是 `design.md` 里能躺一整行字面反斜杠 n、能用死链接、
 * 能把用例数写成三个版本，而所有闸都绿。
 *
 * 三条检查，都只读：
 *   1. 正文（代码块与行内代码之外）里的字面 `反斜杠+n` / `反斜杠+t`——写盘转义没生效的痕迹
 *   2. 相对链接指向的文件必须存在
 *   3. 反引号里点名的仓库路径必须存在（`docs/...` / `enhance/...` / `.zhll/...`）；
 *      只扫正文（代码块里的命令不按路径查），带 `<...>` 或 `*` 占位的不查，
 *      带 `:行号` 的按路径查，历史件（audit/repair/archive）不查
 *
 * 退出码：0 全过；1 有问题或用法错（用法错只打一行消息，不吐栈）。
 *
 * 用法：node enhance/tools/docs-check.mjs [--root <项目根>]
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
  if (existsSync(join(projectRoot, 'README.md'))) out.push(join(projectRoot, 'README.md'))
  if (existsSync(join(projectRoot, 'docs'))) add(join(projectRoot, 'docs'))
  if (existsSync(join(projectRoot, 'enhance'))) add(join(projectRoot, 'enhance'))
  if (existsSync(join(projectRoot, '_artifacts'))) add(join(projectRoot, '_artifacts'))
  // .zhll 是草稿区：里面的调研件会引用宿主仓库的相对路径，不纳入死路径检查
  return out
}

/** 历史件：里面的旧路径是有意的。 */
function isHistorical(relative) {
  return /^docs\/(audit|repair|archive)\//.test(relative) || /^docs\/(audit-|repair-)/.test(relative)
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
  if (!isHistorical(relative)) {
    for (const { line } of proseLines(text)) {
      for (const match of line.matchAll(/`([^`]+)`/g)) {
        const token = match[1].trim()
        if (!/^(docs|enhance|\.zhll|_artifacts|deepseek-harness)\//.test(token)) continue
        if (/[<>*{}]/.test(token)) continue
        if (!token.includes('.') && !token.endsWith('/')) continue
        const bare = token.split('#')[0].replace(/(:\d+(-\d+)?(,\d+)*)+$/, '')
        if (!existsSync(join(projectRoot, bare))) problems.push(`${relative} 提到不存在的路径：${token}`)
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`[docs] ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`[docs] OK：${collectDocs().length} 份文档，字面转义 / 死链 / 死路径三项都过`)
