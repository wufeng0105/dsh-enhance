/**
 * 内容边界注入 + 设置页的服务端。
 *
 * 两件事：
 *   1. 把 `content-scope.txt` 注入成提示词的一段（`enhance:content-scope`，order 同官方 persona suffix）
 *   2. 在宿主已有的本地 HTTP 服务上挂一条路由 `POST /enhance/api`，供设置页读写
 *
 * 四个 op：`state` 快照、`set` 改开关或文本、`check` 运行时检查、
 * `preset` 写/摘 `enhanced` 权限档（本页唯一会碰宿主配置的动作，用户显式点才发生）。
 *
 * 两条关键事实：
 *   - **不能 `inject: ['webServer']`**：headless 里没有这个服务，`inject` 要求全部齐备，
 *     插件会永远 PENDING，内容边界直接消失。要用 `ctx.inject(['webServer'], cb)` 做运行期可选注入。
 *   - 文本每次 assembly 重读，读失败保留上一次好值；`state.json` 坏文件按默认值处理。
 *
 * 来源校验（`sameOrigin`）按三道顺序判，任一道不过即拒：
 *   1. socket 远端必须是回环；
 *   2. `Host` 必须是**回环字面量**（`localhost` / `127.0.0.1` / `[::1]`，带不带端口都行）。
 *      这一条挡 DNS rebinding：攻击者的域名解析到 127.0.0.1 时，Host 会是那个域名，直接出局；
 *   3. `Origin` 缺失视为非浏览器客户端（curl、CLI、Electron 主进程）放行；`app:` 自定义
 *      scheme 放行；其余必须与 Host 严格同源（scheme + host + port）。`Origin: null` 拒绝。
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  APPROVALS, IDENTITY_LIMIT, IDENTITY_MODES, TEXT_LIMIT, derive, deriveIdentity, isPluginActive,
  markPluginActive, paths, readIdentity, readState, readText, resolveHome, textBytes, textSha256,
  textStat, fileStat, writeFileAtomic, writeIdentity, writeState, writeText,
} from '../shared/state.mjs'
import { ensureEnhanceData } from '../shared/seed.mjs'
import { sessionContains, sessionOmits } from '../shared/session-probe.mjs'
import {
  clearPresetRecord, ensureEnhancedPreset, readPresetRecord, readPresetState,
  removeEnhancedPreset, writePresetRecord,
} from '../shared/preset.mjs'
import { declarationOf, displayRange, inRange, parseEnginesDsh } from '../shared/compat.mjs'

/** 诊断标签；只出现在宿主日志与失败链里。 */
export const name = 'enhance-scope'

/** 提示词注册表；`webServer` 是可选的，所以不写进 inject。 */
export const inject = ['systemPrompt']

/** 段名与官方 persona suffix 不同名（同名二次注册会抛）。order 相同；同 order 时宿主按段名定序（`comparePromptSections`），`enhance:` 在 `deployment:` 之后，所以仍落在 persona suffix 之后。 */
const SECTION_NAME = 'enhance:content-scope'

/**
 * 品牌人设要遮蔽的宿主名字。
 *
 * **三个**名字（不是四个）都是**全局注册的第一方段/上下文**；按 agent 作用域用同名项
 * 遮蔽它们，是宿主自己明确支持的能力（`@deepseek-ai/dsh-system-prompt/README.md`：
 * 「creator plugins may register agent-scoped shadows」）。
 * 宿主自己的使用实例只有**两个**：`dsh-persona` 与 `dsh-subagent`，都在遮
 * `deployment:persona-prefix`。**不要把 `dsh-file-reference-local` 列进来**——实测它
 * 注册的是唯一名 `context:file-reference`，不是同名遮蔽（2026-11-02 核对 asar 时发现的
 * 早期注释错误）。`harness:identity` 在本仓之前没有宿主内先例，靠的是上面那条通则。
 *
 * `harness:source` 与 `app:web-surface` 各自**同时**是 section 与 context 的名字，
 * 两个表都要遮——只遮一处，另一处会照原样出现。
 *
 * 只按名定位，不按文本匹配：`harness-dev-context` 会给旧会话返回历史措辞，
 * 按文本找必然漏掉那些会话。
 */
const IDENTITY_SECTION = 'harness:identity'
const HARNESS_SOURCE = 'harness:source'
const WEB_SURFACE = 'app:web-surface'

/**
 * 这些段在宿主里的位置。改身份段用宿主自己的座位号，不写死数字。
 * @param {object} scope 作用域上下文（`scope.systemPrompt`）
 */
function shadowSections(scope) {
  const sp = scope.systemPrompt
  return {
    identity: { name: IDENTITY_SECTION, order: sp.getSectionOrder('HARNESS_IDENTITY') },
    source: { name: HARNESS_SOURCE, order: sp.getSectionOrder('HARNESS_SOURCE') },
    web: { name: WEB_SURFACE, order: sp.getSectionOrder('WEB_SURFACE') },
    sourceContext: { name: HARNESS_SOURCE, order: sp.getContextOrder('HARNESS_SOURCE') },
    webContext: { name: WEB_SURFACE, order: sp.getContextOrder('WEB_SURFACE') },
  }
}

/** 路由路径。设置页与探针都用这一条。 */
const ROUTE_PATH = '/enhance/api'

/** 允许的 Host：回环名字面量，可带端口。 */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 请求体硬上限：文本上限按 4 倍留 JSON 转义余量（8192 个换行会膨胀成 16 KB+），再加 1 KB 外壳。 */
const BODY_LIMIT = TEXT_LIMIT * 4 + 1024

/** `set` 认的键；多一个就 `EBADOP`，不静默忽略。 */
const SET_KEYS = new Set(['op', 'enabled', 'contentScope', 'approval', 'text', 'identity', 'hideHarness', 'identityText'])

