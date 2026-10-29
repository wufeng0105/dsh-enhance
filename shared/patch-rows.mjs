/**
 * 权限选择器替换的 patch 行级手术。
 *
 * 全仓只有这一份实现：`install.mjs` 在 desktop 上接线时用它，行形状、注释块与换行处理
 * 因此不会各写一套。
 *
 * @module enhance/shared/patch-rows
 */

import { eolOf, joinLines, splitLines } from './text-lines.mjs'

/** Insert rows owned by the permission-selector replacement. */
const PERMISSION_ROW = {
  id: 'enhance-permissions',
  name: '../../enhance/enhance-permissions/index.js',
}

/**
 * flow 风格 `presets:` 里我们追加的那一条。
 *
 * 块风格的 `enhanced` 是三条行（`enhanced:` + `sandbox:` + `approval:`）；flow 里
 * 写成一条，语义完全相同（`sandbox: danger-full-access` + `approval: ask`）。
 * 保持 flow 而不是改写成块，是为了安装/卸载能走同一条往返：卸载摘掉这一条之后
 * `presets: {}` 能逐字节回去，而不是留一个值为 null 的 `presets:`。
 */
const FLOW_ENHANCED = 'enhanced: {sandbox: danger-full-access, approval: ask}'

/** 只认「键名恰好是它」的行：`presetsFoo:`、`# presets:` 都不算。 */
const PRESETS_LINE = /^([ \t]*)presets[ \t]*:(.*)$/
const CONFIG_LINE = /^([ \t]*)config[ \t]*:(.*)$/

/**
 * `text[start]` 是 `{` 或 `[`，返回与它配对的闭括号下标；配不上（多行 flow、注释截断、
 * 引号没闭合）返回 -1。引号与转义按 YAML 的规则跳过，所以 `{a: "}"}` 不会提前收尾。
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function flowEnd(text, start) {
  let depth = 0
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (quote === '"' && char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    // `#` 只有前一个是空白才算注释起点：它会把闭括号切到下一行，等于多行 flow
    if (char === '#' && (index === start || /\s/.test(text[index - 1]))) return -1
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) return -1
    }
  }
  return -1
}

/** flow 映射的内里按顶层逗号切开（引号与嵌套括号里的逗号不算）。@param {string} inner */
function flowEntries(inner) {
  const entries = []
  let start = 0
  let depth = 0
  let quote = ''
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (quote !== '') {
      if (quote === '"' && char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      entries.push(inner.slice(start, index))
      start = index + 1
    }
  }
  entries.push(inner.slice(start))
  return entries.filter((entry) => entry.trim() !== '')
}

