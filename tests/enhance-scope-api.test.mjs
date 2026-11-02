/**
 * `/enhance/api` 的 `preset` op 与 `check` 的第四项。
 *
 * 用假 ctx / 假 req / 假 res 直接驱动 `apply()`：这条路的真实调用方是设置页，
 * 组装一整套 cordis 去测它没有意义，要钉的是「它到底写哪个文件、写坏了有没有拒绝、
 * 摘除能不能回到原字节」。
 *
 * 关键的几条纪律在这里也有断言：
 *   - 路径只认服务端自己解析出来的 patchPath（请求体里给路径必须被当未知字段拒掉）；
 *   - 写前必须有 `.bak-enhance-*` 备份，且备份内容等于写前原文；dryRun 只算不改，也不落备份；
 *   - 没有归属记录不许摘（不猜）；没有 profile 上下文就报 EPROFILE，不猜路径。
 *
 * 另有几条不经过 op 的：`resolveProfilePatch` 的回落顺序（profileContext → DSH_PROFILE_DIR）、
 * `readAsarManifestVersion` 的只读读法、以及 `state` 快照里的 preset 与 compat 两段。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { apply, identityPreview, readAsarManifestVersion, resolveProfilePatch, shadowPlan } from '../enhance-scope/index.js'

/** 一个够 `apply()` 用的假 cordis 上下文；`profile` 为 undefined 时模拟「没有 profile 上下文」。 */
function fakeCtx({ profile, home, agents } = {}) {
  const registered = []
  const sections = []
  const contexts = []
  const listeners = new Map()
  const ctx = {
    get(name) {
      if (name === 'profileContext') return profile
      if (name === 'agents') return agents
      return undefined
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      return typeof cleanup === 'function' ? cleanup : () => {}
    },
    inject(names, callback) {
      if (names.includes('webServer')) {
        callback({
          webServer: {
            register(spec) {
              registered.push(spec)
              return () => {}
            },
          },
        })
      }
      if (names.includes('systemPrompt')) {
        // 品牌人设走这条路：agent 作用域里拿到的 systemPrompt 有 section 与 context 两个方法
        callback({
          systemPrompt: {
            getSectionOrder: () => 100,
            getContextOrder: () => 200,
            section(spec) {
              sections.push(spec)
              return () => {}
            },
            context(spec) {
              contexts.push(spec)
              return () => {}
            },
          },
        })
      }
    },
    systemPrompt: {
      getSectionOrder: () => 100,
      getContextOrder: () => 200,
      section(spec) {
        sections.push(spec)
        return () => {}
      },
      context(spec) {
        contexts.push(spec)
        return () => {}
      },
    },
  }
  return { ctx, registered, sections, contexts, listeners }
}

/** 假响应：把 writeHead/end 的结果收起来。 */
function fakeRes() {
  return {
    status: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload
    },
  }
}

/** 一个够 `readJson()` 用的请求体（async iterable of Buffer）。 */
function fakeReq(headers, body) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...headers },
    async* [Symbol.asyncIterator]() {
      if (raw !== '') yield Buffer.from(raw, 'utf8')
    },
  }
}

