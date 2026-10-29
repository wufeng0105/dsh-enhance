import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wirePermissions, ensureEnhancedPreset, removePermissionPreset } from '../shared/patch-rows.mjs'

/**
 * 宿主自带的 js-yaml —— **只在测试里**用来断言「写出来的文本宿主解析得了」。
 * 代码路径一律不 import 它（brief 的硬约束：只用宿主已带的做测试断言）。
 * 拿不到就返回 undefined，相关用例按 skip 处理，不让整套测试因为别的机器缺依赖而红。
 */
const hostYaml = (() => {
  const path = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app', 'node_modules', 'js-yaml')
  if (!existsSync(path)) return undefined
  try {
    return createRequire(join(tmpdir(), 'noop.cjs'))(path)
  } catch {
    return undefined
  }
})()

/** 宿主会不会整份拒绝这份 patch。返回 `'ok'` 或错误首行。 */
function parseWithHost(text) {
  if (hostYaml === undefined) return 'no-js-yaml'
  try {
    hostYaml.load(text)
    return 'ok'
  } catch (error) {
    return String(error?.message ?? error).split('\n')[0]
  }
}

/** 行首计数：同一层的 `presets:` 出现几次（重复就是宿主拒绝的形状）。 */
const presetsLines = (text) => (text.match(/^[ \t]*presets[ \t]*:/gm) ?? []).length

test('adds both rows to an empty patch', () => {
  const result = wirePermissions('[]\n')
  assert.equal(result.action, 'added')
  assert.ok(!result.text.includes('[]'))
  assert.match(result.text, /- id: ui-permission\n  disabled: true/)
  assert.match(result.text, /- insert:\n    - id: enhance-permissions/)
})

test('flips an existing enabled official row', () => {
  const input = '- id: ui-permission\n  config:\n    mode: ask\n'
  const result = wirePermissions(input)
  assert.equal(result.action, 'flipped')
  assert.match(result.text, /- id: ui-permission\n  disabled: true/)
  assert.equal((result.text.match(/- id: ui-permission/g) ?? []).length, 1)
})

test('is idempotent once wired', () => {
  const once = wirePermissions('[]\n')
  const twice = wirePermissions(once.text)
  assert.equal(twice.changed, undefined)
  assert.equal(twice.action, 'unchanged')
  assert.equal(twice.text, once.text)
})

test('preserves CRLF in inserted rows', () => {
  const result = wirePermissions('- id: other\r\n  disabled: true\r\n')
  assert.equal(result.action, 'added')
  assert.ok(result.text.includes('- id: ui-permission\r\n  disabled: true\r\n'))
  assert.ok(!/(?<!\r)\n/.test(result.text))
})

test('adds the whole preset table when there is no permission block', () => {
  const result = ensureEnhancedPreset('[]\n')
  assert.equal(result.action, 'added')
  assert.ok(!result.text.includes('[]'))
  assert.match(result.text, /danger-full-access:\n        sandbox: danger-full-access\n        approval: never/)
  assert.match(result.text, /enhanced:\n        sandbox: danger-full-access\n        approval: ask/)
  assert.match(result.text, /defaultPreset: enhanced/)
})

test('inserts only enhanced and defaults it when no default exists', () => {
  const input = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(input)
  assert.equal(result.action, 'inserted')
  assert.match(result.text, /enhanced:/)
  assert.match(result.text, /defaultPreset: enhanced/)
  assert.equal((result.text.match(/enhanced:/g) ?? []).length, 1)
})

test('does not override an existing default preset', () => {
  const input = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        approval: ask',
    '    defaultPreset: danger-full-access',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(input)
  assert.equal(result.action, 'inserted')
  assert.match(result.text, /defaultPreset: danger-full-access/)
  assert.doesNotMatch(result.text, /defaultPreset: enhanced/)
})

test('is idempotent when enhanced already exists', () => {
  const once = ensureEnhancedPreset('[]\n')
  const twice = ensureEnhancedPreset(once.text)
  assert.equal(twice.action, 'unchanged')
  assert.equal(twice.text, once.text)
})

/** 行首计数：只看真正的键，`# defaultPreset:` 之类的注释不算。 */
const defaultPresetLines = (text) => (text.match(/^[ \t]*defaultPreset:/gm) ?? []).length