/** `preset` 认的键。**路径不许从请求体来**——只认服务端解析出的 patchPath。 */
const PRESET_KEYS = new Set(['op', 'action', 'dryRun'])

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function json(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/**
 * 结构化错误：`code` 是机读判别符，调用方按它分支，**不解析 message**。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 */
function fail(res, status, code, message) {
  return json(res, status, { ok: false, code, message })
}

/** 只接受本机来源；判定顺序见文件头。 */
export function sameOrigin(req) {
  const remote = String(req.socket?.remoteAddress ?? '')
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return false

  const host = String(req.headers?.host ?? '')
  if (!LOOPBACK_HOST.test(host)) return false

  const origin = req.headers?.origin
  if (origin === undefined || origin === '') return true
  if (typeof origin !== 'string') return false
  if (/^app:/i.test(origin)) return true
  try {
    const parsed = new URL(origin)
    const expected = new URL(`http://${host}`)
    return parsed.protocol === expected.protocol && parsed.host === expected.host
  } catch {
    return false
  }
}

/**
 * 读 JSON 体并限长。超限抛 `ETOOLARGE`，非法 JSON 抛 `EBADOP`。
 * @param {AsyncIterable<Buffer>} req
 */
export async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw Object.assign(new Error(`body exceeds ${BODY_LIMIT} bytes`), { code: 'ETOOLARGE' })
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('body must be a JSON object'), { code: 'EBADOP' })
    }
    return parsed
  } catch (error) {
    if (error?.code === 'EBADOP') throw error
    throw Object.assign(new Error(`body is not valid JSON: ${error?.message ?? error}`), { code: 'EBADOP' })
  }
}

/**
 * 当前 profile 的 patch 位置。三级回退，任一级拿不到就返回 undefined。
 *
 *   1. `ctx.get('profileContext')`（宿主启动 profile 时注入，最权威：`patchPath` 是
 *      宿主自己 configEditor 用来定位同一份文件的字段）；
 *   2. `DSH_PROFILE_DIR` + `cordis.patch.yml`（宿主给每次 shell 调用注入的环境量，
 *      插件进程通常也能看到）；
 *   3. 都没有 → undefined。
 *
 * **不猜路径**：拿不到就是拿不到，不去 `~/.dsh/profiles/*` 里找「最近改过的那个」——
 * 猜错就是把档位写进别人的 profile。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{ patchPath: string, profile: string | null, source: 'profileContext' | 'env' } | undefined}
 */
export function resolveProfilePatch(ctx) {
  const context = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
  if (context !== undefined && context !== null && typeof context.patchPath === 'string' && context.patchPath.trim() !== '') {
    return {
      patchPath: context.patchPath,
      profile: typeof context.name === 'string' && context.name !== '' ? context.name : null,
      source: 'profileContext',
    }
  }
  const dir = typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR.trim() : ''
  if (dir !== '') {
    return {
      patchPath: join(dir, 'cordis.patch.yml'),
      profile: basename(dir),
      source: 'env',
    }
  }
  return undefined
}

/**
 * 本包版本与已验的 DSH 范围。**唯一来源是 package.json 的 `engines.dsh`**：
 * README 的适用版本句、`scripts/check.mjs` 的 version 门禁、这一页的版本行，
 * 三处都从 `shared/compat.mjs`（同一实现）派生，改声明只需改一处。
 */
const PACKAGE = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  } catch {
    return {}
  }
})()

const COMPATIBILITY = (() => {
  const declared = declarationOf(PACKAGE)
  if (declared.error !== undefined) return { tool: null, range: null, tested: null, parsed: null }
  const parsed = parseEnginesDsh(declared.enginesDsh)
  return {
    tool: typeof PACKAGE.version === 'string' ? PACKAGE.version : null,
    range: parsed.error === undefined ? displayRange(parsed) : null,
    tested: declared.tested,
    parsed: parsed.error === undefined ? parsed : null,
  }
})()

/**
 * 从 Electron 的 `app.asar` 头里读出宿主版本（**只读**：读头 + 一个文件条目，不解包、不写、不派生任何产物）。
 *
 * 为什么需要它：桌面版宿主是打包进 asar 的，profile 插件实测既 import 不到
 * `@deepseek-ai/dsh-package-manifest`（ERR_MODULE_NOT_FOUND），也解析不到安装作用域里的
 * 核心包（MODULE_NOT_FOUND），`dsh-runtimes/runtime.json` 又不一定存在。asar 根
 * `package.json` 里的 `version` 就是产品版本（`@deepseek-ai/dsh-desktop`），读它最稳。
 *
 * asar 布局：[uint32 4][uint32 headerSize][headerSize 字节的头]，头里是
 * [uint32 总长][uint32 jsonLength][JSON][padding]；文件数据从 `8 + headerSize` 起，
 * 每个条目的 `offset` 相对数据区。
 *
 * @param {string} asarPath
 * @returns {{ name?: string, version?: string } | undefined}
 */
export function readAsarManifestVersion(asarPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const preamble = Buffer.alloc(16)
    if (readSync(fd, preamble, 0, 16, 0) < 16) return undefined
    const headerSize = preamble.readUInt32LE(4)
    if (headerSize <= 16 || headerSize > 64 * 1024 * 1024) return undefined
    const header = Buffer.alloc(headerSize)
    if (readSync(fd, header, 0, headerSize, 8) < headerSize) return undefined
    const jsonLength = header.readUInt32LE(4)
    if (jsonLength <= 0 || jsonLength > headerSize - 8) return undefined
    let index
    try {
      index = JSON.parse(header.slice(8, 8 + jsonLength).toString('utf8'))
    } catch {
      return undefined
    }
    const entry = index?.files?.['package.json']
    if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
    const size = typeof entry.size === 'number' ? entry.size : Number(entry.size)
    const offset = typeof entry.offset === 'number' ? entry.offset : Number(entry.offset)
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0 || size > 1024 * 1024) return undefined
    const data = Buffer.alloc(size)
    if (readSync(fd, data, 0, size, 8 + headerSize + offset) < size) return undefined
    let manifest
    try {
      manifest = JSON.parse(data.toString('utf8'))
    } catch {
      return undefined
    }
    const version = typeof manifest?.version === 'string' ? manifest.version.trim() : ''
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return undefined
    return { name: typeof manifest.name === 'string' ? manifest.name : undefined, version }
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 关不上不影响返回值
      }
    }
  }
}

/**
 * 从「解析到的入口路径」往上找最近的 package.json，读出 name/version。
 * 只读，不执行被解析的模块。
 * @param {string} entry 已解析的绝对路径
 * @param {(path: string) => string} [read] 读文件函数（测试可注入）
 * @returns {{ name?: string, version?: string } | undefined}
 */
