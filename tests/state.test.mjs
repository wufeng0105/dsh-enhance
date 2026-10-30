/**
 * `shared/state.mjs` 的契约测试。
 *
 * 覆盖四件在文档里被当成承诺的事：
 *   - 坏 `state.json` 降级而不抛（缺失 / 损坏 / 非法 approval 三种）
 *   - 写盘是原子的（目录自动建、不留 `*.tmp-*`、写后读得回）
 *   - 文本超限抛 `ETOOLARGE`，且原文件不动；超限的落盘文本不会被注入
 *   - 只认 enabled / contentScope / approval 三个字段，旧版本同形状字段照读、没有迁移支路
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  derive, normalizeText, paths, readState, readText, textBytes, writeState, writeText,
  TEXT_LIMIT, STATE_VERSION,
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

test('state.json 缺失：默认 开/ask，并标明 missing', () => {
  const state = readState(paths(freshHome()))
  assert.equal(state.contentScope, true)
  assert.equal(state.approval, 'ask')
  assert.equal(state.degraded, true)
  assert.equal(state.degradedReason, 'missing')
  assert.equal(state.version, STATE_VERSION)
  assert.equal(STATE_VERSION, 3)
})

test('state.json 损坏：不抛，同样按默认值走', () => {
  const home = freshHome()
  const p = seed(home, '{"contentScope": tru')
  const state = readState(p)
  assert.equal(state.degraded, true)
  assert.equal(state.degradedReason, 'corrupt')
  assert.equal(state.approval, 'ask')
})

test('只认三个字段：同形状字段照读，多出来的字段自然被忽略', () => {
  const home = freshHome()
  const state = readState(seed(home, JSON.stringify({ version: 3, enabled: true, contentScope: true, approval: 'allow', legacyExtra: true })))
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.approval, 'allow')
  assert.equal(state.degraded, false)
  assert.deepEqual(Object.keys(state).sort(), ['approval', 'contentScope', 'degraded', 'degradedReason', 'enabled', 'updatedAt', 'version'])
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
  assert.equal(state.version, 3)
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
