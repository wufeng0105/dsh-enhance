/**
 * `shared/state.mjs` 的契约测试。
 *
 * 覆盖这几件在文档里被当成承诺的事：
 *   - 坏 `state.json` 降级而不抛（缺失 / 损坏 / 非法开关档 `approval`；字符串布尔按字面认）
 *   - 写盘是原子的（目录自动建、不留 `*.tmp-*`、写后读得回）
 *   - 文本按「去 BOM → 去控制字符 → trim」归一，CRLF / CR 折成 LF，字节数按折后算
 *   - 文本超限抛 `ETOOLARGE`，且原文件不动；超限的落盘文本不会被注入
 *   - 只认 enabled / contentScope / approval 三个字段，旧版本同形状字段照读、没有迁移支路
 *   - 总开关 `enabled` 默认开，关掉即停手；写盘只认 true / false，不认识的字段不写进去
 *   - derive 停手的理由各有字面（未激活 / 总开关关闭 / 读不到 / 文本为空），与读盘降级分开
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  derive, deriveIdentity, fileStat, normalizeText, paths, readIdentity, readState, readText,
  textBytes, writeIdentity, writeState, writeText,
  IDENTITY_LIMIT, TEXT_LIMIT, STATE_VERSION,
} from '../shared/state.mjs'

/** 每个用例一个空 home，互不影响。 */
function freshHome() {
  return mkdtempSync(join(tmpdir(), 'enhance-state-'))
}

/** 往 home 里写一份 state.json 原文。 */
function seed(home, raw) {
  const p = paths(home)
  mkdirSync(p.dir, { recursive: true })
  writeFileSync(p.state, raw, 'utf8')
  return p
}

test('state.json 缺失：默认 开/ask/keep，并标明 missing', () => {
  const state = readState(paths(freshHome()))
  assert.equal(state.contentScope, true)
  assert.equal(state.approval, 'ask')
  assert.equal(state.identity, 'keep')
  assert.equal(state.hideHarness, false)
  assert.equal(state.degraded, true)
  assert.equal(state.degradedReason, 'missing')
  assert.equal(state.version, STATE_VERSION)
  assert.equal(STATE_VERSION, 4)
})

test('state.json 损坏：不抛，同样按默认值走', () => {
  const home = freshHome()
  const p = seed(home, '{"contentScope": tru')
  const state = readState(p)
  assert.equal(state.degraded, true)
  assert.equal(state.degradedReason, 'corrupt')
  assert.equal(state.approval, 'ask')
})

test('只认五个字段：同形状字段照读，多出来的字段自然被忽略', () => {
  const home = freshHome()
  const state = readState(seed(home, JSON.stringify({ version: 3, enabled: true, contentScope: true, approval: 'allow', identity: 'custom', hideHarness: true, legacyExtra: true })))
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.approval, 'allow')
  assert.equal(state.identity, 'custom')
  assert.equal(state.hideHarness, true)
  assert.equal(state.degraded, false)
  assert.deepEqual(Object.keys(state).sort(), ['approval', 'contentScope', 'degraded', 'degradedFields', 'degradedReason', 'enabled', 'hideHarness', 'identity', 'updatedAt', 'version'])
})

test('v3 旧文件（无 identity/hideHarness）：按 keep + 不隐藏读，且不标坏', () => {
  // 旧版本 state.json 里没有这两个字段是正常的，不是损坏——升级后不该报降级。
  const state = readState(seed(freshHome(), JSON.stringify({ version: 3, enabled: true, contentScope: true, approval: 'ask' })))
  assert.equal(state.identity, 'keep')
  assert.equal(state.hideHarness, false)
  assert.equal(state.degraded, false)
  assert.deepEqual(state.degradedFields, [])
})

test('空对象 / 非法 approval：按 ask 并标坏，不倒向放行', () => {
  const empty = readState(seed(freshHome(), '{}'))
  assert.equal(empty.approval, 'ask')
  assert.equal(empty.degraded, true)
  assert.equal(empty.degradedReason, 'corrupt')

  const bad = readState(seed(freshHome(), JSON.stringify({ version: 3, approval: 'maybe' })))
  assert.equal(bad.approval, 'ask')
  assert.equal(bad.degraded, true)
  assert.equal(bad.degradedReason, 'corrupt')
  assert.deepEqual(bad.degradedFields, ['approval'])
})

