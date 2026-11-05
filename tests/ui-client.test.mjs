/**
 * 设置页（`ui/client.js`）的测试。
 *
 * 两层：
 *   1. 行为断言 —— 装载、注册、首帧、`call` 的 ok:false 语义。这些是契约，不随文案变。
 *   2. 意图断言 —— 四组结构（内容边界 / 越界审批 / Enhanced 权限档 / 检查）、开关档
 *      `approval` 的三态语义、检查项映射、Enhanced 档四种状态、就地错误行、字节口径、
 *      CSS 守卫、以及「按宿主设置页刻度排版」这件事本身（16/24 标题、14/22 行标题、
 *      0.5px 发丝线、12px 节间距、720 上限宽、焦点环走宿主 token）。
 *
 * 两个 Enhanced 名分属两个标签位，都锁着：检查项叫 **Enhanced 档**，设置组叫 **Enhanced 权限档**。
 *
 * 浏览器里没有 Node 测试跑得了它，但它在浏览器里做的事只有两件：注册 `settings.section`，
 * 组件首帧不抛且只发一次 `state`。这两件都能用一个假 `window.__ModuleLoader__` + 假 react 验掉。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'ui', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/** 假 React：`createElement` 造树，`useState`/`useEffect` 按调用顺序给出稳定槽位。 */
function fakeReact() {
  const slots = []
  let cursor = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = cursor++
      if (slots[index] === undefined) {
        slots[index] = [typeof initial === 'function' ? initial() : initial, (next) => {
          slots[index][0] = typeof next === 'function' ? next(slots[index][0]) : next
        }]
      }
      return slots[index]
    },
    useEffect(run) {
      const index = cursor++
      if (slots[index] === undefined) {
        slots[index] = true
        run()
      }
    },
    /** 假 React 不会在 setState 后自己重渲染：测试要取「落地后的树」时先归零 hook 游标再调一次。 */
    reset() { cursor = 0 },
  }
}

/** 把 bundle 装进一个假装载器，返回它导出的模块。 */
function loadBundle() {
  let spec
  let react
  const window = { __ModuleLoader__: { load(captured) { spec = captured } } }
  // eslint-disable-next-line no-new-func -- 就是要在沙箱里跑这段浏览器代码
  const run = new Function('window', source)
  run(window)
  assert.ok(spec !== undefined, 'bundle 没有调用 window.__ModuleLoader__.load')
  const require = (name) => {
    if (name === 'react') { react = fakeReact(); return react }
    throw new Error(`unexpected require: ${name}`)
  }
  const module = spec.factory(require)
  module.__react = react
  return module
}

/** 一次典型的 snapshot：字段与 `enhance-scope/index.js` 的 snapshot() 对齐。 */
const SNAPSHOT = {
  ok: true,
  version: 4,
  active: true,
  enabled: true,
  injecting: true,
  reason: null,
  contentScope: true,
  approval: 'ask',
  text: 'hello',
  bytes: 5,
  sha256: 'abc123def456',
  identity: 'keep',
  hideHarness: false,
  identityText: '',
  identityBytes: 0,
  identitySha256: null,
  identityLimit: 2048,
  identityEffective: {
    mode: 'keep',
    degraded: false,
    reason: null,
    preview: 'You are an AI agent powered by DeepSeek Harness.',
  },
  identityInstall: {
    state: 'installed',
    ok: true,
    reason: null,
    text: '已接上：1 个 agent 作用域可用；当前「保留」，没有要遮蔽的段。',
    agents: 1,
    installed: 1,
    scoped: 1,
    shadowed: 0,
  },
  updatedAt: '2026-10-28T14:32:00.000Z',
  degraded: false,
  degradedReason: null,
  degradedFields: [],
  home: 'C:/x',
  limit: 8192,
  compat: {
    tool: '1.1.0',
    host: '0.2.1-rc.3',
    source: 'env',
    range: '0.2.1-rc.1–0.2.2-rc.1',
    tested: '0.2.1-rc.3',
    inRange: true,
  },
  preset: {
    patchPath: 'C:/x/profiles/desktop/cordis.patch.yml',
    profile: 'desktop',
    source: 'profileContext',
    present: false,
    unreadable: false,
    unreadableReason: null,
    presets: [],
    defaultPreset: null,
    recorded: false,
    writtenAt: null,
    reason: null,
  },
}

// ───────────────────────────────────────────── 行为断言（不动）

test('客户端半：注册 settings.section，id 与顺序固定', () => {
  const module = loadBundle()
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots'])

  const registered = []
  const ctx = {
    slots: {
      inject(name, run) {
        assert.equal(name, 'settings.section')
        return run()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].spec.name, 'settings.section')
  assert.equal(registered[0].spec.id, 'enhance')
  assert.equal(registered[0].spec.order, 30)
  assert.equal(typeof registered[0].spec.label, 'function')
  assert.equal(registered[0].spec.label(), '增强')
  assert.equal(typeof registered[0].component, 'function')
})

test('客户端半：首帧不抛，且只打一次 state', async () => {
  const module = loadBundle()
  let component
  module.apply({
    slots: {
      inject: (_name, run) => run(),
      register: (_spec, registered) => {
        component = registered
        return () => {}
      },
    },
  })

  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => SNAPSHOT }
  }

  const tree = component({})
  assert.equal(typeof tree, 'object')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/enhance/api')
  assert.equal(calls[0].body.op, 'state')

  await new Promise((resolve) => setImmediate(resolve))
  delete globalThis.fetch
})

