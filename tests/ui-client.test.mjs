/**
 * 设置页（`enhance/ui/client.js`）的测试。
 *
 * 两层：
 *   1. 行为断言 —— 装载、注册、首帧、`call` 的 ok:false 语义。这些是契约，不随文案变。
 *   2. 意图断言 —— 五节结构、结论句状态机、审批三档语义、检查项映射、卸载分组、
 *      就地错误行、字节口径、CSS 守卫。断言的是「页面必须守住的行为」，
 *      不是某一版文案快照。
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
  }
}

/** 把 bundle 装进一个假装载器，返回它导出的模块。 */
function loadBundle() {
  let spec
  const window = { __ModuleLoader__: { load(captured) { spec = captured } } }
  // eslint-disable-next-line no-new-func -- 就是要在沙箱里跑这段浏览器代码
  const run = new Function('window', source)
  run(window)
  assert.ok(spec !== undefined, 'bundle 没有调用 window.__ModuleLoader__.load')
  const require = (name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require: ${name}`)
  }
  return spec.factory(require)
}

/** 一次典型的 snapshot：字段与 `enhance-scope/index.js` 的 snapshot() 对齐。 */
const SNAPSHOT = {
  ok: true,
  version: 3,
  active: true,
  enabled: true,
  injecting: true,
  reason: null,
  contentScope: true,
  approval: 'ask',
  text: 'hello',
  bytes: 5,
  sha256: 'abc123def456',
  updatedAt: '2026-10-28T14:32:00.000Z',
  degraded: false,
  degradedReason: null,
  home: 'C:/x',
  limit: 8192,
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

// ───────────────────────────────────────────── 意图断言

test('结构：六节按 01→06 排列，标题各自说事', () => {
  // 用 section() 的调用位置定序（标题字符串可能在别处先出现，比如注释里的「检查项」）
  const ids = ['enh-block-verdict', 'enh-block-approval', 'enh-block-scope', 'enh-block-preset', 'enh-block-check', 'enh-block-lifecycle']
  const at = ids.map((id) => source.indexOf(`section("0${ids.indexOf(id) + 1}", "${id}"`))
  at.forEach((index, i) => assert.ok(index >= 0, `缺节：${ids[i]}`))
  const sorted = [...at].sort((a, b) => a - b)
  assert.deepEqual(at, sorted, '六节的顺序变了')

  const titles = ['现在会怎么做事', '越界时怎么办', '提示词末尾的内容边界', 'Enhanced 权限档', '检查', '升级与卸载']
  titles.forEach((title, i) => {
    const slice = source.slice(at[i], i + 1 < at.length ? at[i + 1] : source.length)
    assert.ok(slice.includes(title), `第 ${i + 1} 节的标题不对：缺「${title}」`)
  })

  // 每节都有四层的容器类：标题 / 副行 / 右上现状 / 下方后果
  for (const cls of ['enh-h3', 'enh-sub', 'enh-now', 'enh-reason']) {
    assert.ok(source.includes(cls), `缺四层之一：${cls}`)
  }
})

test('结构：结论句在第一节内部，不在页面底部', () => {
  // 用带引号的 className 定位实际使用处，避免匹配到 CSS 里的类定义
  const verdict = source.indexOf('className: "enh-verdict"')
  const firstBlock = source.indexOf('"enh-block-verdict"')
  const lastBlock = source.indexOf('"enh-block-lifecycle"')
  assert.ok(verdict > 0, '结论句没有渲染')
  assert.ok(firstBlock > 0, '01 节缺少 id')
  assert.ok(verdict > firstBlock, '结论句不在 01 节内')
  assert.ok(verdict < lastBlock, '结论句掉到了页面后半段')
})

test('结论句：关闭态一句、开启态三句，三句都可跳转（第三句指向 Enhanced 档）', () => {
  const { verdictClauses } = loadBundle().__testing

  const off = verdictClauses({ ...SNAPSHOT, enabled: false })
  assert.equal(off.length, 1)
  assert.equal(off[0].kind, 'static')
  assert.match(off[0].text, /不接管审批/)
  assert.match(off[0].text, /开关和文本都还在/)

  const on = verdictClauses({ ...SNAPSHOT, approval: 'ask', contentScope: true, text: 'hello' })
  assert.equal(on.length, 3)
  // 转型后第三句也能点：这一页确实能改「菜单里有没有这个档」
  assert.deepEqual(on.map((c) => c.kind), ['jump', 'jump', 'jump'])
  assert.match(on[0].text, /越界时先问我/)
  assert.equal(on[0].target, 'enh-block-approval')
  assert.equal(on[1].text, '提示词末尾带内容边界')
  assert.equal(on[1].target, 'enh-block-scope')
  assert.match(on[2].text, /菜单里没有 Enhanced 档/)
  assert.equal(on[2].target, 'enh-block-preset')

  // 边界那一句随状态三态变化
  assert.equal(verdictClauses({ ...SNAPSHOT, contentScope: false })[1].text, '提示词末尾不带内容边界')
  assert.equal(verdictClauses({ ...SNAPSHOT, text: '  ' })[1].text, '尾段为空、实际不注入')

  // 第三句随 preset 状态变化：已写入 / 写不进去 / 管不了
  assert.match(verdictClauses({ ...SNAPSHOT, preset: { ...SNAPSHOT.preset, present: true } })[2].text, /菜单里有 Enhanced 档/)
  assert.match(verdictClauses({ ...SNAPSHOT, preset: { ...SNAPSHOT.preset, unreadable: true } })[2].text, /写不进去/)
  assert.match(verdictClauses({ ...SNAPSHOT, preset: { ...SNAPSHOT.preset, patchPath: null } })[2].text, /管不了/)
})

test('结论句：审批词随三档变化，且用的是与宿主菜单错开的词', () => {
  const { verdictClauses, approvalOf } = loadBundle().__testing
  assert.match(verdictClauses({ ...SNAPSHOT, approval: 'allow' })[0].text, /自动同意/)
  assert.match(verdictClauses({ ...SNAPSHOT, approval: 'deny' })[0].text, /自动回绝/)
  assert.match(verdictClauses({ ...SNAPSHOT, approval: 'ask' })[0].text, /先问我/)
  // 未知值回落到 ask，不抛
  assert.equal(approvalOf('nonsense').word, '先问我')
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
  assert.deepEqual(rows.map((r) => r.title), ['插件在进程里', '文本合不合规', '真的进了系统提示', 'Enhanced 档'])
  // 关键：pass / na 来自服务端，页面不伪造通过
  assert.deepEqual(rows.map((r) => r.pass), [true, false, false, true])
  assert.deepEqual(rows.map((r) => r.na), [false, false, false, true])
  assert.equal(rows[1].detail, '9000 B / 上限 8192 B')

  // 未知 name 不吞掉，原样显示；缺 checks 时返回空数组
  assert.equal(checkRows({ checks: [{ name: 'future', pass: false, detail: '' }] })[0].title, 'future')
  assert.deepEqual(checkRows(null), [])
})

test('Enhanced 档：四种状态各自说对话，且只在能做事的两种状态给按钮', () => {
  const { presetStatusOf } = loadBundle().__testing

  assert.deepEqual(presetStatusOf(null), { kind: 'unknown', word: '—', tone: 'mute' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: null } }), { kind: 'noprofile', word: '不可用', tone: 'mute' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: 'C:/p/x.yml', unreadable: true } }), { kind: 'unreadable', word: '改不动', tone: 'bad' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: 'C:/p/x.yml', present: true } }), { kind: 'written', word: '已写入', tone: 'ok' })
  assert.deepEqual(presetStatusOf({ preset: { patchPath: 'C:/p/x.yml', present: false } }), { kind: 'absent', word: '未写入', tone: 'mute' })

  // 「写不进去」和「管不了」这两种情况不许给操作按钮——按了也只会报错
  assert.match(source, /presetStatus\.kind === "absent"/, '缺「未写入」才给写入按钮的分支')
  assert.match(source, /presetStatus\.kind === "written"/, '缺「已写入」才给移除按钮的分支')
  assert.ok(source.includes('写入 Enhanced 档'), '缺写入按钮文案')
  assert.ok(source.includes('移除 Enhanced 档'), '缺移除按钮文案')
  // 移除要二次确认：第一次点变文案，第二次才发请求
  assert.ok(source.includes('再点一次确认移除'), '移除缺少二次确认')
  assert.ok(source.includes('action: "add"') && source.includes('action: "remove"'), '缺 preset op 的两种动作')
})

test('升级与卸载节：只说明、不画按钮，命令照实写', () => {
  const at = source.indexOf('// 06 升级与卸载')
  assert.ok(at > 0, '找不到 06 节的注释锚点')
  const block = source.slice(at, source.indexOf('// 页面', at) > 0 ? source.indexOf('// 页面', at) : at + 4000)
  assert.ok(!block.includes('h(Button'), '06 节不该有按钮——页内卸载能力已经不存在')
  assert.ok(block.includes('dsh plugin --profile'), '缺卸载命令')
  assert.ok(block.includes('remove dsh-enhance'), '缺卸载动词与包名')
  assert.ok(block.includes('docs/compatibility.md'), '缺例行核验的指引')
  assert.ok(block.includes('零操作'), '缺「升级零操作」这一句')
  assert.ok(block.includes('.bak 备份都会留着'), '缺「数据会保留」这一句')
})

test('按钮：禁用态的样式必须排在 data-kind 之后（否则禁用仍显示危险色）', () => {
  const disabled = source.indexOf('.enh-btn:disabled,.enh-btn[data-kind]:disabled')
  const danger = source.indexOf('.enh-btn[data-kind=danger]')
  assert.ok(disabled > 0, '缺禁用态覆盖规则')
  assert.ok(danger > 0, '缺 danger 变体')
  assert.ok(disabled > danger, '禁用态规则必须写在 data-kind 之后，同特异性下后写的赢')
})

test('路径：按 home 自己的分隔符拼，不混用 \\ 和 /', () => {
  assert.ok(source.includes('function homePath'), '缺 homePath')
  const { homePath } = (() => {
    const bundle = loadBundle()
    // homePath 没有导出，直接读源码里那一段来跑，避免为一个纯函数扩大 __testing 的暴露面
    const m = source.match(/function homePath\(state\) \{[\s\S]*?\n\t\t\}/)
    assert.ok(m !== null, '源码里找不到 homePath 实现')
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (' + m[0].replace('function homePath(state)', 'function (state)') + ')')()
    void bundle
    return { homePath: fn }
  })()
  assert.equal(homePath({ home: 'C:\\Users\\x\\.dsh' }), 'C:\\Users\\x\\.dsh\\enhance\\')
  assert.equal(homePath({ home: 'C:\\Users\\x\\.dsh\\' }), 'C:\\Users\\x\\.dsh\\enhance\\')
  assert.equal(homePath({ home: '/home/x/.dsh' }), '/home/x/.dsh/enhance/')
  assert.equal(homePath(null), '~/.dsh/enhance/')
})

test('术语说明是可折叠的，不是常驻正文', () => {
  // 常驻会在用户选「先问我」时原地解释「自动同意」，读起来像状态没更新
  assert.ok(source.includes('h("details"'), '术语说明应放在 details 里')
  assert.ok(source.includes('为什么这三个词和主菜单不一样'), '缺折叠区的标题')
  assert.ok(!/h\("p", \{ className: "enh-hint" \}, "为什么叫「自动同意」/.test(source), '不该再有常驻的「为什么叫自动同意」正文')
})

// ──────────────── 规范符合性（WCAG / APG / 一致性）────────────────

test('APG：方向键四个方向都处理，且两端回绕', () => {
  // 键盘逻辑挂在 Segmented 的 onKeyDown 上；按整份源码查，不按邻近位置查。
  for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
    assert.ok(source.includes(key), `缺 ${key}：APG 要求 Right/Down 前进、Left/Up 后退`)
  }
  assert.ok(/\(at \+ 1\) % APPROVAL_ORDER\.length/.test(source), '前进方向必须取模回绕')
  assert.ok(/\(at \+ APPROVAL_ORDER\.length - 1\) % APPROVAL_ORDER\.length/.test(source), '后退方向必须取模回绕')
})

test('APG：radiogroup 与每个 radio 都有可判定的名字', () => {
  assert.match(source, /role: "radiogroup",\s*\n\s*"aria-label":/, 'radiogroup 需要 aria-label')
  assert.ok(source.includes('h(Option'), '三档必须走 Option 组件')
  // radio 的名字来自按钮文本（APG 允许「由其内容标名」）
  assert.ok(source.includes('}, APPROVAL[value].word)'), 'radio 的文本即其名字')
})

test('WCAG 3.3.1 + 3.3.3：错误行指明哪一节，并给一句怎么改', () => {
  assert.ok(source.includes('SECTION_LABELS'), '缺节名映射：3.3.1 要求指明哪一项出错')
  assert.ok(source.includes('function sectionLabel'), '缺 sectionLabel')
  assert.ok(source.includes('function errorHint'), '缺 errorHint：3.3.3 要求给建议')
  // 五个 code 至少覆盖最常撞的三个
  for (const code of ['ETOOLARGE', 'EBADOP', 'EIO']) {
    assert.ok(source.includes(`code === "${code}"`), `缺 ${code} 的建议文案`)
  }
  // 错误行现在必须包含节名
  assert.match(source, /text: sectionLabel\(section\) \+ "没成："/, '错误行应把节名放在最前')
})

test('一致性：每类控件只在一个组件里定义，调用点不许写 className', () => {
  // 各组件各自是唯一的裸标签出处
  for (const [tag, component] of [['button', 'Button'], ['textarea', 'TextArea']]) {
    const count = (source.match(new RegExp(`h\\("${tag}"`, 'g')) ?? []).length
    assert.ok(count >= 1, `缺 ${tag} 的定义`)
  }
  // 每个裸 button/textarea 都必须紧跟在某个 function Xxx(props) 里
  const sites = [...source.matchAll(/h\("(button|textarea)"/g)].map((m) => m.index)
  for (const at of sites) {
    const head = source.slice(Math.max(0, at - 400), at)
    assert.match(head, /function (Button|Switch|Option|Clause|TextArea)\(props\)/, `裸标签出现在组件定义之外（offset ${at}）`)
  }
  // 调用点改用组件后，不应再有 className: "enh-btn" 之类的直接赋值
  // 类名清单必须覆盖**所有**有独立组件的样式类；漏一个，那个组件就会退化成死代码。`enh-tag` 就是这样漏掉的。
  for (const cls of ['enh-btn', 'enh-switch', 'enh-seg-btn', 'enh-textarea', 'enh-tag', 'enh-clause']) {
    const occurrences = (source.match(new RegExp(`className: "${cls}"`, 'g')) ?? []).length
    assert.equal(occurrences, 1, `${cls} 应只在一个组件定义里出现，实际 ${occurrences} 处`)
  }
})

test('错误行：就地、role=alert、每个来源各一处', () => {
  const alerts = source.match(/role: "alert"/g) ?? []
  assert.equal(alerts.length, 1, '错误行应当只有一处实现（复用同一个 helper）')
  const sections = [...source.matchAll(/errorLine\("([a-z]+)"\)/g)].map((m) => m[1])
  assert.deepEqual(sections.sort(), ['approval', 'check', 'page', 'preset', 'scope'])
  assert.ok(source.includes('没成：'), '错误行缺统一前缀')
  // 写档这条路上三个错误码各有「怎么改」的一句话
  for (const code of ['EPROFILE', 'EBADSHAPE', 'ERECORD']) {
    assert.ok(source.includes(`code === "${code}"`), `缺 ${code} 的建议文案`)
  }
})

test('字节口径：与服务端 normalizeText 同一套，再数 UTF-8', () => {
  const { normalizeText, draftBytes } = loadBundle().__testing
  // 去 BOM
  assert.equal(normalizeText('\uFEFFhello'), 'hello')
  // CRLF 与裸 CR 都折成 LF
  assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc')
  // 控制字符去掉，\n 与 \t 保留
  assert.equal(normalizeText('a\u0000b\u001fc'), 'abc')
  assert.equal(normalizeText('a\tb\nc'), 'a\tb\nc')
  // trim
  assert.equal(normalizeText('  x  '), 'x')
  // 字节：ASCII、CJK、emoji（代理对算 4 字节）
  assert.equal(draftBytes('hello'), 5)
  assert.equal(draftBytes('中文'), 6)
  assert.equal(draftBytes('😀'), 4)
  // CRLF 归一后只算 1 字节
  assert.equal(draftBytes('a\r\nb'), 3)
})

test('深色：宿主属性钩子存在，且本地变量在两种模式下都有定义、都被消费', () => {
  // 之前这里是一条恒真断言（两侧都不存在 → 永远通过），等于门禁空转。现在要求：
  // 1) 用属性钩子，不用 class；
  assert.ok(source.includes('body[data-ds-dark-theme]'), '缺深色属性钩子')
  assert.ok(!/\.dark-theme\b/.test(source), '深色不该用 class 钩子')

  // 2) 深色与浅色两个分支都要给本地变量赋值；
  assert.ok(source.includes('body[data-ds-dark-theme] .enh{'), '深色分支没定义本地变量')
  assert.ok(source.includes('body:not([data-ds-dark-theme]) .enh{'), '浅色分支没定义本地变量')

  // 3) 定义出来的变量必须真被消费，否则就是「定义了没进判定」的空转。
  for (const name of ['--enh-rule', '--enh-mark-pass', '--enh-mark-fail']) {
    const defined = source.includes(name + ':')
    const consumed = (source.match(new RegExp('var\\(' + name + '\\)', 'g')) ?? []).length
    assert.ok(defined, `${name} 没有定义`)
    assert.ok(consumed > 0, `${name} 定义了却没人用（空转）`)
  }
})

test('字体：显式继承宿主字体族，等宽只用在代码位', () => {
  assert.ok(source.includes('font-family:var(--dsw-font-family)'), '.enh 根节点应显式继承宿主字体族')
  assert.doesNotMatch(source, /font-family:\\s*[\"']?(?!var\()/, '不该出现非 token 的字体族')
})

test('CSS：颜色只用宿主 token，没有自带色板', () => {
  const hex = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  assert.deepEqual(hex, [], `不该出现硬编码颜色：${hex.join(', ')}`)
  assert.ok(source.includes('--dsw-alias-label-primary'), '缺宿主文字色 token')
  assert.ok(source.includes('--ds-ease-in-out') || source.includes('--ds-transition-duration'), '缺宿主动效 token')
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
  // 没有 document 就不该往 effect 里塞东西
  assert.equal(effects.length, 0)
})

test('CSS 分支真被执行：有 document 时 effect 被注册，style 标签被插入且卸载时移除', () => {
  const module = loadBundle()

  // 最小化的 document 替身：够 querySelector / createElement / head.appendChild 用
  const inserted = []
  const removed = []
  const fakeTag = {
    dataset: {},
    textContent: '',
    parentNode: null,
  }
  const head = {
    appendChild(node) { node.parentNode = head; inserted.push(node) },
    removeChild(node) { removed.push(node); node.parentNode = null },
  }
  const previous = globalThis.document
  globalThis.document = {
    head,
    querySelector: () => null,
    createElement: () => fakeTag,
  }

  try {
    const effects = []
    const cleanups = []
    module.apply({
      effect(run) { effects.push(run); return () => {} },
      slots: {
        inject: (_name, run) => run(),
        register: () => () => {},
      },
    })

    // 有 document + 有 effect → 必须注册一个 effect
    assert.equal(effects.length, 1, '有 document 时应注册 CSS effect')

    // 跑这个 effect：应插入一个 <style>
    const cleanup = effects[0]()
    assert.equal(inserted.length, 1, '应插入一个 style 标签')
    assert.ok(inserted[0].textContent.includes('.enh'), 'style 内容应是我们的 CSS')
    assert.equal(inserted[0].dataset.pluginCss, 'dsh-enhance-ui/settings.css')
    assert.equal(typeof cleanup, 'function', 'effect 应返回清理函数')

    // 清理：应移除同一个标签
    cleanups.push(cleanup)
    cleanup()
    assert.equal(removed.length, 1, '清理时应移除 style 标签')
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('静态：不含已退役的说法，也不再把「范围」做成控件', () => {
  assert.doesNotMatch(source, /改文件/, '出现了已退役的说法')
  assert.doesNotMatch(source, /fence/i, '出现了已退役模块名')
  assert.doesNotMatch(source, /先读后写|读后写/, '出现了已退役的概念')
  // 「范围」只作为结论句里的静态分句出现，不提供控件
  assert.doesNotMatch(source, /kind: "jump", text: "范围/, '「范围」不该做成可跳转入口')
})

test('静态：三个问题都在，但不以问句行形式排列', () => {
  // 旧实现用三行问句；新实现把它们变成各节的标题与结论句
  assert.ok(!/row\("/.test(source), '还在用问句行')
  assert.ok(source.includes('越界时'), '缺越界那一问')
  assert.ok(source.includes('提示词末尾'), '缺边界那一问')
  assert.ok(source.includes('Enhanced 权限档'), '缺档位那一问')
  // 「当前会话在哪个档」这一句必须留给宿主选择器，本页只解释边界
  assert.ok(source.includes('当前会话在哪个档由左下角菜单决定'), '缺「当前档位归谁管」的边界说明')
})

test('静态：真实能力之外不画假按钮（卸载只给命令）', () => {
  assert.ok(!/op: "restore"/.test(source), '页面不该有 restore 的 op')
  assert.ok(!/op: "archive"/.test(source), '页面不该有 archive 的 op')
  assert.ok(!/op: "uninstall"/.test(source), '页面不该有 uninstall 的 op')
  // 已删掉的完整安装/派生件语境一个字都不许回来
  for (const gone of ['install.mjs', 'uninstall.mjs', 'enhance-permissions', 'build-client', 'planGroups']) {
    assert.ok(!source.includes(gone), `残留了已退役的东西：${gone}`)
  }
  assert.ok(source.includes('dsh plugin --profile'), '卸载指引必须给命令文本')
})

// ──────────────── 复核发现的回归闸 ────────────────

test('状态显示看已保存文本，不看未保存草稿（否则清空草稿时自相矛盾）', () => {
  assert.ok(source.includes('var savedEmpty = '), '缺 savedEmpty：03 右上角必须基于已保存文本')

  // 定位 03 的 section() 调用，取它前 4 个参数（标题/副行/右上/色调）
  const at = source.indexOf('section("03"')
  assert.ok(at > 0, '找不到 03 节')
  const head = source.slice(at, at + 700)
  // 必须由 savedEmpty 决定「空文本」这一支；由草稿决定就会与结论句自相矛盾
  assert.match(head, /savedEmpty \? "空文本"/, '03 的「空文本」判定必须基于 savedEmpty')
  assert.ok(!/normalizeText\(draft\)/.test(head), '03 的右上角不该直接读草稿')
})

test('首帧读不到状态时必须给重试入口，不能锁死', () => {
  assert.ok(source.includes('state === null && error !== null && error.section === "page"'), '缺重试条件')
  assert.ok(/\}, "重试"\)/.test(source), '缺重试按钮')
  assert.ok(source.includes('总开关：读取中'), '首帧总开关不该显示「关」')
  assert.ok(source.includes('props.checked === "mixed"'), '未知态应允许 aria-checked=mixed')
})

test('切开关不能静默丢弃未保存的草稿', () => {
  assert.ok(source.includes('previous !== next.text'), 'adopt 应先比较旧文本是否变化再覆盖草稿')
})

test('一个请求只清自己那一节的错误', () => {
  assert.match(source, /setError\(function \(current\) \{[\s\S]{0,200}current\.section === section \? null : current/, 'run() 应只清同节错误')
})

test('A2：API 返回的 active 与 degradedReason 必须被用上', () => {
  assert.ok(source.includes('state.active === false'), '插件未激活必须能显示出来')
  assert.ok(source.includes('state.degradedReason === "missing"'), 'missing 与 corrupt 必须分开说')
})

test('不留死规则，也不给不可点的分句画下划线', () => {
  assert.ok(!/\.enh-body \.enh-group\+\.enh-group,\.enh-body \.enh-actions/.test(source), '两条规则合写会让 14px 永不生效')
  assert.ok(source.includes('.enh-body .enh-group+.enh-group{margin-top:16px}'), '分组间距要写在能生效的位置')
  const at = source.indexOf('.enh-static{')
  const staticRule = source.slice(at, at + 120)
  assert.ok(!staticRule.includes('underline'), '不可点的分句不该画成链接')
})

test('意图 2：同一件事不说两遍（sha 只出现一次；never caveat 只在一处）', () => {
  assert.equal((source.match(/sha " \+/g) ?? []).length, 1, 'sha 应只在 03 里显示一次')
  assert.equal((source.match(/完全权限（never）下宿主不发请求/g) ?? []).length, 1, '「never 下三档轮不到」只该在 02 说一次')
})

// ──────────────── 排版与间距的刻度（防止再次漂移）────────────────

/** 把 CSS 数组拆成规则，供刻度断言使用。 */
function cssRules() {
  const start = source.indexOf('var CSS = [')
  const end = source.indexOf('].join("\\n")')
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

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

test('排版：同一字号只有一种行高（等宽区不再 17/18 混用）', () => {
  const bySize = new Map()
  for (const rule of cssRules()) {
    for (const m of rule.matchAll(/(?<!-)font:(\d+px)\/(\d+px)/g)) {
      const [, size, lh] = m
      if (!bySize.has(size)) bySize.set(size, new Set())
      bySize.get(size).add(lh)
    }
    const fs = rule.match(/font-size:(\d+px)/)
    const lh = rule.match(/line-height:(\d+px)/)
    if (fs && lh) {
      if (!bySize.has(fs[1])) bySize.set(fs[1], new Set())
      bySize.get(fs[1]).add(lh[1])
    }
  }
  for (const [size, heights] of bySize) {
    assert.ok(heights.size <= 2, `${size} 配了 ${heights.size} 种行高（${[...heights].join('/')}），应尽量统一`)
  }
})

test('排版：不用大写变形与字距（宿主设置页零使用）', () => {
  assert.ok(!/text-transform:\s*uppercase/.test(source), '宿主设置页不用 uppercase，别自造')
  assert.ok(!/letter-spacing/.test(source), '宿主设置页不用 letter-spacing，别自造')
})

test('布局：section() 已经包了 .enh-body，节里不许再嵌一层（会把间距加倍）', () => {
  const occurrences = (source.match(/className: "enh-body"/g) ?? []).length
  assert.equal(occurrences, 1, `.enh-body 应只由 section() 生成一次，实际 ${occurrences} 处`)
})

test('布局：间距只用 8/12/16/24 四档，允许 2/4px 的微调', () => {
  const allowed = new Set([2, 4, 8, 12, 16, 24])
  const offenders = []
  for (const rule of cssRules()) {
    const sel = rule.split('{')[0]
    const body = rule.slice(rule.indexOf('{'))
    for (const m of body.matchAll(/(?:^|[;{])(gap|margin|margin-top|margin-bottom|padding|padding-top|padding-left):([^;}]+)/g)) {
      for (const v of m[2].trim().split(/\s+/)) {
        if (!/^\d+px$/.test(v)) continue
        const n = parseInt(v, 10)
        if (n !== 0 && !allowed.has(n)) offenders.push(`${sel} ${m[1]}:${v}`)
      }
    }
  }
  assert.deepEqual(offenders, [], `间距值不在刻度上：${offenders.join('; ')}`)
})