test('非法 identity：按 keep 并标坏，degradedFields 指到具体字段', () => {
  // 降级方向是不改身份；页面要能说对原因，所以坏的是哪个字段必须记下来。
  // 注意：缺 approval 本身也算坏（v3 起就有这个键），所以这里显式给一个合法 approval。
  const bad = readState(seed(freshHome(), JSON.stringify({ version: 4, approval: 'ask', identity: 'white-label' })))
  assert.equal(bad.identity, 'keep')
  assert.equal(bad.degraded, true)
  assert.equal(bad.degradedReason, 'corrupt')
  assert.deepEqual(bad.degradedFields, ['identity'])

  const both = readState(seed(freshHome(), JSON.stringify({ version: 4, approval: 'nope', identity: 'nope' })))
  assert.deepEqual(both.degradedFields.sort(), ['approval', 'identity'])

  const badHide = readState(seed(freshHome(), JSON.stringify({ version: 4, approval: 'ask', hideHarness: 'yes' })))
  assert.equal(badHide.hideHarness, false)
  assert.deepEqual(badHide.degradedFields, ['hideHarness'])
})

test('字符串布尔：读路径按字面认 "false"', () => {
  const home = freshHome()
  const state = readState(seed(home, JSON.stringify({ version: 3, contentScope: 'false', enabled: 'false', approval: 'ask' })))
  assert.equal(state.contentScope, false)
  assert.equal(state.enabled, false)
  assert.equal(derive(state, { text: 'x', ok: true }).injecting, false)
})

