/**
 * README 自检：把 README 写作规范里的硬性约束逐条跑成可执行检查。
 *
 * 为什么独立于 `scripts/check.mjs` 的其它门禁：这些约束是**结构性的**——
 * 章节顺序、站内链接是否失效、图是否真的存在、ToC 是否覆盖全部二级标题、
 * 代码块有没有标语言、许可证是不是最后一节。它们的共同点是：
 * 人眼核对容易漏，漏了就静默退化（链接红了没人知道，ToC 少一节没人知道）。
 *
 * 与 version 门的关系：version 门只管「README 必须逐字含 package.json 派生的那句
 * 适用版本」。这里管其余部分，两边不重叠。
 *
 * 两种用法：
 *   - 当门禁：`import { gateReadme } from './check-readme.mjs'`；
 *   - 单独跑：`node scripts/check-readme.mjs`（打印逐项结果）。
 *
 * @module scripts/check-readme
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 两个版本：中文是默认页，英文是副页。 */
const FILES = ['README.md', 'README.en.md']

/**
 * 中文标题 → 英文 slug。standard-readme 的 linter 只认英文 slug，
 * 中文标题靠这张表映射过去。
 */
const SLUG = {
  它做什么: 'what it does', 目录: 'contents', 安装: 'install', 依赖: 'dependencies',
  用法: 'usage', 设置页: 'settings page', 卸载: 'uninstall', 它怎么接进去的: 'how it fits together',
  兼容性: 'compatibility', 'enhanced 权限档': 'the enhanced preset', 维护者: 'maintainer',
  如何贡献: 'contributing', 许可证: 'license',
}

/** standard-readme 的章节顺序（可选章节可省，顺序不可换）。 */
const ORDER = [
  'install', 'usage', 'api', 'maintainer', 'maintainers', 'thanks', 'credits',
  'acknowledgements', 'contributing', 'license',
]

/**
 * 跑一遍全部检查。
 * @param {string} [base] 仓库根
 * @returns {{ pass: boolean, detail: string, problems: string[], total: number }}
 */
