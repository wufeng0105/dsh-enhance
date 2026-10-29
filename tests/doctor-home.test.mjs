/**
 * `doctor --home` 对「干净卸载后的 home」的判定。
 *
 * 卸载干净之后 `<home>/enhance` 整个不存在 —— 那是**未安装**，不是**坏了**。
 * 两件事必须同时成立：
 *   1. 卸载后 `doctor --home` exit 0，四项落盘检查记「未安装（跳过）」；
 *   2. 装坏（目录在、内容缺）时照样红 —— 未安装分支不能把坏装洗白。
 *
 * 第 2 条是这条改动的真正风险：放宽退出码最容易顺手放过「装了但不生效」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 没装任何东西的 home：只有一份空 patch 的 desktop。 */
function home() {
  const root = mkdtempSync(join(tmpdir(), 'enhance-doctor-home-'))
  mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
  return root
}

function run(script, args) {
  return spawnSync(process.execPath, [join(repo, script), ...args], { cwd: repo, encoding: 'utf8' })
}

function doctor(root) {
  return run('doctor.mjs', ['--home', root])
}

/** 一张表里某一行：`PASS/FAIL  <name>  <detail>`。 */
function row(stdout, name) {
  return stdout.split(/\r?\n/).find((line) => new RegExp(`^(PASS|FAIL)\\s+${name}\\s`).test(line))
}

const HOME_CHECKS = ['home-plugins', 'plugin-imports', 'home-text', 'home-state']

function assertUninstalledSkipped(result) {
  assert.doesNotMatch(result.stdout, /^FAIL/m, `不该有 FAIL：\n${result.stdout}`)
  for (const name of HOME_CHECKS) {
    const line = row(result.stdout, name)
    assert.ok(line !== undefined, `缺 ${name} 这一行：\n${result.stdout}`)
    assert.ok(line.startsWith('PASS'), `${name} 不是 PASS：${line}`)
    assert.match(line, /未安装（跳过）/, `${name} 没有记「未安装（跳过）」：${line}`)
  }
}

