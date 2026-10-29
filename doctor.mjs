#!/usr/bin/env node
/**
 * 预检：把「装上去之后到底成不成立」压成一张表，不需要起 DSH。
 *
 * 分两组：
 *   仓库侧  四件插件的源文件、文本可读、派生件带 `source-sha256` 戳
 *   落盘侧  给了 `--home` 才查：`<home>/enhance/` 里的拷贝、`state.json` 能否解析、
 *           每个 profile 的三行 insert 在不在、行上的 `name` 解析到的文件在不在、
 *           装了插件却没有任何 profile 引用它、以及落盘文本是否超过上限
 *
 * 退出码：全 PASS 为 0，任一 FAIL 为 1。`--json` 输出机器可读数组。
 * 干净卸载后的 home（没有 `<home>/enhance`）判为「未安装」：四项落盘检查记跳过，exit 0；
 * 目录在而内容缺（坏装 / 半装）照样红 —— 红色只意味着真有问题。
 *
 * 用法：
 *   node enhance/doctor.mjs [--home <DSH_HOME>] [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEXT_LIMIT, paths, readState, readText, textBytes, resolveHome } from './shared/state.mjs'
import { defaultPresetApproval } from './shared/patch-rows.mjs'
import { toolVersion } from './shared/tool-version.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** 四件插件各自必须有的文件。 */
const PLUGINS = [
  { name: 'enhance-scope', files: ['index.js', 'package.json'] },
  { name: 'auto-approve', files: ['index.js', 'package.json'] },
  { name: 'enhance-permissions', files: ['index.js', 'package.json', 'client.js'] },
  { name: 'ui', files: ['index.js', 'package.json', 'client.js'] },
]

/** 我们插进 patch 的三行。 */
const INSERT_IDS = ['enhance-scope', 'auto-approve', 'enhance-ui']

const checks = []

function record(name, pass, detail) {
  checks.push({ name, pass: pass === true, detail })
}

function exists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 某个 id 行下面的缩进块里有没有 `disabled: true`。 */
function rowDisabled(text, id) {
  const lines = text.split(/\r?\n/)
  const rowPattern = new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${id}[ \\t]*$`)
  for (let index = 0; index < lines.length; index += 1) {
    const match = rowPattern.exec(lines[index])
    if (match === null) continue
    const base = match[0].length - match[0].trimStart().length
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan]
      const indent = line.length - line.trimStart().length
      if (line.trim() !== '' && indent <= base) break
      if (/^[ \t]*disabled:[ \t]*true[ \t]*$/.test(line)) return true
    }
    return false
  }
  return false
}

/** 从 patch 文本里取某个 id 行下面那一层 `name:` 的值（逐行扫，不用跨行正则）。 */
function rowName(text, id) {
  const lines = text.split(/\r?\n/)
  const rowPattern = new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${id}[ \\t]*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!rowPattern.test(lines[index])) continue
    const base = (lines[index].match(/^[ \t]*/) ?? [''])[0].length
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan]
      if (line.trim() === '') continue
      const indent = line.length - line.trimStart().length
      if (indent <= base) break
      const name = /^[ \t]*name:[ \t]*'?([^'\n]+?)'?[ \t]*$/.exec(line)
      if (name !== null) return name[1].trim()
    }
  }
  return undefined
}


/**
 * True when the permission row's block contains `key:` —— 块风格与 flow 风格都认。
 *
 * flow 形态是 `enhanced: {sandbox: …, approval: …}`（安装器写进 `presets: {…}` 的那一条），
 * 只认 `key:` 行尾为空的块风格会把它判成「缺 enhanced 档位」，于是装完当场红。
 * @param {string} text
 * @param {string} key
 */
function permissionBlockHas(text, key) {
  const lines = text.split(/\r?\n/)
  const rowPattern = /^([ \t]*)-[ \t]*id:[ \t]*permission[ \t]*$/
  const rowIndex = lines.findIndex((line) => rowPattern.test(line))
  if (rowIndex < 0) return false
  const base = (lines[rowIndex].match(/^[ \t]*/) ?? [''])[0].length
  const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*:(?:[ \\t]|$)`)
  const inFlow = new RegExp(`[{,][ \\t]*${key}[ \\t]*:`)
  for (let index = rowIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if ((line.length - line.trimStart().length) <= base) break
    if (pattern.test(line)) return true
    // flow 映射里的条目：`presets: {enhanced: {…}}`、`{read-only: {}, enhanced: {…}}`
    if (inFlow.test(line)) return true
  }
  return false
}

