/**
 * enhance 的共享状态层：状态与文本的唯一读写口。
 *
 * 两个消费方（`enhance-scope`、`auto-approve`）都从这里读，
 * 谁也不各自解析一遍。文件是唯一真相：`state.json` 存开关，`content-scope.txt` 存文本。
 *
 * 三条纪律：
 *   - 写文件一律 temp + rename（进程被杀不会留下半个 JSON），目录先建。
 *   - 坏文件不抛：`state.json` 缺失/损坏都按默认值并标 `degraded`，
 *     理由放在 `degradedReason`，设置页靠它说话。
 *   - 文本按「去 BOM → 去控制字符 → trim」归一，落盘与上报字节数用同一个口径。
 *
 * 状态里只有 `enabled` / `contentScope` / `approval` 三个字段，审批是三态
 * （`allow` / `ask` / `deny`）；宿主的 `approval/request` 有四个 outcome
 * （`allowed-once` / `rejected` / `cancelled` / `unavailable`），我们只产出其中三个
 * （回 `allowed-once`、`next()` 交还下游、回 `rejected`）。1.0 起不做旧格式迁移：
 * 读的时候只认这三个字段，`approval` 不认识就标坏并倒向 `ask`（问人，不静默放行）。
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 文本上限：8 KB。超过就拒绝——别把巨型文本塞进系统提示。 */
export const TEXT_LIMIT = 8 * 1024

/**
 * 品牌人设自定义文本的上限：2 KB。
 *
 * 比内容边界小一个量级，因为它替换的是**系统提示的第一句**——那是一句声明，不是散文。
 * 上限独立，不与 `TEXT_LIMIT` 共用：两份文本的用途不同，共用上限等于让一份的放宽替另一份放行。
 */
export const IDENTITY_LIMIT = 2 * 1024

/** `state.json` 的格式版本。v4 加 `identity` / `hideHarness`，不改 v3 已有字段。 */
export const STATE_VERSION = 4

/**
 * 品牌人设三态：`keep`（保留宿主原句）/ `remove`（去掉）/ `custom`（换成 `identity.txt`）。
 * 默认 `keep`——这一层唯一的降级方向是不改身份。
 */
export const IDENTITY_MODES = ['keep', 'remove', 'custom']

/**
 * 审批三态，也就是开关档 `approval` 的词表：`allow` / `ask` / `deny`。
 * 与宿主 outcome 的映射见文件头；与档位规格的审批策略 `approval/policy`（`ask` / `never`）不是一套。
 */
export const APPROVALS = ['allow', 'ask', 'deny']

/** `$DSH_HOME`（非空优先），否则 `~/.dsh`。 */
export function resolveHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh')
}

/** @param {string} [home] @returns {{ dir: string, state: string, text: string, identity: string }} */
export function paths(home = resolveHome()) {
  const dir = join(home, 'enhance')
  return {
    dir,
    state: join(dir, 'state.json'),
    text: join(dir, 'content-scope.txt'),
    identity: join(dir, 'identity.txt'),
  }
}

/** 控制字符里只保留 `\n` 与 `\t`：提示词是散文，NUL 与转义序列没有存在的理由。 */
export function normalizeText(value) {
  return String(value)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
}

/** 文本的对外字节数（与 `sha256`、`writeText` 同一口径：归一后按 UTF-8 计）。 */
export function textBytes(text) {
  return Buffer.byteLength(normalizeText(text), 'utf8')
}

/**
 * 原子写：同目录写临时文件再 rename。目录不存在就先建。
 * @param {string} file
 * @param {string} data
 */
export function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(temporary, data, 'utf8')
  try {
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // 临时文件本就可能不在：原始错误才是要报的那条
    }
    throw error
  }
}

/**
 * 默认值：文本注入与总开关默认开（宁可多注入一句），审批默认 `ask`（状态说不清时问人，
 * 不静默放行），品牌人设默认 `keep`＋不隐藏（不改身份）。
 * 首装播种的审批值见 `shared/seed.mjs`，不由这里兜底。
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  contentScope: true,
  approval: 'ask',
  identity: 'keep',
  hideHarness: false,
})

/** 审批值不在三态里时回落 `ask`（写盘用）。 */
function toApproval(value) {
  return APPROVALS.includes(value) ? value : 'ask'
}

