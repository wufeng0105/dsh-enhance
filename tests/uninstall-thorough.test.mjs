import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { uninstall } from '../uninstall.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function home() {
  const root = mkdtempSync(join(tmpdir(), 'enhance-thorough-'))
  mkdirSync(join(root, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
  return root
}

function install(root, profiles = undefined) {
  const args = ['--home', root, ...(profiles === undefined ? [] : ['--profiles', profiles])]
  const result = run('install.mjs', args)
  assert.equal(result.status, 0, result.stderr)
}

function run(script, args) {
  return spawnSync(process.execPath, [join(repo, script), ...args], { cwd: repo, encoding: 'utf8' })
}

/** `plan:   彻底清理：删 N 份备份（…）` 里的 N。 */
function planBackupCount(stdout) {
  const match = /彻底清理：删 (\d+) 份备份/.exec(stdout)
  return match === null ? undefined : Number(match[1])
}

/** `changed: remove M backups` 里的 M。 */
function changedBackupCount(stdout) {
  const match = /remove (\d+) backups/.exec(stdout)
  return match === null ? undefined : Number(match[1])
}

function backups(root) {
  try {
    return readdirSync(join(root, 'profiles', 'desktop')).filter((name) => name.startsWith('cordis.patch.yml.bak-'))
  } catch {
    return []
  }
}

test('thorough dry-run lists backups and plans no archive', async () => {
  const root = home()
  try {
    install(root)
    const result = await uninstall({ home: root, dryRun: true, thorough: true })
    assert.equal(result.thorough, true)
    assert.ok(result.backups.length > 0)
    assert.ok(result.planned.some((line) => line.includes('彻底清理')))
    assert.ok(result.planned.every((line) => !line.includes('enhance-archive')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('thorough removes enhance dir and both backup families', async () => {
  const root = home()
  try {
    install(root)
    // make a second backup family so both prefixes are exercised
    writeFileSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml.bak-uninstall-1'), 'old\n', 'utf8')
    const result = await uninstall({ home: root, thorough: true })
    assert.equal(result.ok, true)
    assert.equal(existsSync(join(root, 'enhance')), false)
    assert.deepEqual(backups(root), [])
    assert.equal(existsSync(join(root, 'profiles', 'desktop', 'cordis.patch.yml')), true)
    assert.equal(readdirSync(root).some((name) => name.startsWith('enhance-archive-')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('default uninstall archives and keeps backups', async () => {
  const root = home()
  try {
    install(root)
    const result = await uninstall({ home: root })
    assert.equal(result.ok, true)
    assert.equal(existsSync(join(root, 'enhance')), false)
    assert.ok(readdirSync(root).some((name) => name.startsWith('enhance-archive-')))
    assert.ok(backups(root).length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--to with thorough is rejected', async () => {
  const root = home()
  try {
    await assert.rejects(() => uninstall({ home: root, thorough: true, to: join(root, 'x') }), /--thorough/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--to requires an explicit profile', async () => {
  const root = home()
  try {
    await assert.rejects(() => uninstall({ home: root, to: join(root, 'x') }), /显式 --profiles/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 预览的全部意义是「所见即所删」：两次调用的份数必须是同一个数。 */
test('thorough：预览「删 N 份备份」== 实跑 remove M backups，且 .bak-permissions-* 在范围内', () => {
  const root = home()
  try {
    mkdirSync(join(root, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8')
    install(root, 'desktop,web')

    // 历史迁移工具造的那一类备份（工具已删除，旧机器上仍可能有）：彻底清理必须认领
    const permissions = join(root, 'profiles', 'desktop', 'cordis.patch.yml.bak-permissions-20261028T100000')
    writeFileSync(permissions, 'old\n', 'utf8')

    const preview = run('uninstall.mjs', ['--home', root, '--thorough', '--dry-run'])
    assert.equal(preview.status, 0, preview.stderr)
    const planned = planBackupCount(preview.stdout)
    assert.ok(Number.isInteger(planned) && planned > 0, `预览没报份数：\n${preview.stdout}`)
    // 预览只报数、不写盘：备份都还在
    assert.equal(existsSync(permissions), true, '预览不该删任何东西')

    const real = run('uninstall.mjs', ['--home', root, '--thorough'])
    assert.equal(real.status, 0, real.stderr)
    assert.equal(changedBackupCount(real.stdout), planned, `预览 ${planned} 份 / 实跑 ${changedBackupCount(real.stdout)} 份：\n${real.stdout}`)

    assert.deepEqual(backups(root), [])
    assert.equal(existsSync(permissions), false)
    assert.equal(existsSync(join(root, 'enhance')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('thorough：本工具的五类备份都清掉，别人写的 .bak-* 留着', async () => {
  const root = home()
  try {
    install(root)
    const dir = join(root, 'profiles', 'desktop')
    const ours = [
      'cordis.patch.yml.bak-enhance-1',
      'cordis.patch.yml.bak-uninstall-1',
      'cordis.patch.yml.bak-permissions-1',
      'cordis.patch.yml.bak-presetmerge-1',
      'cordis.patch.yml.bak-presetsplit-1',
    ]
    for (const name of [...ours, 'cordis.patch.yml.bak-someoneelse-1']) {
      writeFileSync(join(dir, name), 'old\n', 'utf8')
    }

    const result = await uninstall({ home: root, thorough: true })
    assert.equal(result.ok, true)
    assert.ok(result.changed.some((line) => /^remove \d+ backups$/.test(line)), result.changed.join(' | '))
    // 留下的只有 patch 本身和别人的备份
    assert.deepEqual(readdirSync(dir).sort(), ['cordis.patch.yml', 'cordis.patch.yml.bak-someoneelse-1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
