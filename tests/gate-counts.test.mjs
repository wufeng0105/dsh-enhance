/**
 * 门禁读数必须等于仓库事实。
 *
 * `syntax` 门禁的「N files」是给人看的读数：它一旦把被 `.gitignore` 排除的本地件
 * （`design/`）算进去，报出来的数就比 `git ls-files` 多 1 —— 一个对不上的数字会让
 * 整行读数失去意义（读到 33 时没人知道多的是哪一个）。
 *
 * 这里直接钉 `scripts/code-files.mjs`（门禁的唯一实现），不起整条 fast 层：
 * 那是 30 s 起步的开销，而这条判据本身只关心「集合怎么来的」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKIP_DIRS, codeFiles } from '../scripts/code-files.mjs'
import { copyRepoTree } from '../scripts/repo-copy.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const git = (args, cwd = repo) => spawnSync('git', args, { cwd, encoding: 'utf8' })

/**
 * 仓库副本：带上 `.git`，`git ls-files` 才有得比。
 *
 * 复制走 `copyRepoTree(..., { includeGit: true })`——按 `git ls-files` 复制，不是
 * 整目录 `cpSync`。原先那种写法会把本地克隆的 `ZCode/`（3 GB / 3.6 万文件）一起搬，
 * 这一条测试因此要跑 200 s+，连带 tests 门禁在 120 s 超时处误报。
 */
function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'enhance-counts-'))
  return copyRepoTree(repo, dir, { includeGit: true })
}

/** 走盘数一遍（独立于被测实现，用来做交叉核对）。 */
function walkCount(base) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) out.push(path)
    }
  }
  walk(base)
  return out
}
test('codeFiles == git ls-files 的 .mjs/.js 数（门禁报的就是这个数）', () => {
  const tracked = git(['ls-files', '*.mjs', '*.js'], repo)
  assert.equal(tracked.status, 0, tracked.stderr)
  const expected = tracked.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  assert.ok(expected.length > 0, 'git ls-files 没给出任何文件')

  const actual = codeFiles(repo).map((path) => relative(repo, path).split(sep).join('/'))
  assert.deepEqual(actual.slice().sort(), expected.slice().sort(), '门禁的集合与 tracked 不一致')
  assert.equal(actual.length, expected.length)
})

test('被 .gitignore 排除的 design/ 不进集合（放了坏文件也不进）', () => {
  const copy = copyRepo()
  try {
    const ignored = git(['check-ignore', 'design/preview-server.mjs'], copy)
    assert.equal(ignored.status, 0, `副本里 design/ 应当仍被忽略：${ignored.stdout}${ignored.stderr}`)

    // 造一个语法坏掉的本地件：它被忽略，就不该被语法门禁看到
    mkdirSync(join(copy, 'design'), { recursive: true })
    writeFileSync(join(copy, 'design', 'zz-broken.mjs'), 'const broken =\n', 'utf8')
    assert.equal(existsSync(join(copy, 'design', 'zz-broken.mjs')), true)

    const files = codeFiles(copy).map((path) => relative(copy, path).split(sep).join('/'))
    assert.equal(files.some((path) => path.startsWith('design/')), false, `design/ 不该在集合里：${files.filter((p) => p.startsWith('design/')).join(', ')}`)
    assert.equal(files.some((path) => path.endsWith('zz-broken.mjs')), false)

    const tracked = git(['ls-files', '*.mjs', '*.js'], copy).stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
    assert.equal(files.length, tracked.length, '加一个被忽略的坏文件不该改变集合大小')
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})

test('没有 git 时退回走盘，仍跳过 design/ 与 node_modules', () => {
  // 走盘的口径与 git 不同（看得见未跟踪的新文件），所以这里不拿 `git ls-files` 当基准：
  // 要钉的是「被忽略的目录不进集合」，由 walkCount 这套同规则实现交叉核对。
  const copy = copyRepo()
  try {
    rmSync(join(copy, '.git'), { recursive: true, force: true })
    mkdirSync(join(copy, 'design'), { recursive: true })
    writeFileSync(join(copy, 'design', 'zz-broken.mjs'), 'const broken =\n', 'utf8')

    const files = codeFiles(copy)
    assert.equal(files.some((path) => path.includes(`${sep}design${sep}`)), false, '走盘兜底必须跳过 design/')
    const expected = walkCount(copy)
    assert.equal(files.length, expected.length, `兜底路径数的不是「除忽略目录外的 .mjs/.js」：${files.length} vs ${expected.length}`)
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
})
