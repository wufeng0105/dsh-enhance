#!/usr/bin/env node
/**
 * 代码 → 图。唯一图源是 `code-map.json`；本脚本负责两件事：
 *
 *   --check  把模型和真实源码比对：模块文件是否存在、import 边是否都声明了、
 *            接缝（ctx.on / systemPrompt.section / webServer）是否都登记了。
 *            `--strict` 再渲染一遍并与仓库里的 SVG 逐字节比对；不带 strict 不碰图。
 *   --emit   把 `diagrams` 渲染成 SVG，写到 `docs/generated/`。
 *
 * 为什么要有 --check：手画的图会漂移，漂移的图比没有图更坏。没有 `docs/generated/`
 * 时用默认模式，只守结构；带图产物的树用 `--check --strict`，产物是纯输出，
 * 改代码不重新生成就过不了门。
 *
 * 用法：
 *   node tools/graph.mjs --check [--strict] [--root <项目根>]
 *   node tools/graph.mjs --emit   [--root <项目根>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const enhanceRoot = resolve(here, '..')
const args = process.argv.slice(2)

/**
 * 用法错（缺值/未知参数）只给一行、exit 1。裸传 `resolve(undefined)` 抛的是
 * `node:path` 的 TypeError，栈对「你把 --root 的值忘了」这件事没有信息。
 */