/** 一条 flow 条目的键名（去掉引号）；`a: b` → `a`。@param {string} entry */
function entryKey(entry) {
  let depth = 0
  let quote = ''
  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index]
    if (quote !== '') {
      if (quote === '"' && char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ':' && depth === 0) return entry.slice(0, index).trim().replace(/^['"]|['"]$/g, '')
  }
  return entry.trim().replace(/^['"]|['"]$/g, '')
}

/**
 * 行尾那段是不是「空白 + 可选注释」——只有这种尾巴才允许在闭括号后面，否则这行不是
 * 「一个 flow 值」而更像多行 flow 的片段。@param {string} tail
 */
function isTailSafe(tail) {
  return /^[ \t]*(#.*)?$/.test(tail)
}

/** Full preset table used when the profile has no permission block at all. */
const PRESET_BLOCK = [
  '- id: permission',
  '  name: "@deepseek-ai/dsh-permission-presets"',
  '  config:',
  '    presets:',
  '      read-only:',
  '        sandbox: read-only',
  '        approval: ask',
  '      workspace-write:',
  '        sandbox: workspace-write',
  '        approval: ask',
  '      danger-full-access:',
  '        sandbox: danger-full-access',
  '        approval: never',
  '      enhanced:',
  '        sandbox: danger-full-access',
  '        approval: ask',
  '    defaultPreset: enhanced',
]

/**
 * `presets` 的三种可识别形态。
 *
 * - `block`   `presets:` 行尾什么都没有（或只有注释），映射在下面的缩进块里；
 * - `flow`    `presets: {…}` / `presets: {}`，整张映射写在同一行；
 * - `error`   认不出安全改法的：多行 flow（闭括号在下一行）、flow 后面还跟着别的键、
 *             引号没收尾。这种**绝不猜**——猜错写出的就是一个宿主拒绝的 patch。
 *
 * @param {string} line
 * @returns {{ form: 'block' | 'flow' | 'error', indent: number, tail?: string, body?: string, entries?: string[], reason?: string }}
 */
function presetsLineShape(line) {
  const match = PRESETS_LINE.exec(line)
  if (match === null) return { form: 'error', indent: 0, reason: '不是 presets 行' }
  const indent = match[1].length
  const tail = match[2]
  if (/^[ \t]*(#.*)?$/.test(tail)) return { form: 'block', indent, tail }
  const lead = tail.length - tail.trimStart().length
  const rest = tail.trimStart()
  if (!rest.startsWith('{')) {
    // `presets: some-name` / `presets: null` / `presets: |` —— 不是映射，改写它等于换掉用户的写法
    return { form: 'error', indent, reason: `presets 的值不是 flow 映射：${rest.trim().slice(0, 40)}` }
  }
  const end = flowEnd(rest, 0)
  if (end < 0) return { form: 'error', indent, reason: 'presets 的 flow 映射跨多行或引号未闭合，无法安全改写单行' }
  if (!isTailSafe(rest.slice(end + 1))) return { form: 'error', indent, reason: `presets 的 flow 映射后面还有内容：${rest.slice(end + 1).trim().slice(0, 40)}` }
  return {
    form: 'flow',
    indent,
    tail: rest.slice(end + 1),
    body: rest.slice(1, end),
    entries: flowEntries(rest.slice(1, end)),
  }
}

/**
 * Ensure the `enhanced` preset exists, without changing an existing default.
 *
 * - no permission row → append the whole four-preset table, default `enhanced`;
 * - permission row without `enhanced` → insert only `enhanced`; add
 *   `defaultPreset: enhanced` only when the block has no `defaultPreset` at all;
 * - already present → unchanged.
 *
 * `defaultPreset` is looked for **anywhere in the permission block**, not only
 * under `presets:`: key order is not ours to assume. A generated patch that
 * sorts keys puts `defaultPreset` before `presets`, and a permission block may
 * have `config:` without a `presets:` map — both shapes used to get a second
 * `defaultPreset`, which YAML rejects (`duplicated mapping key`) and the host
 * refuses the whole profile.
 *
 * `presets:` 的 **flow 风格**（`presets: {}`、`presets: {read-only: {}}`、行尾带注释）
 * 与块风格一样被认出来：认出后**改写那一行**（把 `enhanced` 追加进 flow 映射），
 * 而不是在它下面再插一个同层 `presets:`——那会写出重复键，宿主整份 patch 都不收。
 * 认不出安全改法（多行 flow、`presets:` 的值不是映射、闭合后还有别的键）时返回
 * `{ error }`，由调用方拒绝；**不返回**一份会写坏的文本。
 *
 * @param {string} text
 * @returns {{ text: string, changed: string | undefined, action: 'unchanged' | 'inserted' | 'added', defaultAction?: 'added' | 'kept', error?: undefined } | { text: string, error: string }}
 */
export function ensureEnhancedPreset(text) {
  const eol = eolOf(text)
  const empty = text.trim() === '[]'
  const lines = splitLines(empty ? '' : text)
  const rowPattern = /^([ \t]*)-[ \t]*id:[ \t]*permission[ \t]*$/
  const rowIndex = lines.findIndex((line) => rowPattern.test(line))

  if (rowIndex < 0) {
    const head = empty ? '' : `${text.replace(/\s*$/, '')}${eol}`
    return {
      text: `${head}${PRESET_BLOCK.join(eol)}${eol}`,
      changed: 'add permission presets (default enhanced)',
      action: 'added',
      defaultAction: 'added',
      error: undefined,
    }
  }

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
  const block = lines.slice(rowIndex, end)
  if (block.some((line) => /^[ \t]*enhanced:[ \t]*$/.test(line))) {
    return { text, changed: undefined, action: 'unchanged', error: undefined }
  }
  // 只认整块里的 `defaultPreset`：写在 `presets:` 之前、或 `config:` 里没有 `presets:` 的形状，
  // 都算「已经有默认」，一律保留原值。看的位置错了就会写出第二个键，profile 直接解析失败。
  const hasDefault = block.some((line) => /^[ \t]*defaultPreset:[ \t]*/.test(line))
  const defaultAction = hasDefault ? 'kept' : 'added'
  // 块风格与 flow 风格都认：键名后面既有可能是空尾巴，也有可能直接跟着 `{…}` 或注释。
  const presetsInBlock = block.findIndex((line) => PRESETS_LINE.test(line) && presetsLineShape(line).form !== 'error')
  if (presetsInBlock < 0) {
    // 有 `presets` 行但一种形态都认不出：拒绝，别在它旁边插第二个同层键。
    const unreadable = block.findIndex((line) => PRESETS_LINE.test(line))
    if (unreadable >= 0) {
      const shape = presetsLineShape(block[unreadable])
      return {
        text,
        error: `${shape.reason ?? 'presets 的形态无法安全改写'}（第 ${rowIndex + unreadable + 1} 行）。改回块风格 \`presets:\` 后重跑，或手工加 \`enhanced\` 档位`,
      }
    }
    const configInBlock = block.findIndex((line) => /^[ \t]*config:[ \t]*$/.test(line))
    if (configInBlock >= 0) {
      const configIndent = indentOf(block[configInBlock])
      const insertAt = rowIndex + configInBlock + 1
      const presetLines = [
        `${' '.repeat(configIndent + 2)}presets:`,
        `${' '.repeat(configIndent + 4)}enhanced:`,
        `${' '.repeat(configIndent + 6)}sandbox: danger-full-access`,
        `${' '.repeat(configIndent + 6)}approval: ask`,
      ]
      if (!hasDefault) presetLines.push(`${' '.repeat(configIndent + 2)}defaultPreset: enhanced`)
      lines.splice(insertAt, 0, ...presetLines)
      return { text: joinLines(lines, eol), changed: 'insert enhanced preset (new presets map)', action: 'inserted', defaultAction, error: undefined }
    }
    // `config: {presets: …, defaultPreset: …}`：整张 config 也是 flow。往它下面插一个块风格
    // `config:` 就是同一层两个 `config` 键，宿主同样拒绝。这种一律拒绝而不是猜。
    const flowConfig = block.findIndex((line) => CONFIG_LINE.test(line) && !/^[ \t]*(#.*)?$/.test(CONFIG_LINE.exec(line)[2]))
    if (flowConfig >= 0) {
      return {
        text,
        error: `config 是 flow 风格（第 ${rowIndex + flowConfig + 1} 行），无法在不改写你那一行的前提下加 enhanced 档位。把 config 改成块风格后重跑`,
      }
    }
    const nested = [
      `${' '.repeat(base + 2)}config:`,
      `${' '.repeat(base + 4)}presets:`,
      `${' '.repeat(base + 6)}enhanced:`,
      `${' '.repeat(base + 8)}sandbox: danger-full-access`,
      `${' '.repeat(base + 8)}approval: ask`,
    ]
    if (!hasDefault) nested.push(`${' '.repeat(base + 4)}defaultPreset: enhanced`)
    lines.splice(rowIndex + 1, 0, ...nested)
    return { text: joinLines(lines, eol), changed: 'insert enhanced preset (new config block)', action: 'inserted', defaultAction, error: undefined }
  }

  const shape = presetsLineShape(block[presetsInBlock])
  const lineNumber = rowIndex + presetsInBlock + 1
  if (shape.form === 'flow') {
    const flow = shape
    if ((flow.entries ?? []).some((entry) => entryKey(entry) === 'enhanced')) {
      // `enhanced` 已经在这个 flow 映射里（上面那条只认块风格，这里补上 flow 的幂等）
      return { text, changed: undefined, action: 'unchanged', error: undefined }
    }
    const separator = (flow.body ?? '').trim() === '' ? '' : (flow.body ?? '').trimEnd().endsWith(',') ? ' ' : ', '
    const rewritten = `${' '.repeat(flow.indent)}presets: {${flow.body ?? ''}${separator}${FLOW_ENHANCED}}${flow.tail ?? ''}`
    lines[lineNumber - 1] = rewritten
    let changed = 'insert enhanced preset (flow map)'
    let nextDefault = defaultAction
    if (!hasDefault) {
      lines.splice(lineNumber, 0, `${' '.repeat(flow.indent)}defaultPreset: enhanced`)
      changed = 'insert enhanced preset (flow map) + default'
      nextDefault = 'added'
    }
    return { text: joinLines(lines, eol), changed, action: 'inserted', defaultAction: nextDefault, error: undefined }
  }

  const presetsIndent = shape.indent
  let insertAt = rowIndex + presetsInBlock + 1
  for (let index = presetsInBlock + 1; index < block.length; index += 1) {
    const line = block[index]
    if (line.trim() === '') continue
    if (indentOf(line) <= presetsIndent) break
    insertAt = rowIndex + index + 1
  }
  const enhanced = [
    `${' '.repeat(presetsIndent + 2)}enhanced:`,
    `${' '.repeat(presetsIndent + 4)}sandbox: danger-full-access`,
    `${' '.repeat(presetsIndent + 4)}approval: ask`,
  ]
  lines.splice(insertAt, 0, ...enhanced)
  if (!hasDefault) {
    lines.splice(insertAt + enhanced.length, 0, `${' '.repeat(presetsIndent)}defaultPreset: enhanced`)
  }
  return { text: joinLines(lines, eol), changed: hasDefault ? 'insert enhanced preset' : 'insert enhanced preset + default', action: 'inserted', defaultAction, error: undefined }
}

/**
 * Reverse `ensureEnhancedPreset` for the ownership recorded in the manifest.
 *
 * `added` removes the whole permission row we appended; `inserted` removes only
 * the `enhanced` block, and removes `defaultPreset: enhanced` only when we added
 * it. An unknown action leaves the profile untouched.
 *
 * flow 风格的 `enhanced` 是我们追加进同一行的那一条，反向就把这一条从 flow 映射里摘掉：
 * 摘完 `presets: {}` 逐字节回到安装前的样子。认不出那一行就原样不动——宁可留一条
 * 已知的档位，也不写坏 patch。
 *
 * @param {string} text
 * @param {'added' | 'inserted' | undefined} action
 * @param {boolean} [defaultAdded]
 * @returns {{ text: string, changed: string | undefined }}
 */
export function removePermissionPreset(text, action, defaultAdded = false) {
  if (action !== 'added' && action !== 'inserted') return { text, changed: undefined }
  const eol = eolOf(text)
  const lines = splitLines(text)
  const rowPattern = /^([ \t]*)-[ \t]*id:[ \t]*permission[ \t]*$/
  const rowIndex = lines.findIndex((line) => rowPattern.test(line))
  if (rowIndex < 0) return { text, changed: undefined }
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

  if (action === 'added') {
    lines.splice(rowIndex, end - rowIndex)
    return { text: joinLines(lines, eol), changed: 'remove permission presets' }
  }

  let changed = false
  // flow 形态先摘：我们追加的是 flow 映射里的 `enhanced` 条目，块风格那套在这里匹配不到。
  for (let index = rowIndex; index < end; index += 1) {
    if (!PRESETS_LINE.test(lines[index])) continue
    const shape = presetsLineShape(lines[index])
    if (shape.form !== 'flow') continue
    const entries = shape.entries ?? []
    const kept = entries.filter((entry) => entryKey(entry) !== 'enhanced')
    if (kept.length === entries.length) break
    lines[index] = `${' '.repeat(shape.indent)}presets: {${kept.map((entry) => entry.trim()).join(', ')}}${shape.tail ?? ''}`
    changed = true
    break
  }

  const enhancedIndex = lines.findIndex((line, index) => index >= rowIndex && index < end && /^[ \t]*enhanced:[ \t]*$/.test(line))
  if (enhancedIndex >= 0) {
    const enhancedIndent = indentOf(lines[enhancedIndex])
    let enhancedEnd = enhancedIndex + 1
    while (enhancedEnd < end) {
      const line = lines[enhancedEnd]
      if (line.trim() !== '' && indentOf(line) <= enhancedIndent) break
      enhancedEnd += 1
    }
    lines.splice(enhancedIndex, enhancedEnd - enhancedIndex)
    changed = true
  }
  if (defaultAdded) {
    const defaultIndex = lines.findIndex((line, index) => index >= rowIndex && index < end && /^[ \t]*defaultPreset:[ \t]*enhanced[ \t]*$/.test(line))
    if (defaultIndex >= 0) {
      lines.splice(defaultIndex, 1)
      changed = true
    }
  }
  return changed ? { text: joinLines(lines, eol), changed: 'remove enhanced preset' } : { text, changed: undefined }
}

/**
 * 在 `- id: permission` 那一块里定位 `enhanced` 档。
 *
 * 块风格是我们插入的三行（`enhanced:` + `sandbox:` + `approval:`）；flow 风格是
 * `presets: {…, enhanced: {…}}` 里的一条。找不到 `permission` 行时返回 undefined。
 *
 * @param {string[]} lines
 * @returns {{ rowIndex: number, end: number, keyIndex: number, flowIndex: number } | undefined}
 */
function enhancedSlot(lines) {
  const rowPattern = /^([ \t]*)-[ \t]*id:[ \t]*permission[ \t]*$/
  const rowIndex = lines.findIndex((line) => rowPattern.test(line))
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
  for (let index = rowIndex + 1; index < end; index += 1) {
    // 块风格：`enhanced:` 独占一行（行尾最多一个注释）
    if (/^[ \t]*enhanced[ \t]*:(?:[ \t]*(?:#.*)?)?$/.test(lines[index])) return { rowIndex, end, keyIndex: index, flowIndex: -1 }
    // flow 风格：`{… enhanced: {…}}` 或 `, enhanced: {…}`
    if (/[{,][ \t]*enhanced[ \t]*:[ \t]*\{/.test(lines[index])) return { rowIndex, end, keyIndex: -1, flowIndex: index }
  }
  return { rowIndex, end, keyIndex: -1, flowIndex: -1 }
}

/**
 * 整个 `- id: permission` 行是不是**逐字节**等于「profile 里原本没有 permission 行时，安装器追加的
 * 那张表」（`PRESET_BLOCK`：三个官方档位 + enhanced + `defaultPreset: enhanced`）。
 *
 * 用来回答一个只靠 `defaultPreset: enhanced` 这一行本身答不出来的问题：**这行默认档位是谁写的？**
 * 整行都长成我们那张表 → 是我们建的整行（含默认档位），一起摘；否则这行（连同 `defaultPreset`）
 * 在我们动手之前就在那儿了 —— 那可能是用户自己写的，只能摘我们插进去的 `enhanced` 档。
 *
 * 只判字节，不做 YAML 解析，也不看语义：与 `ownsEnhancedShape` 同一条「不猜」的线。
 *
 * @param {string[]} lines
 * @param {{ rowIndex: number, end: number }} slot
 */
function permissionRowIsPresetTable(lines, slot) {
  const block = lines.slice(slot.rowIndex, slot.end)
  while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
  const shape = (rows) => rows.map((row) => row.trimEnd()).join('\n')
  return shape(block) === shape(PRESET_BLOCK)
}

/**
 * 这个 `enhanced` 是不是**逐字节**长成我们写手写的那一份。
 *
 * 块风格：`enhanced:` 下面紧跟同缩进的 `sandbox: danger-full-access` 与 `approval: ask`
 * （安装器只写空格缩进，tab 或其他写法一律不算）。flow 风格：那一条恰好等于 `FLOW_ENHANCED`。
 *
 * @param {string[]} lines
 * @param {{ keyIndex: number, flowIndex: number }} found
 */
function ownsEnhancedShape(lines, found) {
  if (found.flowIndex >= 0) {
    const shape = presetsLineShape(lines[found.flowIndex])
    if (shape.form !== 'flow') return false
    const entry = (shape.entries ?? []).find((item) => entryKey(item) === 'enhanced')
    return entry !== undefined && entry.trim() === FLOW_ENHANCED
  }
  const indent = (lines[found.keyIndex].match(/^[ \t]*/) ?? [''])[0]
  if (lines[found.keyIndex + 1] !== `${indent}  sandbox: danger-full-access`) return false
  if (lines[found.keyIndex + 2] !== `${indent}  approval: ask`) return false
  // 我们只写这三行：紧随其后必须不比 `enhanced:` 更深（空行跳过）。多一条子键就不是我们写的。
  for (let index = found.keyIndex + 3; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    return (line.length - line.trimStart().length) <= indent.length
  }
  return true
}

/**
 * 归属没记下来时，摘掉一个「逐字节长成我们写的那一份」的 `enhanced` 档。
 *
 * 卸载残留：清单丢失后 `install.mjs` 会收养一份已经增强过的 patch，把归属记成
 * `permissionPresetAction: 'unchanged'`——「这档是我们加的」这个事实到此为止就没了。
 * 默认卸载只按归属摘 preset，于是 `<home>/enhance` 删了、`exit 0`、`doctor` 全绿，
 * 而 `defaultPreset: enhanced` 还在（该 profile 之后仍以沙箱全开的档位为默认）。
 *
 * 为什么不直接调 `removePermissionPreset(text, 'inserted')`：归属不明时唯一能摘的是
 * **逐字节**长成我们输出的那一份。语义相同但写法不同的一份手写档位与我们的输出无法区分，
 * 摘它就是动用户的配置——与「不猜」冲突。认不出来（写法不同、形态读不懂）时原样返回，
 * 并把「保持了哪一行」原样交给调用方打 `warn:`。
 *
 * `defaultPreset: enhanced` 归属的判断与 `enhanced` 档分开：
 *   - 整行 permission 块逐字节等于 `PRESET_BLOCK` → 整行都是我们建的（`added` 的字节形态），
 *     默认档位一起摘；
 *   - 否则那行默认档位在我们动手之前就在，可能是用户写的 → 只摘 `enhanced` 档，把默认档位
 *     留在原地（回到它安装前的样子）并作为 `kept` 交给调用方打 `warn:` —— 名字相同、归属不同
 *     的两行，只有这一条能同时不猜、又不把用户那行删掉。
 *
 * 调用方还必须先确认这个 patch 里确实摘掉过我们的行（见 `uninstall.mjs` 的 `surgery`）：
 * 一个从没装过本工具的 profile 不该因为自己写了 enhanced 档而被动。
 *
 * @param {string} text
 * @returns {{ text: string, changed: string | undefined, kept: string | undefined }}
 */
export function removeUnownedEnhancedPreset(text) {
  const lines = splitLines(text)
  const found = enhancedSlot(lines)
  if (found === undefined || (found.keyIndex < 0 && found.flowIndex < 0)) {
    return { text, changed: undefined, kept: undefined }
  }
  const line = (found.keyIndex >= 0 ? found.keyIndex : found.flowIndex) + 1
  if (!ownsEnhancedShape(lines, found)) {
    return {
      text,
      changed: undefined,
      kept: `enhanced 档（第 ${line} 行）的写法不是我们写的那一份，归属不明，保持原样`,
    }
  }
  const rowIsOurs = permissionRowIsPresetTable(lines, found)
  const result = removePermissionPreset(text, 'inserted', rowIsOurs)
  const after = result.changed === undefined ? undefined : enhancedSlot(splitLines(result.text))
  // 摘完还剩 `defaultPreset: enhanced`：整行是我们的却没摘掉 = 形态认不出，放弃这次改写；
  // 整行不是我们的 = 那行本来就不该动，保留并告警。
  // 只在 permission 行这一块里找：patch 别处也可能有同名键（别的插件行），全文搜会
  // 把「别人的 defaultPreset: enhanced」算成自己的残留，白白放弃一次本来干净的摘除。
  const keptDefault = (() => {
    if (result.changed === undefined || after === undefined) return -1
    const resultLines = splitLines(result.text)
    for (let index = after.rowIndex + 1; index < after.end; index += 1) {
      if (/^[ \t]*defaultPreset:[ \t]*enhanced[ \t]*$/.test(resultLines[index])) return index + 1
    }
    return -1
  })()
  const leftover = result.changed === undefined
    || after === undefined
    || after.keyIndex >= 0
    || after.flowIndex >= 0
    || (rowIsOurs && keptDefault > 0)
  if (leftover) {
    return {
      text,
      changed: undefined,
      kept: `enhanced 档（第 ${line} 行）没能摘干净（形态认不出），归属不明，保持原样`,
    }
  }
  return {
    text: result.text,
    changed: rowIsOurs ? 'remove enhanced preset + default (归属未记录)' : 'remove enhanced preset (归属未记录)',
    kept: keptDefault > 0
      ? `defaultPreset: enhanced（第 ${keptDefault} 行）在我们动手之前就在，归属没有记录，保持原样（要一起清掉请手工删这一行）`
      : undefined,
  }
}

/**
 * Disable the shipped `ui-permission` row (when present) and insert our copy.
 *
 * - already wired → `changed` is undefined (idempotent);
 * - an existing `ui-permission` row without `disabled: true` → `flipped`;
 * - no `ui-permission` row → append one with `disabled: true` → `added`.
 *
 * @param {string} text Profile patch text.
 * @returns {{ text: string, changed: string | undefined, action: 'unchanged' | 'flipped' | 'added' }}
 */
export function wirePermissions(text) {
  if (new RegExp(`-[ \\t]*id:[ \\t]*${PERMISSION_ROW.id}[ \\t]*$`, 'm').test(text)) {
    return { text, changed: undefined, action: 'unchanged' }
  }
  const changes = []
  const eol = eolOf(text)
  let out = text.trim() === '[]' ? '' : text
  let action = 'unchanged'
  const row = /^([ \t]*)-[ \t]*id:[ \t]*ui-permission[ \t]*$/m.exec(out)
  if (row !== null) {
    const after = out.slice(row.index + row[0].length)
    const window = after.slice(0, after.search(/^[ \t]*-[ \t]*(id|insert):/m) >>> 0)
    if (!/^[ \t]*disabled:[ \t]*true/m.test(window)) {
      out = `${out.slice(0, row.index + row[0].length)}${eol}${row[1]}  disabled: true${out.slice(row.index + row[0].length)}`
      changes.push('disable ui-permission')
      action = 'flipped'
    }
  } else {
    out = `${out.replace(/\s*$/, '')}${eol}- id: ui-permission${eol}  disabled: true${eol}`
    changes.push('append ui-permission disabled')
    action = 'added'
  }
  const block = [
    '',
    '# enhance-permissions: the shipped selector\'s glyph table has no entry for a',
    '# custom preset, so a copy of that bundle serves the same slots plus one glyph.',
    '- insert:',
    `    - id: ${PERMISSION_ROW.id}`,
    `      name: '${PERMISSION_ROW.name}'`,
    '',
  ].join(eol)
  out = `${out.replace(/\s*$/, '')}${eol}${block}`
  changes.push('insert enhance-permissions')
  return { text: out, changed: changes.join(' | '), action }
}

/**
 * Read `defaultPreset` and that preset's `approval` from a profile patch.
 *
 * 安装器要在首装前判断「宿主自己的默认档位是不是 approval: never」——如果是，
 * 它种的 allow 永远轮不到；doctor 也用同一份解析。放在这里而不是各写一份，
 * 是为了让「怎么读默认档位」只有一处（只有一个读取口）。
 *
 * @param {string} text
 * @returns {{ name: string, approval: string | undefined } | undefined}
 */
export function defaultPresetApproval(text) {
  const lines = text.split(/\r?\n/)
  const declared = lines.find((line) => /^[ \t]*defaultPreset:[ \t]*\S/.test(line))
  if (declared === undefined) return undefined
  const name = declared.replace(/^.*defaultPreset:[ \t]*/, '').replace(/^['"]|['"]$/g, '').trim()
  if (name === '') return undefined
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((line) => new RegExp(`^[ \\t]*${escaped}:[ \\t]*$`).test(line))
  if (start < 0) return { name, approval: undefined }
  const base = (lines[start].match(/^[ \t]*/) ?? [''])[0].length
  for (let scan = start + 1; scan < lines.length; scan += 1) {
    const line = lines[scan]
    if (line.trim() === '') continue
    if (line.length - line.trimStart().length <= base) break
    const approval = /^[ \t]*approval:[ \t]*(\S+)/.exec(line)
    if (approval !== null) return { name, approval: approval[1] }
  }
  return { name, approval: undefined }
}