function packageManifestNear(entry, read = (path) => readFileSync(path, 'utf8')) {
  let current = dirname(entry)
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(current, 'package.json')
    try {
      const parsed = JSON.parse(read(join(candidate)))
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // 这个目录没有 package.json，继续往上
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * 本机 DSH 版本。五种来源，都拿不到就返回 null（页面上只说「读不到」）：
 *   1. `DSH_VERSION` 环境变量——显式覆盖，脚本与测试用它把结果钉住；
 *   2. 宿主的 `@deepseek-ai/dsh-package-manifest` → `getDshRuntimeVersion()`
 *      —— 宿主自己就用它做插件兼容闸；实测桌面版的 profile 插件 import 不到；
 *   3. **安装作用域里的核心包**的版本（`@deepseek-ai/dsh-base` 等，版本号与产品同号）
 *      —— 实测在 rc.5 的 profile 插件里也解析不到；
 *   4. **桌面版安装根的 `app.asar` 清单**（只读一个文件条目，不解包、不写盘）
 *      —— rc.5 上唯一稳定可用的来源；
 *   5. `<home>/dsh-runtimes/<runtime>/runtime.json` 的 `desktopVersion`——桌面版跑过
 *      一次带工具的会话后才会出现。
 * 不猜版本号：读不到就老实说读不到，并把每次失败的原因放进 `attempts`（只在接口里，不上页面）。
 *
 * @param {string} home
 * @returns {Promise<{ host: string | null, source: 'package-manifest' | 'installation-package' | 'asar-manifest' | 'env' | 'runtime-json' | null, attempts: string[] }>}
 */
export async function readHostVersion(home) {
  const attempts = []
  /** 只认形如 x.y.z 或带预发布后缀的版本串。 */
  const accept = (value, source) => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed) ? { host: trimmed, source, attempts } : undefined
  }

  const env = typeof process.env.DSH_VERSION === 'string' ? process.env.DSH_VERSION.trim() : ''
  const fromEnv = accept(env, 'env')
  if (fromEnv !== undefined) return fromEnv
  try {
    const manifest = await import('@deepseek-ai/dsh-package-manifest')
    const value = typeof manifest.getDshRuntimeVersion === 'function' ? manifest.getDshRuntimeVersion() : undefined
    const hit = accept(value, 'package-manifest')
    if (hit !== undefined) return hit
    attempts.push('package-manifest: 没有可用的 getDshRuntimeVersion()')
  } catch (error) {
    attempts.push('package-manifest: ' + String(error?.code ?? error?.message ?? error).slice(0, 60))
  }

  try {
    const { createRequire } = await import('node:module')
    const resolveFromPlugin = createRequire(import.meta.url)
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-settings']) {
      try {
        const entry = resolveFromPlugin.resolve(name)
        const manifest = packageManifestNear(entry)
        const hit = accept(manifest?.version, 'installation-package')
        if (hit !== undefined) return hit
        attempts.push(name + ': 解析到 ' + entry + ' 但没有版本号')
      } catch (error) {
        attempts.push(name + ': ' + String(error?.code ?? error?.message ?? error).slice(0, 40))
      }
    }
  } catch (error) {
    attempts.push('createRequire: ' + String(error?.message ?? error).slice(0, 60))
  }

  // 桌面版：读安装根里 app.asar 的清单版本（只读一个条目，不解包、不写盘）
  const installRoots = []
  if (typeof process.execPath === 'string' && process.execPath !== '') installRoots.push(dirname(process.execPath))
  const localAppData = typeof process.env.LOCALAPPDATA === 'string' ? process.env.LOCALAPPDATA : ''
  if (localAppData !== '') installRoots.push(join(localAppData, 'Programs', 'DeepSeek Harness'))
  for (const root of installRoots) {
    const manifest = readAsarManifestVersion(join(root, 'resources', 'app.asar'))
    const hit = accept(manifest?.version, 'asar-manifest')
    if (hit !== undefined) return hit
  }
  attempts.push('asar-manifest: 读不到 resources/app.asar 里的 package.json 版本')


  try {
    for (const entry of readdirSync(join(home, 'dsh-runtimes'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const parsed = JSON.parse(readFileSync(join(home, 'dsh-runtimes', entry.name, 'runtime.json'), 'utf8'))
        const hit = accept(parsed?.desktopVersion, 'runtime-json')
        if (hit !== undefined) return hit
      } catch {
        // 换下一个 runtime 目录
      }
    }
    attempts.push('runtime-json: 没有可读的 desktopVersion')
  } catch (error) {
    attempts.push('runtime-json: ' + String(error?.code ?? '').slice(0, 40))
  }

  return { host: null, source: null, attempts }
}

/**
 * 版本行用的快照：本包版本 + 本机 DSH 版本 + 已验范围。
 * `inRange` 为 null 表示**读不到本机版本**——这时页面不判绿也不判红。
 *
 * @param {string} home
 */
export async function compatSnapshot(home) {
  const { host, source, attempts } = await readHostVersion(home)
  return {
    tool: COMPATIBILITY.tool,
    host,
    source,
    range: COMPATIBILITY.range,
    tested: COMPATIBILITY.tested,
    inRange: host === null || COMPATIBILITY.parsed === null ? null : inRange(COMPATIBILITY.parsed, host),
    // 读不到时把每次尝试的失败原因带出来，方便在接口上定位是哪一层断了（不上页面）
    attempts,
  }
}

/**
 * 读 profile patch 与其中的档位现状。读不到文件按「空 patch」处理（写档会新建）。
 * @param {{ patchPath: string, profile: string | null, source: string } | undefined} target
 * @param {{ dir: string }} p
 */function presetSnapshot(target, p) {
  if (target === undefined) {
    return {
      patchPath: null, profile: null, source: null,
      present: false, unreadable: false, unreadableReason: null,
      presets: [], defaultPreset: null, recorded: false, writtenAt: null,
      reason: '没有 profile 上下文：不是从 profile 启动的，本进程不知道往哪写',
    }
  }
  let text = ''
  try {
    text = readFileSync(target.patchPath, 'utf8')
  } catch {
    // 文件不存在：写档会新建；读状态按空 patch 处理
  }
  const state = readPresetState(text)
  const record = readPresetRecord(p)
  const ours = record !== undefined && record.patchPath === target.patchPath
  return {
    patchPath: target.patchPath,
    profile: target.profile,
    source: target.source,
    present: state.present,
    unreadable: state.unreadable,
    unreadableReason: state.unreadableReason,
    presets: state.presets,
    defaultPreset: state.defaultPreset,
    recorded: ours,
    writtenAt: ours ? record.writtenAt : null,
    reason: state.unreadable ? state.unreadableReason : null,
  }
}