/**
 * 未安装的 patch 里还留着 `enhanced` 档或 `defaultPreset: enhanced` 时，给出「残留了什么、在第几行」。
 *
 * 卸载残留：清单丢失后 `install.mjs` 收养一份已增强的 patch 时会把归属记成 `unchanged`，
 * 默认卸载于是只摘 insert 行、把 preset 留在原地（卸载 exit 0、报告 changed）。卸载与门禁
 * 都声称干净，而这个 profile 之后仍以 `sandbox: danger-full-access` 为默认档位。
 *
 * 与 `disabled` 残留同一条判据：**未安装却还留着我们写过的那一档 → 判红并指出来源**，
 * 不许静默。形状认不出来时也判红（那是给人核对的东西，不是可以自动放过的）。
 *
 * 只看 `- id: permission` 那一块：`defaultPreset` 是那一行的键，patch 别处（别人的插件行）
 * 也可能有同名键，全文搜会把别人的配置算成卸载残留（所以只扫 permission 行这一块）。
 *
 * @param {string} text
 * @returns {string | undefined} 例如 `enhanced 档（第 35 行）、defaultPreset: enhanced（第 38 行）`
 */
function residualEnhanced(text) {
  const lines = text.split(/\r?\n/)
  const rowIndex = lines.findIndex((line) => /^([ \t]*)-[ \t]*id:[ \t]*permission[ \t]*$/.test(line))
  if (rowIndex < 0) return undefined
  const indentOf = (line) => (line.match(/^[ \t]*/) ?? [''])[0].length
  const base = indentOf(lines[rowIndex])
  let end = lines.length
  for (let index = rowIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (indentOf(line) <= base && /^[ \t]*-[ \t]*/.test(line)) {
      end = index
      break
    }
  }
  const found = []
  for (let index = rowIndex + 1; index < end; index += 1) {
    if (/^[ \t]*enhanced[ \t]*:/.test(lines[index]) || /[{,][ \t]*enhanced[ \t]*:/.test(lines[index])) {
      found.push(`enhanced 档（第 ${index + 1} 行）`)
      break
    }
  }
  for (let index = rowIndex + 1; index < end; index += 1) {
    if (/^[ \t]*defaultPreset:[ \t]*enhanced[ \t]*$/.test(lines[index])) {
      found.push(`defaultPreset: enhanced（第 ${index + 1} 行）`)
      break
    }
  }
  return found.length > 0 ? found.join('、') : undefined
}

/** `enhanced` 档位的语义：沙箱全开 + 审批仍问人。改了这两项，菜单上那个档位就不是它了。 */
const ENHANCED_SEMANTICS = { sandbox: 'danger-full-access', approval: 'ask' }

/**
 * 取 `enhanced` 档位的 `sandbox` / `approval` —— 块风格与 flow 风格都认。
 *
 * 为什么不能只看键在不在：`enhanced:` 存在但 `sandbox: workspace-write` 时，菜单上
 * 那一档写着 Enhanced 却只能改工作区内的文件，`auto-approve` 的 allow 也在给一个
 * 不该给的范围放行。档位语义是这套东西的契约，键存在只是它的形状。
 *
 * @param {string} text
 * @returns {{ form: 'block' | 'flow', sandbox?: string, approval?: string, line: number } | undefined}
 */
function enhancedSemantics(text) {
  const lines = text.split(/\r?\n/)
  const readValue = (line, key) => {
    const match = new RegExp(`(?:^|[{,\\s])${key}[ \\t]*:[ \\t]*([^,}\\r\\n]+)`).exec(line)
    return match === null ? undefined : match[1].trim().replace(/^['"]|['"]$/g, '')
  }
  /** 从 `enhanced: {…}` 里取 sandbox / approval；`start` 是 `{` 的下标。 */
  const flowValues = (line, start) => {
    let depth = 0
    let end = -1
    for (let index = start; index < line.length; index += 1) {
      if (line[index] === '{') depth += 1
      else if (line[index] === '}') {
        depth -= 1
        if (depth === 0) { end = index; break }
      }
    }
    const inner = end < 0 ? line.slice(start + 1) : line.slice(start + 1, end)
    return { sandbox: readValue(inner, 'sandbox'), approval: readValue(inner, 'approval') }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // flow 形态有两种落点：独占一行的 `enhanced: {…}`，以及嵌在 `presets: {…}` 里的
    // `{enhanced: {…}}`（安装器写 flow 时就是后者）。两种都要认，否则装完就是「缺档位」。
    const flowAt = new RegExp(`(?:^|[{,])[ \\t]*enhanced[ \\t]*:[ \\t]*\\{`).exec(line)
    if (flowAt !== null) {
      const brace = line.indexOf('{', flowAt.index + (flowAt[0].length - 1))
      return { form: 'flow', ...flowValues(line, brace), line: index + 1 }
    }
    if (!/^[ \t]*enhanced[ \t]*:[ \t]*(?:#.*)?$/.test(line)) continue
    const base = (line.match(/^[ \t]*/) ?? [''])[0].length
    const result = { form: 'block', sandbox: undefined, approval: undefined, line: index + 1 }
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const child = lines[scan]
      if (child.trim() === '' || /^[ \t]*#/.test(child)) continue
      if ((child.length - child.trimStart().length) <= base) break
      for (const key of ['sandbox', 'approval']) {
        if (result[key] !== undefined) continue
        const value = readValue(child, key)
        if (value !== undefined) result[key] = value
      }
    }
    return result
  }
  return undefined
}

/**
 * 同一缩进层级下的重复键（行级，无第三方依赖）。
 *
 * 为什么需要它：重复键是宿主**整份拒绝**的那种错（`duplicated mapping key`），
 * 而它只看文件看不出来——两份 `presets:` 并排写在那儿，语法门禁、graph、docs 全绿。
 *
 * 三条不误报的规则，都是被真实 patch 的形状逼出来的：
 *   - **按「映射」判，不只按缩进**：`- id: a` 与 `- id: b` 两个 list 条目里的 `id`
 *     缩进相同却属于两个不同的映射，不算重复。遇到新的 `- ` 条目就另起一个作用域。
 *   - **块标量的正文不是键**：`personaSuffix: |` 下面的 `note: x` 写两遍是文本，跳过。
 *   - **注释行不是键**：`# defaultPreset: …` 那种说明文字跳过。
 *
 * 刻意不做完整 YAML 解析：真正的解析器只有宿主自带
 * （`resources/app/node_modules/js-yaml`），代码路径不许 import 它。这里只判
 * 「会让宿主判非法」的那一类形状，判不出来就沉默——不猜。
 *
 * @param {string} text
 * @returns {{ key: string, line: number, firstLine: number }[]}
 */
function duplicateKeys(text) {
  const lines = text.split(/\r?\n/)
  const duplicates = []
  /** 作用域栈：每一层是一个映射。keys 只在最内层里比。 */
  const stack = []
  let counter = 0
  /** 块标量正文的缩进基线：> 0 时，缩进比它深的行整段跳过。 */
  let blockScalarIndent = -1

  const push = (indent) => {
    counter += 1
    stack.push({ indent, id: counter, keys: new Map() })
    return stack[stack.length - 1]
  }
  const current = (indent) => {
    if (blockScalarIndent >= 0 && indent > blockScalarIndent) return undefined
    blockScalarIndent = -1
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop()
    const top = stack[stack.length - 1]
    if (top === undefined) return push(indent)
    if (top.indent === indent) return top
    return push(indent)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
    const indent = line.length - line.trimStart().length
    if (blockScalarIndent >= 0) {
      if (indent > blockScalarIndent) continue
      blockScalarIndent = -1
    }
    const item = /^[ \t]*-[ \t]*/.exec(line)
    if (item !== null) {
      // 新条目 = 新作用域；它下面那一层（`- id:` 里的 `id`）归这一条所有
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      push(indent)
    } else {
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop()
    }
    const frame = current(indent)
    if (frame === undefined) continue
    const rest = item === null ? line.slice(indent) : line.slice(item[0].length)
    const key = /^([A-Za-z_$][\w$.-]*)[ \t]*:(.*)$/.exec(rest)
    if (key === null) continue
    const name = key[1]
    if (/^[ \t]*[|>][+-]?[ \t]*(?:#.*)?$/.test(key[2])) {
      // `key: |` / `key: >`：下面更深缩进的行是正文，不是键
      blockScalarIndent = indent + (item === null ? 0 : item[0].length - indent)
      continue
    }
    const previous = frame.keys.get(name)
    if (previous !== undefined) duplicates.push({ key: name, line: index + 1, firstLine: previous })
    else frame.keys.set(name, index + 1)
  }
  return duplicates
}

/** 行上的 name 是否指到一个真文件（相对路径按 profile 目录解析，file:// 按绝对路径）。 */
function rowTarget(patchDir, name) {
  if (name === undefined) return { ok: false, detail: 'name 缺失' }
  if (name.startsWith('file://')) {
    try {
      const url = new URL(name)
      const path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
      return { ok: exists(path), detail: path }
    } catch {
      return { ok: false, detail: `file:// 解析失败：${name}` }
    }
  }
  if (!name.startsWith('.')) return { ok: true, detail: `${name}（裸包名，交给 Loader）` }
  const path = isAbsolute(name) ? name : resolve(patchDir, name)
  return { ok: exists(path), detail: path }
}

function parseArgs(argv) {
  const options = { home: undefined, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--home') {
      const value = argv[index + 1]
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--home 需要一个值')
      options.home = resolve(value)
      index += 1
    }
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

function checkRepo() {
  const major = Number(process.versions.node.split('.')[0])
  record('node>=22', major >= 22, `node ${process.versions.node}（会话日志的 zstd 解压要 ≥22）`)

  const missing = []
  for (const plugin of PLUGINS) {
    for (const file of plugin.files) {
      if (!exists(join(here, plugin.name, file))) missing.push(`${plugin.name}/${file}`)
    }
  }
  record('plugins-present', missing.length === 0, missing.length === 0 ? `${PLUGINS.length} 件齐` : `缺：${missing.join(', ')}`)

  const text = read(join(here, 'content-scope.txt'))
  const bytes = text === undefined ? -1 : textBytes(text)
  record('content-scope', text !== undefined && bytes <= TEXT_LIMIT, text === undefined ? '读不到 enhance/content-scope.txt' : `${bytes} B / 上限 ${TEXT_LIMIT} B`)

  const client = read(join(here, 'enhance-permissions', 'client.js'))
  const stamped = client !== undefined && /^\/\/ source-sha256: [0-9a-f]{64}$/m.test(client)
  record('client-stamped', stamped, client === undefined ? '读不到 client.js' : stamped ? '带 source-sha256 戳' : '没有戳：跑 build-client.mjs 重派生')
}

/** 从文件里抽相对 import 的 spec（只认 `.` 开头）。 */
function relativeSpecifiers(file) {
  const text = read(file)
  if (text === undefined) return []
  const specs = []
  for (const match of text.matchAll(/^\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/gm)) specs.push(match[1])
  for (const match of text.matchAll(/^\s*import\s*['"](\.[^'"]+)['"]/gm)) specs.push(match[1])
  return specs
}

/**
 * 「装过了才有的」四项：四件插件的文件、入口的相对 import、文本、状态。
 *
 * 官方 `ui-permission` 行只有装了才有东西可查；宿主自己的 `fs-observation-policy`
 * 从安装到卸载都不读不写（那一条永远由宿主管）。
 * 返回读到的 state（patch 侧还要拿它比 `defaultPreset` 的档位）。
 * @param {ReturnType<typeof paths>} p
 * @returns {ReturnType<typeof readState>}
 */
function checkInstalledFiles(p) {
  const missing = []
  for (const plugin of PLUGINS) {
    for (const file of plugin.files) {
      if (!exists(join(p.dir, plugin.name, file))) missing.push(`${plugin.name}/${file}`)
    }
  }
  record('home-plugins', missing.length === 0, missing.length === 0 ? `${p.dir}` : `缺：${missing.join(', ')}`)

  // 插件入口的相对 import 必须解析得到：漏拷 shared/ 这类"装了但不生效"就死在这里
  const brokenImports = []
  for (const plugin of PLUGINS) {
    const entry = join(p.dir, plugin.name, 'index.js')
    if (!exists(entry)) {
      // 入口不在（半装/没装）：这一条必须红，否则"装了但不生效"的形态永远看不见
      brokenImports.push(`${plugin.name}: 入口缺失`)
      continue
    }
    for (const spec of relativeSpecifiers(entry)) {
      if (!exists(resolve(dirname(entry), spec))) brokenImports.push(`${plugin.name}: ${spec}`)
    }
  }
  // 卸载器也要解析得到：它是运行期从插件里 import 的（POST /enhance/api 的 uninstall op）
  const uninstallEntry = join(p.dir, 'uninstall.mjs')
  if (!exists(uninstallEntry)) {
    brokenImports.push('uninstall: 入口缺失')
  } else {
    for (const spec of relativeSpecifiers(uninstallEntry)) {
      if (!exists(resolve(dirname(uninstallEntry), spec))) brokenImports.push(`uninstall: ${spec}`)
    }
  }
  record(
    'plugin-imports',
    brokenImports.length === 0,
    brokenImports.length === 0 ? '入口与卸载器的相对 import 都解析得到' : `解析不到：${brokenImports.join(', ')}`,
  )

  const installed = readText(p)
  const installedBytes = installed.ok ? textBytes(installed.text) : 0
  // 上限与写入路径（writeText / API）同一口径：README 让用户直接改这个文件，
  // 只报「读得到」会让一份超限文本在 doctor 全绿的情况下被整段注入。
  record(
    'home-text',
    installed.ok && installedBytes <= TEXT_LIMIT,
    installed.ok
      ? (installedBytes <= TEXT_LIMIT
        ? `${installedBytes} B / 上限 ${TEXT_LIMIT} B`
        : `${installedBytes} B 超过上限 ${TEXT_LIMIT} B：删到上限以内（或从 enhance-archive 恢复），否则不会注入`)
      : `读不到 ${p.text}`,
  )

  const state = readState(p)
  record(
    'home-state',
    !state.degraded,
    state.degraded
      ? `state.json ${state.degradedReason === 'missing' ? '不存在' : '损坏'}：按默认值（开 / ask / 关）走`
      : `v${state.version} contentScope=${state.contentScope} approval=${state.approval}`,
  )
  return state
}

function checkInstall(home) {
  const p = paths(home)
  // 干净卸载之后 `<home>/enhance` 整个不在了 —— 那是「未安装」，不是「坏了」。
  // 这四项没有东西可查，记跳过；红色从此只意味着真有问题（坏装 / 半装 / 卸载残留）。
  //
  // 第三种形态：**只接过权限线**（旧版本的一次性迁移工具留下的）。那种工具只改 patch
  // 并记清单、不装插件，所以 home 里 `enhance/` 只有 `install-manifest.json` 一个文件。
  // 它和「半装」必须分开：半装是插件目录缺文件（真问题），而这里是「我们本来就没装插件」。
  const enhanceEntries = (() => {
    try {
      return readdirSync(p.dir)
    } catch {
      return undefined
    }
  })()
  const wireOnly = enhanceEntries !== undefined && enhanceEntries.length > 0 && enhanceEntries.every((name) => name === 'install-manifest.json')
  let state
  if (exists(p.dir) && !wireOnly) {
    state = checkInstalledFiles(p)
  } else {
    for (const name of ['home-plugins', 'plugin-imports', 'home-text', 'home-state']) {
      record(name, true, wireOnly ? `只接过权限线（未装插件）：${p.dir} 里只有 ${enhanceEntries.join(', ')}` : `未安装（跳过）：没有 ${p.dir}`)
    }
  }

  const manifest = read(p.manifest)
  const manifestData = (() => {
    if (manifest === undefined) return undefined
    try {
      return JSON.parse(manifest)
    } catch {
      return undefined
    }
  })()
  const currentVersion = toolVersion()
  // 清单用来标 `disabled` 的归属；没有它，卸载只做行级摘除并在 warnings 里报“不确定”。
  // 没装（没有 enhance 目录）才允许缺。版本是另一件事：清单记的是「这份落盘是哪个版本写的」，
  // 与当前工具不一致时只有一条可行动作——重跑 install.mjs。
  const manifestPass = manifest !== undefined || !exists(p.dir)
  const manifestVersion = manifestData?.toolVersion
  // 旧版「只接过权限线」形态：清单由已删除的迁移工具写下、本来就没有版本字段，
  // 而且那本来就不是一次安装 —— 不按「版本不一致」判红，给一句可行动的重装提示。
  const legacyWire = wireOnly === true && manifestVersion === undefined
  const versionMismatch = manifest !== undefined && !legacyWire && manifestVersion !== currentVersion
  record(
    'install-manifest',
    manifestPass && !versionMismatch,
    manifest !== undefined
      ? (versionMismatch
        ? `清单版本 ${manifestVersion ?? '（无）'} 与当前工具 ${currentVersion} 不一致：重跑 install.mjs 升级`
        : legacyWire
          ? `在（旧版迁移工具留下，无版本字段）：重跑 install.mjs 补齐插件`
          : `在（toolVersion=${currentVersion}）`)
      : (manifestPass ? '没有 enhance 目录（未安装）' : '缺 install-manifest.json：disabled 归属不明，卸载会先警告；重跑 install.mjs 重建'),
  )
  if (manifestData !== undefined && manifestData.fileHashes !== null && typeof manifestData.fileHashes === 'object') {
    const bad = []
    for (const [rel, expected] of Object.entries(manifestData.fileHashes)) {
      try {
        const actual = createHash('sha256').update(readFileSync(join(p.dir, rel))).digest('hex')
        if (actual !== expected) bad.push(rel)
      } catch {
        bad.push(`${rel}(missing)`)
      }
    }
    record(
      'home-files',
      bad.length === 0,
      bad.length === 0 ? `与清单 hash 一致（${Object.keys(manifestData.fileHashes).length} 件）` : `与清单 hash 不符：${bad.join(', ')}；重跑 install.mjs 或删掉改过的落盘文件`,
    )
  } else {
    record('home-files', manifestPass, manifestData === undefined ? '清单缺失，跳过 hash 比对' : '旧清单无 fileHashes（重跑 install 补齐）')
  }

  let profiles = []
  try {
    profiles = readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    profiles = []
  }
  if (profiles.length === 0) {
    record('profiles', false, `读不到 ${join(home, 'profiles')}`)
    return
  }

  // 装了插件、却没有任何 profile 的 patch 引用它：插件目录在、宿主启动后一行都不会加载。
  // 这不是「未安装」（`enhance/` 在），是「装了但没接线」——和半装一样必须看得见，
  // 否则「install exit 0 + doctor 全绿 + 用户重启后什么都没有」会同时成立。
  let wiredProfiles = 0
  for (const profile of profiles) {
    const patchDir = join(home, 'profiles', profile)
    const patchPath = join(patchDir, 'cordis.patch.yml')
    const text = read(patchPath)
    if (text === undefined) {
      record(`patch:${profile}`, true, '没有 cordis.patch.yml（不承载本工具的插件）')
      continue
    }
    recordDuplicates(profile, text)
    const present = INSERT_IDS.filter((id) => new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${id}[ \\t]*$`, 'm').test(text))
    if (present.length > 0) wiredProfiles += 1
    if (present.length === 0) {
      // 清单里记着这个 profile 的 `uiPermissionAction` → 那个 disabled 是我们接线时停的，
      // 不是「别人的改动」。那种形态只停 `ui-permission` 一行 + 插 `enhance-permissions`，
      // 三行 insert 一个都不加，所以这里本来就该是「我们接过线、还没装插件」的正常形态
      // —— 判红会让人以为出了问题。
      const wired = manifestData?.profiles?.[profile]?.uiPermissionAction
      const ours = wired === 'added' || wired === 'flipped'
      const leftovers = []
      if (rowDisabled(text, 'ui-permission') && !ours) leftovers.push('ui-permission')
      // 未安装却还留着我们写过的那一档：卸载残留在 `patch:<profile>` 上必须看得见，否则
      // 「卸载 exit 0 + doctor 全绿」会同时撒谎，而那个 profile 之后仍以沙箱全开为默认。
      const residual = residualEnhanced(text)
      if (leftovers.length > 0) {
        record(`patch:${profile}`, false, `未安装但残留 disabled：${leftovers.join(', ')}（卸载残留或别人的改动，需要人工核对）`)
      } else if (residual !== undefined) {
        record(`patch:${profile}`, false, `未安装但残留 ${residual}（卸载残留或别人的改动，需要人工核对）`)
      } else if (ours && rowDisabled(text, 'ui-permission')) {
        record(`patch:${profile}`, true, `只接过权限线（清单记 uiPermissionAction=${wired}）：ui-permission 的 disabled 是我们的，三行 insert 未装`)
      } else {
        record(`patch:${profile}`, true, '未安装（三行都不在）')
      }
      continue
    }
    if (present.length < INSERT_IDS.length) {
      const absent = INSERT_IDS.filter((id) => !present.includes(id))
      record(`patch:${profile}`, false, `半装：缺 ${absent.join(', ')}`)
      continue
    }
    const broken = []
    for (const id of INSERT_IDS) {
      const target = rowTarget(patchDir, rowName(text, id))
      if (!target.ok) broken.push(`${id} → ${target.detail}`)
    }
    if (text.includes('id: enhance-permissions')) {
      const target = rowTarget(patchDir, rowName(text, 'enhance-permissions'))
      if (!target.ok) broken.push(`enhance-permissions → ${target.detail}`)
      const uiDisabled = rowDisabled(text, 'ui-permission')
      if (!uiDisabled) broken.push('装了 enhance-permissions 但没停 ui-permission（两行会抢同一个槽）')
    }
    if (state?.approval === 'allow') {
      const preset = defaultPresetApproval(text)
      if (preset?.approval === 'never') {
        broken.push(`defaultPreset=${preset.name} approval=never：auto-approve 的 allow 被 approval:never 短路；改档位或把 state 设回 ask`)
      }
    }
    if (!permissionBlockHas(text, 'enhanced')) {
      broken.push('缺 enhanced 档位（重跑 install.mjs）')
    } else {
      // 键在只是形状；档位语义才是契约：`enhanced` 必须是「沙箱全开 + 审批仍问人」。
      // 被改成 workspace-write 之类时，菜单上那一档的文案还叫 Enhanced，行为却窄了。
      const enhanced = enhancedSemantics(text)
      if (enhanced !== undefined) {
        const wrong = []
        if (enhanced.sandbox !== ENHANCED_SEMANTICS.sandbox) {
          wrong.push(`sandbox=${enhanced.sandbox ?? '（缺）'}（期望 ${ENHANCED_SEMANTICS.sandbox}）`)
        }
        if (enhanced.approval !== ENHANCED_SEMANTICS.approval) {
          wrong.push(`approval=${enhanced.approval ?? '（缺）'}（期望 ${ENHANCED_SEMANTICS.approval}）`)
        }
        if (wrong.length > 0) {
          broken.push(`enhanced 档位语义不对（第 ${enhanced.line} 行）：${wrong.join('、')}`)
        }
      }
    }
    record(`patch:${profile}`, broken.length === 0, broken.length === 0 ? '三个 insert 行与目标文件都在' : broken.join('；'))
  }

  // 只在「确实装了插件」的形态上判：干净卸载后 enhance/ 整个不在，那是未安装，不是没接线。
  if (exists(p.dir) && wireOnly !== true) {
    record(
      'profiles-wired',
      wiredProfiles > 0,
      wiredProfiles > 0
        ? `${wiredProfiles} 个 profile 引用了 ${p.dir}`
        : `装了插件，但没有任何 profile 的 patch 引用 ${p.dir}（宿主不会加载）：重跑 install.mjs --profiles <实际存在的 profile>，或卸载后重装`,
    )
  }
}

/**
 * 单独一行的「同层重复键」检查。
 *
 * 为什么不并进 `patch:<profile>` 那一行：重复键既不属于「半装」也不属于「档位」，
 * 而**未安装 / 半装**的 patch 一样可能有（旧版安装器写坏、手改过）。只有放在三个
 * 分支都必经的位置，这条才真的覆盖所有形态。
 *
 * @param {string} profile
 * @param {string} text
 */
function recordDuplicates(profile, text) {
  const duplicates = duplicateKeys(text)
  if (duplicates.length === 0) {
    record(`dup-keys:${profile}`, true, '无同层重复键')
    return
  }
  const listed = duplicates.slice(0, 3).map((entry) => `${entry.key}（第 ${entry.line} 行，首见第 ${entry.firstLine} 行）`)
  const more = duplicates.length > 3 ? ` 等 ${duplicates.length} 处` : ''
  record(
    `dup-keys:${profile}`,
    false,
    `同层重复键：${listed.join('、')}${more}；宿主按 YAML 解析整份 patch，重复键会让它整份拒绝，删掉多出来的那一个`,
  )
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  // 用法错只给一行、exit 1（与 uninstall.mjs 同形）：栈不是「你参数写错了」该有的输出
  console.error(`doctor: ${String(error?.message ?? error)}`)
  process.exit(1)
}
checkRepo()
if (options.home === undefined) {
  record('home', true, `未给 --home：跳过落盘侧检查（默认 home 是 ${resolveHome()}，加 --home 才查）`)
} else {
  checkInstall(options.home)
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`)
} else {
  for (const check of checks) console.log(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name.padEnd(18)} ${check.detail}`)
  const failed = checks.filter((check) => !check.pass).length
  console.log(`summary  pass=${checks.length - failed} fail=${failed} total=${checks.length}`)
}
if (checks.some((check) => !check.pass)) process.exitCode = 1
