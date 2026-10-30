/**
 * `/enhance/api` 的 `preset` op 与 `check` 的第四项。
 *
 * 用假 ctx / 假 req / 假 res 直接驱动 `apply()`：这条路的真实调用方是设置页，
 * 组装一整套 cordis 去测它没有意义，要钉的是「它到底写哪个文件、写坏了有没有拒绝、
 * 摘除能不能回到原字节」。
 *
 * 关键的几条纪律在这里也有断言：
 *   - 路径只认服务端自己解析出来的 patchPath（请求体里给路径必须被当未知字段拒掉）；
 *   - 写前必须有 `.bak-enhance-*` 备份，且备份内容等于写前原文；
 *   - 没有归属记录不许摘（不猜）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, resolveProfilePatch } from '../enhance-scope/index.js'

/** 一个够 `apply()` 用的假 cordis 上下文；`profile` 为 undefined 时模拟「没有 profile 上下文」。 */
function fakeCtx({ profile, home } = {}) {
  const registered = []
  const sections = []
  const ctx = {
    get(name) {
      return name === 'profileContext' ? profile : undefined
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
    },
    systemPrompt: {
      getSectionOrder: () => 100,
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
  }
  return { ctx, registered, sections }
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
async function harness({ profileContext = true, patch, home: presetHome, envProfileDir } = {}) {
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
  const { ctx, registered } = fakeCtx({ profile })
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

  return { home, profileDir, patchPath, call, close }
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
    assert.deepEqual(inside.versions, pkg.dsh.compatibility.versions)

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