test('call：check 的 ok=false 是结果不是错误（不能再报 HTTP 200）', async () => {
  const module = loadBundle()
  const call = module.__testing.call
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, checks: [{ name: 'inject', pass: false, detail: 'x' }] }) })
  const result = await call({ op: 'check' })
  assert.equal(result.ok, false)
  assert.equal(result.checks.length, 1)
  delete globalThis.fetch
})

test('call：HTTP 层失败与结构化错误都要抛', async () => {
  const module = loadBundle()
  const call = module.__testing.call

  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, code: 'EIO', message: 'write failed' }) })
  await assert.rejects(() => call({ op: 'set' }), (error) => error.code === 'EIO' && /write failed/.test(error.message))

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, code: 'EBADOP', message: 'unknown field: x' }) })
  await assert.rejects(() => call({ op: 'set' }), (error) => error.code === 'EBADOP')

  delete globalThis.fetch
})

// ───────────────────────────────────────────── 结构

test('结构：五组按顺序排列（品牌人设 → 内容边界 → 越界审批 → Enhanced → 检查）', () => {
  const ids = ['enh-block-identity', 'enh-block-scope', 'enh-block-approval', 'enh-block-preset', 'enh-block-check']
  const at = ids.map((id) => source.indexOf(`"${id}"`))
  at.forEach((index, i) => assert.ok(index >= 0, `缺组：${ids[i]}`))
  assert.deepEqual(at, [...at].sort((a, b) => a - b), '五组的顺序变了')

  // 品牌人设必须排在内容边界之前：它管系统提示的第一句，内容边界管末尾
  assert.ok(at[0] < at[1], '品牌人设应排在内容边界之前')

  // 第 3 组的切片里两个名字各出现一次：组标题「越界审批」与控件标签「越界时怎么办」。
  // 断言只要求「标题串出现在切片里」，所以只改其中一处时测试仍会绿（弱锁）；
  // 把两处都改掉才会红。别为了「统一」把控件标签也改成「越界审批」。
  const titles = ['品牌人设', '内容边界', '越界审批', 'Enhanced 权限档', '检查']
  titles.forEach((title, i) => {
    const slice = source.slice(at[i], i + 1 < at.length ? at[i + 1] : source.length)
    assert.ok(slice.includes(title), `第 ${i + 1} 组的标题不对：缺「${title}」`)
  })
})

test('结构：头部是 h2 + 状态标签 + 页级总开关，没有旧的结论句/元信息/横幅', () => {
  assert.ok(source.includes('className: "enh-title"'), '缺页面标题')
  assert.ok(source.includes('h("h2", { className: "enh-title" }'), '标题应当是 h2（宿主分节标题的层级）')
  assert.ok(source.includes('"总开关"'), '缺页级总开关')
  assert.ok(source.includes('className: "enh-pill"'), '缺状态标签')

  // 用户明确要求删掉的东西，一个字都不许回来
  for (const gone of ['现在会怎么做事', '升级与卸载', '格式 v', '最后改动', '当前会话在哪个档', 'enh-rail', 'enh-banner', 'enh-verdict']) {
    assert.ok(!source.includes(gone), `残留了已删除的内容：${gone}`)
  }
})

test('结构：越界审批组的最后一行是适用范围说明（宿主中文档名）', () => {
  const groupAt = source.indexOf('"enh-block-approval"')
  const nextGroupAt = source.indexOf('"enh-block-preset"')
  assert.ok(groupAt > 0 && nextGroupAt > groupAt, '找不到越界审批组')
  const block = source.slice(groupAt, nextGroupAt)

  assert.ok(block.includes('APPROVAL_SCOPE_HINT'), '该组的后果行里应带上适用范围常量')
  const hintAt = source.indexOf('var APPROVAL_SCOPE_HINT')
  assert.ok(hintAt > 0, '缺适用范围常量')
  const hint = source.slice(hintAt, source.indexOf('\n', hintAt))
  // 档名必须用宿主中文菜单的叫法（client_locales：仅可查看 / 工作区内修改 / 完全权限）
  for (const word of ['仅可查看', '工作区内修改', '完全权限', 'Enhanced']) {
    assert.ok(hint.includes(word), `适用范围必须点名「${word}」`)
  }
  assert.match(hint, /不会产生需要审批的请求/, '要说明全开档下为什么用不上')
})
test('结构：四组的说明都走 .enh-note，且每组至多一行后果 + 需要时的额外说明', () => {
  const noteCount = (source.match(/className: "enh-note"/g) ?? []).length
  assert.equal(noteCount, 1, '说明行只有一处实现（group() 里统一渲染）')
  assert.ok(source.includes('notes || []'), 'group() 应接受说明数组')
})

// ───────────────────────────────────────────── 语义