/** 身份模式不合法时回落 `keep`（写盘用）——不改身份是唯一的安全方向。 */
function toIdentity(value) {
  return IDENTITY_MODES.includes(value) ? value : 'keep'
}

/** 读布尔：认 `true`/`false` 与字符串 `"true"`/`"false"`；其余回退。 */
function readFlag(value, fallback) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/**
 * 读状态。缺失或损坏都按默认值处理：文本与总开关默认开，审批默认 `ask`，
 * 品牌人设默认 `keep`＋不隐藏。文本可以“宁可多注入一句”，审批不跟着走——状态说不清时问人；
 * 身份也不跟着走——状态说不清时不改身份。
 *
 * 只认 `enabled` / `contentScope` / `approval` / `identity` / `hideHarness` 五个字段；
 * `approval` 不是三态之一时按 `ask` 处理并标坏，`identity` 不是三态之一时按 `keep`
 * 处理并标坏——两层降级方向都是「更保守」。`degradedFields` 记下具体是哪个字段坏了，
 * 设置页靠它说对原因（只写一句「审批回落」会把身份坏值说成审批的事）。
 * @param {{ state: string, text: string }} p
 * @returns {{ version: number, enabled: boolean, contentScope: boolean, approval: 'allow'|'ask'|'deny', identity: 'keep'|'remove'|'custom', hideHarness: boolean, updatedAt?: string, degraded: boolean, degradedReason: 'missing' | 'corrupt' | null, degradedFields: string[] }}
 */
export function readState(p) {
  let raw
  try {
    raw = readFileSync(p.state, 'utf8')
  } catch {
    return { version: STATE_VERSION, ...DEFAULTS, updatedAt: undefined, degraded: true, degradedReason: 'missing', degradedFields: [] }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { version: STATE_VERSION, ...DEFAULTS, updatedAt: undefined, degraded: true, degradedReason: 'corrupt', degradedFields: [] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: STATE_VERSION, ...DEFAULTS, updatedAt: undefined, degraded: true, degradedReason: 'corrupt', degradedFields: [] }
  }

  const enabled = readFlag(parsed.enabled, true)
  const contentScope = readFlag(parsed.contentScope, true)
  const approvalKnown = APPROVALS.includes(parsed.approval)
  // v3 之前就有 `approval`：缺了是异常。v4 新加的 `identity` / `hideHarness` 缺了是**正常的**
  // ——旧文件本来就没有这两个键，升级不该被标成降级。只有「写了但认不出」才算坏。
  const identityPresent = parsed.identity !== undefined
  const identityKnown = IDENTITY_MODES.includes(parsed.identity)
  const hideHarnessPresent = parsed.hideHarness !== undefined && parsed.hideHarness !== null
  const hideHarnessKnown = parsed.hideHarness === true || parsed.hideHarness === false
    || parsed.hideHarness === 'true' || parsed.hideHarness === 'false'

  const degradedFields = []
  if (!approvalKnown) degradedFields.push('approval')
  if (identityPresent && !identityKnown) degradedFields.push('identity')
  if (hideHarnessPresent && !hideHarnessKnown) degradedFields.push('hideHarness')

  return {
    version: STATE_VERSION,
    enabled,
    contentScope,
    approval: approvalKnown ? parsed.approval : 'ask',
    identity: identityKnown ? parsed.identity : 'keep',
    hideHarness: readFlag(parsed.hideHarness, false),
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    degraded: degradedFields.length > 0,
    degradedReason: degradedFields.length > 0 ? 'corrupt' : null,
    degradedFields,
  }
}

