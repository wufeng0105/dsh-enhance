/**
 * `shared/compat.mjs` 的契约测试：engines.dsh 区间的解析、semver 比较、成员判定与展示派生。
 *
 * 这组钉的是「声明怎么被读」：区间形状收窄（只认 `>=A <B`）、预发布比较按 semver、
 * 排他上界在 rc 线上的展示折算（`<0.2.1-rc.6` → 「到 0.2.1-rc.5 为止」）、
 * 折算不出前一位的去直说（上界非 rc、rc.1，或推算出的末位落在下界之前）。
 * 门禁与设置页版本行共用这一个实现，这里红了它们就都红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  basisLabel, compareSemver, declarationOf, displayRange, inRange, parseEnginesDsh,
} from '../shared/compat.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

test('parseEnginesDsh：认双边界区间', () => {
  const parsed = parseEnginesDsh('>=0.2.1-rc.1 <0.2.1-rc.6')
  assert.deepEqual(parsed, { min: '0.2.1-rc.1', max: '0.2.1-rc.6', maxExclusive: true })
})

test('parseEnginesDsh：单界、坏算符、非字符串都拒', () => {
  for (const bad of ['>=0.2.1', '<0.2.1-rc.6', '^0.2.1', '>=0.2.1-rc.1 <=0.2.1-rc.6', '>=0.2.1-rc.1', '', undefined, 42]) {
    const parsed = parseEnginesDsh(bad)
    assert.equal(parsed.error !== undefined, true, `应当拒绝：${String(bad)}`)
  }
})

test('parseEnginesDsh：build meta 不认（宿主 semver 场景里我们不用它）', () => {
  assert.notEqual(parseEnginesDsh('>=0.2.1-rc.1+build <0.2.1-rc.6').error, undefined)
})

test('compareSemver：数字段数值比较，无 pre 大于有 pre', () => {
  assert.equal(compareSemver('0.2.1', '0.2.1'), 0)
  assert.equal(compareSemver('0.2.1-rc.1', '0.2.1'), -1)
  assert.equal(compareSemver('0.2.2', '0.2.10'), -1)
  assert.equal(compareSemver('0.10.0', '0.9.0'), 1)
})

test('compareSemver：预发布标识符按 semver——数值低于字母，短的更小', () => {
  assert.equal(compareSemver('0.2.1-rc.5', '0.2.1-rc.6'), -1)
  assert.equal(compareSemver('0.2.1-rc.5-z', '0.2.1-rc.6'), 1, '字母标识符排在数值之后：rc.5-z > rc.6')
  assert.equal(compareSemver('0.2.1-rc.5.1', '0.2.1-rc.5'), 1, '标识符多一段的更大')
  assert.equal(compareSemver('0.2.1-alpha', '0.2.1-rc.1'), -1, '字母序：alpha < rc')
})

test('inRange：含下界、不含上界，边界值逐个钉死', () => {
  const parsed = parseEnginesDsh('>=0.2.1-rc.1 <0.2.1-rc.6')
  assert.equal(inRange(parsed, '0.2.1-rc.1'), true, '下界含')
  assert.equal(inRange(parsed, '0.2.1-rc.5'), true, '排他上界的 rc 前一个在')
  assert.equal(inRange(parsed, '0.2.1-rc.6'), false, '上界不含')
  assert.equal(inRange(parsed, '0.2.1'), false, '0.2.1 无 pre，大于 0.2.1-rc.6，被上界挡住')
  assert.equal(inRange(parsed, '0.2.1-rc.5-z'), false, '字母后缀越出 rc 线')
  assert.equal(inRange(parsed, '0.2.0'), false, '低于下界')
  assert.equal(inRange(parsed, 'not-a-version'), false, '非法版本串不在任何区间')
})

test('displayRange：rc 上界折算成「到前一个为止」，其余形状直说', () => {
  assert.equal(displayRange(parseEnginesDsh('>=0.2.1-rc.1 <0.2.1-rc.6')), '0.2.1-rc.1–0.2.1-rc.5')
  assert.equal(displayRange(parseEnginesDsh('>=0.2.1 <0.3.0')), '0.2.1 起 · 0.3.0 之前')
  assert.equal(displayRange(parseEnginesDsh('>=0.2.1-rc.2 <0.2.1-rc.2')), '0.2.1-rc.2 起 · 0.2.1-rc.2 之前', '空区间的 rc 上界（rc.1）不硬凑，直说')
})

test('declarationOf：读真实 package.json，形状齐', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const declared = declarationOf(pkg)
  assert.equal(declared.error, undefined)
  // 不钉具体区间值：扩区间只动 package.json 一处，测试跟着派生。
  // 但形状与成员关系必须成立——写歪的区间仍然红。
  const parsed = parseEnginesDsh(declared.enginesDsh)
  assert.equal(parsed.error, undefined, `engines.dsh 必须可解析为 ">=A <B"：${declared.enginesDsh}`)
  assert.equal(declared.tested, pkg.dsh.compatibility.tested)
  assert.equal(inRange(parsed, declared.tested), true, 'tested 必须落在区间内')
  // 防「危险扩宽」：上界核心段必须与 tested 核心段一致（挡住把 <0.2.2-rc.2 改成 <0.3.0 这类形状合法的越级扩宽）
  const coreOf = (version) => version.split('-')[0]
  assert.equal(coreOf(parsed.max), coreOf(declared.tested), `上界 ${parsed.max} 的核心段必须与 tested ${declared.tested} 同一条版本线`)
  assert.notEqual(parsed.max, declared.tested, '上界排他，不能等于 tested')
})

test('declarationOf：缺 engines.dsh、tested 出区间、坏元数据都给 error', () => {
  assert.match(String(declarationOf({}).error), /缺兼容声明/)
  const out = declarationOf({ engines: { dsh: '>=0.2.1-rc.1 <0.2.1-rc.6' }, dsh: { compatibility: { tested: '9.9.9', basis: 'source-level', verifiedAt: '2026-10-30', doc: 'docs/compatibility.md' } } })
  assert.match(String(out.error), /区间内/)
  const badShape = declarationOf({ engines: { dsh: 'lol' }, dsh: { compatibility: { tested: '0.2.1-rc.3', basis: 'source-level', verifiedAt: '2026-10-30', doc: 'docs/compatibility.md' } } })
  assert.match(String(badShape.error), /形状不认/)
  const badDate = declarationOf({ engines: { dsh: '>=0.2.1-rc.1 <0.2.1-rc.6' }, dsh: { compatibility: { tested: '0.2.1-rc.3', basis: 'source-level', verifiedAt: 'once upon a time', doc: 'docs/compatibility.md' } } })
  assert.match(String(badDate.error), /YYYY-MM-DD/)
})

test('basisLabel：两种既定口径直映射，未知值原样返回', () => {
  assert.equal(basisLabel('source-level'), '源码级核验')
  assert.equal(basisLabel('runtime'), '运行期验证')
  assert.equal(basisLabel('vibes'), 'vibes')
})