/**
 * 宿主原句。
 *
 * 两个用途，别拆成两处字面量：
 *   1. `keep` 态的预览句——本插件此刻没改任何东西的准确描述；
 *   2. 「去掉」这一路的**证伪目标**——会话日志的最新一份装配里如果还能读到它，
 *      说明同名段没顶掉宿主段（失效模式 C）。改一次两处一起改。
 */
const HOST_IDENTITY_SENTENCE = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * 预览行：模型将看到的第一句。
 *
 * `keep` 时给的是**宿主原句**——那是本插件此刻没有改任何东西的准确描述。
 * `remove` 时明说「已去掉」，不伪造一句话：去掉之后第一句由宿主的下一个段接管，
 * 具体是哪一句属于宿主装配的事，本插件不猜。
 * @param {{ mode: 'keep'|'remove'|'custom', text: string }} effective
 */
export function identityPreview(effective) {
  if (effective.mode === 'custom') return effective.text.split('\n')[0]
  if (effective.mode === 'remove') return '（已去掉，下一段接上）'
  return HOST_IDENTITY_SENTENCE
}

/**
 * 品牌人设的遮蔽回验（`inject` 检查的第二半）。
 *
 * 三条语义与失效模式表 A/B/C 对应：
 *   - `custom`：会话日志的 `"system-prompt"` 记录里要**找得到** `identity.txt` 的文本；
 *   - `remove`：同一位置**不应**还有宿主原句（同名段没顶掉宿主段 = 最糟的那一类失效）；
 *   - `keep`：这一路不判（不是失败，也不是通过——记 `applies: false`）。
 *
 * 探针口径全部来自 `shared/session-probe.mjs`（它是唯一实现），这里只做三态分派与措辞。
 * 没有会话日志时如实说「没有会话日志」，**不说成遮蔽失效**。
 *
 * @param {string} sessionsDir
 * @param {{ mode: 'keep'|'remove'|'custom', text: string }} effective
 * @returns {Promise<{ applies: boolean, ok: boolean, detail: string }>}
 */
export async function identityShadowProof(sessionsDir, effective) {
  if (effective.mode === 'keep') return { applies: false, ok: true, detail: '品牌人设=保留（这一路不判）' }
  if (effective.mode === 'custom') {
    const proof = await sessionContains(sessionsDir, effective.text)
    return {
      applies: true,
      ok: proof.ok,
      detail: proof.ok ? `品牌人设：自定义文本命中 ${proof.hits} 次` : `品牌人设：${proof.detail}`,
    }
  }
  const proof = await sessionOmits(sessionsDir, HOST_IDENTITY_SENTENCE)
  return {
    applies: true,
    ok: proof.ok,
    detail: proof.ok ? '品牌人设：最新会话里已经没有宿主原句' : `品牌人设：${proof.detail}`,
  }
}

/**
 * 计算「按当前状态要注册哪些遮蔽项」。纯函数，便于单测。
 *
 * 返回空数组表示**什么都不注册**——`keep` 且不隐藏时，让宿主的原样段自己渲染。
 * 这一点是 `keep` 与 `remove` 的分界：同名遮蔽一旦注册就顶掉宿主段，返回空串只会让它消失，
 * 那正是 `remove` 的效果，不是保留。
 *
 * `harness:source` 与 `app:web-surface` 各自有 section 与 context 两条，**必须成对**：
 * 只遮 section 的话，`refreshContext()` 会在准入前按名字把 context 重新求值出来，
 * 那两行宿主名字照样进 user 快照。
 *
 * @param {{ mode: 'keep'|'remove'|'custom', hideHarness: boolean }} effective
 * @returns {{ kind: 'section'|'context', seat: 'identity'|'source'|'sourceContext'|'web'|'webContext', text: 'custom'|'empty' }[]}
 */
export function shadowPlan(effective) {
  const plan = []
  // 身份座无论 `remove` 还是 `custom` 都用 `live`（每次装配现读文本）。
  //
  // 别按模式分成「常量空串 / 动态函数」两种实现：那样两边的座名一样、重装指纹一样，
  // `sync()` 会认为形状没变而不重装，于是「去掉 → 自定义」之后座上留着旧的空串——
  // 设置页显示「已替换」，模型收到的却是删掉的身份句。`deriveIdentity` 在 `remove`
  // 时本来就返回空串，所以一个动态读函数同时满足两种模式，指纹也就只需要看座。
  if (effective.mode === 'custom' || effective.mode === 'remove') {
    plan.push({ kind: 'section', seat: 'identity', text: 'live' })
  }
  if (effective.hideHarness) {
    plan.push({ kind: 'section', seat: 'source', text: 'empty' })
    plan.push({ kind: 'context', seat: 'sourceContext', text: 'empty' })
    plan.push({ kind: 'section', seat: 'web', text: 'empty' })
    plan.push({ kind: 'context', seat: 'webContext', text: 'empty' })
  }
  return plan
}

/**
 * 把品牌人设装到每个 agent 的作用域上。
 *
 * 为什么是「按 agent 遮蔽」而不是监听 `system-prompt/assemble`：宿主官方实践文档把瀑布列为
 * **最强机制**并明写「不要用它增删文本」（`cordis-plugin-development/references/practices.md`），
 * 而「同名段遮蔽」是宿主自己一等公民的用法——`dsh-persona`、`dsh-subagent`、
 * `file-reference-local` 都在 agent 作用域里注册同名项。本函数照抄 `file-reference-local` 的
 * 生命周期写法：`agent.ctx.inject([...], cb)` 建 fiber，按 agent 记账，`agent/disposed`
 * 与插件卸载两边都拆。
 *
 * **`keep` 必须「不注册」**：同名遮蔽一旦注册就顶掉宿主段，返回空串只会让它消失——
 * 那是 `remove` 的效果，不是保留。所以遮蔽项按当前模式**动态增删**，见 `sync`。
 *
 * 模式是**每条装配现算**的（`text` 是函数），所以设置页改完下一条消息就生效，不需要重启。
 *
 * **过去这里静默降级**：拿不到可注入的 agent 上下文时直接 `return`，设置页照样显示
 * 「已替换」。现在同样的降级仍然不抛、不影响其余功能，但会记进 `status()`：
 * 见过几个 agent、几个真的拿到了作用域、几个明确装不上。设置页与 `/enhance/api`
 * 的快照据此如实说明——这是审计缺口 1 的「装不上要吭声」。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => { effective: { mode: 'keep'|'remove'|'custom', text: string, hideHarness: boolean } }} currentIdentity
 * @returns {{ sync: () => void, status: () => { agentsService: boolean, seen: number, installed: number, scoped: number, shadowed: number, unsupported: number } }}
 *   `sync` 主动同步一次（设置页写完状态后调用，让改动不必等下一次装配）；
 *   `status` 只读事实，给快照与设置页说「装上了没有」。
 */