test('默认卸载后 doctor --home exit 0，四项记未安装（跳过）', () => {
  const root = home()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    assert.equal(doctor(root).status, 0, '装好之后本来就该绿')

    assert.equal(run('uninstall.mjs', ['--home', root]).status, 0)
    assert.equal(existsSync(join(root, 'enhance')), false, '默认卸载应当删掉 enhance/')

    const result = doctor(root)
    assert.equal(result.status, 0, `卸载后 doctor 应当 exit 0：\n${result.stdout}${result.stderr}`)
    assertUninstalledSkipped(result)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('彻底清理后 doctor --home 同样 exit 0（未安装形态与卸载方式无关）', () => {
  const root = home()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    assert.equal(run('uninstall.mjs', ['--home', root, '--thorough']).status, 0)
    assert.equal(existsSync(join(root, 'enhance')), false)

    const result = doctor(root)
    assert.equal(result.status, 0, `彻底清理后 doctor 应当 exit 0：\n${result.stdout}${result.stderr}`)
    assertUninstalledSkipped(result)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('反例：未安装但 ui-permission 的 disabled 还在 → exit 1（卸载残留可见）', () => {
  const root = home()
  try {
    const patch = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    writeFileSync(patch, '- id: ui-permission\n  disabled: true\n', 'utf8')
    const result = doctor(root)
    assert.equal(result.status, 1, `未安装的残留也要红：\n${result.stdout}`)
    assert.match(row(result.stdout, 'patch:desktop') ?? '', /^FAIL.*残留 disabled.*ui-permission/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('反例：删掉一个已装文件（不是卸载）仍然 exit 1', () => {
  const root = home()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    rmSync(join(root, 'enhance', 'enhance-scope', 'index.js'), { force: true })

    const result = doctor(root)
    assert.equal(result.status, 1, `坏装必须红：\n${result.stdout}`)
    assert.match(row(result.stdout, 'home-plugins') ?? '', /^FAIL.*enhance-scope\/index\.js/)
    assert.match(row(result.stdout, 'plugin-imports') ?? '', /^FAIL.*入口缺失/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('反例：enhance/ 目录在但空（半装形态）仍然 exit 1', () => {
  const root = home()
  try {
    mkdirSync(join(root, 'enhance'), { recursive: true })

    const result = doctor(root)
    assert.equal(result.status, 1, `目录在而内容缺必须红：\n${result.stdout}`)
    for (const name of HOME_CHECKS) {
      const line = row(result.stdout, name)
      assert.ok((line ?? '').startsWith('FAIL'), `${name} 应当 FAIL：${line}`)
      assert.doesNotMatch(line ?? '', /未安装（跳过）/, `${name} 不该走未安装分支：${line}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 档位语义 + 重复键

/** 造一份装好的 home；`patch` 返回 desktop 的 patch 路径。 */
function installedHome() {
  const root = mkdtempSync(join(tmpdir(), 'enhance-doctor-semantics-'))
  mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
  return root
}

test('enhanced 的 sandbox 被改成 workspace-write -> exit 1 且文案点名期望值', () => {
  const root = installedHome()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    const patch = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    const good = readFileSync(patch, 'utf8')
    assert.equal(doctor(root).status, 0, '装好本来就该绿')

    // 只改 enhanced 那一档的 sandbox —— 键还在，语义不是了
    const bad = good.replace(/(^[ \t]*enhanced:[ \t]*\r?\n[ \t]*sandbox:[ \t]*)danger-full-access/m, '$1workspace-write')
    assert.notEqual(bad, good, '替换没生效，测试本身写错了')
    writeFileSync(patch, bad, 'utf8')

    const result = doctor(root)
    assert.equal(result.status, 1, `档位语义不符必须红：\n${result.stdout}`)
    const line = row(result.stdout, 'patch:desktop') ?? ''
    assert.match(line, /^FAIL/)
    assert.match(line, /enhanced 档位语义不对/)
    assert.match(line, /sandbox=workspace-write/)
    assert.match(line, /期望 danger-full-access/, `文案要给期望值：${line}`)

    writeFileSync(patch, good, 'utf8')
    assert.equal(doctor(root).status, 0, '改回去必须绿')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('enhanced 的 approval 被改成 never -> exit 1（期望 ask）', () => {
  const root = installedHome()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    const patch = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    const good = readFileSync(patch, 'utf8')
    const bad = good.replace(/(^[ \t]*enhanced:[ \t]*\r?\n[ \t]*sandbox:[ \t]*danger-full-access\r?\n[ \t]*approval:[ \t]*)ask/m, '$1never')
    assert.notEqual(bad, good, '替换没生效')
    writeFileSync(patch, bad, 'utf8')
    const result = doctor(root)
    assert.equal(result.status, 1, result.stdout)
    assert.match(row(result.stdout, 'patch:desktop') ?? '', /enhanced 档位语义不对.*approval=never.*期望 ask/)
    writeFileSync(patch, good, 'utf8')
    assert.equal(doctor(root).status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('flow 写法写进去的 enhanced 也算「在」，且语义照样验', () => {
  const root = installedHome()
  try {
    // 安装器会保留 flow 风格，把 enhanced 追加进 flow 映射
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n  config:\n    presets: {}\n    defaultPreset: read-only\n', 'utf8')
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    const patch = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    const text = readFileSync(patch, 'utf8')
    assert.match(text, /enhanced: \{sandbox: danger-full-access, approval: ask\}/, text)
    assert.equal(doctor(root).status, 0, `flow 写法装完必须绿：\n${text}`)

    // flow 里的语义同样要验
    writeFileSync(patch, text.replace('sandbox: danger-full-access, approval: ask', 'sandbox: workspace-write, approval: ask'), 'utf8')
    const result = doctor(root)
    assert.equal(result.status, 1, result.stdout)
    assert.match(row(result.stdout, 'patch:desktop') ?? '', /enhanced 档位语义不对.*sandbox=workspace-write/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('同层两个 presets -> exit 1，文案含键名与行号；删掉一处 -> exit 0', () => {
  const root = installedHome()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    const patch = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    const good = readFileSync(patch, 'utf8')
    // 手工造重复：在块风格 presets 前面再插一行 flow presets
    const duplicated = good.replace(/^(    presets:)/m, '    presets: {}\n$1')
    assert.notEqual(duplicated, good, '注入重复键失败')
    writeFileSync(patch, duplicated, 'utf8')

    const result = doctor(root)
    assert.equal(result.status, 1, `重复键必须红：\n${result.stdout}`)
    const line = row(result.stdout, 'dup-keys:desktop') ?? ''
    assert.match(line, /^FAIL/)
    assert.match(line, /presets/, `要指出键名：${line}`)
    assert.match(line, /第 \d+ 行/, `要指出行号：${line}`)

    writeFileSync(patch, good, 'utf8')
    const clean = doctor(root)
    assert.equal(clean.status, 0, clean.stdout)
    assert.match(row(clean.stdout, 'dup-keys:desktop') ?? '', /^PASS/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('重复键在「未安装」的 patch 上也看得见（不只开关装分支）', () => {
  const root = installedHome()
  try {
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: other\n  config:\n    mode: ask\n    mode: never\n', 'utf8')
    const result = doctor(root)
    assert.equal(result.status, 1, result.stdout)
    assert.match(row(result.stdout, 'dup-keys:desktop') ?? '', /^FAIL.*mode.*第 4 行/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 不误报：这四种形状在 YAML 里都合法，重复的「键」分属不同映射或根本不是键。 */
const NOT_DUPLICATES = [
  ['两个 list 条目各有 config', '- id: a\n  config:\n    x: 1\n- id: b\n  config:\n    x: 2\n'],
  ['块标量正文里的同名行', '- id: a\n  personaSuffix: |\n    note: hi\n    note: again\n'],
  ['注释里的同名行', '# note: a\n# note: b\n- id: a\n  config: {}\n'],
  ['两个兄弟键各有一个 x', '- id: a\n  config:\n    x: 1\n  other:\n    x: 2\n'],
]

for (const [label, body] of NOT_DUPLICATES) {
  test(`不误报：${label}`, () => {
    const root = installedHome()
    try {
      writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), body, 'utf8')
      const result = doctor(root)
      assert.match(row(result.stdout, 'dup-keys:desktop') ?? '', /^PASS/, `${label} 被误判：\n${result.stdout}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('只接过权限线的旧 home（enhance/ 里只有清单）doctor exit 0，不误判半装', () => {
  // 历史迁移工具（已删除）只改 patch + 记清单，不装插件。那种 home 的 enhance/ 里只有一个
  // install-manifest.json；把它当「半装」判红会让人以为装坏了。这里手写出那个形态，
  // 因为旧机器上它仍然存在（工具没了，状态还在）。
  const root = home()
  try {
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), '- id: ui-permission\n  disabled: true\n', 'utf8')
    mkdirSync(join(root, 'enhance'), { recursive: true })
    writeFileSync(join(root, 'enhance', 'install-manifest.json'), JSON.stringify({
      version: 1,
      profiles: { web: { uiPermissionDisabled: true, uiPermissionAction: 'added' } },
    }, null, 2), 'utf8')
    assert.deepEqual(readdirSync(join(root, 'enhance')), ['install-manifest.json'])
    const result = doctor(root)
    assert.equal(result.status, 0, `只接线不该判红：\n${result.stdout}`)
    for (const name of ['home-plugins', 'plugin-imports', 'home-text', 'home-state']) {
      const line = row(result.stdout, name) ?? ''
      assert.ok(line.startsWith('PASS'), `${name} 应当 PASS：${line}`)
      assert.match(line, /只接过权限线/, `${name} 文案要说明是接线形态：${line}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('接线的 home 一旦有别的文件，仍按装过检查（不把半装洗白）', () => {
  const root = home()
  try {
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), '- id: ui-permission\n  disabled: true\n', 'utf8')
    mkdirSync(join(root, 'enhance'), { recursive: true })
    writeFileSync(join(root, 'enhance', 'install-manifest.json'), JSON.stringify({
      version: 1,
      profiles: { web: { uiPermissionDisabled: true, uiPermissionAction: 'added' } },
    }, null, 2), 'utf8')
    // 多出一个文件（例如插件目录只建了一半）：就不该再走「只接线」分支
    mkdirSync(join(root, 'enhance', 'enhance-scope'), { recursive: true })
    const result = doctor(root)
    assert.equal(result.status, 1, `目录里多了东西就不该 PASS：\n${result.stdout}`)
    assert.match(row(result.stdout, 'home-plugins') ?? '', /^FAIL/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 超限文本与零目标安装的门禁侧

test('反例：已装文本超过 8 KB 上限 -> exit 1，home-text 点名上限', () => {
  // README 让用户直接改这个文件；只报「读得到」会让超限文本在 doctor 全绿时被整段注入。
  const root = home()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    writeFileSync(join(root, 'enhance', 'content-scope.txt'), 'x'.repeat(9216), 'utf8')
    const result = doctor(root)
    assert.equal(result.status, 1, `超限文本必须红：\n${result.stdout}`)
    assert.match(row(result.stdout, 'home-text') ?? '', /^FAIL.*上限/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('反例：装了插件但没有任何 profile 引用它 -> exit 1（绿色空操作看得见）', () => {
  // install 的零目标已经被拒；这条守的是「历史遗留 / 手改出来的空接线」形态：
  // enhance/ 有插件、patch 却一行没有 —— 宿主不会加载任何东西。
  const root = home()
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
    const result = doctor(root)
    assert.equal(result.status, 1, `未接线的安装必须红：\n${result.stdout}`)
    assert.match(row(result.stdout, 'profiles-wired') ?? '', /^FAIL.*没有任何 profile/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