/**
 * 写状态（总是写 v4）。五个开关由调用方给全（`enabled` 省略即当开）；`version`/`updatedAt` 由这里生成。
 *
 * **整块重建**：不带上一次的 `identity` / `hideHarness` 就等于把它们重置回默认。
 * 所有调用点都必须先 `readState()` 再原样带回，见 `enhance-scope` 的 `set` 与 `shared/seed.mjs`。
 * @param {{ state: string, text: string }} p
 * @param {{ enabled?: boolean, contentScope: boolean, approval: 'allow'|'ask'|'deny', identity?: 'keep'|'remove'|'custom', hideHarness?: boolean }} next
 */
export function writeState(p, next) {
  const body = {
    version: STATE_VERSION,
    enabled: next.enabled !== false,
    contentScope: next.contentScope === true,
    approval: toApproval(next.approval),
    identity: toIdentity(next.identity),
    hideHarness: next.hideHarness === true,
    updatedAt: new Date().toISOString(),
  }
  writeFileAtomic(p.state, `${JSON.stringify(body, null, 2)}\n`)
  return body
}

/**
 * 读一个文本文件。返回 `{ text, ok }`：`ok=false` 表示文件读不到（调用方应保留上一次好值）。
 *
 * 这是**唯一的读实现**：内容边界与品牌人设都走它，只是文件不同。
 * 另起一份「差不多」的实现，归一/编码/sha 的口径迟早会漂。
 * @param {string} file
 */