export function installBrandPersona(ctx, currentIdentity) {
  /** 每个 agent 一份：已注册的遮蔽项、它们的拆解器，以及当前形状的指纹。 */
  const agents = new Map()
  /** 处理过的 agent（成功或明确失败都算），用来让「见过几个」只数一次。 */
  const seenAgents = new WeakSet()
  let seen = 0
  let unsupported = 0
  let scheduled = false
  const agentsService = agentsServiceOf(ctx) !== undefined

  /** 按当前模式把遮蔽项注册进这个 agent 作用域，返回拆解器数组。 */
  const register = (scope, effective) => {
    const seats = shadowSections(scope)
    const disposers = []
    for (const item of shadowPlan(effective)) {
      const seat = seats[item.seat]
      // 用户写的是散文：一个落单的 `{{` 会让整次装配抛错，所以 `interpolate: false`。
      // `live` 的座每次装配都重读当前派生的文本（`remove` 时它天然是空串）；
      // `empty` 的座恒空串——渲染器会丢弃空段，等于把那一段去掉。
      const spec = {
        name: seat.name,
        order: seat.order,
        interpolate: false,
        text: item.text === 'live' ? () => currentIdentity().effective.text : () => '',
      }
      const api = scope.systemPrompt
      disposers.push(item.kind === 'context' ? api.context(spec) : api.section(spec))
    }
    return disposers
  }

  /** 当前状态要求注册哪些项。形状没变就不重装——重装会打断那一步的装配。 */
  const shapeOf = (effective) => shadowPlan(effective).map((item) => `${item.kind}:${item.seat}`).join(',')

  /** 重装一个 agent 的遮蔽项（仅当形状变了）。 */
  const sync = (agent) => {
    const record = agents.get(agent)
    if (record === undefined || record.scope === undefined) return
    const { effective } = currentIdentity()
    const shape = shapeOf(effective)
    if (record.shape === shape) return
    for (const dispose of record.disposers) {
      try {
        dispose()
      } catch (error) {
        console.error('[enhance-scope] brand-persona unregister failed:', error)
      }
    }
    record.shape = shape
    record.disposers = register(record.scope, effective)
  }

  /**
   * 装配期间不就地改注册表（那一刻 sections 已经物化），推迟到微任务。
   * 下一次装配一定看得到新状态，用户感知仍是「下一条消息生效」。
   */
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      for (const agent of agents.keys()) sync(agent)
    })
  }

  const install = (agent) => {
    if (agent === undefined || agent === null) return
    // 同一个 agent 只处理一次：装上或明确装不上都算处理过，重复事件不该把读数翻倍。
    if (typeof agent === 'object') {
      if (seenAgents.has(agent)) return
      seenAgents.add(agent)
    }
    seen += 1
    // 拿不到可注入的 agent 上下文（老宿主 / 非 agent 组合）就降级为「只做内容边界」，
    // 不抛、也不影响其余功能——但要记下来，让设置页说得出口。
    if (typeof agent.ctx?.inject !== 'function') {
      unsupported += 1
      return
    }
    const record = { scope: undefined, shape: '', disposers: [], fiber: undefined }
    agents.set(agent, record)
    record.fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      record.scope = scope
      const { effective } = currentIdentity()
      record.shape = shapeOf(effective)
      record.disposers = register(scope, effective)
    })
  }

  /**
   * 只读事实，不做判定：设置页与快照靠它把「装上了没有 / 几个 agent / 拿不到什么」
   * 说出口。`installed` 与 `scoped` 是**当前**活着的数；`seen` / `unsupported` 是本进程
   * 累计处理过的数（同一个 agent 只数一次）。
   */
  const status = () => {
    let scoped = 0
    let shadowed = 0
    for (const record of agents.values()) {
      if (record.scope !== undefined) scoped += 1
      shadowed += record.disposers.length
    }
    return { agentsService, seen, installed: agents.size, scoped, shadowed, unsupported }
  }

  const dispose = (agent) => {
    const record = agents.get(agent)
    if (record === undefined) return
    agents.delete(agent)
    for (const unregister of record.disposers) {
      try {
        unregister()
      } catch {
        // 单项拆除失败不拦住宿主处置 agent
      }
    }
    Promise.resolve(record.fiber?.dispose?.()).catch((error) => {
      console.error('[enhance-scope] brand-persona fiber cleanup failed:', error)
    })
  }

  for (const agent of listAgents(ctx)) install(agent)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => dispose(agent))
  ctx.effect(() => () => {
    for (const agent of [...agents.keys()]) dispose(agent)
  }, 'enhance-scope brand-persona fibers')

  return { sync: schedule, status }
}

/**
 * 把「品牌人设装上了没有」翻成一句人话，连同可机读的事实一起交给快照。
 *
 * 这不是判据，是**可发现性**：过去 `installBrandPersona` 在拿不到可注入的 agent 上下文时
 * 静默 return，设置页照样显示「已替换」。现在同一份事实有两个出口——`/enhance/api` 的
 * `state` 快照（机读）与设置页那一行说明（人读）。
 *
 * `ok` 是三值的，别压成布尔：`true` 装上了、`false` 明确装不上、`null` 还没有 agent 可判。
 * 「还没有 agent」不是失败——新装的机器第一次打开设置页时本来就没有会话。
 *
 * @param {{ agentsService: boolean, seen: number, installed: number, scoped: number, shadowed: number, unsupported: number }} status
 * @param {{ mode: 'keep'|'remove'|'custom', hideHarness: boolean }} effective
 * @returns {{ state: 'installed'|'pending'|'unsupported'|'idle', ok: boolean|null, reason: string|null, text: string, agents: number, installed: number, scoped: number, shadowed: number }}
 */