test('does not duplicate defaultPreset when it precedes presets', () => {
  // 按字母序生成配置的工具会把 defaultPreset 排到 presets 前面：第二个同名键会让整份 patch
  // 在宿主那边解析失败（duplicated mapping key），而 doctor 不看这个。
  const input = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    defaultPreset: read-only',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(input)
  assert.equal(result.action, 'inserted')
  assert.equal(result.defaultAction, 'kept')
  assert.equal(defaultPresetLines(result.text), 1)
  assert.match(result.text, /defaultPreset: read-only/)
  assert.match(result.text, /enhanced:\n        sandbox: danger-full-access\n        approval: ask/)
  assert.doesNotMatch(result.text, /defaultPreset: enhanced/)
})

test('does not duplicate defaultPreset when config has no presets', () => {
  const input = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    defaultPreset: read-only',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(input)
  assert.equal(result.action, 'inserted')
  assert.equal(result.defaultAction, 'kept')
  assert.equal(defaultPresetLines(result.text), 1)
  assert.match(result.text, /defaultPreset: read-only/)
  assert.match(result.text, /presets:\n      enhanced:/)
  assert.doesNotMatch(result.text, /defaultPreset: enhanced/)
})

test('a bare defaultPreset outside config is not duplicated either', () => {
  const input = [
    '- id: permission',
    '  defaultPreset: read-only',
    '',
  ].join('\n')
  const result = ensureEnhancedPreset(input)
  assert.equal(result.action, 'inserted')
  assert.equal(defaultPresetLines(result.text), 1)
  assert.match(result.text, /enhanced:/)
  assert.doesNotMatch(result.text, /defaultPreset: enhanced/)
})

test('every key order ends with exactly one defaultPreset', () => {
  for (const input of [
    '- id: permission\n  config:\n    presets:\n      read-only:\n        approval: ask\n',
    '- id: permission\n  config:\n    defaultPreset: read-only\n    presets:\n      read-only:\n        approval: ask\n',
    '- id: permission\n  config:\n    presets:\n      read-only:\n        approval: ask\n    defaultPreset: read-only\n',
    '- id: permission\n  config:\n    defaultPreset: read-only\n',
    '- id: permission\n  defaultPreset: read-only\n',
  ]) {
    const once = ensureEnhancedPreset(input)
    assert.equal(defaultPresetLines(once.text), 1, input)
    assert.match(once.text, /enhanced:/, input)
    const twice = ensureEnhancedPreset(once.text)
    assert.equal(twice.changed, undefined, input)
    assert.equal(defaultPresetLines(twice.text), 1, input)
  }
})

test('keeps CRLF when inserting enhanced into an existing block', () => {
  const input = [
    '- id: permission',
    '  config:',
    '    presets:',
    '      read-only:',
    '        approval: ask',
    '',
  ].join('\r\n')
  const result = ensureEnhancedPreset(input)
  assert.ok(result.text.includes('enhanced:\r\n'))
  assert.ok(result.text.includes('defaultPreset: enhanced'))
  assert.ok(!/(?<!\r)\n/.test(result.text))
})

// ------------------------------------------------------------------ flow 风格 presets

/**
 * flow 风格的 `presets` 是**同一行**写完整张映射。旧实现只认块风格（`presets:` 行尾为空），
 * 于是在 `config:` 下面又插了一个块风格 `presets:` —— 同一层两个同名键，宿主
 * `duplicated mapping key` 整份拒绝。下面每条都用宿主自带的 js-yaml 断言解析得了。
 */
const FLOW_CASES = [
  ['空 flow 映射', '    presets: {}\n'],
  ['带内容的 flow 映射', '    presets: {read-only: {}}\n'],
  ['flow 映射 + 行尾注释', '    presets: {}  # 保留这一行\n'],
  ['flow 映射带多个档位', '    presets: {read-only: {}, workspace-write: {sandbox: workspace-write}}\n'],
]

