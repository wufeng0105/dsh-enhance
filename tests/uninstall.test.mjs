/**
 * `uninstall.mjs` 的行级手术测试。
 *
 * 钉住两件事：
 *   - 摘完我们的行以后，剩下的东西一个字节不动；空 patch 要还原成 `[]`（宿主按顶层数组解析，
 *     空文件会直接被判非法）；
 *   - `disabled` 的归属判断只看 id 行下面那一块，不跨块误判。
 *
 * 官方 `fs-observation-policy` 一行都不动：它属于宿主，安装与卸载都不读不写。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __testing } from '../uninstall.mjs'
import { removeInsertRow } from '../shared/text-lines.mjs'

const { surgery, rowDisabled, defaultProfiles } = __testing

/** 一份装过本工具的 patch：一行别人的，加上我们的两行。 */
const installed = [
  '- id: other-plugin',
  '  config: {}',
  '',
  '# enhance: 内容边界（enhance-scope）、审批（auto-approve）、设置页（enhance-ui）。',
  '- insert:',
  '    - id: enhance-scope',
  "      name: '../../enhance/enhance-scope/index.js'",
  '    - id: enhance-ui',
  "      name: '../../enhance/ui/index.js'",
  '',
].join('\n')

/** 只装了我们这一层的 patch：摘完应当回到空数组。 */
const onlyOurs = [
  '# enhance: 内容边界（enhance-scope）、审批（auto-approve）、设置页（enhance-ui）。',
  '- insert:',
  '    - id: enhance-scope',
  "      name: '../../enhance/enhance-scope/index.js'",
  '    - id: enhance-ui',
  "      name: '../../enhance/ui/index.js'",
  '',
].join('\n')

/** 官方读后写行被停过的形态（我们从不碰这一行）。 */
const oldInstallWithOfficialOff = [
  '- id: fs-observation-policy',
  '  disabled: true',
  '',
  ...onlyOurs.split('\n'),
].join('\n')

test('surgery：摘干净后空 patch 还原成空数组标记', () => {
  const result = surgery(onlyOurs, {})
  assert.deepEqual(result.removed.sort(), ['enhance-scope', 'enhance-ui'])
  assert.deepEqual(result.restored, [])
  assert.equal(result.text.trim(), '[]')
})

test('surgery：别人的行原样保留', () => {
  const result = surgery(installed, {})
  assert.ok(result.text.includes('- id: other-plugin'))
  assert.ok(result.text.includes('  config: {}'))
  assert.ok(!result.text.includes('enhance-scope'))
})

test('surgery：官方 fs-observation-policy 一行都不动', () => {
  const result = surgery(oldInstallWithOfficialOff, {})
  assert.ok(result.text.includes('- id: fs-observation-policy'))
  assert.ok(result.text.includes('  disabled: true'))
  assert.ok(!result.restored.includes('fs-observation-policy'))
  assert.deepEqual(result.removed.sort(), ['enhance-scope', 'enhance-ui'])
})

test('surgery：没有我们的行时不动任何东西', () => {
  const text = '- id: only\n  config: {}\n'
  const result = surgery(text, {})
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.restored, [])
  assert.equal(result.text, text)
})

test('surgery：官方行没有我们动过的痕迹时，不谎报恢复', () => {
  const text = '- id: fs-observation-policy\n  disabled: true\n'
  const result = surgery(text, {})
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.restored, [])
  assert.equal(result.text, text)
})

test('rowDisabled：只看 id 行下面那一块', () => {
  assert.equal(rowDisabled('- id: ui-permission\n  disabled: true\n', 'ui-permission'), true)
  assert.equal(rowDisabled('- id: ui-permission\n  config: {}\n- id: other\n  disabled: true\n', 'ui-permission'), false)
  assert.equal(rowDisabled('- id: nothing\n', 'ui-permission'), false)
})

test('surgery：整行是我们加的，摘整行', () => {
  const result = surgery('- id: ui-permission\n  disabled: true\n', { uiPermissionAction: 'added' })
  assert.ok(result.restored.includes('ui-permission'))
  assert.equal(result.text.trim(), '[]')
})

test('surgery：官方的行是我们停的，只摘 disabled，保留行', () => {
  const text = '- id: ui-permission\n  disabled: true\n- id: keep\n  config: {}\n'
  const result = surgery(text, { uiPermissionAction: 'flipped' })
  assert.ok(result.restored.includes('ui-permission'))
  assert.ok(result.text.includes('- id: ui-permission'))
  assert.ok(!result.text.includes('disabled: true'))
  assert.ok(result.text.includes('- id: keep'))
})

test('removeInsertRow：块空了不留悬空 - insert:', () => {
  const lines = ['- id: keep', '', '- insert:', '    - id: x', '      name: y']
  assert.deepEqual(removeInsertRow(lines, 'x').lines, ['- id: keep'])
})

test('defaultProfiles：清单 → home 里实际存在的 → desktop', async () => {
  // `<home>/enhance` 是全局的，默认集漏一个 profile 就把它指到已删除的目录上
  const root = mkdtempSync(join(tmpdir(), 'enhance-uninstall-'))
  const bare = mkdtempSync(join(tmpdir(), 'enhance-uninstall-bare-'))
  try {
    mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    // 1. 清单记的优先（含 manifest 里还在、目录已不在的名字）
    assert.deepEqual(await defaultProfiles(root, { profiles: { web: {}, desktop: {}, gone: {} } }), ['desktop', 'gone', 'web'])
    // 2. 清单缺失/为空 → 当前 home 里存在的
    assert.deepEqual(await defaultProfiles(root, { profiles: {} }), ['desktop', 'web'])
    assert.deepEqual(await defaultProfiles(root, {}), ['desktop', 'web'])
    // 3. 两者都没有 → desktop
    assert.deepEqual(await defaultProfiles(bare, { profiles: {} }), ['desktop'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})
