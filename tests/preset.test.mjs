/**
 * `shared/preset.mjs` 的契约测试。
 *
 * 这一组钉的是「写档敢不敢动用户配置」这件事：
 *   - 无 permission 行 → 追加**完整**档位表（少一条就是把用户的一个档位删了）；
 *   - 有 permission 行 → 只插 `enhanced`（patch 里的键名，小写；档位在用户面前叫
 *     **Enhanced 档**，两处并存是有意的），用户已有的档位与 defaultPreset 一个字节不动；
 *   - flow 风格 → 改写那一行，不在下面再插一个同层 `presets:`（重复键，宿主整份拒绝）；
 *   - 认不出安全改法 → 拒绝，不返回可能写坏的文本；
 *   - 幂等、CRLF 保持、摘除逐字节还原、没有归属记录时不猜；坏记录当没有记录，不抛也不顺手改掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BASE_PRESETS, ENHANCED_NAME, ENHANCED_SPEC,
  clearPresetRecord, ensureEnhancedPreset, readPresetRecord, readPresetState,
  removeEnhancedPreset, writePresetRecord,
} from '../shared/preset.mjs'

/** 一个只有注释和空数组的 patch（新 profile 的默认形态）。 */
const EMPTY_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '[]',
  '',
].join('\n')

test('空 patch：追加完整档位表（三档 + enhanced），一条都不少', () => {
  const result = ensureEnhancedPreset(EMPTY_PATCH)
  assert.equal(result.action, 'added')
  assert.equal(result.emptyArray, true)
  assert.match(result.text, /- id: permission/)
  assert.match(result.text, /name: "@deepseek-ai\/dsh-permission-presets"/)

  const state = readPresetState(result.text)
  assert.deepEqual(state.presets, ['read-only', 'workspace-write', 'danger-full-access', ENHANCED_NAME])
  assert.equal(state.present, true)
  // 不写 defaultPreset：本工具不改用户的默认档位
  assert.equal(state.defaultPreset, null)
  // 原有的注释行要留着
  assert.match(result.text, /^# Your patch layer/)
})

test('完整档位表的三档与宿主基础组合包一致（read-only/write=ask，full=never）', () => {
  const result = ensureEnhancedPreset('[]\n')
  for (const preset of BASE_PRESETS) {
    assert.match(result.text, new RegExp(`${preset.name}:\\n\\s+sandbox: ${preset.sandbox}\\n\\s+approval: ${preset.approval}`))
  }
  assert.match(result.text, new RegExp(`enhanced:\\n\\s+sandbox: ${ENHANCED_SPEC.sandbox}\\n\\s+approval: ${ENHANCED_SPEC.approval}`))
})

test('幂等：连写两次，第二次 unchanged 且逐字节相同', () => {
  const once = ensureEnhancedPreset('[]\n')
  const twice = ensureEnhancedPreset(once.text)
  assert.equal(twice.action, 'unchanged')
  assert.equal(twice.text, once.text)
})

test('已有 permission 行：只插 enhanced，用户档位与 defaultPreset 不动', () => {
  const patch = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      my-own:',
    '        sandbox: workspace-write',
    '        approval: never',
    '    defaultPreset: my-own',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(patch)
  assert.equal(result.action, 'inserted')
  const state = readPresetState(result.text)
  assert.deepEqual(state.presets, ['read-only', 'my-own', ENHANCED_NAME])
  assert.equal(state.defaultPreset, 'my-own', '用户的默认档位不许被改')
  // 用户那条的语义逐字保留
  assert.match(result.text, /my-own:\n\s+sandbox: workspace-write\n\s+approval: never/)
})

test('flow 风格 presets：改写那一行，不在下面再插同层 presets', () => {
  const patch = [
    '- id: permission',
    '  config:',
    '    presets: {read-only: {sandbox: read-only, approval: ask}}',
    '    defaultPreset: read-only',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(patch)
  assert.equal(result.action, 'inserted')
  const state = readPresetState(result.text)
  assert.deepEqual(state.presets, ['read-only', ENHANCED_NAME])
  assert.equal(state.defaultPreset, 'read-only')
  // 只有一个 presets: 行
  assert.equal(result.text.match(/^[ \t]*presets:/gm).length, 1)
})

test('空的 flow 映射 presets: {} 也能写进去', () => {
  const patch = ['- id: permission', '  config:', '    presets: {}', ''].join('\n')
  const result = ensureEnhancedPreset(patch)
  const state = readPresetState(result.text)
  assert.deepEqual(state.presets, [ENHANCED_NAME])
})

test('认不出安全改法就拒绝：多行 flow 不猜', () => {
  const patch = [
    '- id: permission',
    '  config:',
    '    presets: {read-only: {sandbox: read-only,',
    '      approval: ask}}',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(patch)
  assert.equal(result.text, patch, '拒绝时一个字节都不能变')
  assert.equal(typeof result.error, 'string')
  assert.match(result.error, /多行|认不出|跨了多行/)
})

test('认不出安全改法就拒绝：presets 的值不是映射', () => {
  const patch = ['- id: permission', '  config:', '    presets: null', ''].join('\n')
  const result = ensureEnhancedPreset(patch)
  assert.equal(result.text, patch)
  assert.match(String(result.error), /不是映射/)
})

test('CRLF 的 patch 写回还是 CRLF', () => {
  const patch = ['- id: permission', '  config:', '    presets:', '      read-only:', '        sandbox: read-only', '        approval: ask', ''].join('\r\n')
  const result = ensureEnhancedPreset(patch)
  assert.ok(result.text.includes('\r\n'), '换行不能被改成 LF')
  assert.ok(!/[^\r]\n/.test(result.text), '不能出现落单的 LF')
})

test('摘除：整行是我们追加的 → 整行摘掉并还回 []', () => {
  const added = ensureEnhancedPreset(EMPTY_PATCH)
  const removed = removeEnhancedPreset(added.text, { action: 'added', emptyArray: true, original: EMPTY_PATCH })
  assert.equal(removed.changed !== undefined, true)
  assert.equal(removed.text, EMPTY_PATCH, '有原文时应当逐字节还原（含注释头）')
})

test('摘除：记录里没有原文时，退到只摘 enhanced 三行（不猜整行归属）', () => {
  const added = ensureEnhancedPreset(EMPTY_PATCH)
  const removed = removeEnhancedPreset(added.text, { action: 'added', emptyArray: true })
  assert.ok(!removed.text.includes('enhanced:'), 'enhanced 必须摘掉')
  assert.ok(removed.text.includes('- id: permission'), '没有原文就不知道整行归属，宁可留下它')
  assert.ok(!removed.text.includes('sandbox: danger-full-access\n        approval: ask'), '三行一起摘，不能留下半条')
})

test('摘除：写完之后用户又改了别处 → 不整行摘，只摘 enhanced，用户的改动留着', () => {
  const added = ensureEnhancedPreset(EMPTY_PATCH)
  const edited = `${added.text}# 用户后加的一行注释\n`
  const removed = removeEnhancedPreset(edited, { action: 'added', emptyArray: true, original: EMPTY_PATCH })
  assert.ok(removed.text.includes('用户后加的一行注释'), '用户的改动不许被原文整体覆盖掉')
  assert.ok(!removed.text.includes('enhanced:'), '我们的那一档仍要摘掉')
  assert.ok(removed.text.includes('- id: permission'), '整行归属不明时只摘自己写的那三行')
})

test('摘除：只插过 enhanced → 逐字节回到原文', () => {
  const patch = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '    defaultPreset: read-only',
    '',
  ].join('\n')
  const added = ensureEnhancedPreset(patch)
  const removed = removeEnhancedPreset(added.text, { action: 'inserted' })
  assert.equal(removed.text, patch, '摘完必须逐字节等于写前')
})

test('摘除：flow 风格摘完也回到原文', () => {
  const patch = ['- id: permission', '  config:', '    presets: {read-only: {sandbox: read-only, approval: ask}}', '    defaultPreset: read-only', ''].join('\n')
  const added = ensureEnhancedPreset(patch)
  const removed = removeEnhancedPreset(added.text, { action: 'inserted' })
  assert.equal(removed.text, patch)
})

test('摘除：没有归属记录就拒绝（不猜）', () => {
  const added = ensureEnhancedPreset('[]\n')
  const removed = removeEnhancedPreset(added.text, undefined)
  assert.equal(removed.text, added.text)
  assert.match(String(removed.error), /记录|手工/)
})

test('readPresetState：没有 permission 行时也给出一致的空状态', () => {
  const state = readPresetState('[]\n')
  assert.equal(state.hasPermissionRow, false)
  assert.equal(state.present, false)
  assert.equal(state.unreadable, false)
  assert.deepEqual(state.presets, [])
})

test('归属记录：写得出、读得回、清得掉', () => {
  const home = mkdtempSync(join(tmpdir(), 'enhance-preset-record-'))
  try {
    const paths = { dir: join(home, 'enhance') }
    const record = { patchPath: 'C:/x/profiles/desktop/cordis.patch.yml', profile: 'desktop', action: 'added', emptyArray: true, writtenAt: '2026-10-30T00:00:00.000Z' }
    writePresetRecord(paths, record)
    assert.deepEqual(readPresetRecord(paths), record)
    clearPresetRecord(paths)
    assert.equal(readPresetRecord(paths), undefined)
    // 清第二次不抛
    clearPresetRecord(paths)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('归属记录：坏 JSON 当没有记录处理，不抛', () => {
  const home = mkdtempSync(join(tmpdir(), 'enhance-preset-record-bad-'))
  try {
    const paths = { dir: join(home, 'enhance') }
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(join(paths.dir, 'preset-write.json'), '{not json', 'utf8')
    assert.equal(readPresetRecord(paths), undefined, '坏记录当没有记录，不能抛')
    assert.equal(readFileSync(join(paths.dir, 'preset-write.json'), 'utf8'), '{not json', '坏记录不许被顺手改掉')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