/** 起一个 home + profile patch，返回调用一个 op 的函数。 */
async function harness({ profileContext = true, patch, home: presetHome, envProfileDir, agents } = {}) {
  const home = presetHome ?? mkdtempSync(join(tmpdir(), 'enhance-api-'))
  const profileDir = join(home, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (patch !== undefined) writeFileSync(patchPath, patch, 'utf8')

  const previousHome = process.env.DSH_HOME
  const previousDir = process.env.DSH_PROFILE_DIR
  process.env.DSH_HOME = home
  if (envProfileDir === true) process.env.DSH_PROFILE_DIR = profileDir
  else if (envProfileDir === false) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = profileDir

  const profile = profileContext === true ? { name: 'desktop', dir: profileDir, patchPath } : undefined
  const { ctx, registered, listeners, contexts } = fakeCtx({ profile, agents })
  apply(ctx)
  assert.equal(registered.length, 1, '路由没挂上')
  const handler = registered[0].handler

  /** 发一个 op，返回 `{ status, json }`。 */
  async function call(body) {
    const res = fakeRes()
    await handler(fakeReq({}, body), res)
    return { status: res.status, json: res.body === undefined ? undefined : JSON.parse(res.body) }
  }

  async function close() {
    process.env.DSH_HOME = previousHome ?? ''
    if (previousHome === undefined) delete process.env.DSH_HOME
    if (previousDir === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previousDir
    rmSync(home, { recursive: true, force: true })
  }

  return { home, profileDir, patchPath, call, close, listeners, contexts }
}

test('resolveProfilePatch：优先 profileContext.patchPath', () => {
  const target = resolveProfilePatch({ get: (name) => (name === 'profileContext' ? { name: 'web', dir: 'C:/p/web', patchPath: 'C:/p/web/cordis.patch.yml' } : undefined) })
  assert.deepEqual(target, { patchPath: 'C:/p/web/cordis.patch.yml', profile: 'web', source: 'profileContext' })
})

test('resolveProfilePatch：没有 profileContext 时退回 DSH_PROFILE_DIR；都没有就是 undefined', () => {
  const previous = process.env.DSH_PROFILE_DIR
  try {
    process.env.DSH_PROFILE_DIR = join('C:', 'x', 'profiles', 'tui')
    const target = resolveProfilePatch({ get: () => undefined })
    assert.equal(target.source, 'env')
    assert.equal(target.profile, 'tui')
    assert.match(target.patchPath, /cordis\.patch\.yml$/)

    delete process.env.DSH_PROFILE_DIR
    assert.equal(resolveProfilePatch({ get: () => undefined }), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = previous
  }
})

test('state 快照带 preset 段；没有 profile 上下文时 patchPath 为 null', async () => {
  const probe = await harness({ profileContext: false, patch: '[]\n', envProfileDir: false })
  try {
    const { status, json } = await probe.call({ op: 'state' })
    assert.equal(status, 200)
    assert.equal(json.preset.patchPath, null)
    assert.equal(json.preset.present, false)
    assert.match(String(json.preset.reason), /profile/)
  } finally {
    await probe.close()
  }
})

test('readAsarManifestVersion：只读 asar 头里的 package.json（不解包、不写盘）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'enhance-asar-'))
  try {
    const asarPath = join(dir, 'app.asar')
    const manifest = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5' }), 'utf8')
    const index = Buffer.from(JSON.stringify({ files: { 'package.json': { size: manifest.length, offset: '0' } } }), 'utf8')
    const headerSize = 8 + index.length
    const header = Buffer.alloc(headerSize)
    header.writeUInt32LE(headerSize - 4, 0)
    header.writeUInt32LE(index.length, 4)
    index.copy(header, 8)
    const preamble = Buffer.alloc(8)
    preamble.writeUInt32LE(4, 0)
    preamble.writeUInt32LE(headerSize, 4)
    writeFileSync(asarPath, Buffer.concat([preamble, header, manifest]))

    assert.deepEqual(readAsarManifestVersion(asarPath), { name: '@deepseek-ai/dsh-desktop', version: '0.2.1-rc.5' })

    const junk = join(dir, 'junk.bin')
    writeFileSync(junk, 'not an asar')
    assert.equal(readAsarManifestVersion(junk), undefined)
    assert.equal(readAsarManifestVersion(join(dir, 'missing.asar')), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('state 快照带 compat：本包版本取自 package.json，本机版本用于核对已验范围', async () => {
  const pkg = JSON.parse(readFileSync(join(fileURLToPath(new URL('../package.json', import.meta.url)) ), 'utf8'))
  const previous = process.env.DSH_VERSION
  const probe = await harness({ patch: '[]\n' })
  try {
    process.env.DSH_VERSION = pkg.dsh.compatibility.tested
    const inside = (await probe.call({ op: 'state' })).json.compat
    assert.equal(inside.tool, pkg.version)
    assert.equal(inside.host, pkg.dsh.compatibility.tested)
    assert.equal(inside.inRange, true)
    assert.equal(inside.range, '0.2.1-rc.1–0.2.1-rc.5')

    process.env.DSH_VERSION = '9.9.9'
    const outside = (await probe.call({ op: 'state' })).json.compat
    assert.equal(outside.host, '9.9.9')
    assert.equal(outside.inRange, false)
  } finally {
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
    await probe.close()
  }
})
test('preset add：写完整档位表、留备份、回 needRestart', async () => {
  const original = '# comment\n[]\n'
  const probe = await harness({ patch: original })
  try {
    const { status, json } = await probe.call({ op: 'preset', action: 'add' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.needRestart, true)
    assert.ok(json.changed)

    const after = readFileSync(probe.patchPath, 'utf8')
    for (const name of ['read-only', 'workspace-write', 'danger-full-access', 'enhanced']) {
      assert.match(after, new RegExp(`${name}:`), `写完整表必须含 ${name}`)
    }
    assert.match(after, /^# comment/, '原有注释不能被吃掉')

    // 备份必须存在且内容等于写前原文
    const backups = readdirSync(probe.profileDir).filter((name) => name.startsWith('cordis.patch.yml.bak-enhance-'))
    assert.equal(backups.length, 1, '应当恰好一份备份')
    assert.equal(readFileSync(join(probe.profileDir, backups[0]), 'utf8'), original)

    // 快照也要反映出来
    const snapshot = await probe.call({ op: 'state' })
    assert.equal(snapshot.json.preset.present, true)
    assert.deepEqual(snapshot.json.preset.presets, ['read-only', 'workspace-write', 'danger-full-access', 'enhanced'])
  } finally {
    await probe.close()
  }
})

test('preset add 幂等：第二次 changed 为 null、文件字节不变', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    await probe.call({ op: 'preset', action: 'add' })
    const first = readFileSync(probe.patchPath, 'utf8')
    const { status, json } = await probe.call({ op: 'preset', action: 'add' })
    assert.equal(status, 200)
    assert.equal(json.changed, null)
    assert.equal(readFileSync(probe.patchPath, 'utf8'), first)
  } finally {
    await probe.close()
  }
})

test('preset remove：有归属记录时摘净并回到写前字节', async () => {
  const original = '[]\n'
  const probe = await harness({ patch: original })
  try {
    await probe.call({ op: 'preset', action: 'add' })
    const { status, json } = await probe.call({ op: 'preset', action: 'remove' })
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(readFileSync(probe.patchPath, 'utf8'), original, '摘除必须回到逐字节原文')

    const snapshot = await probe.call({ op: 'state' })
    assert.equal(snapshot.json.preset.present, false)
    assert.equal(snapshot.json.preset.recorded, false)
  } finally {
    await probe.close()
  }
})

test('preset remove：没有归属记录 → 409 ERECORD，且不动文件', async () => {
  const patch = [
    '- id: permission',
    '  config:',
    '    presets:',
    '      enhanced:',
    '        sandbox: danger-full-access',
    '        approval: ask',
    '',
  ].join('\n')
  const probe = await harness({ patch })
  try {
    const { status, json } = await probe.call({ op: 'preset', action: 'remove' })
    assert.equal(status, 409)
    assert.equal(json.code, 'ERECORD')
    assert.equal(readFileSync(probe.patchPath, 'utf8'), patch)
  } finally {
    await probe.close()
  }
})

test('preset add：没有 profile 上下文 → 409 EPROFILE', async () => {
  const probe = await harness({ profileContext: false, patch: '[]\n', envProfileDir: false })
  try {
    const { status, json } = await probe.call({ op: 'preset', action: 'add' })
    assert.equal(status, 409)
    assert.equal(json.code, 'EPROFILE')
  } finally {
    await probe.close()
  }
})

test('preset：非法 action 与未知字段都是 400 EBADOP', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const bad = await probe.call({ op: 'preset', action: 'nuke' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.code, 'EBADOP')

    const pathInjection = await probe.call({ op: 'preset', action: 'add', patchPath: 'C:/Windows/system32/evil.yml' })
    assert.equal(pathInjection.status, 400)
    assert.equal(pathInjection.json.code, 'EBADOP')
    assert.match(String(pathInjection.json.message), /unknown field/)

    const badDry = await probe.call({ op: 'preset', action: 'add', dryRun: 'yes' })
    assert.equal(badDry.status, 400)
    assert.equal(badDry.json.code, 'EBADOP')
  } finally {
    await probe.close()
  }
})

test('preset dryRun：只算不改，也不留备份', async () => {
  const original = '[]\n'
  const probe = await harness({ patch: original })
  try {
    const { status, json } = await probe.call({ op: 'preset', action: 'add', dryRun: true })
    assert.equal(status, 200)
    assert.equal(json.dryRun, true)
    assert.match(json.preview, /enhanced:/)
    assert.equal(readFileSync(probe.patchPath, 'utf8'), original, 'dryRun 不许落盘')
    assert.equal(readdirSync(probe.profileDir).filter((name) => name.includes('.bak-enhance-')).length, 0)
  } finally {
    await probe.close()
  }
})

test('check：四项里有 preset，未写入时是 pass + na（不是红叉）', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const { status, json } = await probe.call({ op: 'check' })
    assert.equal(status, 200)
    assert.deepEqual(json.checks.map((item) => item.name), ['plugins', 'text', 'inject', 'preset'])
    const preset = json.checks.find((item) => item.name === 'preset')
    assert.equal(preset.pass, true)
    assert.equal(preset.na, true)
    assert.match(preset.detail, /未写入/)
  } finally {
    await probe.close()
  }
})

test('check：写入之后 preset 项变成已写入', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    await probe.call({ op: 'preset', action: 'add' })
    const { json } = await probe.call({ op: 'check' })
    const preset = json.checks.find((item) => item.name === 'preset')
    assert.equal(preset.pass, true)
    assert.notEqual(preset.na, true)
    assert.match(preset.detail, /已写入/)
  } finally {
    await probe.close()
  }
})

test('check：presets 形态认不出时 preset 项判红', async () => {
  const patch = ['- id: permission', '  config:', '    presets: {a: {sandbox: read-only,', '      approval: ask}}', ''].join('\n')
  const probe = await harness({ patch })
  try {
    const { json } = await probe.call({ op: 'check' })
    const preset = json.checks.find((item) => item.name === 'preset')
    assert.equal(preset.pass, false)
    assert.match(preset.detail, /认不出/)
  } finally {
    await probe.close()
  }
})

test('路径不从请求体来：即便带了 patchPath 也只写服务端解析出的那份', async () => {
  const original = '[]\n'
  const probe = await harness({ patch: original })
  const victim = join(probe.home, 'victim.yml')
  writeFileSync(victim, 'DO NOT TOUCH\n', 'utf8')
  try {
    const { status } = await probe.call({ op: 'preset', action: 'add', patchPath: victim })
    assert.equal(status, 400, '带 patchPath 的请求必须被拒')
    assert.equal(readFileSync(victim, 'utf8'), 'DO NOT TOUCH\n')
  } finally {
    await probe.close()
  }
})

test('写档会在 <home>/enhance/preset-write.json 留归属记录', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    await probe.call({ op: 'preset', action: 'add' })
    const recordPath = join(probe.home, 'enhance', 'preset-write.json')
    assert.equal(existsSync(recordPath), true)
    const record = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(record.patchPath, probe.patchPath)
    assert.equal(record.profile, 'desktop')
    assert.equal(record.action, 'added')
  } finally {
    await probe.close()
  }
})