export function readTextFile(file) {
  try {
    return { text: normalizeText(readFileSync(file, 'utf8')), ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

/**
 * 写一个文本文件（归一后落盘）。超限抛 `ETOOLARGE`，调用方按 `code` 分支。
 * @param {string} file
 * @param {string} text
 * @param {number} [limit] 字节上限，默认 `TEXT_LIMIT`
 * @returns {{ bytes: number, sha256: string }}
 */
export function writeTextFile(file, text, limit = TEXT_LIMIT) {
  const clean = normalizeText(text)
  const bytes = Buffer.byteLength(clean, 'utf8')
  if (bytes > limit) throw Object.assign(new Error(`text exceeds ${limit} bytes`), { code: 'ETOOLARGE' })
  writeFileAtomic(file, clean)
  return { bytes, sha256: textSha256(clean) }
}

/**
 * 读内容边界文本。
 * @param {{ state: string, text: string }} p
 */
export function readText(p) {
  return readTextFile(p.text)
}

/**
 * 写内容边界文本。
 * @param {{ state: string, text: string }} p
 * @param {string} text
 */
export function writeText(p, text) {
  return writeTextFile(p.text, text, TEXT_LIMIT)
}

/**
 * 读品牌人设自定义文本。
 * @param {{ identity: string }} p
 */
export function readIdentity(p) {
  return readTextFile(p.identity)
}

/**
 * 写品牌人设自定义文本（上限 `IDENTITY_LIMIT`）。
 * @param {{ identity: string }} p
 * @param {string} text
 */
export function writeIdentity(p, text) {
  return writeTextFile(p.identity, text, IDENTITY_LIMIT)
}

/** 文本的 sha256 前 12 位（与 `writeText` 同一口径，只读不写）。 */
export function textSha256(text) {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex').slice(0, 12)
}

/** 文件元信息（页面状态行用）；读不到返回 `undefined`。`bytes` 是磁盘上的原始大小。 */
export function textStat(p) {
  return fileStat(p.text)
}

/** 任意文件的元信息；读不到返回 `undefined`。 */
export function fileStat(file) {
  try {
    const item = statSync(file)
    return { mtime: item.mtime.toISOString(), bytes: item.size }
  } catch {
    return undefined
  }
}

/**
 * 进程内插件登记表。
 *
 * 同一进程里两个插件 import 的是同一个模块实例，所以这里的内存表就是准确的
 * 「本进程到底挂了哪些件」。跨进程（`dsh web` 与桌面端各一份）各算各的，
 * 不要把它当持久状态——持久状态只有 `state.json`。
 */
const loadedPlugins = new Map()

/** @param {string} name @param {boolean} [active] */
export function markPluginActive(name, active = true) {
  loadedPlugins.set(name, active === true)
}

/** @param {string} name */
export function isPluginActive(name) {
  return loadedPlugins.get(name) === true
}

/**
 * 派生「内容边界注不注入」：**只有它为真时，提示词里才真的会有那一段**。
 * `active` 是「本进程的 section 真的注册上了」，不是「文件读得到」。
 * `reason` 只给人看；机读判别符在路由的错误体里。
 * @param {{ contentScope: boolean }} state
 * @param {{ text: string, ok: boolean }} text
 * @param {boolean} [active]
 * @returns {{ injecting: boolean, reason: string | undefined }}
 */
export function derive(state, text, active = true) {
  if (!active) return { injecting: false, reason: '插件未激活' }
  if (state.enabled === false) return { injecting: false, reason: '总开关关闭' }
  if (state.contentScope !== true) return { injecting: false, reason: '开关关闭' }
  if (!text.ok) return { injecting: false, reason: '读不到 content-scope.txt' }
  if (text.text.length === 0) return { injecting: false, reason: '文本为空' }
  // 上限同样管**读**：README 让用户直接编辑 content-scope.txt，而写路径（writeText / API）
  // 之外的这份文件没人拦。超限时整段注入会绕过 8 KB 上限，且注入效果没有任何信号 ——
  // 所以这里按写入口径拒绝注入，理由给到人；设置页的 check 用同一个判据（TEXT_LIMIT）。
  if (textBytes(text.text) > TEXT_LIMIT) {
    return { injecting: false, reason: `文本超过上限（${TEXT_LIMIT} B）` }
  }
  return { injecting: true, reason: undefined }
}

/**
 * 派生「品牌人设该注册什么」。
 *
 * 返回 `mode` 是**实际生效**的模式，不是 state 里写的那个：`custom` 读不到文本、文本为空、
 * 或超限时都会退化，退化方向一律 `keep`（= 宿主原样，不改身份）。
 * `text` 只在 `custom` 且文本可用时非空。
 *
 * 与 `derive()` 的分工：那个回答「内容边界注不注入」，这个回答「身份段怎么注册」。
 * 两者都从同一份 state 派生，但判据不同，不强并成一个函数。
 *
 * @param {{ enabled: boolean, identity: 'keep'|'remove'|'custom', hideHarness: boolean }} state
 * @param {{ text: string, ok: boolean }} [identityText]
 * @returns {{ mode: 'keep'|'remove'|'custom', text: string, hideHarness: boolean, degraded: boolean, reason: string | undefined }}
 */
export function deriveIdentity(state, identityText = { text: '', ok: true }) {
  // 页级总开关关着 = 这一页什么都不做，品牌人设也跟着停手
  if (state?.enabled === false) return { mode: 'keep', text: '', hideHarness: false, degraded: false, reason: '总开关关闭' }

  const wanted = IDENTITY_MODES.includes(state?.identity) ? state.identity : 'keep'
  const hideHarness = state?.hideHarness === true

  if (wanted === 'keep') return { mode: 'keep', text: '', hideHarness, degraded: false, reason: undefined }
  if (wanted === 'remove') return { mode: 'remove', text: '', hideHarness, degraded: false, reason: undefined }

  // wanted === 'custom'：三条退化路径，全部倒向 keep，理由给到人
  if (!identityText.ok) return { mode: 'keep', text: '', hideHarness, degraded: true, reason: '读不到 identity.txt' }
  if (identityText.text.length === 0) return { mode: 'remove', text: '', hideHarness, degraded: true, reason: '自定义文本为空（按去掉处理）' }
  // 上限同样管**读**：README 让用户直接编辑 identity.txt，写路径之外的这份文件没人拦
  if (textBytes(identityText.text) > IDENTITY_LIMIT) {
    return { mode: 'keep', text: '', hideHarness, degraded: true, reason: `自定义文本超过上限（${IDENTITY_LIMIT} B）` }
  }
  return { mode: 'custom', text: identityText.text, hideHarness, degraded: false, reason: undefined }
}
