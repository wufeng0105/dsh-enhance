#!/usr/bin/env node
/**
 * 代码结构门禁。唯一模型源是 `code-map.json`；本脚本只做一件事：
 *
 *   --check  把模型和真实源码比对：模块文件是否存在、import 边是否都声明了、
 *            接缝（ctx.on / systemPrompt.section / webServer）是否都登记了。
 *
 * 为什么要有 --check：声明会漂移——新加的源码文件没登记、删掉的模块没撤、import 边漏写。
 * 漂移的模型比没有模型更坏，因为它让登记表说出与代码不符的话。
 *
 * **图不归它管。** 架构图由 Archify 在仓外生成，不进仓维护，不经本脚本。
 * 早先这里有一台 `--emit` / `--strict` 的渲染机（把 `code-map.json` 的 `diagrams` 渲染成
 * SVG 写进 `docs/generated/`，再逐字节比对），它**从未接电**——`docs/generated/` 在 git
 * 全历史中不存在、`--emit` 无任何调用方、CI 只跑 fast 层、`gateStrict` 在缺产物时恒 SKIP。
 * 2026-11-03 连同 `code-map.json` 的 `diagrams` 段一起删除。
 *
 * 用法：
 *   node tools/graph.mjs --check
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFields } from './field-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const enhanceRoot = resolve(here, '..')
const args = process.argv.slice(2)

/**
 * 用法错（未知参数）只给一行、exit 1，不吐栈。
 * 不提供 `--root`：本脚本只审自己所在的仓库——check.mjs 是在一次性副本里跑
 * 副本自己的这份脚本（cwd=副本根），从来没有调用方传过根，参数解析了也从不使用。
 */
function parseArgs(argv) {
  const options = { check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
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

/** 不参与模型检查的：自指的这个文件 + `tests/` 整个目录；其余 tools/ 下的脚本必须登记进 `code-map.json`。 */
const IGNORED = new Set(['tools/graph.mjs', 'tests'])
/**
 * 走盘时跳过的一级/任意层级目录：`tests` 与 `scripts` 各自有别的门禁守着，
 * 其余是被 `.gitignore` 排除的本地件——本地克隆的 `ZCode/` 有 3 万多文件，
 * 让它进模型比对会把一道结构门禁变成一次全盘扫描。
 *
 * **这条豁免与 `CONTRIBUTING.md` 的硬约束必须逐字对得上**（见下面 check() 里那条断言）：
 * 早先 CONTRIBUTING 写「新源码文件必须登记」，而这里跳过 `scripts/`，两句话各说各话
 * （审计 §3.3 点过）。现在约束收窄成「常驻源码（不含 `scripts/`、`tests/`）必须登记」，
 * 由门禁钉住，不靠人记得。
 */
const SKIP_DIRS = new Set(['node_modules', 'tests', 'scripts', 'design', '.codegraph', '.zhll', '.tmp', '.dsh', 'ZCode', '.archify', '.git'])

/** CONTRIBUTING.md 里必须逐字出现的那句登记约束（与上面 SKIP_DIRS 的豁免同源）。 */
const REGISTRATION_EXEMPTION = '常驻源码（不含 `scripts/`、`tests/`）必须登记进 `code-map.json`'

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

function check(map) {
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

  // 5. 登记豁免与 CONTRIBUTING.md 逐字对得上（审计 §3.3 那处矛盾）
  let contributing = ''
  try {
    contributing = readFileSync(join(enhanceRoot, 'CONTRIBUTING.md'), 'utf8')
  } catch (error) {
    errors.push(`读不到 CONTRIBUTING.md，无法核对 code-map 登记的豁免范围：${String(error?.message ?? error)}`)
  }
  if (contributing !== '' && !contributing.includes(REGISTRATION_EXEMPTION)) {
    errors.push(`CONTRIBUTING.md 的登记约束与 graph 门的豁免不一致：应逐字含「${REGISTRATION_EXEMPTION}」`)
  }
  for (const dir of ['scripts', 'tests']) {
    if (!SKIP_DIRS.has(dir)) errors.push(`graph 的 SKIP_DIRS 不再跳过 ${dir}/，CONTRIBUTING.md 的豁免句要跟着改`)
  }

  // 8. 未文档化宿主字段（.layers 这类未登记入口）
  const fields = checkFields(enhanceRoot)
  errors.push(...fields.errors)

  return { errors, fields }
}

// ---------- 入口 ----------

const map = loadMap()
if (!cli.check) {
  console.error('graph: 用法：node tools/graph.mjs --check [--root <项目根>]')
  process.exit(1)
}

const { errors, fields } = check(map)
if (errors.length > 0) {
  console.error(`[graph] 模型与代码不一致（${errors.length} 项）：`)
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}
console.log(`[graph] OK：${map.modules.length} 个模块 / ${map.edges.length} 条边 / ${fields.files} 个生产文件无未登记的宿主字段入口`)