function describeIdentityInstall(status, effective) {
  const facts = {
    agents: status.seen,
    installed: status.installed,
    scoped: status.scoped,
    shadowed: status.shadowed,
  }
  // 「这一轮该有遮蔽项吗」：keep 且不隐藏时本来就没有要遮的段，谈不上失效。
  const wanted = effective.mode !== 'keep' || effective.hideHarness === true

  // 明确装不上：有 agent 的宿主上下文不可注入，且没有任何一个 agent 拿到作用域。
  if (status.unsupported > 0 && status.scoped === 0) {
    const queued = status.installed > 0 ? `（另有 ${status.installed} 个 agent 已排队，但还没拿到作用域）` : ''
    return {
      state: 'unsupported',
      ok: false,
      reason: 'agent.ctx.inject 不可用',
      text: `未生效：本版宿主没有可注入的 agent 上下文（agent.ctx.inject 不可用），品牌人设这一路这轮不生效${queued}。`,
      ...facts,
    }
  }
  if (status.scoped > 0) {
    const extra = status.unsupported > 0 ? `；另有 ${status.unsupported} 个 agent 没有可注入的上下文` : ''
    return {
      state: 'installed',
      ok: true,
      reason: null,
      text: wanted
        ? `已生效：${status.scoped} 个 agent 作用域里注册了 ${status.shadowed} 项遮蔽${extra}。`
        : `已接上：${status.scoped} 个 agent 作用域可用；当前「保留」，没有要遮蔽的段${extra}。`,
      ...facts,
    }
  }
  if (status.installed > 0) {
    return {
      state: 'pending',
      ok: null,
      reason: '注入回调还没拿到 systemPrompt 作用域',
      text: `已接上 ${status.installed} 个 agent，注入回调还没拿到 systemPrompt 作用域（本轮还判断不了）。`,
      ...facts,
    }
  }
  const why = status.agentsService ? '本进程还没建过会话' : '拿不到宿主的 agents 服务，只能等新的 agent/created'
  return {
    state: 'idle',
    ok: null,
    reason: '还没见到 agent',
    text: `还没见到 agent（${why}）；见到就会装上。`,
    ...facts,
  }
}