function valueOf(argv, index, flag) {
  const value = argv[index + 1]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${flag} 需要一个值`)
  return value
}

function parseArgs(argv) {
  const options = { check: false, emit: false, strict: false, root: enhanceRoot }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--emit') options.emit = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--root') { options.root = resolve(valueOf(argv, index, '--root')); index += 1 }
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

let cli
try {
  cli = parseArgs(args)
} catch (error) {
  console.error(`graph: ${String(error?.message ?? error)}`)
  process.exit(1)
}

const projectRoot = cli.root
const outDir = join(projectRoot, 'docs', 'generated')

/** 不参与模型检查的：自指的这个文件 + `tests/` 整个目录；其余 tools/ 下的脚本必须登记进 `code-map.json`。 */
const IGNORED = new Set(['tools/graph.mjs', 'tests'])
/**
 * 走盘时跳过的一级/任意层级目录：`tests` 与 `scripts` 各自有别的门禁守着，
 * 其余是被 `.gitignore` 排除的本地件——本地克隆的 `ZCode/` 有 3 万多文件，
 * 让它进模型比对会把一道结构门禁变成一次全盘扫描。
 */
const SKIP_DIRS = new Set(['node_modules', 'tests', 'scripts', 'design', '.codegraph', '.zhll', '.tmp', '.dsh', 'ZCode', '.git'])

function toPosix(value) {
  return value.split(sep).join('/')
}

function walk(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...walk(join(dir, entry.name), base))
    } else if (/\.(mjs|js)$/.test(entry.name)) {
      out.push(toPosix(relative(base, join(dir, entry.name))))
    }
  }
  return out
}

function loadMap() {
  return JSON.parse(readFileSync(join(enhanceRoot, 'code-map.json'), 'utf8'))
}

/** 从源码里抽静态 import 目标、事件名与接缝标记。 */
function scan(files) {
  const imports = new Map()
  const tokens = new Map()
  for (const file of files) {
    const text = readFileSync(join(enhanceRoot, file), 'utf8')
    const specs = new Set()
    for (const match of text.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/gm)) specs.add(match[1])
    for (const match of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.add(match[1])
    imports.set(file, specs)

    const set = new Set()
    for (const match of text.matchAll(/ctx\.on\(\s*['"]([^'"]+)['"]/g)) set.add('event:' + match[1])
    if (text.includes('systemPrompt.section')) set.add('seam:systemPrompt')
    if (text.includes('webServer')) set.add('seam:webServer')
    tokens.set(file, set)
  }
  return { imports, tokens }
}

/** 把相对 import 解析成 enhance 内的 posix 路径；外部包返回 undefined。 */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return undefined
  const target = resolve(enhanceRoot, dirname(fromFile), spec)
  return toPosix(relative(enhanceRoot, target))
}

function check(map, strict = false) {
  const errors = []
  const files = walk(enhanceRoot).filter((file) => !IGNORED.has(file))
  const byId = new Map(map.modules.map((module) => [module.id, module]))
  const byPath = new Map(map.modules.map((module) => [module.path, module]))

  // 1. 声明的模块必须存在
  for (const module of map.modules) {
    try {
      statSync(join(enhanceRoot, module.path))
    } catch {
      errors.push(`模块 ${module.id} 的 path 不存在：${module.path}`)
    }
  }

  // 2. 源码里每个 .mjs 都必须登记（除 tools/tests）
  for (const file of files) {
    if (!byPath.has(file)) errors.push(`源码未登记进 code-map：${file}`)
  }

  const { imports, tokens } = scan(files)
  const declared = new Set(map.edges.filter((edge) => edge.kind === 'import').map((edge) => edge.from + '->' + edge.to))

  // 3. import 边：源码有的必须声明，声明的必须存在
  for (const [file, specs] of imports) {
    const from = byPath.get(file)
    if (!from) continue
    for (const spec of specs) {
      const target = resolveSpecifier(file, spec)
      if (target === undefined) continue
      const to = byPath.get(target)
      if (!to) {
        errors.push(`${file} import 了未登记的模块：${spec}`)
        continue
      }
      if (!declared.has(from.id + '->' + to.id)) errors.push(`import 边未声明：${from.id} -> ${to.id}`)
    }
  }
  for (const edge of map.edges) {
    if (edge.kind !== 'import') continue
    if (!byId.has(edge.from) || !byId.has(edge.to)) errors.push(`import 边引用了不存在的模块：${edge.from} -> ${edge.to}`)
  }

  // 4. 接缝：源码出现的事件/接缝标记必须登记
  for (const [file, set] of tokens) {
    const module = byPath.get(file)
    if (!module) continue
    for (const token of set) {
      if (token.startsWith('event:')) {
        const name = token.slice('event:'.length)
        if (!map.events.some((event) => event.name === name && event.owner === module.id)) {
          errors.push(`${module.id} 监听了未登记的事件：${name}`)
        }
      } else {
        const seam = token.slice('seam:'.length)
        const declaredSeam = map.edges.some((edge) => edge.kind === 'seam' && edge.from === module.id && edge.via.includes(seam))
        if (!declaredSeam) errors.push(`${module.id} 用了未登记的接缝：${seam}`)
      }
    }
  }

  if (strict) {
    // 5. 图产物漂移
    for (const diagram of map.diagrams) {
      const svg = renderDiagram(diagram)
      const path = join(outDir, diagram.id + '.svg')
      let current
      try {
        current = readFileSync(path, 'utf8')
      } catch {
        errors.push(`图未生成：docs/generated/${diagram.id}.svg（跑 --emit）`)
        continue
      }
      if (current !== svg) errors.push(`图与模型不一致：${diagram.id}.svg（跑 --emit 重新生成）`)
    }

    // 6. 反向：目录里多出来的 SVG 也要报——删掉模型项而忘了删文件，同样算漂移
    const expected = new Set(map.diagrams.map((diagram) => diagram.id + '.svg'))
    let present = []
    try {
      present = readdirSync(outDir).filter((name) => name.endsWith('.svg'))
    } catch {
      present = []
    }
    for (const name of present) {
      if (!expected.has(name)) errors.push(`多余的图：docs/generated/${name}（从 code-map 删掉了模型项？删文件或登记回去）`)
    }
  }

  return errors
}

// ---------- SVG 渲染（无第三方依赖，固定布局） ----------

const BOX_W = 186
const BOX_H = 58
const GAP_X = 74
const GAP_Y = 34

function escapeXml(value) {
  return String(value).replace(/[<>&"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[char]))
}

function layout(diagram) {
  const positions = new Map()
  if (diagram.layout === 'row') {
    diagram.nodes.forEach((node, index) => {
      positions.set(node.id, { x: 40 + index * (BOX_W + GAP_X), y: 120 })
    })
    return { positions, width: 40 + diagram.nodes.length * (BOX_W + GAP_X), height: 260 }
  }
  const columns = new Map()
  for (const node of diagram.nodes) {
    const group = node.group ?? 0
    if (!columns.has(group)) columns.set(group, [])
    columns.get(group).push(node)
  }
  const sorted = [...columns.keys()].sort((a, b) => a - b)
  let maxRows = 0
  sorted.forEach((group, columnIndex) => {
    const rows = columns.get(group)
    maxRows = Math.max(maxRows, rows.length)
    rows.forEach((node, rowIndex) => {
      positions.set(node.id, { x: 40 + columnIndex * (BOX_W + GAP_X), y: 110 + rowIndex * (BOX_H + GAP_Y) })
    })
  })
  return { positions, width: 40 + sorted.length * (BOX_W + GAP_X), height: 150 + maxRows * (BOX_H + GAP_Y) }
}

function renderDiagram(diagram) {
  const { positions, width, height } = layout(diagram)
  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${diagram.id}-title ${diagram.id}-desc">`)
  // 无障碍契约：<title> 必须是第一个子元素，id 带图 slug，aria-labelledby 先 title 后 desc
  parts.push(`<title id="${diagram.id}-title">${escapeXml(diagram.title)}</title>`)
  parts.push(`<desc id="${diagram.id}-desc">${escapeXml(diagram.subtitle ?? diagram.title)}</desc>`)
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#8a8a90"/></marker></defs>`)
  parts.push(`<style>
    .t { font: 600 18px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; fill: #1d1d1f }
    .s { font: 13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; fill: #6b6b70 }
    .n { font: 14px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; fill: #1d1d1f }
    .b { fill: #ffffff; stroke: #d9d9d5; rx: 12 }
    .e { stroke: #b9b9c0; stroke-width: 1.6; fill: none }
    .el { font: 12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; fill: #8a8a90 }
    @media (prefers-color-scheme: dark) { .t,.n { fill: #ececf0 } .b { fill: #1f1f23; stroke: #35353c } .e { stroke: #4a4a52 } .s,.el { fill: #9b9ba4 } }
  </style>`)
  parts.push(`<rect width="100%" height="100%" fill="none"/>`)
  parts.push(`<text class="t" x="40" y="42">${escapeXml(diagram.title)}</text>`)
  if (diagram.subtitle) parts.push(`<text class="s" x="40" y="64">${escapeXml(diagram.subtitle)}</text>`)

  for (const edge of diagram.edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (!from || !to) continue
    const sameRow = Math.abs(from.y - to.y) < 1
    const x1 = sameRow ? from.x + BOX_W : from.x + BOX_W / 2
    const y1 = sameRow ? from.y + BOX_H / 2 : from.y + BOX_H
    const x2 = sameRow ? to.x : to.x + BOX_W / 2
    const y2 = sameRow ? to.y + BOX_H / 2 : to.y
    const dash = edge.dashed ? ' stroke-dasharray="5 4"' : ''
    if (sameRow) {
      parts.push(`<line class="e" x1="${x1}" y1="${y1}" x2="${x2 - 8}" y2="${y2}"${dash} marker-end="url(#arrow)"/>`)
    } else if (Math.abs(x1 - x2) < 1) {
      parts.push(`<line class="e" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2 - 8}"${dash} marker-end="url(#arrow)"/>`)
    } else {
      const midY = to.y - 18
      parts.push(`<polyline class="e" points="${x1},${y1} ${x1},${midY} ${x2},${midY} ${x2},${y2 - 8}"${dash} marker-end="url(#arrow)"/>`)
    }
    if (edge.label) parts.push(`<text class="el" x="${(x1 + x2) / 2 + 6}" y="${(y1 + y2) / 2 - 6}">${escapeXml(edge.label)}</text>`)
  }

  for (const node of diagram.nodes) {
    const position = positions.get(node.id)
    if (!position) continue
    parts.push(`<rect class="b" x="${position.x}" y="${position.y}" width="${BOX_W}" height="${BOX_H}" stroke-width="1.2"/>`)
    parts.push(`<text class="n" x="${position.x + BOX_W / 2}" y="${position.y + BOX_H / 2 + 5}" text-anchor="middle">${escapeXml(node.label)}</text>`)
  }
  parts.push('</svg>')
  return parts.join('\n') + '\n'
}

// ---------- 入口 ----------

const map = loadMap()
if (cli.emit) {
  mkdirSync(outDir, { recursive: true })
  for (const diagram of map.diagrams) {
    writeFileSync(join(outDir, diagram.id + '.svg'), renderDiagram(diagram), 'utf8')
    console.log(`emitted docs/generated/${diagram.id}.svg`)
  }
} else if (cli.check) {
  const strict = cli.strict
  if (!strict && !existsSync(outDir)) console.log('[graph] docs/generated 不存在：跳过图比对（--strict 才会要求图产物）')
  const errors = check(map, strict)
  if (errors.length > 0) {
    console.error(`[graph] 模型与代码/产物不一致（${errors.length} 项）：`)
    for (const error of errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`[graph] OK：${map.modules.length} 个模块 / ${map.edges.length} 条边${strict ? ` / ${map.diagrams.length} 张图与模型一致` : '（结构检查；加 --strict 才逐字节比图）'}`)
} else {
  console.error('graph: 用法：node tools/graph.mjs --check [--strict] | --emit [--root <项目根>]')
  process.exit(1)
}
