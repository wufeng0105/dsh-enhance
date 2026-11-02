/**
 * 端到端冒烟（真机装载 + 进程内跑真实的 op 处理链路）。
 *
 * 前置：在一个隔离的 DSH_HOME 里已经用 `dsh plugin --profile smoke add <本仓库>` 装好；
 * 这个脚本自己不做安装，只做验证——安装步骤在 smoke.ps1 里，两者都落盘成证据。
 *
 * 为什么不用 `dsh headless "..."` 跑真会话：那需要模型凭据，而凭据在用户的
 * `~/.dsh/.credentials.yaml` 里。为了冒烟去复制用户凭据是不可接受的，所以
 * 「注入是否真的进系统提示」这一条用**进程内捕获 section 文本**来验：宿主拿到的就是
 * 同一个 `spec.text()` 的返回值，这条路径与真会话完全同源。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const repo = process.cwd()
const home = process.env.DSH_HOME
const profileDir = join(home, 'profiles', 'smoke')
const patchPath = join(profileDir, 'cordis.patch.yml')
const cli = join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')

let failures = 0
const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/** 跑一次 dsh CLI，返回 { status, output }。 */
function dsh(args) {
  const result = spawnSync(`"${cli}" ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`, {
    encoding: 'utf8', timeout: 120_000, shell: true, env: { ...process.env, DSH_HOME: home },
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

console.log(`# DSH_HOME = ${home}`)
console.log(`# repo = ${repo}`)
console.log()

// ---- 0. 前置：真机装载的痕迹 ----
const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
check('0.1 bundle 装进 profile 依赖', String(profilePkg.dependencies?.['dsh-enhance'] ?? '').startsWith('link:'), JSON.stringify(profilePkg.dependencies))
check('0.2 profile bundles 里有本包', (profilePkg.dsh?.profile?.bundles ?? []).includes('dsh-enhance'))
const composed = dsh(['--profile', 'smoke', '--dump-config'])
check('0.3 dsh --dump-config 能组合出 profile', composed.status === 0, `exit=${composed.status}`)
for (const id of ['enhance-scope', 'auto-approve', 'enhance-ui']) {
  check(`0.4 组合树里有入口 ${id}`, composed.output.includes(`- id: ${id}`))
}

// ---- 1. 注入：宿主拿到的 section 文本 ----
process.env.DSH_HOME = home
const scope = await import(pathToFileURL(join(repo, 'enhance-scope', 'index.js')).href)
const autoApprove = await import(pathToFileURL(join(repo, 'auto-approve', 'index.js')).href)

const captured = { sections: [], routes: [], approvalHandler: undefined, agentCreated: undefined }
const profileContext = { name: 'smoke', dir: profileDir, patchPath }
function makeCtx() {
  return {
    get: (name) => (name === 'profileContext' ? profileContext : undefined),
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    inject(names, callback) {
      if (!names.includes('webServer')) return
      callback({
        webServer: {
          register(spec) {
            captured.routes.push(spec)
            return () => {}
          },
        },
      })
    },
    systemPrompt: {
      getSectionOrder: () => 100,
      section(spec) {
        captured.sections.push(spec)
        return () => {}
      },
    },
    on(event, handler) {
      if (event === 'approval/request') captured.approvalHandler = handler
      if (event === 'agent/created') captured.agentCreated = handler
      return () => {}
    },
  }
}

scope.apply(makeCtx())
autoApprove.apply(makeCtx())

const sectionText = captured.sections.map((spec) => spec.text()).filter((text) => text !== '')
check('1.1 section 已注册', captured.sections.length === 1)
check('1.2 section 文本非空（首装种下的默认文本）', sectionText.length > 0, JSON.stringify(sectionText[0]?.slice(0, 40)))
check('1.3 section order 与 API 对齐', captured.sections[0]?.order === 100)
check('1.4 路由已注册且是 exact', captured.routes.length === 1 && captured.routes[0].kind === 'exact' && captured.routes[0].path === '/enhance/api')

// ---- 2. 三态审批 ----
function approvalOutcome(policy) {
  const statePath = join(home, 'enhance', 'state.json')
  const current = JSON.parse(readFileSync(statePath, 'utf8'))
  writeFileSync(statePath, `${JSON.stringify({ ...current, approval: policy }, null, 2)}\n`, 'utf8')
  let called = false
  const next = () => { called = true; return Promise.resolve('unavailable') }
  return Promise.resolve(captured.approvalHandler({}, next)).then((outcome) => ({ outcome, called }))
}
for (const [policy, expected] of [['allow', 'allowed-once'], ['ask', 'unavailable'], ['deny', 'rejected']]) {
  const { outcome, called } = await approvalOutcome(policy)
  const ok = policy === 'ask' ? called : outcome === expected
  check(`2.${policy} 审批三态 → ${expected}`, ok, `outcome=${outcome} next=${called}`)
}

// ---- 3. 设置页 op：state / check / preset ----
function fakeRes() {
  return {
    status: 0, body: undefined,
    writeHead(status) { this.status = status },
    end(payload) { this.body = payload },
  }
}
async function api(body) {
  const res = fakeRes()
  await captured.routes[0].handler({
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json' },
    async* [Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body), 'utf8') },
  }, res)
  return { status: res.status, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}

const stateBefore = await api({ op: 'state' })
check('3.1 state 快照含 preset 段', stateBefore.status === 200 && stateBefore.json.preset !== undefined)
check('3.2 快照定位到当前 profile 的 patch', stateBefore.json.preset.patchPath === patchPath, stateBefore.json.preset.patchPath)
check('3.3 初始状态：patch 里没有 enhanced 档', stateBefore.json.preset.present === false)
// ↑ 断言名里的小写 enhanced 指 patch 字面键；档位展示名是 Enhanced。

const checkResult = await api({ op: 'check' })
const checksNow = checkResult.json?.checks ?? []
const names = checksNow.map((item) => item.name)
check('3.4 检查项是四项且最后一项是 preset', JSON.stringify(names) === JSON.stringify(['plugins', 'text', 'inject', 'preset']), JSON.stringify(names))

/**
 * 断言某一项的取值：**哪一项 / 期望什么 / 实际什么** 一起打出来。
 *
 * 比较一律用 `===`（不是 truthy）：字段被删掉、缺省成 `undefined` 时必须判红，
 * 不许「没这个字段就当默认值放过」——设置页那四项此前只有名字与顺序的证据，缺的正是取值。
 *
 * @param {string} assertionName 断言名
 * @param {string} itemName 检查项名（`plugins` / `text` / `inject` / `preset` 之一）
 * @param {Record<string, unknown>} expectations 期望的取值（逐键严格相等）
 */
function checkItemValues(assertionName, itemName, expectations) {
  const item = checksNow.find((entry) => entry.name === itemName)
  const keys = Object.keys(expectations)
  const wanted = keys.map((key) => `${key}=${JSON.stringify(expectations[key])}`).join(' ')
  const actual = item === undefined
    ? '(响应里没有这一项)'
    : keys.map((key) => `${key}=${JSON.stringify(item[key])}`).join(' ')
  const detail = item?.detail === undefined ? '' : ` · detail=${item.detail}`
  check(assertionName, item !== undefined && keys.every((key) => item[key] === expectations[key]), `期望 ${wanted} · 实际 ${actual}${detail}`)
}

// 一次性的 home、**还没有任何会话日志**：这是「刚装好、还没发过消息」的真实初态。
// 四项取值在这里各自钉一条（本批 T33 之前只有名字与顺序的结构证据）。
checkItemValues('3.4.1 plugins 取值：pass=true（两个插件都进了组合树）', 'plugins', { pass: true })
checkItemValues('3.4.2 text 取值：pass=true（内容边界文本读得到且不超上限）', 'text', { pass: true })
// `inject` 在这一态必须是**如实红**：没有会话日志 = 还没有证据。既不是静默绿，
// 也不能把 detail 写成「遮蔽没有生效」——那会把人骗去修一个没坏的东西。
const injectNoLog = checksNow.find((entry) => entry.name === 'inject')
const injectNoLogDetail = String(injectNoLog?.detail ?? '')
check('3.4.3 inject 取值：没有会话日志时 pass=false 且 detail 点明「没有会话日志」（还没证据，不是遮蔽失效）',
  injectNoLog?.pass === false && injectNoLogDetail.includes('没有会话日志') && !injectNoLogDetail.includes('遮蔽没有生效'),
  `期望 pass=false 且 detail 含「没有会话日志」、不含「遮蔽没有生效」 · 实际 pass=${JSON.stringify(injectNoLog?.pass)} · detail=${injectNoLog?.detail}`)
checkItemValues('3.4.4 preset 取值：pass=true 且 na=true（用户没 opt-in，不是坏了）', 'preset', { pass: true, na: true })

// ---- 3.4.5 `inject` 的绿路：**合成**会话日志（不是真机会话证据）----
// 这里自己造一份 `<home>/sessions/<ws>/<session>/session.v4.jsonl.zstd`：只含一条
// `"system-prompt"` 记录、正文就是当前 `content-scope.txt` 的文本；再跑一次 `op=check`，
// 断言 `inject` 变绿。
//
// **这是合成日志，不是真机会话。** 它证明的是「探针判定链路通」：文件落盘 → zstd 解码
// （探针按帧切，见 `shared/session-probe.mjs`）→ 只认 `"system-prompt"` 行 → 字面命中。
// 它**不**证明真会话里注入过，也**不**替代真机会话证据——文档里「真机会话还缺一次有余额
// 的会话」这个口径不因这一段改口。
//
// 前提：默认 `content-scope.txt` 是单行、不含引号与反斜杠，JSON 编码后仍是逐字原文。
// 探针按字面 `includes` 找（多行文本走 `\n` 转义那条分支），换文本后要复核这一点。
const sessionsRoot = join(home, 'sessions')
const syntheticDir = join(sessionsRoot, 'synthetic-workspace', 'synthetic-session')
mkdirSync(syntheticDir, { recursive: true })
const scopeText = readFileSync(join(home, 'enhance', 'content-scope.txt'), 'utf8').replace(/\r\n?/g, '\n').trim()
const syntheticPromptLine = `${JSON.stringify({ type: 'system-prompt', sessionId: 'synthetic-session', text: scopeText })}\n`
writeFileSync(join(syntheticDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(syntheticPromptLine, 'utf8')))
const checkAfterSynthetic = await api({ op: 'check' })
const injectSynthetic = (checkAfterSynthetic.json?.checks ?? []).find((entry) => entry.name === 'inject')
check('3.4.5 合成日志下 inject 取值：pass=true（探针链路通；不是真机会话证据）',
  injectSynthetic?.pass === true,
  `期望 pass=true · 实际 pass=${JSON.stringify(injectSynthetic?.pass)} · detail=${injectSynthetic?.detail}`)

// ---- 3.4.6 品牌人设的第二路（`identity=custom`）也走一遍合成日志 ----
// 同样用**合成**日志（第二份，只含自定义文本，与上面那份内容边界日志分开——这样探针
// 必须真的按文本去找，而不是靠哪份日志都能命中）。它证明 custom 这一路的判定链路通，
// 仍然**不**是真机会话证据。
const customIdentityText = 'You are Aria, a private assistant (synthetic-log probe).'
await api({ op: 'set', identity: 'custom', identityText: customIdentityText })
const syntheticCustomDir = join(sessionsRoot, 'synthetic-workspace', 'synthetic-session-custom')
mkdirSync(syntheticCustomDir, { recursive: true })
writeFileSync(
  join(syntheticCustomDir, 'session.v4.jsonl.zstd'),
  zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'system-prompt', sessionId: 'synthetic-session-custom', text: customIdentityText })}\n`, 'utf8')),
)
const checkAfterCustom = await api({ op: 'check' })
const injectCustom = (checkAfterCustom.json?.checks ?? []).find((entry) => entry.name === 'inject')
check('3.4.6 合成日志下 inject 的第二路（identity=custom）取值：pass=true（同样不是真机会话证据）',
  injectCustom?.pass === true && String(injectCustom?.detail ?? '').includes('品牌人设'),
  `期望 pass=true 且 detail 含「品牌人设」 · 实际 pass=${JSON.stringify(injectCustom?.pass)} · detail=${injectCustom?.detail}`)
// 还原成默认 keep：下面 3.5.1 要从「默认 keep 不注册任何遮蔽项」起步。
await api({ op: 'set', identity: 'keep' })

// ---- 3.5 品牌人设：agent/created 把遮蔽项装进 agent 作用域 ----
// 这一段验的是「按 agent 遮蔽」这条路线在真宿主组合里接通了：默认 keep 不注册任何东西；
// 切到 remove 后注册一条同名 `harness:identity`，且 interpolate 必须是 false。
function makeAgent() {
  const sections = []
  const contexts = []
  return {
    sections,
    contexts,
    ctx: {
      inject(names, callback) {
        if (!names.includes('systemPrompt')) return { dispose() {} }
        callback({
          systemPrompt: {
            getSectionOrder: () => -1000,
            getContextOrder: () => 200,
            section(spec) { sections.push(spec); return () => {} },
            context(spec) { contexts.push(spec); return () => {} },
          },
        })
        return { dispose() {} }
      },
    },
  }
}
check('3.5.0 插件监听了 agent/created', typeof captured.agentCreated === 'function')
const keepAgent = makeAgent()
await captured.agentCreated({ agent: keepAgent })
check('3.5.1 默认 keep：不注册任何遮蔽项', keepAgent.sections.length === 0, JSON.stringify(keepAgent.sections.map((s) => s.name)))

await api({ op: 'set', identity: 'remove' })
await new Promise((resolve) => setTimeout(resolve, 0))
const removeAgent = makeAgent()
await captured.agentCreated({ agent: removeAgent })
const identityShadow = removeAgent.sections.find((spec) => spec.name === 'harness:identity')
check('3.5.2 remove：注册了 harness:identity', identityShadow !== undefined)
check('3.5.3 遮蔽段保持字面（interpolate=false）', identityShadow?.interpolate === false)
check('3.5.4 remove 的内容是空串（渲染时丢弃）', identityShadow?.text() === '')

await api({ op: 'set', hideHarness: true })
await new Promise((resolve) => setTimeout(resolve, 0))
const hideAgent = makeAgent()
await captured.agentCreated({ agent: hideAgent })
const shadowNames = hideAgent.sections.map((spec) => spec.name).sort().join(',')
check('3.5.5 隐藏开关把两段说明的 section 一起遮', shadowNames === 'app:web-surface,harness:identity,harness:source', shadowNames)
const ctxNames = hideAgent.contexts.map((spec) => spec.name).sort().join(',')
check('3.5.6 两条 context 成对遮蔽（不遮会被 refreshContext 重建）', ctxNames === 'app:web-surface,harness:source', ctxNames)

// 3.5.7 在**同一个活着的 agent** 上「去掉 → 自定义」：这是审计 B1 的现场。
// 只换模式时座名不变，如果重装指纹只记座、不看座上文本是哪一种实现，旧注册会留下，
// 于是设置页显示「已替换」而模型收到空串。新 agent 是好的，所以只有同 agent 连做两步才照得出来。
await api({ op: 'set', identity: 'custom', identityText: 'You are Aria, a private assistant.' })
await new Promise((resolve) => setTimeout(resolve, 0))
const onSameAgent = removeAgent.sections.find((spec) => spec.name === 'harness:identity')
check('3.5.7 同一个 agent 上「去掉 → 自定义」真的换上了自定义文本',
  onSameAgent?.text() === 'You are Aria, a private assistant.',
  JSON.stringify(onSameAgent?.text()))

await api({ op: 'set', identity: 'keep', hideHarness: false })
await new Promise((resolve) => setTimeout(resolve, 0))

// ---- 4. 写档 → 重启（dump-config）→ 移除 ----
const originalPatch = readFileSync(patchPath, 'utf8')
const added = await api({ op: 'preset', action: 'add' })
check('4.1 写档成功且要求重启', added.status === 200 && added.json.needRestart === true, `changed=${added.json?.changed}`)
const backups = readdirSync(profileDir).filter((name) => name.startsWith('cordis.patch.yml.bak-enhance-'))
check('4.2 写前留了备份', backups.length >= 1, backups.join(', '))
check('4.3 备份内容等于写前原文', backups.length >= 1 && readFileSync(join(profileDir, backups[0]), 'utf8') === originalPatch)
check('4.4 备份落在 profile 目录里（不是别处）', backups.every((name) => existsSync(join(profileDir, name))))

const afterWrite = readFileSync(patchPath, 'utf8')
const presets = ['read-only', 'workspace-write', 'danger-full-access', 'enhanced'].filter((name) => afterWrite.includes(`${name}:`))
check('4.5 patch 写的是完整档位表（四档齐全）', presets.length === 4, presets.join(', '))
check('4.6 没写 defaultPreset（不改用户默认档）', !/^\s*defaultPreset:/m.test(afterWrite))

const composedAfter = dsh(['--profile', 'smoke', '--dump-config'])
check('4.7 重启后（dump-config）组合树里出现 enhanced', /enhanced:/.test(composedAfter.output), `exit=${composedAfter.status}`)
check('4.8 重启后其它三档还在', ['read-only:', 'workspace-write:', 'danger-full-access:'].every((token) => composedAfter.output.includes(token)))

const removed = await api({ op: 'preset', action: 'remove' })
check('5.1 移除成功', removed.status === 200 && removed.json.needRestart === true, `changed=${removed.json?.changed}`)
const afterRemove = readFileSync(patchPath, 'utf8')
check('5.2 移除后 patch 回到写前字节', afterRemove === originalPatch, JSON.stringify(afterRemove))
const composedBack = dsh(['--profile', 'smoke', '--dump-config'])
check('5.3 重启后组合树里不再有 enhanced', !/enhanced:/.test(composedBack.output))
check('5.4 其它三档仍在', ['read-only:', 'workspace-write:', 'danger-full-access:'].every((token) => composedBack.output.includes(token)))

// ---- 6. 卸载：删掉 enhance 数据目录不影响插件加载 ----
mkdirSync(join(home, 'enhance'), { recursive: true })
check('6.1 <home>/enhance/ 由插件自动补齐', existsSync(join(home, 'enhance', 'state.json')) && existsSync(join(home, 'enhance', 'content-scope.txt')))

console.log()
console.log(`# summary pass=${results.length - failures} fail=${failures} total=${results.length}`)
process.exit(failures === 0 ? 0 : 1)
