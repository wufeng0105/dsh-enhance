/**
 * 从 Archify 产出的 HTML 里抽出可独立渲染的 SVG。
 *
 * 为什么要它：Archify 的交付物是交互式 HTML（780 KB，带 viewer 的全部 CSS 与脚本）。
 * GitHub 的 Markdown 只渲染 `<img src="*.svg">`，不执行脚本、不加载外部样式——
 * 直接引 HTML 没有意义，而只截 `<svg>` 会丢掉定义在文档 `<style>` 里的类规则，
 * 图会渲染成没有配色的线框（实测：文字全成黑块）。
 *
 * 所以这里做五件事：
 *   1. 截出 `<svg>…</svg>`；
 *   2. 从文档样式里挑出 SVG 用到的类规则；
 *   3. **两遍扫描**：先拿规则，再从规则体里收集 var(--x) 引用，回到样式里挑出
 *      这些变量的声明块——少了这一步，类规则引用的变量全部落空，颜色归零；
 *   4. 补 `xmlns`（Archify 的 SVG 是 HTML 片段，没有 xmlns，不能当独立文件用）；
 *   5. 用 CDATA 包住 CSS：Archify 的变量块注释里有 `<html>` 这类尖括号，
 *      SVG 按 XML 解析时会把它们当标签开始，直接报 "Unexpected closing tag"。
 *
 * 用法：node scripts/extract-figure-svg.mjs <输入.html> <输出.svg>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
if (input === undefined || output === undefined) {
  console.error('用法：node extract-figure-svg.mjs <输入.html> <输出.svg>')
  process.exit(2)
}

const html = readFileSync(input, 'utf8')

// ---- 1. 截出 SVG 元素
const svgStart = html.indexOf('<svg')
if (svgStart < 0) {
  console.error(`${input}: 找不到 <svg>`)
  process.exit(1)
}
const svgEnd = html.indexOf('</svg>', svgStart)
if (svgEnd < 0) {
  console.error(`${input}: 找不到 </svg>`)
  process.exit(1)
}
let svg = html.slice(svgStart, svgEnd + '</svg>'.length)

// ---- 2. 收集 SVG 用到的 class
const used = new Set()
for (const match of svg.matchAll(/class="([^"]+)"/g)) {
  for (const name of match[1].split(/\s+/)) if (name !== '') used.add(name)
}

const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
const selectorRe = /([^{}]+)\{([^{}]*)\}/g

/** 把样式块拆成 {selectors, body} 列表。 */
function rules() {
  const out = []
  for (const block of styleBlocks) {
    for (const match of block.matchAll(selectorRe)) {
      const selectors = match[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
      if (selectors.length > 0) out.push({ selectors, body: match[2] })
    }
  }
  return out
}
const allRules = rules()

// ---- 3a. 挑出 SVG 用到的类规则
const picked = []
for (const rule of allRules) {
  const hits = rule.selectors.filter((selector) => {
    const classes = [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])
    if (classes.length === 0) return false
    // 只收「选择器里的每个 class 都确实被 SVG 用到」的规则，
    // 避免把 .viewer-xxx 之类整块带进来。
    return classes.every((c) => used.has(c))
  })
  if (hits.length > 0) picked.push(`${hits.join(', ')} {${rule.body}}`)
}
if (picked.length === 0) {
  console.error(`${input}: 没有挑到任何 SVG 类规则`)
  process.exit(1)
}

// ---- 3b. 从挑出的规则体里收集 var(--x) 引用
const varRefs = new Set()
for (const match of svg.matchAll(/var\((--[\w-]+)/g)) varRefs.add(match[1])
for (const rule of picked) {
  for (const match of rule.matchAll(/var\((--[\w-]+)/g)) varRefs.add(match[1])
}

// ---- 3c. 回到样式里挑出这些变量的声明块
const varBlocks = []
for (const rule of allRules) {
  const isVarHost = rule.selectors.some((s) => /^(:root|\[data-theme[^\]]*\]|svg|\.diagram-container)$/.test(s))
  if (!isVarHost) continue
  if (!/--[\w-]+\s*:/.test(rule.body)) continue
  const needed = rule.body.split(';').map((d) => d.trim()).filter((decl) => {
    const name = decl.match(/^(--[\w-]+)\s*:/)
    return name !== null && varRefs.has(name[1])
  })
  if (needed.length > 0) varBlocks.push(`${rule.selectors.join(', ')} {${needed.join(';')};}`)
}
if (varBlocks.length === 0) {
  console.error(`${input}: 变量块一个都没挑到（引用了 ${varRefs.size} 个变量）`)
  process.exit(1)
}

// ---- 4. 组装：规则塞进 SVG **已有** 的 <style>（Archify 的 SVG 自带一个，
//         再开一个会让 XML 解析报错），并补 xmlns
//
//         CSS 内容必须用 CDATA 包裹：Archify 的变量块注释里有 `<html>` 这类尖括号，
//         SVG 按 XML 解析时会把它们当标签开始，直接报 "Unexpected closing tag"。
const styleContent = [...varBlocks, ...picked].join('\n')
const namespace = 'http://www.w3.org/2000/svg'
if (!/xmlns=/.test(svg)) svg = svg.replace('<svg', `<svg xmlns="${namespace}"`)

if (/<style[^>]*>/.test(svg)) {
  // 并入第一个 <style>：插到开标签之后，CDATA 包住 CSS 文本。
  svg = svg.replace(/(<style[^>]*>)/, `$1\n<![CDATA[\n${styleContent}\n]]>`)
} else {
  svg = svg.replace(/(<svg[^>]*>)/, `$1\n<style><![CDATA[\n${styleContent}\n]]></style>`)
}

// 去掉 HTML 专属属性（GitHub 的 SVG 渲染器按 XML 解析）
svg = svg.replace(/\sdata-reader-[a-z-]+="[^"]*"/g, '')
svg = svg.replace(/\slang="([^"]*)"/g, ' xml:lang="$1"')

writeFileSync(output, `${svg}\n`, 'utf8')
console.log(`${output}  ${(svg.length / 1024).toFixed(1)} KB  classes=${used.size} rules=${picked.length} varBlocks=${varBlocks.length} vars=${varRefs.size}`)