export function gateReadme(base = repo) {
  const problems = []
  let total = 0

  /** 记一条检查结果。 */
  const check = (file, ok, message) => {
    total += 1
    if (!ok) problems.push(`${file}: ${message}`)
  }

  for (const file of FILES) {
    const path = resolve(base, file)
    if (!existsSync(path)) {
      problems.push(`${file}: 文件不存在`)
      total += 1
      continue
    }
    const raw = readFileSync(path, 'utf8')
    const lines = raw.split('\n')

    // 1. H1 标题与仓库名对应
    const h1 = lines.find((l) => l.startsWith('# '))
    check(file, h1 !== undefined, '有 H1 标题')
    check(file, /^# dsh-enhance\b/.test(h1 ?? ''), `H1 与仓库名对应（实际：${h1 ?? '无'}）`)

    // 2. 一句话简介：独立成行、<120 字符、不以 > 开头。
    //    定位方式：H1 之后第一段「既不是标题、也不是徽章/图片、也不是语言切换」的行。
    const afterH1 = lines.slice(lines.findIndex((l) => l.startsWith('# ')) + 1)
    const intro = afterH1.find((l) => l.trim() !== '' && !l.startsWith('#') && !l.startsWith('[') && !l.startsWith('![') && !l.startsWith('>'))
    check(file, intro !== undefined && intro.trim().length < 120, `一句话简介 <120 字符（实际 ${intro?.trim().length ?? 0}）`)
    check(file, intro !== undefined && !intro.trim().startsWith('>'), '一句话简介不以 > 开头')

    // 3. 章节顺序
    const rawHeadings = lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim())
    const headings = rawHeadings.map((h) => SLUG[h] ?? h.toLowerCase())
    const positions = headings.map((h) => ORDER.findIndex((s) => h.startsWith(s))).filter((i) => i >= 0)
    check(file, positions.every((v, i) => i === 0 || v >= positions[i - 1]), `章节顺序符合 standard-readme（${rawHeadings.join(' | ')}）`)

    // 4. License 是最后一节
    check(file, (headings[headings.length - 1] ?? '').startsWith('license'), 'License 是最后一节')

    // 5. 站内链接用相对路径、目标真实存在、链接文本未折行
    for (const match of raw.matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const [, text, target] = match
      if (/^(https?:|mailto:|#)/.test(target)) continue
      check(file, target.startsWith('./') || target.startsWith('../'), `站内链接用相对路径：${target}`)
      check(file, existsSync(resolve(base, target)), `站内链接有效：${target}`)
      check(file, !text.includes('\n'), `链接文本未折行：${text.slice(0, 40)}`)
    }

    // 6. 代码块标注语言：成对的 ``` 之间必须有语言标记
    const fences = lines.map((l, i) => ({ l, i })).filter((x) => x.l.startsWith('```'))
    for (let k = 0; k + 1 < fences.length; k += 2) {
      check(file, fences[k].l.slice(3).trim() !== '', `代码块标注语言（行 ${fences[k].i + 1}）`)
    }

    // 7. 本地图片真实存在（徽章是外链 URL，不查）
    for (const match of raw.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      const target = match[2]
      if (/^https?:/.test(target)) continue
      check(file, existsSync(resolve(base, target)), `图片存在：${target}`)
    }

    // 8. ToC 覆盖全部二级标题（正文 > 100 行时必须）；ToC 自身不列入
    if (lines.length > 100) {
      check(file, /^(## Contents|## 目录)$/m.test(raw), '正文 >100 行，有 ToC')
      const anchors = [...raw.matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)/gm)].map((m) => m[2])
      const expected = rawHeadings.filter((h) => h !== 'Contents' && h !== '目录')
        .map((h) => h.toLowerCase().replace(/[^a-z0-9一-鿿 -]/g, '').trim().replace(/ /g, '-'))
      const missing = expected.filter((e) => !anchors.includes(e))
      check(file, missing.length === 0, `ToC 覆盖全部二级标题${missing.length ? `（缺 ${missing.join(', ')}）` : ''}`)
    }

    // 9. 无空章节（下一节标题之前必须有正文）
    const headingIndexes = lines.map((l, i) => ({ l, i })).filter((x) => /^## /.test(x.l))
    for (let k = 0; k < headingIndexes.length; k += 1) {
      const from = headingIndexes[k].i + 1
      const to = k + 1 < headingIndexes.length ? headingIndexes[k + 1].i : lines.length
      check(file, lines.slice(from, to).some((l) => l.trim() !== ''), `章节非空：${headingIndexes[k].l.slice(3).trim()}`)
    }

    // 10. 徽章不超过 4 个
    const badges = (raw.match(/!\[[^\]]*\]\(https?:\/\/[^)]*badge[^)]*\)/g) ?? []).length
    check(file, badges <= 4, `徽章 ${badges} 个（上限 4）`)

    // 11. 许可证含 SPDX 标识符与版权者
    check(file, /MIT © \d{4} \S/.test(raw), '含 SPDX 标识符与版权年份、版权者')
  }

  // 12. 两个版本互相指向
  const zhRaw = readFileSync(resolve(base, 'README.md'), 'utf8')
  const enRaw = readFileSync(resolve(base, 'README.en.md'), 'utf8')
  check('README.md', zhRaw.includes('[English](./README.en.md)'), '指向英文版')
  check('README.en.md', enRaw.includes('[简体中文](./README.md)'), '指向中文版')

  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${total} 项检查全过` : `${problems.length} 项不合规：${problems.slice(0, 3).join(' | ')}`,
    problems,
    total,
  }
}

// 直接运行时打印逐项结果；被 import 时只导出函数。
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-readme.mjs')) {
  const result = gateReadme()
  if (result.pass) {
    console.log(`[readme] OK：${result.total} 项检查全过`)
  } else {
    console.error(`[readme] ${result.problems.length} 项不合规：`)
    for (const problem of result.problems) console.error(`  - ${problem}`)
  }
  process.exit(result.pass ? 0 : 1)
}
