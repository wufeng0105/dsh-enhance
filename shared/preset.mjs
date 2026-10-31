/**
 * 权限档位的读写：往 profile patch 里写 `enhanced` 档、摘掉它、读它的现状。
 *
 * 唯一消费者是设置页那条路（`enhance-scope` 的 `preset` op）与检查项。**没有第二个实现**。
 *
 * 三条硬约束（都由宿主的真实行为逼出来，不是风格偏好）：
 *
 *   1. **profile patch 的 `config` 是整块替换，不是深合并。**
 *      asar 内 `applyEntryPatches` 对非 insert 补丁执行 `target[key] = value`；
 *      实测只写一条 `enhanced` 的 `- id: permission` 会把基础组合包的
 *      `read-only` / `workspace-write` / `danger-full-access` 三条**连根拔掉**
 *      （`dsh --dump-config` 只剩 enhanced）。所以改 profile patch 时，
 *      `presets` 这张表要么不碰、要么写全。
 *   2. **不猜。** 认不出安全改法（多行 flow、`presets` 的值不是映射、引号未闭合）时
 *      返回 `{ error }`，由调用方拒绝；**绝不返回一份可能写坏宿主配置的文本**。
 *   3. **换行原样写回。** patch 是 CRLF 就必须还是 CRLF——宿主读 YAML 不看这个，
 *      但「只改我们都认识的那几行、其余逐字节不动」是本项目对用户配置的承诺。
 *
 * 归属不做「逐字节认领」那套取证：写的时候记一条事实（哪个 patch、什么动作、什么时候），
 * 摘的时候按记录办；记录缺失就报错并给手工指引。宁可让用户手删三行，
 * 也不去猜一份同名档位是不是我们写的。
 *
 * @module shared/preset
 */

import { readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { eolOf, joinLines, splitLines } from './text-lines.mjs'
import { defaultPresetApproval } from './preset-shape.mjs'
import { writeFileAtomic } from './state.mjs'

/** 自定义档名。封闭字面量：改这里等于改宿主的档位菜单，别改。 */
export const ENHANCED_NAME = 'enhanced'

/** 这条档位的两个旋钮。沙箱全开 + 越界仍问人——与内置 `danger-full-access`（never）的区别就在这。 */
export const ENHANCED_SPEC = Object.freeze({ sandbox: 'danger-full-access', approval: 'ask' })

/** 宿主基础组合包里那张三档表。写全表时以它为准（少一条就是删了用户的一个档位）。这里的 `approval:` 是档位规格的审批策略（`approval/policy`），与本仓 state.json 的开关档 `approval` 不是一套词表。 */
export const BASE_PRESETS = Object.freeze([
  { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
  { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
  { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
])

/** `- id: permission` 那一行的识别式。 */
const PERMISSION_ROW = /^([ \t]*)-[ \t]*id:[ \t]*permission[ \t]*$/
/** `presets:` 那一行的识别式（它的值可能是空的/注释，也可能是 `{…}`）。 */
const PRESETS_LINE = /^([ \t]*)presets[ \t]*:(.*)$/
/** `config:` 那一行。 */
const CONFIG_LINE = /^([ \t]*)config[ \t]*:(.*)$/
/** 行缩进宽度。@param {string} line */
function indentOf(line) {
  return (line.match(/^[ \t]*/) ?? [''])[0].length
}

/**
 * `- id: permission` 那一块的起止行号（`end` 不含，指向下一个同级 `- ` 行）。
 * 找不到返回 undefined。
 * @param {string[]} lines
 * @returns {{ start: number, end: number, base: number } | undefined}
 */
function permissionBlock(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = PERMISSION_ROW.exec(lines[index])
    if (match === null) continue
    const base = match[1].length
    let end = lines.length
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan]
      if (line.trim() === '') continue
      if (indentOf(line) <= base && /^[ \t]*-[ \t]*/.test(line)) {
        end = scan
        break
      }
    }
    return { start: index, end, base }
  }
  return undefined
}

/**
 * 找 `presets` 映射在 patch 里的位置与形态。
 *
 * 形态只有两种是可安全改写的：
 *   - `block`：`presets:` 行尾为空（或只有注释），映射写在下面的缩进块里；
 *   - `flow` ：`presets: {…}` 整张映射在同一行（`{}` 也算）。
 * 其余（多行 flow、`presets: 某个标量`、闭括号后面还跟着别的键）一律 `error`。
 *
 * @param {string[]} lines
 * @param {{ start: number, end: number }} block
 * @returns {{ form: 'block' | 'flow' | 'error', index: number, indent: number, body?: string, tail?: string, reason?: string } | undefined}
 */
function presetsMap(lines, block) {
  for (let index = block.start + 1; index < block.end; index += 1) {
    const match = PRESETS_LINE.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const tail = match[2]
    if (/^[ \t]*(#.*)?$/.test(tail)) return { form: 'block', index, indent }
    const rest = tail.trimStart()
    if (!rest.startsWith('{')) {
      return { form: 'error', index, indent, reason: `presets 的值不是映射：${rest.trim().slice(0, 40)}` }
    }
    const close = flowClose(rest, 0)
    if (close < 0) return { form: 'error', index, indent, reason: 'presets 的 flow 映射跨了多行或引号未闭合，无法安全改写单行' }
    const after = rest.slice(close + 1)
    if (!/^[ \t]*(#.*)?$/.test(after)) {
      return { form: 'error', index, indent, reason: `presets 的 flow 映射后面还有内容：${after.trim().slice(0, 40)}` }
    }
    return { form: 'flow', index, indent, body: rest.slice(1, close), tail: after }
  }
  return undefined
}

/**
 * `text[start]` 是 `{` 或 `[`，返回配对闭括号的下标；配不上返回 -1。
 * 引号与转义按 YAML 的习惯跳过，所以 `{a: "}"}` 不会提前收尾。
 * @param {string} text
 * @param {number} start
 */
function flowClose(text, start) {
  let depth = 0
  let quote = ''
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== '') {
      if (quote === '"' && char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
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

/** 一条 flow 条目的键名（去引号）。`a: b` → `a`。@param {string} entry */
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
 * 读 profile patch 里的档位现状。**不写盘、不抛**。
 *
 * @param {string} text
 * @returns {{
 *   hasPermissionRow: boolean,
 *   present: boolean,
 *   unreadable: boolean,
 *   unreadableReason: string | null,
 *   presets: string[],
 *   defaultPreset: string | null,
 * }}
 */
export function readPresetState(text) {
  const lines = splitLines(String(text ?? ''))
  const block = permissionBlock(lines)
  const state = {
    hasPermissionRow: block !== undefined,
    present: false,
    unreadable: false,
    unreadableReason: null,
    presets: [],
    defaultPreset: null,
  }
  if (block === undefined) return state

  const declaredDefault = lines
    .slice(block.start, block.end)
    .find((line) => /^[ \t]*defaultPreset:[ \t]*\S/.test(line))
  if (declaredDefault !== undefined) {
    state.defaultPreset = declaredDefault
      .replace(/^.*defaultPreset:[ \t]*/, '')
      .replace(/^['"]|['"]$/g, '')
      .trim() || null
  }

  const map = presetsMap(lines, block)
  if (map === undefined) return state
  if (map.form === 'error') {
    state.unreadable = true
    state.unreadableReason = map.reason ?? 'presets 的形态认不出'
    return state
  }
  if (map.form === 'flow') {
    state.presets = flowEntries(map.body ?? '').map(entryKey)
  } else {
    for (let index = map.index + 1; index < block.end; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      if (indentOf(line) <= map.indent) break
      const keyMatch = /^[ \t]*['"]?([A-Za-z0-9_.-]+)['"]?[ \t]*:/.exec(line)
      if (keyMatch !== null && indentOf(line) === map.indent + 2) state.presets.push(keyMatch[1])
    }
  }
  state.present = state.presets.includes(ENHANCED_NAME)
  return state
}

/** `enhanced:` 三行，按给定缩进。@param {number} indent @returns {string[]} */
function enhancedBlock(indent) {
  const pad = ' '.repeat(indent)
  return [
    `${pad}${ENHANCED_NAME}:`,
    `${pad}  sandbox: ${ENHANCED_SPEC.sandbox}`,
    `${pad}  approval: ${ENHANCED_SPEC.approval}`,
  ]
}

/** 完整档位表（含 enhanced），按给定缩进。@param {number} indent @returns {string[]} */
function fullPresetTable(indent) {
  const pad = ' '.repeat(indent)
  const rows = []
  for (const preset of [...BASE_PRESETS, { name: ENHANCED_NAME, ...ENHANCED_SPEC }]) {
    rows.push(`${pad}${preset.name}:`)
    rows.push(`${pad}  sandbox: ${preset.sandbox}`)
    rows.push(`${pad}  approval: ${preset.approval}`)
  }
  return rows
}

/**
 * 把 `enhanced` 档写进 patch 文本。**幂等**：已经写过就原样返回。
 *
 * 三条分支：
 *   - 没有 `- id: permission` 行 → 在末尾追加一整行（含完整三档 + enhanced）。
 *     必须写全，理由见文件头第 1 条硬约束（`config` 是整块替换，不是深合并）。
 *   - 有该行、但块里没有 `presets:` → 在 `config:`（或行尾）下补一个完整映射。
 *   - 有 `presets:` → 在映射里补 enhanced（块风格插在表尾；flow 风格改写那一行）。
 *
 * **不写 `defaultPreset`**：本工具不改用户的默认档位。已有值原样保留；
 * 没有就维持没有（宿主按组合的 sandbox + approval 推导，行为与安装前一致）。
 *
 * @param {string} text
 * @returns {{ text: string, changed?: string, action: 'added' | 'inserted' | 'unchanged', error?: string }}
 */
export function ensureEnhancedPreset(text) {
  const source = String(text ?? '')
  const state = readPresetState(source)
  if (state.present) return { text: source, action: 'unchanged' }
  if (state.unreadable) {
    return { text: source, action: 'unchanged', error: `profile 的 presets 形态认不出，无法安全改写：${state.unreadableReason ?? ''}` }
  }

  const eol = eolOf(source)
  const lines = splitLines(source)
  const emptyPatch = source.trim() === '' || source.trim() === '[]' ||
    source.split(/\r?\n/).every((line) => line.trim() === '' || line.trim().startsWith('#') || line.trim() === '[]')

  if (!state.hasPermissionRow) {
    const head = emptyPatch
      ? lines.filter((line) => line.trim() !== '' && line.trim() !== '[]').join(eol)
      : lines.join(eol).replace(/\s*$/, '')
    const row = [
      '- id: permission',
      '  name: "@deepseek-ai/dsh-permission-presets"',
      '  config:',
      '    presets:',
      ...fullPresetTable(6),
    ]
    const prefix = head === '' ? '' : `${head}${eol}`
    return {
      text: `${prefix}${row.join(eol)}${eol}`,
      changed: '追加 permission 行（完整三档 + enhanced）',
      action: 'added',
      emptyArray: emptyPatch,
    }
  }

  const block = permissionBlock(lines)
  const map = presetsMap(lines, block)

  // 有 permission 行但没有 presets 映射：在 config: 下补完整表（含 enhanced）。
  if (map === undefined) {
    const configIndex = (() => {
      for (let index = block.start + 1; index < block.end; index += 1) {
        if (CONFIG_LINE.test(lines[index])) return index
      }
      return -1
    })()
    const rows = [`${' '.repeat(block.base + 4)}presets:`, ...fullPresetTable(block.base + 6)]
    const insertAt = configIndex >= 0 ? configIndex + 1 : block.start + 1
    const next = [...lines]
    next.splice(insertAt, 0, ...(configIndex >= 0 ? rows : [`${' '.repeat(block.base + 2)}config:`, ...rows]))
    return { text: joinLines(next, eol), changed: '补 presets 映射（完整三档 + enhanced）', action: 'inserted' }
  }

  if (map.form === 'flow') {
    const entries = flowEntries(map.body ?? '')
    const separator = (map.body ?? '').trim() === '' ? '' : (map.body ?? '').trimEnd().endsWith(',') ? ' ' : ', '
    const spec = `{sandbox: ${ENHANCED_SPEC.sandbox}, approval: ${ENHANCED_SPEC.approval}}`
    const rewritten = `${' '.repeat(map.indent)}presets: {${map.body ?? ''}${separator}${ENHANCED_NAME}: ${spec}}${map.tail ?? ''}`
    const next = [...lines]
    next[map.index] = rewritten
    return { text: joinLines(next, eol), changed: '写 Enhanced 档（flow 映射）', action: 'inserted' }
  }

  // 块风格：插在 `presets:` 下这张表的末尾（保持用户已有顺序）。
  let insertAt = map.index + 1
  for (let index = map.index + 1; index < block.end; index += 1) {
    const line = lines[index]
    if (line.trim() === '') continue
    if (indentOf(line) <= map.indent) break
    insertAt = index + 1
  }
  const next = [...lines]
  next.splice(insertAt, 0, ...enhancedBlock(map.indent + 2))
  return { text: joinLines(next, eol), changed: '写 Enhanced 档（块映射）', action: 'inserted' }
}

/**
 * 摘掉 `enhanced` 档。
 *
 * 只摘两种东西：
 *   ① 归属记录说「这一整行 permission 是我们追加的」→ 整行摘掉，并**尽量把 patch 还原成
 *      写前的字节**（记录里存了原文）。空数组这种基线要还回 `[]`——profile patch 必须是
 *      顶层数组，摘成空文件宿主会解析失败。
 *   ② 否则只摘 `enhanced:` 那三行（块风格）或 flow 映射里的那一条。
 *
 * 还原是「有条件」的：只有当摘掉我们那一块之后剩下的内容，与「写前原文去掉它的 `[]` 行」
 * 对得上时，才交还原文——用户在我们写完之后又改过别处的话，就当没这回事，只做行级摘除。
 *
 * 认不出形态、或没有归属记录，一律原样返回并给原因——**不猜**。
 * 「逐字节认领」那套取证被拿掉了：宁可让用户手删三行，也不去猜一份同名档位是不是我们写的。
 *
 * 文案口径：`changed` / 错误消息里出现的 `enhanced` 指的是 patch 里的字面键名
 * （`enhanced:` 三行）。它在用户面前有三层名字，都别「统一」成同一个：
 * 档位菜单里是纯文字的 **Enhanced**（表外档名，宿主按 Title Case 渲染）；
 * 设置页那一组的组名是「Enhanced 权限档」；检查项里那一项叫「Enhanced 档」。
 * 键名与这三个显示名并存是有意的。
 *
 * @param {string} text
 * @param {{ action?: 'added' | 'inserted' | 'unchanged', emptyArray?: boolean, original?: string } | undefined} [record]
 * @returns {{ text: string, changed?: string, error?: string }}
 */
export function removeEnhancedPreset(text, record) {
  const source = String(text ?? '')
  const eol = eolOf(source)
  const state = readPresetState(source)

  if (state.unreadable) {
    return { text: source, error: `profile 的 presets 形态认不出，无法安全摘除：${state.unreadableReason ?? ''}` }
  }
  if (record === undefined || (record.action !== 'added' && record.action !== 'inserted')) {
    return { text: source, error: '没有「这一档是我们写的」的记录，无法安全摘除；请手工删掉 enhanced 那三行' }
  }

  // ① 整行是我们追加的，且文件自我们写完起没被别人动过 → 直接还原写前原文。
  //
  // 「有没有被动过」用重新算一遍来判断：对记录里的原文再跑一次 ensure，结果与我们此刻
  // 看到的文本逐字节相同，就说明中间没人改过。这个判据比扫描行边界可靠——注释行与
  // 空行的归属在 YAML 里本来就是模糊的，按行切很容易把用户后来加的注释一起切掉。
  if (record.action === 'added' && state.hasPermissionRow && typeof record.original === 'string' && record.original !== '') {
    const ours = ensureEnhancedPreset(record.original)
    if (ours.error === undefined && source === ours.text) {
      return { text: record.original, changed: '摘掉 permission 行（整行是我们追加的，已还原为写前字节）' }
    }
    // 被别人改过：不整行摘（那会连带删掉用户的改动），退到②只摘 enhanced 那三行。
  }

  if (!state.present) return { text: source, changed: undefined }

  let lines = splitLines(source)

  // ② flow 风格：从那条映射里摘掉 enhanced 这一项。
  const map = presetsMap(lines, permissionBlock(lines))
  if (map !== undefined && map.form === 'flow') {
    const entries = flowEntries(map.body ?? '')
    const kept = entries.filter((entry) => entryKey(entry) !== ENHANCED_NAME)
    const rewritten = `${' '.repeat(map.indent)}presets: {${kept.map((entry) => entry.trim()).join(', ')}}${map.tail ?? ''}`
    lines = [...lines]
    lines[map.index] = rewritten
    return { text: joinLines(lines, eol), changed: '移除 Enhanced 档（flow 映射）' }
  }

  // ② 块风格：摘 enhanced: 及其子键。
  const block = permissionBlock(lines)
  for (let index = block.start + 1; index < block.end; index += 1) {
    if (!/^[ \t]*enhanced[ \t]*:(?:[ \t]*(?:#.*)?)?$/.test(lines[index])) continue
    const indent = indentOf(lines[index])
    let end = index + 1
    while (end < block.end) {
      const line = lines[end]
      if (line.trim() === '' || indentOf(line) <= indent) break
      end += 1
    }
    lines = [...lines]
    lines.splice(index, end - index)
    return { text: joinLines(lines, eol), changed: '移除 Enhanced 档（块映射）' }
  }

  return { text: source, error: '能找到 enhanced 档，但没法安全定位它那几行；请手工删掉' }
}

/**
 * 归属记录的文件位置（`<home>/enhance/preset-write.json`）。
 * @param {{ dir: string }} paths
 */
export function presetRecordPath(paths) {
  return join(paths.dir, 'preset-write.json')
}

/**
 * 读归属记录。读不到 / 坏 JSON → undefined（调用方按「没有记录」处理，不抛）。
 * @param {{ dir: string }} paths
 * @returns {{ patchPath: string, profile: string | null, action: 'added' | 'inserted', writtenAt: string } | undefined}
 */
export function readPresetRecord(paths) {
  try {
    const parsed = JSON.parse(readFileSync(presetRecordPath(paths), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.patchPath !== 'string') return undefined
    if (parsed.action !== 'added' && parsed.action !== 'inserted') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export { defaultPresetApproval }

/**
 * 写归属记录。目录不存在就建；写入是原子的（借 `shared/state.mjs` 的 `writeFileAtomic`）。
 * 记录只记事实：改的是哪个 patch、做的是哪种动作、动手前的 patch 是不是空数组、什么时候。
 *
 * `emptyArray` 是「移除时要不要写回 `[]`」的唯一依据：profile patch 必须是顶层数组，
 * 摘成空文件宿主会解析失败，所以空数组这种基线要记下来、原样还回去。
 *
 * @param {{ dir: string }} paths
 * @param {{ patchPath: string, profile: string | null, action: 'added' | 'inserted', emptyArray: boolean, writtenAt: string }} record
 */
export function writePresetRecord(paths, record) {
  writeFileAtomic(presetRecordPath(paths), `${JSON.stringify(record, null, 2)}\n`)
}

/** 清掉归属记录（移除成功后调用）。文件不存在不算错。@param {{ dir: string }} paths */
export function clearPresetRecord(paths) {
  try {
    unlinkSync(presetRecordPath(paths))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