// ───────────────────────────────────────────── 品牌人设：遮蔽计划与预览

test('shadowPlan：keep 且不隐藏 = 什么都不注册（这才叫「保留」）', () => {
  assert.deepEqual(shadowPlan({ mode: 'keep', hideHarness: false }), [])
})

test('shadowPlan：remove / custom 只遮身份段，且两者注册方式必须完全一样', () => {
  // 两者都用 `live`（动态读文本）是**功能性要求**，不是风格问题：
  // 若 remove 用常量空串、custom 用动态函数，两者座名相同 → 重装指纹相同 →
  // 「去掉 → 自定义」不会重装，座上留着旧空串。见下面那条回归测试。
  const remove = shadowPlan({ mode: 'remove', hideHarness: false })
  const custom = shadowPlan({ mode: 'custom', hideHarness: false })
  assert.deepEqual(remove, [{ kind: 'section', seat: 'identity', text: 'live' }])
  assert.deepEqual(custom, [{ kind: 'section', seat: 'identity', text: 'live' }])
  assert.deepEqual(remove, custom, '两种模式必须产出同一份注册计划')
})

test('shadowPlan：隐藏开关把两段说明的 section 与 context 一起遮——成对，不能只遮一半', () => {
  const plan = shadowPlan({ mode: 'keep', hideHarness: true })
  assert.deepEqual(plan.map((item) => `${item.kind}:${item.seat}`), [
    'section:source', 'context:sourceContext', 'section:web', 'context:webContext',
  ])
  // 只遮 section 的话，refreshContext() 会在准入前按名字把 context 重新求值出来
  assert.equal(plan.filter((item) => item.kind === 'context').length, 2)
})

