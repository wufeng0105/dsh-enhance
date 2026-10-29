/**
 * 内容边界注入 + 设置页的服务端。
 *
 * 两件事：
 *   1. 把 `content-scope.txt` 注入成提示词的一段（`enhance:content-scope`，order 同官方 persona suffix）
 *   2. 在宿主已有的本地 HTTP 服务上挂一条路由 `POST /enhance/api`，供设置页读写
 *
 * 四个 op：`state` 快照、`set` 改开关或文本、`check` 运行时检查、`uninstall` 行级卸载。
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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  APPROVALS, TEXT_LIMIT, derive, isPluginActive, markPluginActive, paths,
  readState, readText, resolveHome, textBytes, textSha256, textStat, writeState, writeText,
} from '../shared/state.mjs'
import { ensureEnhanceData } from '../shared/seed.mjs'
import { sessionContains } from '../shared/session-probe.mjs'

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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean, file?: string, interpolate?: boolean, onMissing?: 'fail' | 'warn' }} [config]
 */
/**
 * 检查 `enhance-permissions/client.js` 这一项。
 *
 * 它只做一件事：文件里是否有 `// source-sha256: <64 hex>` 那一行戳。
 * **不校验哈希值、不读 asar**——所以它只能证明「文件在且带来源记录」，
 * 证明不了派生件与当前 DSH 同代。文案必须把这个边界说清楚，
 * 否则用户会把「通过」读成「已对齐」（早期实现）。
 *
 * @param {string} pluginDir 插件根目录（`client.js` 的相对位置基于它）
 * @returns {{name: string, pass: boolean, detail: string}}
 */
export function clientCheck(pluginDir) {
  let stamped = false
  try {
    stamped = /^\/\/ source-sha256: [0-9a-f]{64}$/m.test(readFileSync(join(pluginDir, 'enhance-permissions', 'client.js'), 'utf8'))
  } catch {
    stamped = false
  }
  return {
    name: 'client',
    pass: stamped,
    detail: stamped
      ? '存在，文件完整，执行 build-client.mjs --check --asar <app.asar> 可验证是否跟当前 DSH 同代'
      : '不存在，执行 build-client.mjs --asar <app.asar> 生成。',
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const home = resolveHome()
  const p = paths(home)
  const file = typeof config.file === 'string' && config.file.trim() !== '' ? config.file : p.text
  const onMissing = config.onMissing === 'warn' ? 'warn' : 'fail'

  // bundle 安装（dsh plugin add）没有 install.mjs 参与：首次加载时补齐 <home>/enhance/
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

    const snapshot = () => {
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

      const proof = await sessionContains(join(home, 'sessions'), text.ok ? text.text : '')
      checks.push({
        name: 'inject',
        pass: effective.injecting && proof.ok,
        detail: effective.injecting
          ? (proof.detail + (proof.sessionAt ? ` · 最新 ${proof.sessionAt.slice(11, 16)}` : ''))
          : `没有注入：${effective.reason ?? '未知'}`,
      })

      // 第四项只在完整安装下成立：只有 `enhance/` 下带派生的 client.js 才有权限菜单图标。
      // bundle 安装（dsh plugin add）按设计不含它，标成「不适用」而不是红叉。
      const installedClient = join(p.dir, 'enhance-permissions', 'client.js')
      checks.push(existsSync(installedClient)
        ? clientCheck(p.dir)
        : { name: 'client', pass: true, na: true, detail: 'bundle 安装不含权限菜单图标（Enhanced 档要用完整安装）' })

      return { ok: checks.every((check) => check.pass), checks }
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
          if (op === 'state') return json(res, 200, snapshot())
          if (op === 'check') return json(res, 200, await runChecks())
          if (op === 'uninstall') return handleUninstall(res, body, home, p)

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
          return json(res, 200, snapshot())
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

/**
 * 卸载：**先回包，再动手**。卸载会删掉 `enhance/`，也就是路由代码自己所在的地方，
 * 反过来做请求会断在半路（`11-settings-page-plan.md` 的铁律之一）。
 */
async function handleUninstall(res, body, home, p) {
  const tool = join(p.dir, 'uninstall.mjs')
  if (!existsSync(tool)) {
    return fail(res, 409, 'EBUNDLE', '当前是 bundle 安装：用 `dsh plugin --profile <profile> remove dsh-enhance` 卸载；设置页这个按钮只服务完整安装')
  }

  const load = () => import(pathToFileURL(tool).href)
  const thorough = body.thorough === true
  if (body.dryRun === true) {
    // 预览：调同一个函数、同一份代码，只是不写盘
    try {
      const module = await load()
      const result = await module.uninstall({ home, dryRun: true, thorough })
      return json(res, 200, {
        ok: true,
        dryRun: true,
        thorough,
        planned: result.planned,
        skipped: result.skipped,
        warnings: result.warnings,
        failed: result.failed,
        backups: result.backups,
      })
    } catch (error) {
      return fail(res, 500, 'EIO', 'preview failed')
    }
  }

  json(res, 200, { ok: true, needRestart: true })
  setTimeout(() => {
    load()
      .then((module) => module.uninstall({ home, thorough }))
      .catch((error) => console.error('[enhance-scope] uninstall failed:', error))
  }, 50)
  return undefined
}
/** 文本写入口的预校验：超限先抛，避免状态已被改动而文本落不下。 */
function normalizeForWrite(text) {
  const bytes = textBytes(text)
  if (bytes > TEXT_LIMIT) throw Object.assign(new Error(`text exceeds ${TEXT_LIMIT} bytes`), { code: 'ETOOLARGE' })
  return text
}

/** 测试口：路由的纯函数部分（来源判定与读体），不依赖 cordis。 */
export const __testing = { sameOrigin, readJson, LOOPBACK_HOST, BODY_LIMIT, clientCheck }