test('writeState：建目录、原子落盘、写当前格式', () => {
  const home = freshHome()
  const p = paths(home)
  assert.equal(readdirSyncSafe(home).length, 0)
  const body = writeState(p, { contentScope: false, approval: 'deny' })
  assert.equal(body.version, STATE_VERSION)
  assert.equal(body.approval, 'deny')
  const reread = readState(p)
  assert.equal(reread.contentScope, false)
  assert.equal(reread.approval, 'deny')
  assert.equal(reread.degraded, false)
  assert.match(reread.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(readdirSyncSafe(p.dir).filter((name) => name.includes('.tmp-')), [])
})

test('writeState 整块重建：漏带新字段就把身份重置回默认——调用点必须读回来再写回去', () => {
  // 这条锁的是「点一次总开关把品牌人设清空」这类事故：writeState 不合并旧值，
  // 调用方必须先 readState() 再把 identity/hideHarness 原样带回。
  const p = paths(freshHome())
  writeState(p, { contentScope: true, approval: 'ask', identity: 'custom', hideHarness: true })
  assert.equal(readState(p).identity, 'custom')

  // 反例：只带三键（1.1.2 的旧写法）→ 身份被重置
  writeState(p, { enabled: false, contentScope: true, approval: 'ask' })
  assert.equal(readState(p).identity, 'keep', '漏带即重置——这正是必须在所有调用点补齐的原因')
  assert.equal(readState(p).hideHarness, false)

  // 正例：先读后写，五键带全
  const before = readState(p)
  writeState(p, { ...before, enabled: true })
  assert.equal(readState(p).identity, 'keep')
})

test('writeText：写得进、去控制字符、sha 与字节数同口径', () => {
  const p = paths(freshHome())
  const result = writeText(p, '\uFEFF  hello\u0007 world  \n')
  assert.equal(result.bytes, textBytes('hello world'))
  assert.equal(readText(p).text, 'hello world')
  assert.equal(result.sha256.length, 12)
})

test('writeText 超过上限：抛 ETOOLARGE，原文件不变', () => {
  const p = paths(freshHome())
  writeText(p, 'original')
  assert.throws(() => writeText(p, 'x'.repeat(TEXT_LIMIT + 1)), (error) => error.code === 'ETOOLARGE')
  assert.equal(readFileSync(p.text, 'utf8'), 'original')
})

test('normalizeText：去 BOM、去 C0、保留换行与制表', () => {
  assert.equal(normalizeText('\uFEFFa\u0000b\u000Bc\n\u0009d'), 'abc\n\u0009d')
})

test('normalizeText：CRLF 与 CR 折成 LF，字节数按折后算', () => {
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc')
  assert.equal(textBytes('a\r\nb'), 3)
})

test('derive：非激活 / 开关关 / 读不到 / 空文本 / 正常', () => {
  const on = { contentScope: true, approval: 'allow' }
  const off = { contentScope: false, approval: 'allow' }
  assert.equal(derive(on, { text: 'x', ok: true }, false).reason, '插件未激活')
  assert.equal(derive(off, { text: 'x', ok: true }).injecting, false)
  assert.equal(derive(on, { text: '', ok: false }).reason, '读不到 content-scope.txt')
  assert.equal(derive(on, { text: '', ok: true }).reason, '文本为空')
  assert.equal(derive(on, { text: 'Private sandbox.', ok: true }).injecting, true)
  assert.equal(derive({ contentScope: 'false' }, { text: 'x', ok: true }).injecting, false)
})

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

test('总开关：默认开；关掉后派生停手', () => {
  const home = freshHome()
  const p = seed(home, JSON.stringify({ version: 2 }))
  const state = readState(p)
  assert.equal(state.enabled, true)

  const off = readState(seed(freshHome(), JSON.stringify({ version: 2, enabled: false })))
  assert.equal(off.enabled, false)
  assert.equal(derive(off, { text: 'x', ok: true }).reason, '总开关关闭')
})

test('总开关写盘：只认 true/false，写回后读得到', () => {
  const p = paths(freshHome())
  writeState(p, { enabled: false, contentScope: true, approval: 'allow' })
  const state = readState(p)
  assert.equal(state.enabled, false)
  assert.equal(state.version, 4)
  assert.equal('fence' in state, false)
})

test('derive：超过 8 KB 上限就不注入（与设置页 check 同一口径）', () => {
  // README 让用户直接编辑 content-scope.txt；写路径之外的这份文件没人拦，
  // 若读路径也不判上限，一份超限文本会在设置页检查全绿的情况下被整段注入。
  const on = { contentScope: true, approval: 'ask' }
  assert.equal(derive(on, { text: 'x'.repeat(TEXT_LIMIT), ok: true }).injecting, true, '恰好到上限仍然注入')
  const over = derive(on, { text: 'x'.repeat(TEXT_LIMIT + 1), ok: true })
  assert.equal(over.injecting, false, '超过上限必须停手')
  assert.match(over.reason, /上限/)
})

// ───────────────────────────────────────────── 品牌人设

test('identity.txt：读写同口径，独立上限 2 KB', () => {
  const p = paths(freshHome())
  assert.equal(IDENTITY_LIMIT, 2048)
  assert.equal(readIdentity(p).ok, false, '文件不存在时 ok=false')

  writeIdentity(p, '\uFEFF  You are Aria.\u0007  \n')
  assert.equal(readIdentity(p).text, 'You are Aria.')
  assert.equal(fileStat(p.identity).bytes, 'You are Aria.'.length)

  // 恰好在限内能写；超一个字节就抛，且原文件不变
  writeIdentity(p, 'x'.repeat(IDENTITY_LIMIT))
  assert.throws(() => writeIdentity(p, 'x'.repeat(IDENTITY_LIMIT + 1)), (error) => error.code === 'ETOOLARGE')
  assert.equal(readIdentity(p).text.length, IDENTITY_LIMIT)
})

test('deriveIdentity：keep / remove 直通，custom 取文本', () => {
  assert.deepEqual(deriveIdentity({ identity: 'keep', hideHarness: false }), { mode: 'keep', text: '', hideHarness: false, degraded: false, reason: undefined })
  assert.deepEqual(deriveIdentity({ identity: 'keep', hideHarness: true }).hideHarness, true)
  assert.equal(deriveIdentity({ identity: 'remove', hideHarness: false }).mode, 'remove')

  const custom = deriveIdentity({ identity: 'custom', hideHarness: false }, { text: 'You are Aria.', ok: true })
  assert.equal(custom.mode, 'custom')
  assert.equal(custom.text, 'You are Aria.')
  assert.equal(custom.degraded, false)
})

test('deriveIdentity：custom 的失败路径各有归宿，且都给出理由', () => {
  // 读不到 / 超限 → 退化为 keep（不改身份）
  const missing = deriveIdentity({ identity: 'custom', hideHarness: false }, { text: '', ok: false })
  assert.equal(missing.mode, 'keep')
  assert.equal(missing.degraded, true)
  assert.match(missing.reason, /读不到 identity.txt/)

  const over = deriveIdentity({ identity: 'custom', hideHarness: false }, { text: 'x'.repeat(IDENTITY_LIMIT + 1), ok: true })
  assert.equal(over.mode, 'keep')
  assert.equal(over.degraded, true)
  assert.match(over.reason, /超过上限/)

  // 空文本 → 按「去掉」处理（空文本等于不声明），并标明
  const empty = deriveIdentity({ identity: 'custom', hideHarness: false }, { text: '', ok: true })
  assert.equal(empty.mode, 'remove')
  assert.equal(empty.degraded, true)
  assert.match(empty.reason, /为空/)
})

test('deriveIdentity：总开关关着就什么都不做', () => {
  const off = deriveIdentity({ enabled: false, identity: 'custom', hideHarness: true }, { text: 'You are Aria.', ok: true })
  assert.equal(off.mode, 'keep')
  assert.equal(off.hideHarness, false)
  assert.equal(off.reason, '总开关关闭')
})

test('deriveIdentity：非法 identity 值按 keep 处理', () => {
  const out = deriveIdentity({ identity: 'white-label', hideHarness: false }, { text: 'x', ok: true })
  assert.equal(out.mode, 'keep')
})

test('deriveIdentity：hideHarness 与三态互相独立', () => {
  for (const identity of ['keep', 'remove', 'custom']) {
    const out = deriveIdentity({ identity, hideHarness: true }, { text: 'x', ok: true })
    assert.equal(out.hideHarness, true, `${identity} 下 hideHarness 应保持为真`)
  }
})