test('结论：Enhanced 档四种状态各自说对话，且只在能做事的两种状态给按钮', () => {
  const { presetStatusOf } = loadBundle().__testing

  // 四态 = 不可用 / 改不动 / 已写入 / 未写入；`null` 快照另有一条前置回落 unknown。
  assert.deepEqual(presetStatusOf(null), { kind: 'unknown', word: '—', tone: 'mute' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: null } }), { kind: 'noprofile', word: '不可用', tone: 'mute' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: 'C:/p/x.yml', unreadable: true } }), { kind: 'unreadable', word: '改不动', tone: 'bad' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: 'C:/p/x.yml', present: true } }), { kind: 'written', word: '已写入', tone: 'ok' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: 'C:/p/x.yml', present: false } }), { kind: 'absent', word: '未写入', tone: 'mute' })

  assert.match(source, /presetStatus\.kind === "absent"/, '缺「未写入」才给写入按钮的分支')
  assert.match(source, /presetStatus\.kind === "written"/, '缺「已写入」才给移除按钮的分支')
  assert.ok(source.includes('写入 Enhanced 档'), '缺写入按钮文案')
  assert.ok(source.includes('移除 Enhanced 档'), '缺移除按钮文案')
  assert.ok(source.includes('再点一次确认移除'), '移除缺少二次确认')
  assert.ok(source.includes('action: "add"') && source.includes('action: "remove"'), '缺 preset op 的两种动作')

  // Enhanced 权限档那一节只留「用户确认过的那一句话」+ 右上状态 + 按钮 + 折叠区；
  // 其余解释性句子（档位归属、图标契约、写入后的路径说明）已按用户要求删除。
  assert.ok(source.includes('档位菜单里可以通过 profile 增加一个「全开沙箱、保留审批」的可选档'), '缺 03 的副行')
  for (const gone of ['当前用哪个档仍由菜单决定', '没有图标', '已写进 profile', '显示契约']) {
    assert.ok(!source.includes(gone), `03 节又长回去了：${gone}`)
  }
})

test('检查节：四项以 API 的 name 为键、标题是本地映射、pass 一律取服务端值', () => {
  const { checkRows } = loadBundle().__testing
  const rows = checkRows({
    ok: false,
    checks: [
      { name: 'plugins', pass: true, detail: 'enhance-scope=在 · auto-approve=在' },
      { name: 'text', pass: false, detail: '9000 B / 上限 8192 B' },
      { name: 'inject', pass: false, detail: '会话里没有这段文本' },
      { name: 'preset', pass: true, na: true, detail: '未写入（在「Enhanced 权限档」一节点一下写入）' },
    ],
  })
  assert.deepEqual(rows.map((r) => r.key), ['plugins', 'text', 'inject', 'preset'])
  assert.deepEqual(rows.map((r) => r.title), ['插件在进程里', '文字合规', '真的进了系统提示', 'Enhanced 档'])
  // 关键：pass / na 来自服务端，页面不伪造通过
  assert.deepEqual(rows.map((r) => r.pass), [true, false, false, true])
  assert.deepEqual(rows.map((r) => r.na), [false, false, false, true])
  assert.equal(rows[1].detail, '9000 B / 上限 8192 B')

  // 未知 name 不吞掉，原样显示；缺 checks 时返回空数组
  assert.equal(checkRows({ checks: [{ name: 'future', pass: false, detail: '' }] })[0].title, 'future')
  assert.deepEqual(checkRows(null), [])
})

test('审批三档：radiogroup + radio + aria-checked + roving tabindex + 方向键', () => {
  // 抽取组件后 role/aria 落在组件定义里，所以按「组件定义里有没有」查，不按调用点写法查。
  assert.ok(source.includes('role: "radiogroup"'), '缺 role=radiogroup')
  assert.ok(source.includes('role: "radio"'), '缺 role=radio')
  assert.ok(source.includes('"aria-checked": props.checked === true'), '缺 aria-checked')
  assert.ok(source.includes('tabIndex: props.checked === true ? 0 : -1'), '缺 roving tabindex（整组不该都能 Tab 到）')
  assert.ok(source.includes('ArrowRight') && source.includes('ArrowLeft'), '缺方向键处理')
  // 旧的 <select> 必须已经不在
  assert.ok(!/h\("select"/.test(source), '还在用 <select> 做三档')
})

test('APG：方向键四个方向都处理，且两端回绕', () => {
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
    assert.ok(source.includes(key), `缺 ${key}：APG 要求 Right/Down 前进、Left/Up 后退`)
  }
  assert.ok(/\(at \+ 1\) % APPROVAL_ORDER\.length/.test(source), '前进方向必须取模回绕')
  assert.ok(/\(at \+ APPROVAL_ORDER\.length - 1\) % APPROVAL_ORDER\.length/.test(source), '后退方向必须取模回绕')
})

test('审批词随三档变化，且用的是与档位菜单错开的词', () => {
  const { approvalOf } = loadBundle().__testing
  assert.equal(approvalOf('allow').word, '自动同意')
  assert.equal(approvalOf('deny').word, '自动回绝')
  assert.equal(approvalOf('ask').word, '先问我')
  // 未知值回落到 ask，不抛
  assert.equal(approvalOf('nonsense').word, '先问我')
})

// ───────────────────────────────────────────── 样式与规范

test('按钮：禁用态的样式必须排在 data-kind 之后（否则禁用仍显示危险色）', () => {
  const disabled = source.indexOf('.enh-btn:disabled,.enh-btn[data-kind]:disabled')
  const danger = source.indexOf('.enh-btn[data-kind=danger]')
  assert.ok(disabled > 0, '缺禁用态覆盖规则')
  assert.ok(danger > 0, '缺 danger 变体')
  assert.ok(disabled > danger, '禁用态规则必须写在 data-kind 之后，同特异性下后写的赢')
})

