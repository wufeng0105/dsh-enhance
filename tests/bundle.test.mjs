/**
 * bundle 形态的契约测试：仓库能被 `dsh plugin add` 安装。
 *
 * 三件事：
 *   1. `package.json` 声明 `dsh.bundle.patch`，根 patch 里的 insert 名都能解析到文件；
 *   2. 包内默认文本与仓库根的 `content-scope.txt` 逐字节一致（防止两条安装路径的种子漂移）；
 *   3. 插件首次加载用的 `ensureEnhanceData()` 是幂等的：缺文件才种，已有不覆盖，
 *      审批按宿主默认档位（`never` → `ask`，否则 `allow`）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideApprovalSeed, ensureEnhanceData } from '../shared/seed.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json 声明 dsh.bundle.patch，且 insert 名都能解析到文件', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  const declared = pkg?.dsh?.bundle?.patch
  const patches = typeof declared === 'string' ? [declared] : declared
  assert.ok(Array.isArray(patches) && patches.length > 0, '缺 dsh.bundle.patch')

  let rows = 0
  for (const file of patches) {
    const lines = readFileSync(join(repo, file), 'utf8').split(/\r?\n/)
    let id
    for (const line of lines) {
      const idMatch = /^[ \t]*-[ \t]*id:[ \t]*(\S+)/.exec(line)
      if (idMatch !== null) {
        id = idMatch[1]
        continue
      }
      const nameMatch = /^[ \t]+name:[ \t]*['"]?([^'"\s]+)/.exec(line)
      if (nameMatch === null || id === undefined) continue
      const target = nameMatch[1]
      assert.ok(target.startsWith(`${pkg.name}/`), `insert ${id} 的 name 不是本包路径：${target}`)
      assert.ok(existsSync(join(repo, target.slice(pkg.name.length + 1))), `insert ${id} 指向不存在的文件`)
      rows += 1
      id = undefined
    }
  }
  assert.ok(rows > 0, 'patch 里没有任何 insert 行')
})

test('包内默认文本与仓库根 content-scope.txt 一致', () => {
  assert.deepEqual(
    readFileSync(join(repo, 'shared', 'content-scope.default.txt')),
    readFileSync(join(repo, 'content-scope.txt')),
  )
})

test('decideApprovalSeed：默认档位是 never 就种 ask，否则 allow', () => {
  assert.deepEqual(decideApprovalSeed([]), { approval: 'allow', blockedBy: undefined })
  assert.equal(decideApprovalSeed([{ profile: 't1', text: '[]\n' }]).approval, 'allow')

  const never = [
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '    defaultPreset: danger-full-access',
    '',
  ].join('\n')
  const seed = decideApprovalSeed([{ profile: 't1', text: never }])
  assert.equal(seed.approval, 'ask')
  assert.equal(seed.blockedBy, 't1:danger-full-access')
})

test('ensureEnhanceData：缺文件才种，已有不覆盖', () => {
  const template = join(repo, 'shared', 'content-scope.default.txt')
  const home = mkdtempSync(join(tmpdir(), 'enhance-seed-'))
  try {
    mkdirSync(join(home, 'profiles', 't1'), { recursive: true })
    writeFileSync(join(home, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')
    const first = ensureEnhanceData(home, template)
    assert.equal(first.textSeeded, true)
    assert.equal(first.stateSeeded, true)
    assert.deepEqual(readFileSync(join(home, 'enhance', 'content-scope.txt')), readFileSync(template))
    const state = JSON.parse(readFileSync(join(home, 'enhance', 'state.json'), 'utf8'))
    assert.equal(state.approval, 'allow')
    assert.equal(state.enabled, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  const home2 = mkdtempSync(join(tmpdir(), 'enhance-seed2-'))
  try {
    mkdirSync(join(home2, 'enhance'), { recursive: true })
    writeFileSync(join(home2, 'enhance', 'content-scope.txt'), 'my own text', 'utf8')
    writeFileSync(join(home2, 'enhance', 'state.json'), JSON.stringify({ version: 3, enabled: false, contentScope: false, approval: 'deny' }), 'utf8')
    const result = ensureEnhanceData(home2, template)
    assert.equal(result.textSeeded, false)
    assert.equal(result.stateSeeded, false)
    assert.equal(readFileSync(join(home2, 'enhance', 'content-scope.txt'), 'utf8'), 'my own text')
    assert.equal(JSON.parse(readFileSync(join(home2, 'enhance', 'state.json'), 'utf8')).approval, 'deny')
  } finally {
    rmSync(home2, { recursive: true, force: true })
  }
})