for (const [label, presetsLine] of FLOW_CASES) {
  test(`flow presets：${label} -> 改写那一行，同层 presets 只 1 次且可解析`, (t) => {
    if (hostYaml === undefined) return t.skip('本机没有宿主自带的 js-yaml')
    const input = `- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n  config:\n${presetsLine}    defaultPreset: read-only\n`
    const result = ensureEnhancedPreset(input)
    assert.equal(result.error, undefined, `不该拒绝：${result.error}`)
    assert.equal(result.action, 'inserted')
    assert.equal(presetsLines(result.text), 1, `同层 presets 只该有 1 个：\n${result.text}`)
    assert.equal(parseWithHost(result.text), 'ok', `宿主解析失败：\n${result.text}`)
    assert.match(result.text, /enhanced: \{[^}]*sandbox: danger-full-access[^}]*approval: ask/)
    // 原默认档位保留，不被顶掉
    assert.match(result.text, /defaultPreset: read-only/)
    // 幂等
    const twice = ensureEnhancedPreset(result.text)
    assert.equal(twice.changed, undefined)
    assert.equal(presetsLines(twice.text), 1)
  })
}

test('flow presets：已含 enhanced 时 unchanged（不分块/flow 两种写法）', () => {
  const input = '- id: permission\n  config:\n    presets: {enhanced: {sandbox: danger-full-access, approval: ask}}\n    defaultPreset: enhanced\n'
  const result = ensureEnhancedPreset(input)
  assert.equal(result.changed, undefined)
  assert.equal(result.action, 'unchanged')
  assert.equal(result.text, input)
  assert.equal(presetsLines(result.text), 1)
})

test('flow presets：没有 defaultPreset 时补一条，仍然只 1 个 presets', (t) => {
  if (hostYaml === undefined) return t.skip('本机没有宿主自带的 js-yaml')
  const input = '- id: permission\n  config:\n    presets: {}\n'
  const result = ensureEnhancedPreset(input)
  assert.equal(result.defaultAction, 'added')
  assert.equal((result.text.match(/^[ \t]*defaultPreset:/gm) ?? []).length, 1)
  assert.equal(presetsLines(result.text), 1)
  assert.equal(parseWithHost(result.text), 'ok', result.text)
})

test('flow presets：卸载把那一条摘回去，逐字节回到安装前', (t) => {
  if (hostYaml === undefined) return t.skip('本机没有宿主自带的 js-yaml')
  for (const [, presetsLine] of FLOW_CASES) {
    const input = `- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n  config:\n${presetsLine}    defaultPreset: read-only\n`
    const installed = ensureEnhancedPreset(input)
    assert.equal(installed.error, undefined)
    const back = removePermissionPreset(installed.text, installed.action, installed.defaultAction === 'added')
    assert.equal(back.text, input, `没回到原样：\n${back.text}`)
    assert.equal(presetsLines(back.text), 1)
    assert.equal(parseWithHost(back.text), 'ok', back.text)
  }
})

/**
 * 认不出安全改法时必须**返回 error**，而不是写一份宿主拒绝的 patch。
 * 这三条是「宁可拒绝也不写坏」的负例：旧实现三个输入都会吐出一个重复键的文本。
 */
const UNSAFE_CASES = [
  ['多行 flow（闭括号在下一行）', '- id: permission\n  config:\n    presets: {\n      read-only: {}\n    }\n'],
  ['presets 的值不是映射', '- id: permission\n  config:\n    presets: read-only\n'],
  ['config 自己也是 flow 风格', '- id: permission\n  config: {presets: {}, defaultPreset: read-only}\n'],
]

for (const [label, input] of UNSAFE_CASES) {
  test(`flow presets：${label} -> 返回 error，不返回会写坏的文本`, () => {
    const result = ensureEnhancedPreset(input)
    assert.equal(typeof result.error, 'string', `应当拒绝：${JSON.stringify(result)}`)
    assert.ok(result.error.length > 0)
    // 拒绝时 text 就是原文：调用方拿到的任何字段都不该是一份新文本
    assert.equal(result.text, input)
    assert.equal(result.changed, undefined)
  })
}

test('flow presets：解析一次就够——拒绝路径的输出宿主本来就能解析（没被我们动过）', (t) => {
  if (hostYaml === undefined) return t.skip('本机没有宿主自带的 js-yaml')
  for (const [, input] of UNSAFE_CASES) {
    // 拒绝的价值在于「原样保留」：输入本身必须是合法的，否则拒绝也没意义
    assert.equal(parseWithHost(input), 'ok', `输入本该能解析：\n${input}`)
  }
})