test('焦点可见：所有可交互元素都有 :focus-visible 焦点环，且用宿主 token', () => {
  for (const cls of ['.enh-btn', '.enh-switch', '.enh-seg-btn', '.enh-textarea', '.enh-term>summary']) {
    assert.ok(source.includes(`${cls}:focus-visible`), `缺 ${cls} 的 focus-visible`)
  }
  const at = source.indexOf('.enh-btn:focus-visible')
  const rule = source.slice(at, at + 400)
  assert.ok(rule.includes('--dsw-focus-ring-width'), '焦点环宽度应走宿主 token')
  assert.ok(rule.includes('--dsw-focus-ring-color'), '焦点环颜色应走宿主 token')
  assert.ok(rule.includes('outline-offset:2px'), '焦点环要有偏移，别贴着边框')
  assert.ok(!/outline:\s*none/.test(source), '不许出现 outline:none（会吃掉键盘焦点）')
})

test('减少动效：prefers-reduced-motion 下关掉过渡', () => {
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/, '缺 prefers-reduced-motion 分支')
  const at = source.indexOf('@media (prefers-reduced-motion: reduce)')
  const block = source.slice(at, at + 200)
  assert.match(block, /transition:none/, '该分支里应把过渡关掉')
  // 不许 transition: all
  assert.ok(!/transition:\s*all/.test(source), 'transition: all 会连带布局属性，列具体属性')
})

test('排版：按宿主设置页的刻度（16/24 标题、14/22 行标题、12/18 辅助）', () => {
  assert.match(source, /\.enh-title\{[^}]*font-size:16px;line-height:24px;font-weight:500/, '页面标题应是 16/24 500')
  assert.match(source, /\.enh-h3\{[^}]*font-size:14px;line-height:22px/, '行标题应是 14/22')
  assert.match(source, /\.enh-hint\{[^}]*font-size:12px;line-height:18px/, '辅助文字应是 12/18')
  assert.ok(source.includes('max-width:720px'), '宽度上限应对齐宿主设置页（720）')
  assert.ok(!source.includes('max-width:760px'), '旧的 760 上限应已去掉')
  assert.match(source, /\.enh-group\+\.enh-group\{border-top:\.5px solid var\(--enh-rule\);padding-top:16px\}/, '组之间应是 0.5px 发丝线 + 16px 内距')
})

test('排版：字号只用宿主 token 的七个台阶，不自造中间档', () => {
  const allowed = new Set(['11px', '12px', '13px', '14px', '16px', '20px', '24px'])
  const seen = new Set()
  for (const rule of cssRules()) {
    for (const m of rule.matchAll(/font-size:(\d+px)/g)) seen.add(m[1])
    for (const m of rule.matchAll(/(?<!-)font:(\d+px)\/\d+px/g)) seen.add(m[1])
  }
  for (const size of seen) {
    assert.ok(allowed.has(size), `字号 ${size} 不在宿主刻度上（--dsw-font-* 只有 11/12/13/14/16/20/24）`)
  }
})

test('排版：不用大写变形与字距（宿主设置页零使用）', () => {
  assert.ok(!/text-transform:\s*uppercase/.test(source), '宿主设置页不用 uppercase，别自造')
  assert.ok(!/letter-spacing/.test(source), '宿主设置页不用 letter-spacing，别自造')
})

