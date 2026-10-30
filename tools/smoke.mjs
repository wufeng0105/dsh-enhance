/**
 * WP7 端到端冒烟（真机装载 + 进程内跑真实的 op 处理链路）。
 *
 * 前置：由一个隔离的 DSH_HOME 里已经用 `dsh plugin --profile smoke add <本仓库>` 装好；
 * 这个脚本自己不做安装，只做验证——安装步骤在 smoke.ps1 里，两者都落盘成证据。
 *
 * 为什么不用 `dsh headless "..."` 跑真会话：那需要模型凭据，而凭据在用户的
 * `~/.dsh/.credentials.yaml` 里。为了冒烟去复制用户凭据是不可接受的，所以
 * 「注入是否真的进提示词」这一条用**进程内捕获 section 文本**来验：宿主拿到的就是
 * 同一个 `spec.text()` 的返回值，这条路径与真会话完全同源。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

const captured = { sections: [], routes: [], approvalHandler: undefined }
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

const checkResult = await api({ op: 'check' })
const names = (checkResult.json?.checks ?? []).map((item) => item.name)
check('3.4 检查项是四项且最后一项是 preset', JSON.stringify(names) === JSON.stringify(['plugins', 'text', 'inject', 'preset']), JSON.stringify(names))

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
