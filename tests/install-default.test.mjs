import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uninstall } from '../uninstall.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 行首计数：只看真正的键，`# defaultPreset:` 之类的注释不算。 */
const defaultPresetLines = (text) => (text.match(/^[ \t]*defaultPreset:/gm) ?? []).length

function home(profiles) {
  const root = mkdtempSync(join(tmpdir(), 'enhance-install-'))
  for (const profile of profiles) {
    mkdirSync(join(root, 'profiles', profile), { recursive: true })
    writeFileSync(join(root, 'profiles', profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  }
  return root
}

function patch(root, profile) {
  return readFileSync(join(root, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
}

function run(script, args) {
  return spawnSync(process.execPath, [join(repo, script), ...args], { cwd: repo, encoding: 'utf8' })
}

test('原样安装：三行 insert + 权限替换行，官方 fs-observation-policy 不被停用', () => {
  // 硬要求：装完的 patch 里不能有官网 `fs-observation-policy` 的 `disabled: true`，
  // 也不能自己补一行出来 —— 那一行是宿主的，装/卸都不读不写。
  const root = home(['desktop'])
  try {
    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    const text = patch(root, 'desktop')
    for (const id of ['enhance-scope', 'auto-approve', 'enhance-ui']) {
      assert.match(text, new RegExp(`^[ \\t]*-[ \\t]*id: ${id}$`, 'm'), `缺行：${id}`)
    }
    assert.doesNotMatch(text, /fs-observation-policy/)
    assert.match(text, /- insert:\n {4}- id: enhance-permissions/)
    // 三行 insert（不是四行）
    assert.equal((text.match(/^ {4}- id: /gm) ?? []).length, 4, text)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install 不动已存在的官方行：开着就还开着', () => {
  const root = home(['desktop'])
  try {
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), [
      '- id: fs-observation-policy',
      '  config: {}',
      '',
    ].join('\n'), 'utf8')
    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    const text = patch(root, 'desktop')
    assert.match(text, /- id: fs-observation-policy\n {2}config: \{\}/)
    // 官方行没有被加 disabled（`ui-permission` 的 disabled 是权限替换该做的事）
    assert.doesNotMatch(text, /- id: fs-observation-policy\n[^\n]*\n(?: {2}[^\n]*\n)*? {2}disabled:/)
    assert.equal((text.match(/- id: fs-observation-policy/g) ?? []).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('首装的 state.json 只有三个字段', () => {
  const root = home(['desktop'])
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    const state = JSON.parse(readFileSync(join(root, 'enhance', 'state.json'), 'utf8'))
    assert.equal(state.version, 3)
    assert.deepEqual(Object.keys(state).sort(), ['approval', 'contentScope', 'enabled', 'updatedAt', 'version'])
    assert.equal(state.contentScope, true)
    assert.equal(state.approval, 'allow')
    assert.equal(state.enabled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('宿主默认档位是 approval: never 时，首装种 ask（否则装完 doctor 必红）', () => {
  const root = home(['desktop'])
  try {
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), [
      '- id: permission',
      '  name: "@deepseek-ai/dsh-permission-presets"',
      '  config:',
      '    presets:',
      '      danger-full-access:',
      '        sandbox: danger-full-access',
      '        approval: never',
      '    defaultPreset: danger-full-access',
      '',
    ].join('\n'), 'utf8')

    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    const state = JSON.parse(readFileSync(join(root, 'enhance', 'state.json'), 'utf8'))
    assert.equal(state.approval, 'ask')
    assert.match(result.stdout, /warn:.*approval: never/)
    // 已有的 defaultPreset 不被安装器改写
    assert.match(patch(root, 'desktop'), /defaultPreset: danger-full-access/)
    assert.doesNotMatch(patch(root, 'desktop'), /defaultPreset: enhanced/)

    // 装完 doctor 必须绿：本机那条 FAIL 的回归闸
    const doctor = run('doctor.mjs', ['--home', root])
    assert.equal(doctor.status, 0, doctor.stdout)
    assert.match(doctor.stdout, /PASS {2}patch:desktop/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default install touches desktop only', () => {
  const root = home(['desktop', 't1', 'headless'])
  try {
    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    assert.match(patch(root, 'desktop'), /enhance-scope/)
    assert.match(patch(root, 'desktop'), /enhanced:/)
    assert.equal(patch(root, 't1').trim(), '[]')
    assert.equal(patch(root, 'headless').trim(), '[]')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--all installs every existing profile', () => {
  const root = home(['desktop', 't1'])
  try {
    const result = run('install.mjs', ['--home', root, '--all'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(patch(root, 'desktop'), /enhanced:/)
    assert.match(patch(root, 't1'), /enhanced:/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing defaultPreset is not overridden', () => {
  const root = home(['desktop'])
  try {
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), [
      '- id: permission',
      '  name: "@deepseek-ai/dsh-permission-presets"',
      '  config:',
      '    presets:',
      '      read-only:',
      '        approval: ask',
      '    defaultPreset: danger-full-access',
      '',
    ].join('\n'), 'utf8')
    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    const text = patch(root, 'desktop')
    assert.match(text, /enhanced:/)
    assert.match(text, /defaultPreset: danger-full-access/)
    assert.doesNotMatch(text, /defaultPreset: enhanced/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('second install does not duplicate enhanced', () => {
  const root = home(['desktop'])
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    assert.equal((patch(root, 'desktop').match(/enhanced:/g) ?? []).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default uninstall returns desktop to [] and leaves other profiles alone', () => {
  const root = home(['desktop', 't1'])
  try {
    assert.equal(run('install.mjs', ['--home', root]).status, 0)
    const result = run('uninstall.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(patch(root, 'desktop').trim(), '[]')
    assert.equal(patch(root, 't1').trim(), '[]')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default uninstall takes every installed profile from the manifest', () => {
  // `<home>/enhance` 是全局的：只摘 desktop 就把 web 指到一个已经删掉的目录上
  const root = home(['desktop', 'web'])
  try {
    assert.equal(run('install.mjs', ['--home', root, '--profiles', 'desktop,web']).status, 0)
    assert.match(patch(root, 'web'), /enhance-scope/)
    const result = run('uninstall.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(patch(root, 'desktop').trim(), '[]')
    assert.equal(patch(root, 'web').trim(), '[]')
    assert.equal(existsSync(join(root, 'enhance')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default uninstall preview plans every installed profile', async () => {
  // 设置页预览与实跑调的是同一个函数、同一份参数（`{ home, dryRun }`）
  const root = home(['desktop', 'web'])
  try {
    assert.equal(run('install.mjs', ['--home', root, '--profiles', 'desktop,web']).status, 0)
    const preview = await uninstall({ home: root, dryRun: true })
    assert.equal(preview.ok, true)
    assert.ok(preview.planned.some((line) => line.startsWith('desktop:')), preview.planned.join(' | '))
    assert.ok(preview.planned.some((line) => line.startsWith('web:')), preview.planned.join(' | '))
    // 预览不写盘
    assert.match(patch(root, 'web'), /enhance-scope/)
    assert.equal(existsSync(join(root, 'enhance')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default uninstall falls back to the profiles present when the manifest is gone', async () => {
  const root = home(['desktop', 'web'])
  try {
    assert.equal(run('install.mjs', ['--home', root, '--profiles', 'desktop,web']).status, 0)
    rmSync(join(root, 'enhance'), { recursive: true, force: true })
    const result = await uninstall({ home: root })
    assert.equal(result.ok, true)
    // 没有清单就不知道 ui-permission 的归属（按设计保留），但我们插的行必须两个 profile 都摘掉
    assert.doesNotMatch(patch(root, 'desktop'), /enhance-scope/)
    assert.doesNotMatch(patch(root, 'web'), /enhance-scope/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('install keeps a single defaultPreset when it precedes presets', () => {
  // 端到端：装进去，装好的 patch 里只有一个 defaultPreset（重复键会让 profile 起不来）
  const root = home(['desktop'])
  try {
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), [
      '- id: permission',
      '  name: "@deepseek-ai/dsh-permission-presets"',
      '  config:',
      '    defaultPreset: read-only',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '        approval: ask',
      '',
    ].join('\n'), 'utf8')
    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 0, result.stderr)
    const text = patch(root, 'desktop')
    assert.equal(defaultPresetLines(text), 1)
    assert.match(text, /defaultPreset: read-only/)
    assert.match(text, /enhanced:/)
    assert.doesNotMatch(text, /defaultPreset: enhanced/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--to without an explicit --profiles still exits 1', () => {
  const root = home(['desktop', 'web'])
  try {
    assert.equal(run('install.mjs', ['--home', root, '--profiles', 'desktop,web']).status, 0)
    const backup = join(root, 'profiles', 'desktop', 'cordis.patch.yml.bak-enhance-x')
    writeFileSync(backup, '[]\n', 'utf8')
    const result = run('uninstall.mjs', ['--home', root, '--to', backup])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /--to 必须显式 --profiles/)
    // 拒绝时一份 patch 都不该动
    assert.match(patch(root, 'web'), /enhance-scope/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty profile set is refused before anything is written', async () => {
  // 空集落到旧实现上 = 一条 patch 没摘就删全局 `<home>/enhance`，剩下的 profile 全悬空
  const root = home(['desktop', 'web'])
  const bare = mkdtempSync(join(tmpdir(), 'enhance-install-empty-'))
  const backups = () => readdirSync(join(root, 'profiles', 'desktop')).filter((name) => name.startsWith('cordis.patch.yml.bak-')).length
  try {
    assert.equal(run('install.mjs', ['--home', root, '--profiles', 'desktop,web']).status, 0)
    const before = { desktop: patch(root, 'desktop'), web: patch(root, 'web'), backups: backups() }

    // CLI：`--profiles ","` 经 split/trim/filter 之后就是空集
    const cli = run('uninstall.mjs', ['--home', root, '--profiles', ','])
    assert.equal(cli.status, 1)
    assert.match(cli.stderr, /没有 profile 可摘/)
    assert.equal(cli.stderr.trim().split(/\r?\n/).length, 1)

    // API：设置页那条路径传空数组；预览同一份代码，也一样拒绝
    await assert.rejects(() => uninstall({ home: root, profiles: [] }), /没有 profile 可摘/)
    await assert.rejects(() => uninstall({ home: root, dryRun: true, profiles: [] }), /没有 profile 可摘/)
    // `--all` 一个 profile 都没扫到是同一个雷
    await assert.rejects(() => uninstall({ home: bare, all: true }), /没有 profile 可摘/)

    // 拒绝发生在写盘前：两份 patch 逐字节不变、没多出备份、enhance 目录还在
    assert.equal(patch(root, 'desktop'), before.desktop)
    assert.equal(patch(root, 'web'), before.web)
    assert.equal(backups(), before.backups)
    assert.equal(existsSync(join(root, 'enhance')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(bare, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- flow presets 端到端

const FLOW_PATCHES = {
  'flow 空映射': '- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n  config:\n    presets: {}\n    defaultPreset: read-only\n',
  'flow 带内容': '- id: permission\n  config:\n    presets: {read-only: {}}\n    defaultPreset: read-only\n',
  'flow + 行尾注释': '- id: permission\n  config:\n    presets: {}  # 保留\n    defaultPreset: read-only\n',
}

for (const [label, body] of Object.entries(FLOW_PATCHES)) {
  test(`flow presets 端到端：${label} -> install 0、同层 1 个 presets、doctor 0、卸载回到原样`, () => {
    const root = home(['desktop'])
    try {
      const file = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
      writeFileSync(file, body, 'utf8')
      const installed = run('install.mjs', ['--home', root])
      assert.equal(installed.status, 0, installed.stderr)

      const text = patch(root, 'desktop')
      assert.equal((text.match(/^[ \t]*presets[ \t]*:/gm) ?? []).length, 1, `同层 presets 只该 1 个：\n${text}`)
      assert.match(text, /enhanced: \{sandbox: danger-full-access, approval: ask\}/, text)
      assert.match(text, /defaultPreset: read-only/, '已有默认档位不该被顶掉')
      assert.equal(run('doctor.mjs', ['--home', root]).status, 0, `装完 doctor 必须绿：\n${text}`)

      const removed = run('uninstall.mjs', ['--home', root])
      assert.equal(removed.status, 0, removed.stderr)
      assert.equal(patch(root, 'desktop'), body, '卸载必须逐字节回到安装前')
      assert.equal(existsSync(join(root, 'enhance')), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('拒绝路径：认不出安全改法的 patch -> install exit 1、stderr 一行、patch 逐字节不变', () => {
  const root = home(['desktop'])
  try {
    const file = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    // 多行 flow：闭括号在下一行，单行改写无从下手
    const body = '- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n  config:\n    presets: {\n      read-only: {}\n    }\n'
    writeFileSync(file, body, 'utf8')
    const before = readFileSync(file)

    const result = run('install.mjs', ['--home', root])
    assert.equal(result.status, 1, `拒绝必须 exit 1：\n${result.stdout}${result.stderr}`)
    const stderrLines = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
    assert.equal(stderrLines.length, 1, `stderr 应当只有一行：\n${result.stderr}`)
    assert.match(stderrLines[0], /^install: .*presets/)
    assert.doesNotMatch(result.stderr, /Node\.js v|^\s+at /m, '不该吐栈')

    // patch 逐字节不变；连备份、插件目录都不该留下（先探形态、后写盘）
    assert.deepEqual(readFileSync(file), before, 'patch 必须逐字节不变')
    assert.equal(existsSync(join(root, 'enhance')), false, '拒绝时不该留下 enhance/')
    const names = readdirSync(join(root, 'profiles', 'desktop'))
    assert.deepEqual(names, ['cordis.patch.yml'], `拒绝时不该留备份：${names.join(', ')}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('拒绝路径：dry-run 也一样 exit 1（先探形态、与写盘无关）', () => {
  const root = home(['desktop'])
  try {
    const file = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    writeFileSync(file, '- id: permission\n  config:\n    presets: read-only\n', 'utf8')
    const result = run('install.mjs', ['--home', root, '--dry-run'])
    assert.equal(result.status, 1, result.stdout)
    assert.equal(result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '').length, 1)
    assert.equal(existsSync(join(root, 'enhance')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 零可装目标

test('零可装目标：--profiles 空列表 -> exit 1、stderr 一行、一个字节都不写', () => {
  // 旧行为：插件目录/state/manifest 全落盘、patch 一行没加，exit 0，doctor 还全绿。
  const root = home(['desktop'])
  try {
    const file = join(root, 'profiles', 'desktop', 'cordis.patch.yml')
    const before = readFileSync(file)
    const beforeNames = readdirSync(join(root, 'profiles', 'desktop'))
    const result = run('install.mjs', ['--home', root, '--profiles', ','])
    assert.equal(result.status, 1, result.stdout)
    const stderrLines = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
    assert.equal(stderrLines.length, 1, `stderr 应当只有一行：\n${result.stderr}`)
    assert.match(stderrLines[0], /^install: 没有 profile 可装/)
    assert.equal(existsSync(join(root, 'enhance')), false, '拒绝时不该留下 enhance/')
    assert.deepEqual(readFileSync(file), before, 'patch 必须逐字节不变')
    assert.deepEqual(readdirSync(join(root, 'profiles', 'desktop')), beforeNames, '拒绝时不该留备份')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('零可装目标：全是没 patch 的 profile -> 拒绝；至少一个能装则照常（不一刀切）', () => {
  const root = home(['desktop'])
  const absent = mkdtempSync(join(tmpdir(), 'enhance-install-absent-'))
  try {
    const onlyMissing = run('install.mjs', ['--home', root, '--profiles', 'headless'])
    assert.equal(onlyMissing.status, 1, onlyMissing.stdout)
    assert.match(onlyMissing.stderr, /headless 没有 cordis\.patch\.yml/)
    assert.equal(onlyMissing.stderr.trim().split(/\r?\n/).length, 1)
    assert.equal(existsSync(join(root, 'enhance')), false, '被拒时不该留 enhance/')
    assert.equal(patch(root, 'desktop').trim(), '[]', '被拒时 desktop 也不该被动')

    // 混合：desktop 可装、headless 没有 patch -> 装 desktop、headless 打 skipped、exit 0
    const mixed = run('install.mjs', ['--home', root, '--profiles', 'desktop,headless'])
    assert.equal(mixed.status, 0, mixed.stderr)
    assert.match(patch(root, 'desktop'), /enhance-scope/)
    assert.match(mixed.stdout, /profile=headless skipped=no patch/)

    // `--all` 一个 profile 都没扫到 -> 同样是零可装目标
    const all = run('install.mjs', ['--home', absent, '--all'])
    assert.equal(all.status, 1, all.stdout)
    assert.match(all.stderr, /没有 profile 可装/)
    assert.equal(existsSync(join(absent, 'enhance')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(absent, { recursive: true, force: true })
  }
})