test('布局：间距只用 8/12/16/24 四档，允许 2/4px 的微调', () => {
  const allowed = new Set([2, 4, 8, 12, 16, 24])
  const offenders = []
  for (const rule of cssRules()) {
    const sel = rule.split('{')[0]
    const body = rule.slice(rule.indexOf('{'))
    for (const m of body.matchAll(/(?:^|[;{])(gap|margin|margin-top|margin-bottom|padding|padding-top|padding-bottom|padding-left|padding-right):([^;}]+)/g)) {
      for (const v of m[2].trim().split(/\s+/)) {
        if (!/^\d+px$/.test(v)) continue
        const n = parseInt(v, 10)
        if (n !== 0 && !allowed.has(n)) offenders.push(`${sel} ${m[1]}:${v}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `间距值不在刻度上：${offenders.join('; ')}`)
})

test('字体：显式继承宿主字体族，等宽只用在代码位', () => {
  assert.ok(source.includes('font-family:var(--dsw-font-family)'), '.enh 根节点应显式继承宿主字体族')
  // 检测器自己先验一次，否则它可能是一条永远为真的断言。
  // 原先写成 `/font-family:\\s*…/`：在正则字面量里 `\\s` 是「字面反斜杠 + 字母 s」，
  // 连 `font-family:Arial` 都不匹配 —— 写进违规也永不红。
  const nonTokenFont = /font-family:\s*(?!var\()/
  assert.ok(nonTokenFont.test('.x{font-family:Arial}'), '检测器必须能认出非 token 的字体族')
  assert.doesNotMatch(source, nonTokenFont, '不该出现非 token 的字体族')
})

test('CSS：颜色只用宿主 token，没有自带色板', () => {
  const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hex, [], `不该出现硬编码颜色：${hex.join(', ')}`)
  assert.ok(source.includes('--dsw-alias-label-primary'), '缺宿主文字色 token')
  assert.ok(source.includes('--ds-ease-in-out') || source.includes('--ds-transition-duration'), '缺宿主动效 token')
})

test('深色：宿主属性钩子存在，且本地变量在两种模式下都有定义、都被消费', () => {
  assert.ok(source.includes('body[data-ds-dark-theme]'), '缺深色属性钩子')
  assert.ok(!/\.dark-theme\b/.test(source), '深色不该用 class 钩子')
  assert.ok(source.includes('body[data-ds-dark-theme] .enh{'), '深色分支没定义本地变量')
  assert.ok(source.includes('body:not([data-ds-dark-theme]) .enh{'), '浅色分支没定义本地变量')

  for (const name of ['--enh-rule', '--enh-mark-pass', '--enh-mark-fail']) {
    const defined = source.includes(name + ':')
    const consumed = (source.match(new RegExp('var\\(' + name + '\\)', 'g')) ?? []).length
    assert.ok(defined, `${name} 没有定义`)
    assert.ok(consumed > 0, `${name} 定义了却没人用（空转）`)
  }
})

test('错误行：就地、role=alert、每个来源各一处，写档三个错误码各有建议', () => {
  const alerts = source.match(/role: "alert"/g) ?? []
  assert.equal(alerts.length, 1, '错误行应当只有一处实现（复用同一个 helper）')
  const sections = [...source.matchAll(/errorLine\("([a-z]+)"\)/g)].map((m) => m[1])
  assert.deepEqual(sections.sort(), ['approval', 'check', 'identity', 'page', 'preset', 'scope'])
  assert.ok(source.includes('没成：'), '错误行缺统一前缀')
  for (const code of ['EPROFILE', 'EBADSHAPE', 'ERECORD', 'ETOOLARGE', 'EBADOP', 'EIO']) {
    assert.ok(source.includes(`code === "${code}"`), `缺 ${code} 的建议文案`)
  }
})

test('一致性：每类控件只在一个组件里定义，调用点不许写 className', () => {
  for (const tag of ['button', 'textarea']) {
    const count = (source.match(new RegExp(`h\\("${tag}"`, 'g')) ?? []).length
    assert.ok(count >= 1, `缺 ${tag} 的定义`)
  }
  const sites = [...source.matchAll(/h\("(button|textarea)"/g)].map((m) => m.index)
  for (const at of sites) {
    const head = source.slice(Math.max(0, at - 400), at)
    assert.match(head, /function (Button|Switch|Option|TextArea)\(props\)/, `裸标签出现在组件定义之外（offset ${at}）`)
  }
  for (const cls of ['enh-btn', 'enh-switch', 'enh-seg-btn', 'enh-textarea']) {
    const occurrences = (source.match(new RegExp(`className: "${cls}"`, 'g')) ?? []).length
    assert.equal(occurrences, 1, `${cls} 应只在一个组件定义里出现，实际 ${occurrences} 处`)
  }
})

test('字节口径：与服务端 normalizeText 同一套，再数 UTF-8', () => {
  const { normalizeText, draftBytes } = loadBundle().__testing
  assert.equal(normalizeText('\uFEFFhello'), 'hello')
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc')
  assert.equal(normalizeText('a\u0000b\u001fc'), 'abc')
  assert.equal(normalizeText('a\tb\nc'), 'a\tb\nc')
  assert.equal(normalizeText('  x  '), 'x')
  assert.equal(draftBytes('hello'), 5)
  assert.equal(draftBytes('中文'), 6)
  assert.equal(draftBytes('😀'), 4)
  assert.equal(draftBytes('a\r\nb'), 3)
})

test('内容边界：注入成立时给的是「能写什么」，不是把四个条件再念一遍', () => {
  assert.ok(source.includes('写行为规矩、写内容要求、写补充说明都行'), '缺「能写什么」这句说明')
  assert.ok(!source.includes('四个条件都成立'), '不该再把注入的四个条件念一遍（上面已经说过了）')
  // 没注入时仍要给「卡在哪」的诊断，只换掉成立时那一句
  assert.ok(source.includes('没有生效，卡在：'), '缺「卡在哪」的诊断句')
})

test('内容边界只有「保存」「还原」两个动作（清空按钮已删）', () => {
  assert.ok(source.includes('"保存"'), '缺保存按钮')
  assert.ok(source.includes('"还原"'), '缺还原按钮')
  // 清空文本不是必需动作：关掉开关就是不注入；真想清空，在文本框里删光再保存即可
  assert.ok(!source.includes('清空（= 不加）'), '「清空」按钮不该回来')
})

test('版本行：本包版本 + 本机 DSH 版本 + 已验范围，超范围只变黄不拦人', () => {
  assert.ok(source.includes('function compatLine'), '缺版本行渲染')
  for (const text of ['已验 DSH ', '已验 ', '超出已验范围 ']) {
    assert.ok(source.includes(text), `版本行缺文案：${text}`)
  }
  assert.ok(source.includes('state.compat'), '版本行数据应来自快照的 compat 段')
  assert.ok(source.includes('typeof compat.range === "string"'), '版本行应直接消费服务端派生的 range 串')
  // 超范围是提示，不是拒绝：只给 data-tone=warn，不隐藏任何控件
  assert.match(source, /"data-tone": "warn" \}, head \+ " · DSH "/, '超范围应只变黄')
})

test('状态：服务端 active / degraded 必须被用上，降级原因要有一行说明', () => {
  assert.ok(source.includes('state.active === false'), '插件未激活必须能显示出来')
  assert.ok(source.includes('state.degraded'), '降级必须能显示出来')
  assert.ok(source.includes('state.degradedReason === "missing"'), 'missing 与 corrupt 必须分开说')
})

test('状态：损坏原因按 degradedFields 说，不许一律说成「审批回落」（审计 B2）', () => {
  // 坏的是「品牌人设」时，说成「审批回落到先问我」是替另一件事背锅——
  // 用户照着它去查审批，永远查不到。
  assert.ok(source.includes('state.degradedFields'), '必须读服务端给的 degradedFields')
  assert.ok(source.includes('field === "identity"'), 'identity 坏值要说成「品牌人设回落到保留」')
  assert.ok(source.includes('field === "approval"'), 'approval 坏值才说审批')
  // 认不出的字段名要照原样抖出来，不能静默吞掉
  assert.ok(source.includes('认不出，按默认值处理'), '未知字段名必须照原样说出来')
  // 整行不再硬编码「审批回落到先问我」
  assert.ok(!/状态文件损坏，这一页按默认值运行；审批回落到/.test(source), '不许把损坏原因写死成审批')
})

// ───────────────────────────────────────────── 回归闸

test('状态显示看已保存文本，不看未保存草稿（否则清空草稿时自相矛盾）', () => {
  assert.ok(source.includes('var savedEmpty = '), '缺 savedEmpty：内容边界右上角必须基于已保存文本')
  // 右上角现状由 scopeNow 算出来；它必须用 savedEmpty，而不是草稿
  const at = source.indexOf('var scopeNow =')
  assert.ok(at > 0, '找不到内容边界右上角的现状计算')
  const line = source.slice(at, source.indexOf('\n', at))
  assert.match(line, /savedEmpty \? "文字为空"/, '右上角的「空文本」判定必须基于 savedEmpty')
  assert.ok(!/normalizeText\(draft\)/.test(line), '右上角不该直接读草稿')
})

test('渲染：用真实快照首帧渲染出五组 + 头部，且不带已删除的两节', async () => {
  const module = loadBundle()
  let component
  module.apply({
    slots: {
      inject: (_name, run) => run(),
      register: (_spec, registered) => { component = registered; return () => {} },
    },
  })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SNAPSHOT })

  const tree = component({})
  await new Promise((resolve) => setImmediate(resolve))

  /** 收集整棵树里的 className 与 id（假 React 的节点形如 { type, props, children }）。 */
  const classes = new Set()
  const ids = new Set()
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    const props = node.props ?? {}
    if (typeof props.className === 'string') classes.add(props.className)
    if (typeof props.id === 'string') ids.add(props.id)
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)

  for (const id of ['enh-block-identity', 'enh-block-scope', 'enh-block-approval', 'enh-block-preset', 'enh-block-check']) {
    assert.ok(ids.has(id), `渲染树里缺 ${id}`)
  }
  assert.equal(ids.size, 5, '渲染树里只该有五组')
  // 组件节点（Switch/Button）的 className 在组件内部，假 React 不会展开它们；
  // 这里只验宿主可渲染的真实 DOM 节点上的类名。
  for (const cls of ['enh', 'enh-head', 'enh-title', 'enh-pill', 'enh-group', 'enh-row-head', 'enh-note']) {
    assert.ok(classes.has(cls), `渲染树里缺 .${cls}`)
  }
  // 旧结构（编号列 / 结论句 / 卸载节）不该出现在渲染树里
  for (const cls of ['enh-rail', 'enh-idx', 'enh-verdict', 'enh-banner', 'enh-rows']) {
    assert.ok(!classes.has(cls), `渲染树里残留旧结构 .${cls}`)
  }

  delete globalThis.fetch
})

test('首帧读不到状态时必须给重试入口，不能锁死', () => {
  assert.ok(source.includes('state === null && error !== null && error.section === "page"'), '缺重试条件')
  assert.ok(/\}, "重试"\)/.test(source), '缺重试按钮')
  assert.ok(source.includes('总开关'), '缺页级总开关')
  assert.ok(source.includes('props.checked === "mixed"'), '未知态应允许 aria-checked=mixed')
})

test('切开关不能静默丢弃未保存的草稿', () => {
  assert.ok(source.includes('previous !== next.text'), 'adopt 应先比较旧文本是否变化再覆盖草稿')
})

test('一个请求只清自己那一组的错误', () => {
  assert.match(source, /setError\(function \(current\) \{[\s\S]{0,200}current\.section === section \? null : current/, 'run() 应只清同组错误')
})

test('写档结果要能被屏幕阅读器念出来（role=status + aria-live）', () => {
  assert.match(source, /role: "status"/, '缺 role=status')
  assert.match(source, /"aria-live": "polite"/, '缺 aria-live=polite')
})

test('守卫：ctx 没有 effect 时页面仍能注册（假 ctx 只有 slots）', () => {
  const module = loadBundle()
  let registered = 0
  module.apply({
    slots: {
      inject: (_name, run) => run(),
      register: () => {
        registered += 1
        return () => {}
      },
    },
  })
  assert.equal(registered, 1)
})

test('守卫：ctx 有 effect 且无 document 时不抛（Node 环境）', () => {
  const module = loadBundle()
  const effects = []
  assert.doesNotThrow(() => {
    module.apply({
      effect(run) { effects.push(run); return () => {} },
      slots: {
        inject: (_name, run) => run(),
        register: () => () => {},
      },
    })
  })
  assert.equal(effects.length, 0)
})

test('CSS 分支真被执行：有 document 时 effect 被注册，style 标签被插入且卸载时移除', () => {
  const module = loadBundle()

  const inserted = []
  const removed = []
  const fakeTag = { dataset: {}, textContent: '', parentNode: null }
  const head = {
    appendChild(node) { node.parentNode = head; inserted.push(node) },
    removeChild(node) { removed.push(node); node.parentNode = null },
  }
  const previous = globalThis.document
  globalThis.document = { head, querySelector: () => null, createElement: () => fakeTag }

  try {
    const effects = []
    module.apply({
      effect(run) { effects.push(run); return () => {} },
      slots: { inject: (_name, run) => run(), register: () => () => {} },
    })
    assert.equal(effects.length, 1, '有 document 时应注册 CSS effect')

    const cleanup = effects[0]()
    assert.equal(inserted.length, 1, '应插入一个 style 标签')
    assert.ok(inserted[0].textContent.includes('.enh'), 'style 内容应是我们的 CSS')
    assert.equal(inserted[0].dataset.pluginCss, 'dsh-enhance-ui/settings.css')
    assert.equal(typeof cleanup, 'function', 'effect 应返回清理函数')

    cleanup()
    assert.equal(removed.length, 1, '清理时应移除 style 标签')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

/** 把 CSS 数组拆成规则，供刻度断言使用。 */
function cssRules() {
  const start = source.indexOf('var CSS = [')
  const end = source.indexOf('].join("\\n")')
  const rules = [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1])
  // 空集合会让「字号」「间距」两条刻度断言在零条规则上静默全绿——
  // 那是「门禁在跑但什么都没量」的典型空转。量之前先确认真量到了东西。
  if (rules.length === 0) throw new Error('cssRules() 抽到 0 条规则：CSS 数组的标记可能被改了，刻度断言会静默失效')
  return rules
}

// ───────────────────────────────────────────── 品牌人设

test('品牌人设：三态词与现状词都在，且不含「人设」二字（避开宿主 persona 与内容边界）', () => {
  for (const word of ['保留', '去掉', '自定义']) {
    assert.ok(source.includes(`word: "${word}"`), `缺三态词：${word}`)
  }
  for (const status of ['原样', '已去掉', '已替换']) {
    assert.ok(source.includes(`"${status}"`), `缺现状词：${status}`)
  }
  // 组名与控件标签都不能用「人设」：宿主把 persona 叫「人设」，内容边界也能写人设文本，
  // 这一组只管开头那句声明，混用一个词会让三件事读成一件。
  const block = source.slice(source.indexOf('"enh-block-identity"'), source.indexOf('"enh-block-scope"'))
  assert.ok(!block.includes('人设开关'), '别用「人设开关」这类合称')
  assert.ok(block.includes('"品牌人设"'), '组名应是「品牌人设」')
})

test('品牌人设：只有「自定义」才画输入框（没有的控件不画）', () => {
  // 输入框的渲染必须在 identityMode !== "custom" 的分支里
  const at = source.indexOf('identityMode !== "custom" ? null :')
  assert.ok(at > 0, '输入框应由 identityMode 分支控制')
  const input = source.indexOf('label: "第一句写什么"')
  assert.ok(input > at, '输入框必须在那条分支之后')
})

test('品牌人设：预览行与「改一次冷一次」的后果说明都在', () => {
  assert.ok(source.includes('模型看到的第一句'), '缺预览行标签')
  assert.ok(source.includes('identityEffective.preview'), '预览必须消费服务端派生的 preview')
  assert.ok(source.includes('改一次，下一条请求要重算一次系统提示'), '缺缓存代价说明')
  assert.ok(source.includes('下一条消息生效，不用重启'), '缺生效时机说明')
})

test('品牌人设：降级时说对原因，不冒称已生效', () => {
  assert.ok(source.includes('identityEffective.degraded === true'), '必须读降级标志')
  assert.ok(source.includes('此刻发出去的仍是宿主原句'), '降级时要说明实际行为')
})

test('品牌人设：切三态不能静默丢弃未保存的自定义文字', () => {
  // adopt 里只有服务端身份文本真的变了才覆盖草稿
  assert.match(source, /previousIdentity === null \|\| previousIdentity !== next\.identityText/, '草稿覆盖必须以服务端文本变化为条件')
})

test('品牌人设：隐藏开关的标签必须固定为动作名，不许随状态翻转（读反过）', () => {
  // 原先按状态在「显示宿主说明 / 同时隐藏宿主说明」之间换文案，而 checked 绑的是 hideHarness，
  // 于是「关着 + 显示宿主说明」会被读成「宿主说明不显示了」——与事实正好相反。
  assert.ok(source.includes('}, "隐藏宿主说明")'), '标签应是恒定的「隐藏宿主说明」')
  assert.ok(!source.includes('"显示宿主说明"'), '标签不许再随状态翻转')
  assert.ok(!/"同时隐藏宿主说明"/.test(source), '标签不许再随状态翻转')
})

test('品牌人设：隐藏的代价要说清（那两段不纯是品牌，含开发防错规则）', () => {
  // 隐藏的不只是「提到宿主名字」，还包含「别把实现目录当工作目录」与
  // 「别另起服务器 / 改动何时生效」这类操作约定——对改 DSH 的人是真退化。
  assert.ok(source.includes('实现目录与工作目录不是一回事'), '要说清第一段丢的是什么')
  assert.ok(source.includes('不要另起服务器'), '要说清第二段丢的是什么')
  assert.ok(source.includes('自己在改 DSH 或写插件时，它们正是防错规则'), '要点明对开发场景是防错规则')
})

test('品牌人设：开关开着时状态词不许说「原样」（页面说的要和实际发的一致）', () => {
  // 这一组管三处自指。只看三态会让「开关开 + 三态保留」显示成「原样」，
  // 可那四段其实已经被隐藏 —— 发出去的并不是原样。
  const fn = source.slice(source.indexOf('function identityStatusOf'), source.indexOf('function degradedTextOf'))
  assert.ok(fn.includes('state.hideHarness === true'), '状态词必须读开关，不能只看三态')
  assert.ok(fn.includes('"说明已隐藏"'), '只隐藏说明（开场白没动）时要有自己的词')
  const hiddenAt = fn.indexOf('if (hidden)')
  const plainAt = fn.indexOf('return { word: "原样"')
  assert.ok(hiddenAt > 0 && plainAt > hiddenAt, '「原样」必须排在开关判断之后，否则会说出与事实相反的结论')
})

test('品牌人设：组内副标题要覆盖三处自指，不能只说开场白', () => {
  assert.ok(source.includes('提到宿主名字的三处'), '副标题要说清这一组管三处')
  assert.ok(!source.includes('系统提示的第一句，模型用它回答「你是谁」。'), '旧的单处说法应已替换')
})

test('品牌人设：开关开着时，后果行不许再说「一个字不动」', () => {
  assert.ok(!source.includes('本插件一个字不动'), '只有开关关着才成立的话，不许无条件写出来')
  assert.ok(source.includes('另外两段说明也已隐藏'), '开关开着时要补一句，说明另外两段也被处理了')
})

// ───────────────────────────────────────────── 品牌人设：装上了没有（T25，审计缺口 1）

test('品牌人设：装不上时状态词说「未生效」，不说「已替换」；keep 且没开隐藏时不虚惊', () => {
  const { identityStatusOf } = loadBundle().__testing
  const unsupported = { state: 'unsupported', ok: false, text: '未生效：本版宿主没有可注入的 agent 上下文。' }
  // 用户选了「自定义/去掉」却装不上：页面必须在状态词上就改口，不能继续说「已替换」。
  assert.deepEqual(
    identityStatusOf({ enabled: true, identity: 'custom', hideHarness: false, identityEffective: { mode: 'custom' }, identityInstall: unsupported }),
    { word: '未生效', tone: 'warn' },
  )
  assert.deepEqual(
    identityStatusOf({ enabled: true, identity: 'remove', hideHarness: false, identityEffective: { mode: 'remove' }, identityInstall: unsupported }),
    { word: '未生效', tone: 'warn' },
  )
  // keep 且没开隐藏：本来就没有要遮蔽的段，报「未生效」是虚惊。
  assert.equal(identityStatusOf({ enabled: true, identity: 'keep', hideHarness: false, identityEffective: { mode: 'keep' }, identityInstall: unsupported }).word, '原样')
  // keep + 隐藏说明：那时确实有要装的遮蔽项。
  assert.equal(identityStatusOf({ enabled: true, identity: 'keep', hideHarness: true, identityEffective: { mode: 'keep' }, identityInstall: unsupported }).word, '未生效')
  // 总开关关着优先，且不因为装不上而变红。
  assert.equal(identityStatusOf({ enabled: false, identity: 'custom', hideHarness: false, identityEffective: {}, identityInstall: unsupported }).word, '不生效')
  // 装上了 / 旧快照没有这个字段：原判定一个都不变。
  assert.equal(identityStatusOf({ enabled: true, identity: 'custom', hideHarness: false, identityEffective: { mode: 'custom' }, identityInstall: { ok: true } }).word, '已替换')
  assert.equal(identityStatusOf({ enabled: true, identity: 'custom', hideHarness: false, identityEffective: { mode: 'custom' } }).word, '已替换')
})

test('品牌人设：安装状态那一行会渲染出来（服务端给了才画）', async () => {
  const module = loadBundle()
  let component
  module.apply({
    slots: {
      inject: (_name, run) => run(),
      register: (_spec, registered) => { component = registered; return () => {} },
    },
  })
  const line = '未生效：本版宿主没有可注入的 agent 上下文（agent.ctx.inject 不可用），品牌人设这一路这轮不生效。'
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ...SNAPSHOT, identityInstall: { state: 'unsupported', ok: false, text: line } }),
  })
  try {
    // 首帧只负责触发 state 请求；假 React 不会自己在 setState 后重渲染，
    // 所以第二次调用组件取「已落地的快照」渲染出来的树。
    component({})
    await new Promise((resolve) => setImmediate(resolve))
    module.__react.reset()
    const tree = component({})
    const strings = []
    const walk = (node) => {
      if (typeof node === 'string') { strings.push(node); return }
      if (node === null || node === undefined || typeof node !== 'object') return
      if (Array.isArray(node)) { node.forEach(walk); return }
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    assert.ok(strings.includes(line), '安装状态行没有出现在渲染树里')
  } finally {
    delete globalThis.fetch
  }
})
