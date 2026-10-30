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
 * （`allow` / `ask` / `deny`），与宿主 `approval/request` 能做的三件事一一对应
 * （回 `allowed-once`、`next()` 交还下游、回 `rejected`）。1.0 起不做旧格式迁移：
 * 读的时候只认这三个字段，`approval` 不认识就标坏并倒向 `ask`（问人，不静默放行）。
 */

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 文本上限：8 KB。超过就拒绝——别把巨型文本塞进系统提示。 */
export const TEXT_LIMIT = 8 * 1024

/** `state.json` 的格式版本。 */
export const STATE_VERSION = 3

/** 审批三态；与宿主 outcome 的映射见文件头。 */
export const APPROVALS = ['allow', 'ask', 'deny']

/** `$DSH_HOME`（非空优先），否则 `~/.dsh`。 */
export function resolveHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh')
}

/** @param {string} [home] @returns {{ dir: string, state: string, text: string }} */
export function paths(home = resolveHome()) {
  const dir = join(home, 'enhance')
  return {
    dir,
    state: join(dir, 'state.json'),
    text: join(dir, 'content-scope.txt'),
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
 * 不静默放行）。首装播种的审批值见 `shared/seed.mjs`，不由这里兜底。
 */
const DEFAULTS = Object.freeze({ enabled: true, contentScope: true, approval: 'ask' })

/** 审批值不在三态里时回落 `ask`（写盘用）。 */
function toApproval(value) {
  return APPROVALS.includes(value) ? value : 'ask'
}

/** 读布尔：认 `true`/`false` 与字符串 `"true"`/`"false"`；其余回退。 */
function readFlag(value, fallback) {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return fallback
}

/**
 * 读状态。缺失或损坏都按默认值处理：文本与总开关默认开，审批默认 `ask`。
 * 文本可以“宁可多注入一句”，审批不跟着走——状态说不清时问人。
 *
 * 只认 `enabled` / `contentScope` / `approval` 三个字段；`approval` 不是三态之一时
 * 按 `ask` 处理**并标坏**（`degraded=true`）——这一层唯一的降级方向是倒向问人。
 * @param {{ state: string, text: string }} p
 * @returns {{ version: number, contentScope: boolean, approval: 'allow'|'ask'|'deny', updatedAt?: string, degraded: boolean, degradedReason: 'missing' | 'corrupt' | null }}
 */
export function readState(p) {
  let raw
  try {
    raw = readFileSync(p.state, 'utf8')
  } catch {
    return { version: STATE_VERSION, ...DEFAULTS, updatedAt: undefined, degraded: true, degradedReason: 'missing' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { version: STATE_VERSION, ...DEFAULTS, updatedAt: undefined, degraded: true, degradedReason: 'corrupt' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: STATE_VERSION, ...DEFAULTS, updatedAt: undefined, degraded: true, degradedReason: 'corrupt' }
  }

  const enabled = readFlag(parsed.enabled, true)
  const contentScope = readFlag(parsed.contentScope, true)
  const approvalKnown = APPROVALS.includes(parsed.approval)

  return {
    version: STATE_VERSION,
    enabled,
    contentScope,
    approval: approvalKnown ? parsed.approval : 'ask',
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    degraded: !approvalKnown,
    degradedReason: approvalKnown ? null : 'corrupt',
  }
}

/**
 * 写状态（总是写 v3）。三个开关由调用方给全；`version`/`updatedAt` 由这里生成。
 * @param {{ state: string, text: string }} p
 * @param {{ contentScope: boolean, approval: 'allow'|'ask'|'deny' }} next
 */
export function writeState(p, next) {
  const body = {
    version: STATE_VERSION,
    enabled: next.enabled !== false,
    contentScope: next.contentScope === true,
    approval: toApproval(next.approval),
    updatedAt: new Date().toISOString(),
  }
  writeFileAtomic(p.state, `${JSON.stringify(body, null, 2)}\n`)
  return body
}

/**
 * 读文本。返回 `{ text, ok }`：`ok=false` 表示文件读不到（调用方应保留上一次好值）。
 * @param {{ state: string, text: string }} p
 */
export function readText(p) {
  try {
    return { text: normalizeText(readFileSync(p.text, 'utf8')), ok: true }
  } catch {
    return { text: '', ok: false }
  }
}

/**
 * 写文本（归一后落盘）。超限抛 `ETOOLARGE`，调用方按 `code` 分支。
 * @param {{ state: string, text: string }} p
 * @param {string} text
 * @returns {{ bytes: number, sha256: string }}
 */
export function writeText(p, text) {
  const clean = normalizeText(text)
  const bytes = Buffer.byteLength(clean, 'utf8')
  if (bytes > TEXT_LIMIT) throw Object.assign(new Error(`text exceeds ${TEXT_LIMIT} bytes`), { code: 'ETOOLARGE' })
  writeFileAtomic(p.text, clean)
  return { bytes, sha256: createHash('sha256').update(clean, 'utf8').digest('hex').slice(0, 12) }
}

/** 文本的 sha256 前 12 位（与 `writeText` 同一口径，只读不写）。 */
export function textSha256(text) {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex').slice(0, 12)
}

/** 文件元信息（页面状态行用）；读不到返回 `undefined`。`bytes` 是磁盘上的原始大小。 */
export function textStat(p) {
  try {
    const item = statSync(p.text)
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
