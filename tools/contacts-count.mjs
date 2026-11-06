#!/usr/bin/env node
/**
 * 宿主触点数的机器来源。
 *
 * 口径写在 `docs/host-seams.md` 的「宿主触点」节里（数法 a/b/c）：把那张分组表的
 * 第二列按「、」分段，其中「版本探测链」按 `→` 拆；两段相加就是触点数。
 *
 * 为什么读这份文档而不是 `docs/compatibility.md`：触点表是体检资产，与版本声明契约解耦
 * （表搬出后契约文档可以整份处置，表长存）。口径仍只有一处，改口径就改那份文档。
 *
 * 为什么需要它：`hostContacts` 原先标 `manual`，理由是「口径是散文公式，机算不了」。
 * 实测可以机算——按上面口径复算得到 36，与文档一致。标 `manual` 的代价是**没人核**：
 * 谁把这个数改成任意值，文档跟着改就全绿，等于自证。
 *
 * 数不出来 / 表结构变了 → 判红（不许静默通过）。表改了让数变了，就同步单一来源。
 *
 * 用法：node tools/contacts-count.mjs [--root <项目根>]
 * 退出码：0 与单一来源一致；1 不一致 / 表读不出来。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
let root = resolve(here, '..')
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--root') {
    if (args[i + 1] === undefined) { console.error('contacts-count: --root 需要一个值'); process.exit(2) }
    root = resolve(args[i + 1]); i += 1
  } else { console.error(`contacts-count: 未知参数 ${args[i]}`); process.exit(2) }
}

const docPath = join(root, 'docs', 'host-seams.md')
if (!existsSync(docPath)) {
  console.error('[contacts] 读不到 docs/host-seams.md：触点表是唯一口径来源，缺了没法数')
  process.exit(1)
}

const lines = readFileSync(docPath, 'utf8').split(/\r?\n/)
const sectionStart = lines.findIndex((line) => /^## 宿主触点/.test(line))
if (sectionStart < 0) {
  console.error('[contacts] 找不到「## 宿主触点」节：口径没了，不许静默通过')
  process.exit(1)
}

/** 取该节里的第一张表（遇到非表格行即结束）。 */
const rows = []
let inTable = false
for (let i = sectionStart; i < lines.length; i += 1) {
  const line = lines[i]
  if (/^###/.test(line)) break
  if (/^\| cordis 插件 API \|/.test(line)) inTable = true
  if (!inTable) continue
  if (!/^\|/.test(line)) break
  if (/^\|\s*-+/.test(line)) continue
  rows.push({ line: i + 1, text: line })
}
if (rows.length === 0) {
  console.error('[contacts] 触点表一行都没读到：表结构变了，先修本脚本的数法再谈数字')
  process.exit(1)
}

/** 按口径数一行。返回 { count, how }。 */
function countRow(name, cell) {
  if (/版本探测链/.test(name)) {
    const parts = cell.split('→').map((s) => s.trim()).filter(Boolean)
    return { count: parts.length, how: `${parts.length} 条（按 → 拆）` }
  }
  // 括号里的补充说明不算触点：「（…）」整段剥掉再按「、」分段
  const parts = cell.replace(/（[^）]*）/g, '').split('、').map((s) => s.trim()).filter(Boolean)
  return { count: parts.length, how: `${parts.length} 段（按 、 拆）` }
}

let total = 0
const detail = []
for (const row of rows) {
  const cols = row.text.split('|')
  const name = (cols[1] ?? '').trim()
  const cell = (cols[2] ?? '').trim()
  const { count, how } = countRow(name, cell)
  total += count
  detail.push(`  ${name.padEnd(15)} → ${how}`)
}

let declared
try {
  declared = JSON.parse(readFileSync(join(root, 'scripts', 'known-counts.json'), 'utf8'))?.counts?.hostContacts?.value
} catch { /* 读不到由 docs 门报 */ }

if (typeof declared !== 'number') {
  console.error('[contacts] 单一来源里没有 hostContacts.value：数出来了但没处对账')
  process.exit(1)
}
if (declared !== total) {
  console.error(`[contacts] ${rows.length} 行数出来 ${total}，单一来源写 ${declared}：`)
  for (const line of detail) console.error(line)
  console.error('  → 要么触点表漏/多了条目，要么单一来源过期。改表，别只改数。')
  process.exit(1)
}

console.log(`[contacts] OK：${total} 条触点（${rows.length} 组）＝ 单一来源 ${declared}`)
