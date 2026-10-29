/**
 * 两个使用者脚本（薄壳 + `scripts/enhance-*.mjs`）的决策与端到端测试。
 *
 * 钉住四件事：
 *   - 安装脚本的四分支决策：没装 / 同版本 / 异版本 / 清单坏了（外加宿主 DSH 没装）；
 *   - 非交互口（`--yes`）在临时 home 上真装、真校验、真更新，且路径含空格可跑；
 *   - 卸载脚本的两个选项：默认归档保留备份 / 彻底清理（不归档、只删自己的备份）；
 *   - 薄壳的用法错只给一行 stderr + exit 1，成功路径不自动重启（只打印提示）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideInstall, readInstalledState, toolVersion } from '../scripts/enhance-lib.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = toolVersion()

/** 假 DSH 根：只建 resources 目录（没有 asar → 代际校验被跳过，正是「没有 asar 的机器」形态）。 */
function fakeDshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'enhance-fake-dsh-'))
  mkdirSync(join(root, 'resources'), { recursive: true })
  return root
}

/** 临时 home：desktop 一份空 patch；`name` 可带空格。 */
function home(name = 'home') {
  const root = mkdtempSync(join(tmpdir(), 'enhance-scripts-'))
  const dir = name === 'home' ? root : join(root, name)
  mkdirSync(join(dir, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
  return dir
}

function runScript(script, args, options = {}) {
  return spawnSync(process.execPath, [join(repo, 'scripts', script), ...args], {
    cwd: repo,
    encoding: 'utf8',
    input: options.input ?? '',
    timeout: 120_000,
  })
}

function runShell(script, args) {
  return spawnSync('pwsh', ['-NoProfile', '-File', join(repo, script), ...args], { cwd: repo, encoding: 'utf8', timeout: 180_000 })
}

const patchOf = (dir) => readFileSync(join(dir, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')

// ---------------------------------------------------------------- 决策（纯函数）

test('决策：没找到 DSH 根 -> host-missing（不自动下载）', () => {
  const dir = home()
  try {
    const decision = decideInstall({ home: dir, dshRoot: undefined, currentVersion: VERSION })
    assert.equal(decision.action, 'host-missing')
    assert.match(decision.detail, /不自动下载安装包/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('决策：没装 -> install；已装同版本 -> verify；异版本 -> update', () => {
  const dsh = fakeDshRoot()
  const dir = home()
  try {
    assert.equal(decideInstall({ home: dir, dshRoot: { root: dsh, hasAsar: false }, currentVersion: VERSION }).action, 'install')
    assert.equal(runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes']).status, 0)
    assert.equal(decideInstall({ home: dir, dshRoot: { root: dsh, hasAsar: false }, currentVersion: VERSION }).action, 'verify')

    // 把清单版本改旧：决策必须变成 update
    const manifestPath = join(dir, 'enhance', 'install-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.toolVersion = '0.0.1'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    const decision = decideInstall({ home: dir, dshRoot: { root: dsh, hasAsar: false }, currentVersion: VERSION })
    assert.equal(decision.action, 'update')
    assert.match(decision.detail, /0\.0\.1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})

test('决策：清单缺失 / 坏 JSON / 无 toolVersion -> broken，并给可执行命令', () => {
  const dsh = fakeDshRoot()
  const dir = home()
  try {
    mkdirSync(join(dir, 'enhance'), { recursive: true })
    let decision = decideInstall({ home: dir, dshRoot: { root: dsh, hasAsar: false }, currentVersion: VERSION })
    assert.equal(decision.action, 'broken')
    assert.match(decision.detail, /uninstall\.mjs --home .*--thorough/)

    writeFileSync(join(dir, 'enhance', 'install-manifest.json'), '{not json', 'utf8')
    decision = decideInstall({ home: dir, dshRoot: { root: dsh, hasAsar: false }, currentVersion: VERSION })
    assert.equal(decision.action, 'broken')

    writeFileSync(join(dir, 'enhance', 'install-manifest.json'), JSON.stringify({ version: 1, profiles: {} }), 'utf8')
    decision = decideInstall({ home: dir, dshRoot: { root: dsh, hasAsar: false }, currentVersion: VERSION })
    assert.equal(decision.action, 'broken')
    assert.match(decision.detail, /toolVersion/)
    assert.equal(readInstalledState(dir).state, 'broken')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 安装脚本：非交互 e2e

test('安装 e2e：未装 -> 装（打印重启行）；同版本 -> 只校验（打印无需重启，patch 一个字节不动）', () => {
  const dsh = fakeDshRoot()
  const dir = home('home with space')
  try {
    const first = runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes'])
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stdout, /请重启 DeepSeek Harness/)
    const manifest = JSON.parse(readFileSync(join(dir, 'enhance', 'install-manifest.json'), 'utf8'))
    assert.equal(manifest.toolVersion, VERSION)
    assert.match(patchOf(dir), /enhance-scope/)
    const patchBefore = patchOf(dir)

    const second = runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes'])
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /无需重启/)
    assert.match(second.stdout, /一致性校验通过/)
    assert.equal(patchOf(dir), patchBefore, '同版本分支不许改 patch')
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})

test('安装 e2e：清单版本变旧 -> 更新（打印重启行），doctor 全 PASS', () => {
  const dsh = fakeDshRoot()
  const dir = home()
  try {
    assert.equal(runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes']).status, 0)
    const manifestPath = join(dir, 'enhance', 'install-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.toolVersion = '0.0.1'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const update = runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes'])
    assert.equal(update.status, 0, update.stdout + update.stderr)
    assert.match(update.stdout, /将更新/)
    assert.match(update.stdout, /请重启 DeepSeek Harness/)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).toolVersion, VERSION)
    assert.equal(spawnSync(process.execPath, [join(repo, 'doctor.mjs'), '--home', dir], { encoding: 'utf8' }).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})

test('安装 e2e：宿主没装 -> exit 1、不下载；清单坏了 -> exit 1 且一个字节都不写', () => {
  const dir = home()
  const missingDsh = join(dir, 'no-such-dsh')
  try {
    const hostMissing = runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', missingDsh, '--yes'])
    assert.equal(hostMissing.status, 1)
    assert.match(hostMissing.stderr, /不自动下载安装包/)
    assert.equal(existsSync(join(dir, 'enhance')), false, '宿主没装时不该写任何东西')

    mkdirSync(join(dir, 'enhance'), { recursive: true })
    const patchBefore = patchOf(dir)
    const broken = runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dir, '--yes'])
    assert.equal(broken.status, 1)
    assert.match(broken.stderr, /拒绝静默跳过/)
    assert.match(broken.stderr, /uninstall\.mjs/)
    assert.equal(patchOf(dir), patchBefore)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安装 e2e：--dry-run 只打印计划，不写文件', () => {
  const dsh = fakeDshRoot()
  const dir = home()
  try {
    const result = runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes', '--dry-run'])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /dry run/)
    assert.equal(existsSync(join(dir, 'enhance')), false)
    assert.equal(patchOf(dir).trim(), '[]')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 卸载脚本：非交互 e2e

test('卸载 e2e：没装 -> exit 0 一行说明；装了 -> 归档保备份；彻底清理不归档', () => {
  const dsh = fakeDshRoot()
  const dir = home()
  try {
    const notInstalled = runScript('enhance-uninstall.mjs', ['--home', dir, '--yes'])
    assert.equal(notInstalled.status, 0)
    assert.match(notInstalled.stdout, /没有可卸载的东西/)

    assert.equal(runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes']).status, 0)
    const remove = runScript('enhance-uninstall.mjs', ['--home', dir, '--yes'])
    assert.equal(remove.status, 0, remove.stdout + remove.stderr)
    assert.match(remove.stdout, /请重启 DeepSeek Harness/)
    assert.equal(existsSync(join(dir, 'enhance')), false)
    assert.equal(readdirSync(dir).filter((name) => name.startsWith('enhance-archive-')).length, 1, '默认卸载要归档')
    assert.ok(readdirSync(join(dir, 'profiles', 'desktop')).some((name) => name.startsWith('cordis.patch.yml.bak-')), '默认卸载要保留备份')
    assert.equal(patchOf(dir).trim(), '[]', '卸载后 patch 回到空数组')

    assert.equal(runScript('enhance-install.mjs', ['--home', dir, '--dsh-root', dsh, '--yes']).status, 0)
    writeFileSync(join(dir, 'profiles', 'desktop', 'cordis.patch.yml.bak-someoneelse-1'), 'old\n', 'utf8')
    const thorough = runScript('enhance-uninstall.mjs', ['--home', dir, '--yes', '--thorough'])
    assert.equal(thorough.status, 0, thorough.stdout + thorough.stderr)
    const archivesAfter = readdirSync(dir).filter((name) => name.startsWith('enhance-archive-'))
    assert.equal(archivesAfter.length, 1, '彻底清理不再新增归档')
    assert.ok(readdirSync(join(dir, 'profiles', 'desktop')).includes('cordis.patch.yml.bak-someoneelse-1'), '别人的 .bak-* 不许碰')
    assert.equal(readdirSync(join(dir, 'profiles', 'desktop')).filter((name) => name.startsWith('cordis.patch.yml.bak-enhance-')).length, 0, '本工具备份要清掉')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 薄壳

test('薄壳：-Yes 非交互跑通安装（路径含空格），用法错 = 一行 stderr + exit 1', () => {
  const dsh = fakeDshRoot()
  const dir = home('shell home')
  try {
    const ok = runShell('enhance-install.ps1', ['-Yes', '-Home', dir, '-DshRoot', dsh])
    assert.equal(ok.status, 0, ok.stdout + ok.stderr)
    assert.match(ok.stdout, /请重启 DeepSeek Harness/)
    assert.match(patchOf(dir), /enhance-scope/)

    const usage = runShell('enhance-install.ps1', ['-Bogus'])
    assert.equal(usage.status, 1)
    const stderrLines = usage.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')
    assert.equal(stderrLines.length, 1, `用法错应当只有一行 stderr：\n${usage.stderr}`)
    assert.match(stderrLines[0], /enhance-install: 未知参数：-Bogus/)

    const remove = runShell('enhance-uninstall.ps1', ['-Yes', '-Home', dir])
    assert.equal(remove.status, 0, remove.stdout + remove.stderr)
    assert.match(remove.stdout, /请重启 DeepSeek Harness/)
    assert.equal(existsSync(join(dir, 'enhance')), false)
  } finally {
    rmSync(join(dir, '..'), { recursive: true, force: true })
    rmSync(dsh, { recursive: true, force: true })
  }
})