test('shadowPlan：三态与隐藏开关互相独立，组合起来不重不漏', () => {
  const combo = shadowPlan({ mode: 'custom', hideHarness: true })
  assert.deepEqual(combo.map((item) => `${item.kind}:${item.seat}`), [
    'section:identity', 'section:source', 'context:sourceContext', 'section:web', 'context:webContext',
  ])
})

test('identityPreview：keep 给宿主原句，remove 不伪造，custom 取首行', () => {
  assert.match(identityPreview({ mode: 'keep', text: '' }), /^You are an AI agent/)
  assert.match(identityPreview({ mode: 'remove', text: '' }), /已去掉/)
  assert.equal(identityPreview({ mode: 'custom', text: 'You are Aria.\nsecond line' }), 'You are Aria.')
})

test('品牌人设：agent/created 装遮蔽项、agent/disposed 拆掉，且落在 agent 自己的作用域上', async () => {
  // 钉的是「按 agent 遮蔽」这条路线真的接上了，以及「keep 不注册」这条分界。
  const agentSections = []
  const agentContexts = []
  const makeAgent = () => ({
    ctx: {
      inject(names, callback) {
        if (!names.includes('systemPrompt')) return { dispose: () => {} }
        callback({
          systemPrompt: {
            getSectionOrder: () => -1000,
            getContextOrder: () => 200,
            section(spec) {
              agentSections.push(spec)
              return () => { const i = agentSections.indexOf(spec); if (i >= 0) agentSections.splice(i, 1) }
            },
            context(spec) {
              agentContexts.push(spec)
              return () => { const i = agentContexts.indexOf(spec); if (i >= 0) agentContexts.splice(i, 1) }
            },
          },
        })
        return { dispose: () => {} }
      },
    },
  })

  const probe = await harness({ patch: '[]\n', agents: { list: () => [] } })
  try {
    const created = probe.listeners.get('agent/created')?.[0]
    const disposed = probe.listeners.get('agent/disposed')?.[0]
    assert.equal(typeof created, 'function', 'apply 必须监听 agent/created')
    assert.equal(typeof disposed, 'function', 'apply 必须监听 agent/disposed')

    const agent = makeAgent()
    await created({ agent })
    assert.deepEqual(agentSections, [], '默认 keep：一项都不该注册（注册空串等于去掉，不是保留）')

    // 切成 remove → 走真实 op，排一次微任务让同步落地
    await probe.call({ op: 'set', identity: 'remove' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(agentSections.length, 1, 'remove：应注册一条身份遮蔽')
    assert.equal(agentSections[0].name, 'harness:identity', '必须遮宿主的身份段名')
    assert.equal(agentSections[0].interpolate, false, '用户文本要保持字面，否则一个 { { 就炸')
    assert.equal(agentSections[0].text(), '', 'remove 的内容是空串，渲染时被丢弃')

    // 再开隐藏 → 身份 + 两段说明的 section/context 都在
    await probe.call({ op: 'set', hideHarness: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const names = agentSections.map((spec) => spec.name).sort()
    assert.deepEqual(names, ['app:web-surface', 'harness:identity', 'harness:source'])
    assert.deepEqual(agentContexts.map((spec) => spec.name).sort(), ['app:web-surface', 'harness:source'])

    // 退回 keep + 关隐藏 → 拆干净
    await probe.call({ op: 'set', identity: 'keep', hideHarness: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(agentSections, [], '退回保留后不该留任何遮蔽项')
    assert.deepEqual(agentContexts, [])

    disposed({ agent })
    assert.deepEqual(agentSections, [])
  } finally {
    await probe.close()
  }
})

test('writeState 回归：只切总开关，品牌人设不被重置（审计 M5）', async () => {
  // writeState 是整块重建。set 的 next 必须把五键都带上，否则用户点一次「总开关」
  // 就把 identity/hideHarness 悄悄清回默认——这是最容易漏、也最难在界面上看出来的事故。
  const probe = await harness({ patch: '[]\n' })
  try {
    const first = await probe.call({ op: 'set', identity: 'custom', hideHarness: true })
    assert.equal(first.status, 200)

    const second = await probe.call({ op: 'set', enabled: false })
    assert.equal(second.status, 200)
    assert.equal(second.json.enabled, false)
    assert.equal(second.json.identity, 'custom', '切总开关后身份必须还在')
    assert.equal(second.json.hideHarness, true, '切总开关后隐藏开关必须还在')

    // 内容边界那条路也一样
    const third = await probe.call({ op: 'set', contentScope: false })
    assert.equal(third.json.contentScope, false)
    assert.equal(third.json.identity, 'custom')
    assert.equal(third.json.hideHarness, true)
  } finally {
    await probe.close()
  }
})

test('品牌人设：非法 identity / 非布尔 hideHarness / 超限文本都被拒，且不落盘', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const badMode = await probe.call({ op: 'set', identity: 'white-label' })
    assert.equal(badMode.status, 400)
    assert.equal(badMode.json.code, 'EBADOP')

    const badBool = await probe.call({ op: 'set', hideHarness: 'yes' })
    assert.equal(badBool.status, 400)
    assert.equal(badBool.json.code, 'EBADOP')

    const tooLong = await probe.call({ op: 'set', identityText: 'x'.repeat(2049) })
    assert.equal(tooLong.status, 413)
    assert.equal(tooLong.json.code, 'ETOOLARGE')

    // 超限与非法都不该改状态
    const snapshot = await probe.call({ op: 'state' })
    assert.equal(snapshot.json.identity, 'keep')
    assert.equal(snapshot.json.identityText, '')
  } finally {
    await probe.close()
  }
})

test('state 快照：身份字段齐全，preview 按服务端派生', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const keep = await probe.call({ op: 'state' })
    assert.equal(keep.json.identity, 'keep')
    assert.equal(keep.json.identityLimit, 2048)
    assert.equal(keep.json.identityEffective.mode, 'keep')
    assert.match(keep.json.identityEffective.preview, /^You are an AI agent/)

    await probe.call({ op: 'set', identity: 'custom', identityText: 'You are Aria.' })
    const custom = await probe.call({ op: 'state' })
    assert.equal(custom.json.identityEffective.mode, 'custom')
    assert.equal(custom.json.identityEffective.preview, 'You are Aria.')
    assert.equal(custom.json.identitySha256.length, 12)
  } finally {
    await probe.close()
  }
})

test('品牌人设回归：活着的 agent 上「去掉 → 自定义」必须真的换上自定义文本', async () => {
  // 这条钉的是审计 B1：重装指纹原先只看「有哪些座」，不看座上的 text 是哪一种实现。
  // remove 注册的是常量空串、custom 注册的是动态读函数，两者座名相同 → 指纹相同 → 不重装，
  // 结果设置页显示「已替换」而模型实际收到空串（等于删除）。新 agent 正常，所以症状是
  // 「有的会话对、有的不对」——这类 bug 只有把三步串起来才照得出来。
  const sections = []
  const agent = {
    ctx: {
      inject(names, callback) {
        if (!names.includes('systemPrompt')) return { dispose: () => {} }
        callback({
          systemPrompt: {
            getSectionOrder: () => -1000,
            getContextOrder: () => 200,
            section(spec) {
              sections.push(spec)
              return () => { const i = sections.indexOf(spec); if (i >= 0) sections.splice(i, 1) }
            },
            context() { return () => {} },
          },
        })
        return { dispose: () => {} }
      },
    },
  }

  const probe = await harness({ patch: '[]\n', agents: { list: () => [] } })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const created = probe.listeners.get('agent/created')[0]
    await created({ agent })
    assert.equal(sections.length, 0, 'keep：不注册')

    await probe.call({ op: 'set', identity: 'remove' })
    await settle()
    assert.equal(sections.length, 1, 'remove：注册一条')
    assert.equal(sections[0].text(), '', 'remove：内容为空串')

    await probe.call({ op: 'set', identity: 'custom', identityText: 'You are Aria, a private assistant.' })
    await settle()
    assert.equal(sections.length, 1, 'custom：仍然只该有一条（同一个座）')
    assert.equal(sections[0].text(), 'You are Aria, a private assistant.',
      '去掉 → 自定义之后，座上必须真的换成自定义文本；留着旧空串就是「显示已替换、实际被删掉」')

    // 只改文本（identity 不变）也要能跟上
    await probe.call({ op: 'set', identityText: 'You are Nova.' })
    await settle()
    assert.equal(sections[0].text(), 'You are Nova.', '只改文本时，动态读函数本身就该跟上')
  } finally {
    await probe.close()
  }
})

// ───────────────────────────────────────────── 品牌人设：装上了没有 / 遮蔽有没有生效（T25，审计缺口 1）
//
// 这一节钉三件事：
//   1. 装不上要吭声——拿不到可注入的 agent 上下文时，快照里有可读状态，设置页能如实说明；
//   2. 装上了但没顶掉要能证伪——`inject` 一项扩成「内容边界 + 品牌人设」，detail 点名是哪一路；
//   3. 不许假绿——keep 不判、没有会话日志不判成「遮蔽失效」。

/** 宿主原句：`remove` 这一路的证伪目标，与 `enhance-scope/index.js` 里那一个常量逐字一致。 */
const HOST_SENTENCE = 'You are an AI agent powered by DeepSeek Harness.'

/**
 * 造一份假会话日志：`<home>/sessions/workspace/<name>/session.v4.jsonl.zstd`。
 *
 * 只放要验的那一行——`"system-prompt"` 是探针唯一认的标记，payload 是那一行里真正
 * 喂给模型的文本。`mtimeMs` 用来摆新旧顺序（`sessionOmits` 只判最新一份）。
 */
function writeSession(home, name, payload, mtimeMs) {
  const dir = join(home, 'sessions', 'workspace', name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'system-prompt', payload })}\n`, 'utf8')))
  if (mtimeMs !== undefined) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

/** 一个可注入的假 agent：`agent.ctx.inject` 立刻回调，把遮蔽项记进数组。 */
function injectableAgent() {
  const sections = []
  const contexts = []
  const agent = {
    ctx: {
      inject(names, callback) {
        if (!names.includes('systemPrompt')) return { dispose: () => {} }
        callback({
          systemPrompt: {
            getSectionOrder: () => -1000,
            getContextOrder: () => 200,
            section(spec) {
              sections.push(spec)
              return () => { const i = sections.indexOf(spec); if (i >= 0) sections.splice(i, 1) }
            },
            context(spec) {
              contexts.push(spec)
              return () => { const i = contexts.indexOf(spec); if (i >= 0) contexts.splice(i, 1) }
            },
          },
        })
        return { dispose: () => {} }
      },
    },
  }
  return { agent, sections, contexts }
}

/** 取 check 结果里的 `inject` 项。 */
async function injectCheck(probe) {
  const { json } = await probe.call({ op: 'check' })
  return json.checks.find((item) => item.name === 'inject')
}

test('identityInstall：拿不到可注入的 agent 上下文时，快照如实报「未生效」且不把整页判红', async () => {
  // 失效模式 B：`agent.ctx.inject` 不是函数。过去这里静默 return，页面照样显示「已替换」。
  const agent = { ctx: {} }
  const probe = await harness({ patch: '[]\n', agents: { list: () => [agent] } })
  try {
    const { status, json } = await probe.call({ op: 'state' })
    assert.equal(status, 200)
    // 「不是页面级红」：快照本身 ok、状态文件没坏、内容边界照常注入。
    assert.equal(json.ok, true)
    assert.equal(json.degraded, false)
    assert.equal(json.injecting, true)
    // 「装不上要吭声」：可机读状态 + 一句人话，都点明拿不到什么。
    assert.equal(json.identityInstall.state, 'unsupported')
    assert.equal(json.identityInstall.ok, false)
    assert.match(json.identityInstall.text, /^未生效/)
    assert.match(json.identityInstall.text, /agent\.ctx\.inject/)
    assert.equal(json.identityInstall.agents, 1)
  } finally {
    await probe.close()
  }
})

test('identityInstall：没有 agent 时是「还没见到」而不是失败（ok 为 null，不是红）', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const install = (await probe.call({ op: 'state' })).json.identityInstall
    assert.equal(install.state, 'idle')
    assert.equal(install.ok, null, '还没见到 agent 不是失败，别压成 false')
    assert.equal(install.scoped, 0)
    assert.match(install.text, /还没见到 agent/)
  } finally {
    await probe.close()
  }
})

test('identityInstall：装上之后报出 agent 数与遮蔽项数，keep 与 remove 的措辞不同', async () => {
  const { agent } = injectableAgent()
  const probe = await harness({ patch: '[]\n', agents: { list: () => [agent] } })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    const keep = (await probe.call({ op: 'state' })).json.identityInstall
    assert.equal(keep.state, 'installed')
    assert.equal(keep.ok, true)
    assert.equal(keep.agents, 1)
    assert.equal(keep.scoped, 1)
    assert.equal(keep.shadowed, 0, 'keep 时没有要遮蔽的段')
    assert.match(keep.text, /已接上/)

    await probe.call({ op: 'set', identity: 'remove' })
    await settle()
    const remove = (await probe.call({ op: 'state' })).json.identityInstall
    assert.equal(remove.shadowed, 1, 'remove 应当在作用域里注册一条身份遮蔽')
    assert.match(remove.text, /已生效/)
  } finally {
    await probe.close()
  }
})

test('inject：identity=custom 但最新会话里没有自定义文本 → 判红并点名「品牌人设」；补上后变绿', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const contentText = (await probe.call({ op: 'state' })).json.text
    assert.ok(contentText.length > 0, '首装种下的内容边界文本不该为空')
    await probe.call({ op: 'set', identity: 'custom', identityText: 'You are Aria, a private assistant.' })
    // 会话里有内容边界文本、没有自定义文本：内容边界那一路应当过，红在品牌人设。
    writeSession(probe.home, 'custom-red', contentText, Date.now() - 1000)
    const red = await injectCheck(probe)
    assert.equal(red.pass, false)
    assert.match(red.detail, /内容边界：命中/, '内容边界那一路应当过了')
    assert.match(red.detail, /品牌人设：/, 'detail 必须点名是哪一路没过')
    assert.match(red.detail, /没有这段文本/)

    // 再来一份更新的会话，里面真的有自定义文本：同一项必须变绿。
    writeSession(probe.home, 'custom-green', `You are Aria, a private assistant.\n${contentText}`, Date.now())
    const green = await injectCheck(probe)
    assert.equal(green.pass, true)
    assert.match(green.detail, /品牌人设：自定义文本命中/)
  } finally {
    await probe.close()
  }
})

test('inject：identity=remove 但最新会话里仍有宿主原句 → 判红；只看最新一份，新日志干净就变绿', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const contentText = (await probe.call({ op: 'state' })).json.text
    await probe.call({ op: 'set', identity: 'remove' })
    // 更旧的一份日志带着宿主原句（模拟「切换设置之前的会话」）——它不该把判定拉红。
    writeSession(probe.home, 'stale', `${HOST_SENTENCE}\n${contentText}`, Date.now() - 5000)
    writeSession(probe.home, 'current', `${HOST_SENTENCE}\n${contentText}`, Date.now())
    const red = await injectCheck(probe)
    assert.equal(red.pass, false)
    assert.match(red.detail, /品牌人设：/)
    assert.match(red.detail, /仍有宿主原句/)

    // 新起一份不含宿主原句的会话：最新一份干净，就该绿（也证明判定不是「最近 N 份任一含」）。
    writeSession(probe.home, 'newer', contentText, Date.now() + 1000)
    const green = await injectCheck(probe)
    assert.equal(green.pass, true)
    assert.match(green.detail, /品牌人设：最新会话里已经没有宿主原句/)

    // hideHarness 打开与否不影响本判据（它管另外两段说明）。
    await probe.call({ op: 'set', hideHarness: true })
    const stillGreen = await injectCheck(probe)
    assert.equal(stillGreen.pass, true)
  } finally {
    await probe.close()
  }
})

test('inject：identity=keep 时品牌人设不参与判定——会话里没有宿主原句也不判红', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    const contentText = (await probe.call({ op: 'state' })).json.text
    // 日志里只有内容边界文本，没有宿主原句。若把 keep 误当 remove 判，这里会假红。
    writeSession(probe.home, 'keep', contentText, Date.now())
    const inject = await injectCheck(probe)
    assert.equal(inject.pass, true)
    assert.doesNotMatch(inject.detail, /品牌人设/, 'keep 这一路不判，detail 不该出现品牌人设结论')
  } finally {
    await probe.close()
  }
})

test('inject：没有会话日志时如实说「没有会话日志」，不判成遮蔽失效', async () => {
  const probe = await harness({ patch: '[]\n' })
  try {
    await probe.call({ op: 'set', identity: 'remove' })
    const inject = await injectCheck(probe)
    // 现有口径：没有证据就是红（提示先发一条消息），但理由必须是「没有日志」而不是「失效」。
    assert.equal(inject.pass, false)
    assert.match(inject.detail, /没有会话日志/)
    assert.doesNotMatch(inject.detail, /遮蔽没有生效/)
  } finally {
    await probe.close()
  }
})
