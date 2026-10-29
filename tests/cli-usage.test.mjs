/**
 * 用法错的门禁：列出的入口在缺值 / 未知参数时 → **stderr 一行、exit 1、不吐栈**。
 *
 * 为什么值得单独钉住：「用法错不吐栈」是仓库级纪律，而栈 + `Node.js v`
 * 会让人以为脚本崩了，而不是「你把参数写错了」。缺值还有更坏的一种旧形态——
 * 直接 `resolve(undefined)`，首行是裸 `node:path` 的 TypeError。
 *
 * 正常路径不进这里：install/doctor/uninstall 的端到端由 `install-default`、
 * `uninstall*`、`scripts/check.mjs` 的 lifecycle 门禁各自钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(args, cwd = repo) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' })
}

/** 六个入口（install / doctor / uninstall / build-client / graph / docs-check）的用法错矩阵。 */
const USAGE_ERRORS = [
  ['install.mjs', ['--home']],
  ['install.mjs', ['--profiles']],
  ['install.mjs', ['--restore']],
  ['install.mjs', ['--bogus']],
  ['doctor.mjs', ['--home']],
  ['doctor.mjs', ['--bogus']],
  ['uninstall.mjs', ['--home']],
  ['uninstall.mjs', ['--bogus']],
  ['enhance-permissions/build-client.mjs', ['--asar']],
  ['enhance-permissions/build-client.mjs', ['--app']],
  ['enhance-permissions/build-client.mjs', ['--bogus']],
  ['tools/graph.mjs', ['--root']],
  ['tools/graph.mjs', ['--bogus']],
  ['tools/docs-check.mjs', ['--root']],
  ['tools/docs-check.mjs', ['--bogus']],
]

for (const [script, args] of USAGE_ERRORS) {
  test(`用法错单行 exit 1：node ${script} ${args.join(' ')}`, () => {
    const result = run([script, ...args])
    const where = `${script} ${args.join(' ')}`
    const stderrLines = result.stderr.split(/\r?\n/).filter((line) => line.trim() !== '')

    assert.equal(result.status, 1, `${where} → exit=${result.status}\n${result.stderr}`)
    assert.equal(stderrLines.length, 1, `${where} → stderr 应当只有一行：\n${result.stderr}`)
    assert.doesNotMatch(result.stderr, /Node\.js v/, `${where} → 吐了 Node 版本尾巴`)
    assert.doesNotMatch(result.stderr, /^\s+at /m, `${where} → 吐了栈帧`)
    assert.doesNotMatch(result.stderr, /node:path|TypeError/, `${where} → 还是裸 TypeError`)
    // `入口: 原因` 的形状；原因必须是「需要一个值」或「未知参数」
    assert.match(stderrLines[0], /^[\w.-]+: (.*需要一个值|未知参数：.+)$/, `${where} → 消息形状不对：${stderrLines[0]}`)
    // 用法错在任何输出之前就该结束
    assert.equal(result.stdout, '', `${where} → 用法错还打了 stdout：${result.stdout}`)
  })
}

test('正常路径不受影响：四个只读入口仍 exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'enhance-usage-'))
  try {
    mkdirSync(join(root, 'profiles', 't1'), { recursive: true })
    writeFileSync(join(root, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')

    const cases = [
      ['doctor.mjs'],
      ['tools/graph.mjs', '--check'],
      ['tools/docs-check.mjs', '--root', repo],
      ['install.mjs', '--home', root, '--profiles', 't1', '--dry-run'],
    ]
    for (const args of cases) {
      const result = run(args)
      assert.equal(result.status, 0, `node ${args.join(' ')} → exit=${result.status}\n${result.stdout}${result.stderr}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