/**
 * 拿宿主的 `agents` 服务。没有就返回 `undefined`——**不抛**，也不假装拿到了：
 * 品牌人设的安装状态需要把「拿不到什么」如实说出来（见 `describeIdentityInstall`），
 * 所以「拿不到」用返回值表达，而不是吞掉。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function agentsServiceOf(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (service !== undefined && typeof service.list === 'function') return service
  } catch {
    // 服务不在或不可用：按「没有 agent」处理
  }
  return undefined
}

/**
 * 列出当前活着的 agent。拿不到 `agents` 服务就返回空数组——品牌人设整体降级，
 * 不影响内容边界与审批。返回空数组**不等于**装不上：`agent/created` 那条路仍然在，
 * 「装上了没有」由`installBrandPersona` 的状态如实报告。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function listAgents(ctx) {
  const service = agentsServiceOf(ctx)
  if (service === undefined) return []
  try {
    return service.list()
  } catch {
    return []
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, file?: string, interpolate?: boolean, onMissing?: 'fail' | 'warn' }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const home = resolveHome()
  const p = paths(home)
  const file = typeof config.file === 'string' && config.file.trim() !== '' ? config.file : p.text
  // `onMissing` 是留给配置方的开关（读不到文本文件时 fail 还是 warn）——本仓的
  // bundle patch 不配置它，宿主侧也没有已知使用方；留着是因为删掉分支即行为变化
  // （配置了 warn 的假想部署会突然启动失败），零行为红线下先挂账，不删。
  const onMissing = config.onMissing === 'warn' ? 'warn' : 'fail'

  // 没有安装器阶段：首次加载时补齐 <home>/enhance/
  ensureEnhanceData(home, fileURLToPath(new URL('../shared/content-scope.default.txt', import.meta.url)))


  let lastGood = readText({ ...p, text: file })
  if (!lastGood.ok && onMissing === 'fail') {
    throw new Error(`enhance-scope: cannot read content-scope file "${file}"`)
  }

  // 每步现算：激活 + 开关 + 文本 → 真注入了没有
  const current = () => {
    const text = readText({ ...p, text: file })
    if (text.ok) lastGood = text
    const state = readState(p)
    const active = isPluginActive('enhance-scope')
    return {
      state,
      text: lastGood,
      active,
      effective: derive(state, lastGood, active),
    }
  }

  // 品牌人设也每步现算：读 identity.txt，与 state 一起派生实际生效的模式
  let lastGoodIdentity = readIdentity({ ...p, identity: p.identity })
  const currentIdentity = () => {
    const text = readIdentity({ ...p, identity: p.identity })
    if (text.ok) lastGoodIdentity = text
    const state = readState(p)
    return { state, text: lastGoodIdentity, effective: deriveIdentity(state, lastGoodIdentity) }
  }

  // ---- 品牌人设：按 agent 遮蔽宿主同名段 ----
  const brandPersona = installBrandPersona(ctx, currentIdentity)
  const syncBrandPersona = brandPersona.sync

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    // 文件是任意人写的散文：`{{` 必须保持字面
    interpolate: config.interpolate === true,
    text: () => {
      const { effective } = current()
      // 顺带把品牌人设的同步排上：这一段每次装配都会求值，所以手改 state.json 也能在
      // 下一次装配被接住，不必等设置页的某次点击。副作用推迟到微任务，不影响本次装配。
      syncBrandPersona()
      return effective.injecting ? lastGood.text : ''
    },
  }), 'enhance-scope.section()')
  ctx.effect(() => () => markPluginActive('enhance-scope', false), 'enhance-scope active flag')
  markPluginActive('enhance-scope')

  // ---- 路由：宿主有 webServer 才挂（headless 没有） ----
  // 不能在 apply 里直接 `ctx.get('webServer')`：那时服务可能还没挂上（顺序由服务依赖决定，
  // 而我们没有把 webServer 写进 inject，因为它不是本插件的必需依赖）。用运行期注入：
  // 服务出现时回调跑一次，服务消失时回调被卸载——提示词注入完全不受影响。
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (inner) => {
    const web = inner.webServer
    if (web === undefined || typeof web.register !== 'function') return

    const snapshot = async () => {
      const { state, text, active, effective } = current()
      const identityState = currentIdentity()
      const meta = textStat({ ...p, text: file })
      const identityMeta = fileStat(p.identity)
      return {
        ok: true,
        version: state.version,
        active,
        enabled: state.enabled,
        injecting: effective.injecting,
        reason: effective.reason ?? null,
        contentScope: state.contentScope,
        approval: state.approval,
        text: text.ok ? text.text : '',
        bytes: text.ok ? textBytes(text.text) : (meta?.bytes ?? 0),
        sha256: text.ok ? textSha256(text.text) : null,
        identity: state.identity,
        hideHarness: state.hideHarness,
        identityText: identityState.text.ok ? identityState.text.text : '',
        identityBytes: identityState.text.ok ? textBytes(identityState.text.text) : (identityMeta?.bytes ?? 0),
        identitySha256: identityState.text.ok ? textSha256(identityState.text.text) : null,
        identityLimit: IDENTITY_LIMIT,
        identityEffective: {
          mode: identityState.effective.mode,
          degraded: identityState.effective.degraded,
          reason: identityState.effective.reason ?? null,
          preview: identityPreview(identityState.effective),
        },
        // 「装上了没有」的机读事实 + 一句人话：设置页品牌人设组直接显示 text。
        // 过去装不上是静默的（这里没有字段，页面也不会提），审计缺口 1 要补的就是它。
        identityInstall: describeIdentityInstall(brandPersona.status(), identityState.effective),
        updatedAt: state.updatedAt ?? null,
        degraded: state.degraded,
        degradedReason: state.degradedReason ?? null,
        degradedFields: state.degradedFields ?? [],
        home,
        limit: TEXT_LIMIT,
        preset: presetSnapshot(resolveProfilePatch(ctx), p),
        compat: await compatSnapshot(home),
      }
    }

    /** 运行时检查：四项，全部在进程内完成，不起子进程。 */
    const runChecks = async () => {
      const { state, text, effective } = current()
      const checks = []

      const scopeOn = isPluginActive('enhance-scope')
      const approveOn = isPluginActive('auto-approve')
      checks.push({
        name: 'plugins',
        pass: scopeOn && approveOn,
        detail: `enhance-scope=${scopeOn ? '在' : '缺'} · auto-approve=${approveOn ? '在' : '缺'}`,
      })

      checks.push({
        name: 'text',
        pass: text.ok && textBytes(text.text) <= TEXT_LIMIT,
        detail: text.ok ? `${textBytes(text.text)} B / 上限 ${TEXT_LIMIT} B` : `读不到 ${file}`,
      })

      // `inject` 仍然是**一项**（四个机检键不许增删），但它现在同时回答两个问题：
      //   1. 内容边界那段文字进没进提示词（原来的 needle）；
      //   2. 品牌人设有没有真的顶掉/换上宿主身份句（失效模式 C：注册成功但遮蔽不生效）。
      // 两路都走同一个探针口径；detail 上点名是哪一路没过，否则用户分不清该修哪个。
      const sessions = join(home, 'sessions')
      const identityState = currentIdentity()
      const [proof, identity] = await Promise.all([
        sessionContains(sessions, text.ok ? text.text : ''),
        identityShadowProof(sessions, identityState.effective),
      ])
      const contentDetail = effective.injecting
        ? (proof.detail + (proof.sessionAt ? ` · 最新 ${proof.sessionAt.slice(11, 16)}` : ''))
        : `没有注入：${effective.reason ?? '未知'}`
      const parts = [`内容边界：${contentDetail}`]
      // `keep` 这一路不判：不因为「没命中」造红，也不假装验过。
      if (identity.applies) parts.push(identity.detail)
      checks.push({
        name: 'inject',
        pass: effective.injecting && proof.ok && identity.ok,
        detail: parts.join(' · '),
      })

      // 第四项：Enhanced 档。
      // 「没写」不是失败——那是用户没选择的功能（na），红叉会把人骗去修一个没坏的东西。
      const preset = presetSnapshot(resolveProfilePatch(ctx), p)
      checks.push(presetCheck(preset))

      return { ok: checks.every((check) => check.pass), checks }
    }

    /**
     * 「Enhanced 档」这一项怎么判：
     *   - 写过了 → pass；
     *   - patch 里没有 → pass + na（用户没 opt-in，不是坏了）；
     *   - 结构认不出 → 红（真会写坏宿主配置）；
     *   - 不知道在哪个 profile → pass + na（不是从 profile 启动的）。
     */
    const presetCheck = (preset) => {
      if (preset.patchPath === null) {
        return { name: 'preset', pass: true, na: true, detail: '不是从 profile 启动的，本进程无法写 profile 配置' }
      }
      if (preset.unreadable) {
        return {
          name: 'preset',
          pass: false,
          detail: `${preset.patchPath} 的 presets 形态认不出，无法安全改写：${preset.unreadableReason ?? ''}`,
        }
      }
      if (preset.present) {
        return { name: 'preset', pass: true, detail: `已写入 Enhanced 档（profile: ${preset.profile ?? '?'}，重启后出现在档位菜单）` }
      }
      return {
        name: 'preset',
        pass: true,
        na: true,
        detail: `未写入（在「Enhanced 权限档」一节点一下写入，重启后生效）· ${preset.patchPath}`,
      }
    }

    /**
     * 写/摘 enhanced 档。
     *
     * 写盘前先备份（`.bak-enhance-<时间>`，沿用既有命名风格），再用
     * `writeFileAtomic` 落盘——写坏的 patch 会让宿主整份 profile 解析失败，
     * 所以宁可多一份备份文件。`dryRun` 只算不改，供测试与预览。
     *
     * 路径只认服务端自己解析出来的 `patchPath`，**绝不**从请求体取（否则就是
     * 一个能写任意文件的本地接口）。
     */
    const runPreset = async ({ action, dryRun }) => {
      const target = resolveProfilePatch(ctx)
      if (target === undefined) {
        return { status: 409, body: { ok: false, code: 'EPROFILE', message: '没有 profile 上下文：不是从 profile 启动的，请在桌面版或 `dsh --profile <name>` 里操作' } }
      }
      let original = ''
      let existsBefore = true
      try {
        original = readFileSync(target.patchPath, 'utf8')
      } catch {
        existsBefore = false
      }
      const record = readPresetRecord(p)

      if (action === 'add') {
        const result = ensureEnhancedPreset(original)
        if (result.error !== undefined) {
          return { status: 422, body: { ok: false, code: 'EBADSHAPE', message: result.error } }
        }
        if (result.action === 'unchanged' && record !== undefined && record.patchPath === target.patchPath) {
          return { status: 200, body: { ok: true, changed: null, needRestart: false } }
        }
        if (dryRun === true) {
          return { status: 200, body: { ok: true, dryRun: true, changed: result.changed ?? null, action: result.action, preview: result.text } }
        }
        const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18)
        const backup = existsBefore ? `${target.patchPath}.bak-enhance-${stamp}` : null
        if (backup !== null) writeFileSync(backup, original, 'utf8')
        writeFileAtomic(target.patchPath, result.text)
        writePresetRecord(p, {
          patchPath: target.patchPath,
          profile: target.profile,
          action: result.action,
          emptyArray: result.emptyArray === true,
          original,
          writtenAt: new Date().toISOString(),
        })
        return { status: 200, body: { ok: true, changed: result.changed, backup, needRestart: true } }
      }

      // action === 'remove'
      if (record === undefined || record.patchPath !== target.patchPath) {
        return {
          status: 409,
          body: { ok: false, code: 'ERECORD', message: `没有「这一档是我们写的」的记录，无法安全摘除：请手工删掉 ${target.patchPath} 里 enhanced 那三行` },
        }
      }
      const result = removeEnhancedPreset(original, record)
      if (result.error !== undefined) {
        return { status: 422, body: { ok: false, code: 'EBADSHAPE', message: result.error } }
      }
      if (dryRun === true) {
        return { status: 200, body: { ok: true, dryRun: true, changed: result.changed ?? null, preview: result.text } }
      }
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18)
      const backup = existsBefore ? `${target.patchPath}.bak-enhance-${stamp}` : null
      if (backup !== null) writeFileSync(backup, original, 'utf8')
      writeFileAtomic(target.patchPath, result.text)
      clearPresetRecord(p)
      return { status: 200, body: { ok: true, changed: result.changed ?? null, backup, needRestart: true } }
    }

    ctx.effect(() => web.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return fail(res, 405, 'EMETHOD', 'POST only')
        if (!sameOrigin(req)) return fail(res, 403, 'EORIGIN', 'cross-origin request rejected')
        let body
        try {
          body = await readJson(req)
        } catch (error) {
          const status = error?.code === 'ETOOLARGE' ? 413 : 400
          return fail(res, status, error?.code === 'ETOOLARGE' ? 'ETOOLARGE' : 'EBADOP', String(error?.message ?? error))
        }
        const op = typeof body.op === 'string' ? body.op : ''
        try {
          if (op === 'state') return json(res, 200, await snapshot())
          if (op === 'check') return json(res, 200, await runChecks())
          if (op === 'preset') {
            for (const key of Object.keys(body)) {
              if (!PRESET_KEYS.has(key)) return fail(res, 400, 'EBADOP', `unknown field: ${key}`)
            }
            if (body.action !== 'add' && body.action !== 'remove') {
              return fail(res, 400, 'EBADOP', `action must be add|remove (got ${String(body.action)})`)
            }
            if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
              return fail(res, 400, 'EBADOP', 'dryRun must be a boolean')
            }
            const result = await runPreset({ action: body.action, dryRun: body.dryRun === true })
            if (result.body.ok === true) {
              return json(res, result.status, { ...result.body, preset: presetSnapshot(resolveProfilePatch(ctx), p) })
            }
            return fail(res, result.status, result.body.code, result.body.message)
          }

          if (op !== 'set') return fail(res, 400, 'EBADOP', `unknown op: ${op === '' ? '(missing)' : op}`)
          for (const key of Object.keys(body)) {
            if (!SET_KEYS.has(key)) return fail(res, 400, 'EBADOP', `unknown field: ${key}`)
          }
          if (body.approval !== undefined && !APPROVALS.includes(body.approval)) {
            return fail(res, 400, 'EBADOP', `approval must be one of ${APPROVALS.join('|')}`)
          }
          if (body.identity !== undefined && !IDENTITY_MODES.includes(body.identity)) {
            return fail(res, 400, 'EBADOP', `identity must be one of ${IDENTITY_MODES.join('|')}`)
          }
          if (body.hideHarness !== undefined && typeof body.hideHarness !== 'boolean') {
            return fail(res, 400, 'EBADOP', 'hideHarness must be a boolean')
          }

          const before = readState(p)
          // writeState 是整块重建：五键必须带全，漏一个就等于把它重置回默认
          const next = {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : before.enabled,
            contentScope: typeof body.contentScope === 'boolean' ? body.contentScope : before.contentScope,
            approval: typeof body.approval === 'string' ? body.approval : before.approval,
            identity: typeof body.identity === 'string' ? body.identity : before.identity,
            hideHarness: typeof body.hideHarness === 'boolean' ? body.hideHarness : before.hideHarness,
          }
          // 先验文本再落盘：超限时状态不该先被改掉
          const text = typeof body.text === 'string' ? normalizeForWrite(body.text) : undefined
          const identityText = typeof body.identityText === 'string'
            ? normalizeForWriteIdentity(body.identityText)
            : undefined
          const changed = next.enabled !== before.enabled
            || next.contentScope !== before.contentScope
            || next.approval !== before.approval
            || next.identity !== before.identity
            || next.hideHarness !== before.hideHarness
          if (changed) writeState(p, next)
          if (text !== undefined) writeText({ ...p, text: file }, text)
          if (identityText !== undefined) writeIdentity(p, identityText)
          // 模式或隐藏开关变了：立刻让已装好的 agent 重装遮蔽项，不必等下一次装配
          if (changed) syncBrandPersona()
          return json(res, 200, await snapshot())
        } catch (error) {
          const tooLarge = error?.code === 'ETOOLARGE'
          // 超限的细节给调用方（它要改的就是那个数字）；落盘失败的细节只进宿主 stderr，
          // 回包里不出现绝对路径。
          if (!tooLarge) console.error('[enhance-scope] /enhance/api failed:', error)
          return fail(res, tooLarge ? 413 : 500, tooLarge ? 'ETOOLARGE' : 'EIO', tooLarge ? String(error?.message ?? error) : 'write failed')
        }
      },
    }), 'enhance-scope.route()')
  })
}

/** 内容边界文本写入口的预校验：超限先抛，避免状态已被改动而文本落不下。 */
function normalizeForWrite(text) {
  const bytes = textBytes(text)
  if (bytes > TEXT_LIMIT) throw Object.assign(new Error(`text exceeds ${TEXT_LIMIT} bytes`), { code: 'ETOOLARGE' })
  return text
}

/** 品牌人设文本写入口的预校验：上限独立，是 2 KB。 */
function normalizeForWriteIdentity(text) {
  const bytes = textBytes(text)
  if (bytes > IDENTITY_LIMIT) throw Object.assign(new Error(`text exceeds ${IDENTITY_LIMIT} bytes`), { code: 'ETOOLARGE' })
  return text
}

/** 测试口：路由的纯函数部分（来源判定与读体），不依赖 cordis。 */
export const __testing = { sameOrigin, readJson, LOOPBACK_HOST, BODY_LIMIT }
