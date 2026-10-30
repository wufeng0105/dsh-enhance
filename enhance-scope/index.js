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
  APPROVALS, TEXT_LIMIT, derive, isPluginActive, markPluginActive, paths,
  readState, readText, resolveHome, textBytes, textSha256, textStat, writeFileAtomic, writeState, writeText,
} from '../shared/state.mjs'
import { ensureEnhanceData } from '../shared/seed.mjs'
import { sessionContains } from '../shared/session-probe.mjs'
import {
  clearPresetRecord, ensureEnhancedPreset, readPresetRecord, readPresetState,
  removeEnhancedPreset, writePresetRecord,
} from '../shared/preset.mjs'
import { declarationOf, displayRange, inRange, parseEnginesDsh } from '../shared/compat.mjs'

/** Diagnostics label. */
export const name = 'enhance-scope'

/** 提示词注册表；`webServer` 是可选的，所以不写进 inject。 */
export const inject = ['systemPrompt']

/** 段名与官方 persona suffix 不同名（同名二次注册会抛），order 相同。 */
const SECTION_NAME = 'enhance:content-scope'

/** 路由路径。设置页与探针都用这一条。 */
const ROUTE_PATH = '/enhance/api'

/** 允许的 Host：回环名字面量，可带端口。 */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

/** 请求体硬上限：文本上限按 4 倍留 JSON 转义余量（8192 个换行会膨胀成 16 KB+），再加 1 KB 外壳。 */
const BODY_LIMIT = TEXT_LIMIT * 4 + 1024

/** `set` 认的键；多一个就 `EBADOP`，不静默忽略。 */
const SET_KEYS = new Set(['op', 'enabled', 'contentScope', 'approval', 'text'])

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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, file?: string, interpolate?: boolean, onMissing?: 'fail' | 'warn' }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const home = resolveHome()
  const p = paths(home)
  const file = typeof config.file === 'string' && config.file.trim() !== '' ? config.file : p.text
  const onMissing = config.onMissing === 'warn' ? 'warn' : 'fail'

  // bundle 安装没有 installer 参与：首次加载时补齐 <home>/enhance/
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

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'),
    // 文件是任意人写的散文：`{{` 必须保持字面
    interpolate: config.interpolate === true,
    text: () => {
      const { effective } = current()
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
      const meta = textStat({ ...p, text: file })
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
        updatedAt: state.updatedAt ?? null,
        degraded: state.degraded,
        degradedReason: state.degradedReason ?? null,
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

      // 三项都在进程内完成，不起子进程。
      const proof = await sessionContains(join(home, 'sessions'), text.ok ? text.text : '')
      checks.push({
        name: 'inject',
        pass: effective.injecting && proof.ok,
        detail: effective.injecting
          ? (proof.detail + (proof.sessionAt ? ` · 最新 ${proof.sessionAt.slice(11, 16)}` : ''))
          : `没有注入：${effective.reason ?? '未知'}`,
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
        return { name: 'preset', pass: true, detail: `已写入 enhanced 档（profile: ${preset.profile ?? '?'}，重启后出现在档位菜单）` }
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
     * 写盘前先备份（`.bak-enhance-<时间>`，与原安装器同一命名风格），再用
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

          const before = readState(p)
          const next = {
            enabled: typeof body.enabled === 'boolean' ? body.enabled : before.enabled,
            contentScope: typeof body.contentScope === 'boolean' ? body.contentScope : before.contentScope,
            approval: typeof body.approval === 'string' ? body.approval : before.approval,
          }
          // 先验文本再落盘：超限时状态不该先被改掉
          const text = typeof body.text === 'string' ? normalizeForWrite(body.text) : undefined
          const changed = next.enabled !== before.enabled
            || next.contentScope !== before.contentScope
            || next.approval !== before.approval
          if (changed) writeState(p, next)
          if (text !== undefined) writeText({ ...p, text: file }, text)
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

/** 文本写入口的预校验：超限先抛，避免状态已被改动而文本落不下。 */
function normalizeForWrite(text) {
  const bytes = textBytes(text)
  if (bytes > TEXT_LIMIT) throw Object.assign(new Error(`text exceeds ${TEXT_LIMIT} bytes`), { code: 'ETOOLARGE' })
  return text
}

/** 测试口：路由的纯函数部分（来源判定与读体），不依赖 cordis。 */
export const __testing = { sameOrigin, readJson, LOOPBACK_HOST, BODY_LIMIT }
