/**
 * `tools/compat-diff.mjs` 的离线测试：fixture 全本地，零网络。
 *
 * fixture 是临时目录里的真 git 仓库（`git init` + 两 tag），文件按 9 个核验包的路径
 * 布局摆放——工具按 docs/compatibility.md 第 2 步的包清单列变更，fixture 文件必须
 * 落在这些路径下才会被数进去：
 *   - `packages/core/system-prompt/src/seam.ts`：两 tag 间变更，内容含
 *     `ctx.on('approval/request')` → SEAM-HIT（cordis 插件 API）；
 *   - `packages/client/ui-settings-general/src/visual.css`：变更，含 `--dsw-x` →
 *     SEAM-HIT（宿主视觉 token，且不重复报 `--ds-`）；
 *   - `packages/boot/plugin-manager/src/notes.md`：变更，无接缝关键词 → SKIM；
 *   - 其余 6 包各一个两 tag 不变的占位文件 → --trees 模式的 ALL-SAME 面。
 *
 * 断言：changed-files 行（行级精确）、SEAM-HIT/SKIM 分类、--out 的 diff 内容、
 * --trees 的 ALL-SAME 与短 SHA、以及三个负例（坏 --repo 路径、无缓存无 --repo、
 * 本地路径 repo 缺 tag）都给可操作提示并退出非零。测试内没有任何网络依赖。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, dedupePrefixHits, SEAM_GROUPS } from '../tools/compat-diff.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 跑仓库里的 compat-diff CLI，返回退出码与两个流；非零退出不抛，交给断言判。 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, ['tools/compat-diff.mjs', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    }
  }
}

// ---------- fixture：临时 git 仓库，两 tag ----------

const OLD_TAG = 'dsh-v0.2.1-rc.5'
const NEW_TAG = 'dsh-v0.2.2-rc.1'
const KEEP_PKGS = [
  'packages/host/webserver/src',
  'packages/interaction/user-approval/src',
  'packages/interaction/permission-presets/src',
  'packages/client/ui-settings/src',
  'packages/client/ui-permission-presets/src',
  'packages/boot/app-boot/src',
]

function gitIn(dir, args, env = process.env) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** fixture 内的提交用一次性身份与环境，不依赖也不污染本机的 git 全局配置。 */
function commitAll(dir, message, env) {
  gitIn(dir, ['add', '-A'], env)
  execFileSync('git', ['-C', dir, '-c', 'user.name=compat-diff-fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', message], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'compat-diff-fixture-'))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
  gitIn(dir, ['init', '-b', 'main'], env)

  const put = (path, content) => {
    const file = join(dir, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  // tag 1（rc.5）：9 个核验包各有一个文件
  put('packages/core/system-prompt/src/seam.ts', "export const bind = (ctx) => ctx.on('approval/request', async () => {})\n")
  put('packages/client/ui-settings-general/src/visual.css', ':root {\n  --dsw-x: 1;\n}\n')
  put('packages/boot/plugin-manager/src/notes.md', '# notes\n\nv1 plain text\n')
  for (const pkg of KEEP_PKGS) put(`${pkg}/keep.ts`, 'export const keep = true\n')
  commitAll(dir, 'tag 1', env)
  gitIn(dir, ['tag', OLD_TAG], env)

  // tag 2（rc.1）：两个 SEAM-HIT 文件加一行、SKIM 文件改文字，其余不动
  put('packages/core/system-prompt/src/seam.ts', "export const bind = (ctx) => ctx.on('approval/request', async () => {})\nctx.effect(() => { /* bump */ })\n")
  put('packages/client/ui-settings-general/src/visual.css', ':root {\n  --dsw-x: 1;\n}\n\n.b {\n  --dsw-y: 2;\n}\n')
  put('packages/boot/plugin-manager/src/notes.md', '# notes\n\nv2 still plain text\n')
  commitAll(dir, 'tag 2', env)
  gitIn(dir, ['tag', NEW_TAG], env)

  return dir
}

const fixture = makeFixture()
test.after(() => {
  rmSync(fixture, { recursive: true, force: true })
})

// ---------- 单元：表达式表与预分类 ----------

test('SEAM_GROUPS：8 组，组名与 pattern 形状齐', () => {
  assert.equal(SEAM_GROUPS.length, 8)
  for (const { group, pattern } of SEAM_GROUPS) {
    assert.equal(typeof group, 'string')
    assert.ok(group.length > 0)
    assert.equal(typeof pattern, 'string')
    assert.ok(pattern.length > 0)
    for (const atom of pattern.split('|')) assert.ok(atom.length > 0, `${group} 里有空原子`)
  }
})

test('classify：--dsw- 命中且不重复报 --ds-，短前缀单独在场保留', () => {
  assert.deepEqual(dedupePrefixHits(['--dsw-', '--ds-']), ['--dsw-'])
  assert.deepEqual(dedupePrefixHits(['--ds-']), ['--ds-'])
  const groups = classify(':root {\n  --dsw-x: 1;\n}\n')
  assert.deepEqual(groups, ['宿主视觉 token'])
  assert.deepEqual(classify('.a { --ds-y: 1; }'), ['宿主视觉 token'], '只有短前缀时不丢')
})

test('classify：seam 文件命中组，无接缝文本零命中', () => {
  assert.deepEqual(classify("ctx.on('approval/request')\n"), ['cordis 插件 API'])
  assert.deepEqual(classify('# notes\n\nv2 still plain text\n'), [])
})

// ---------- 主模式 ----------

test('主模式：changed-files 行 + SEAM-HIT/SKIM 分类 + 边界句', () => {
  const { code, stdout, stderr } = runCli([OLD_TAG, NEW_TAG, '--repo', fixture])
  assert.equal(code, 0, `应退出 0：${stderr}`)
  const lines = stdout.split(/\r?\n/).filter((line) => line !== '')
  assert.ok(lines.includes(`changed-files: 3`), `数量行要行级精确，实际输出：\n${stdout}`)
  assert.ok(lines.includes(`SEAM-HIT cordis 插件 API\tpackages/core/system-prompt/src/seam.ts`), stdout)
  assert.ok(lines.includes(`SEAM-HIT 宿主视觉 token\tpackages/client/ui-settings-general/src/visual.css`), stdout)
  assert.ok(lines.includes(`SKIM\tpackages/boot/plugin-manager/src/notes.md`), stdout)
  assert.equal(lines.at(-1), '预分类是分诊不是判决，SKIM 不等于免检')
})

test('主模式 --out：逐文件统一 diff 落盘且内容可读', () => {
  const outDir = join(fixture, '..', 'compat-diff-out')
  rmSync(outDir, { recursive: true, force: true })
  const { code, stderr } = runCli([OLD_TAG, NEW_TAG, '--out', outDir, '--repo', fixture])
  assert.equal(code, 0, `应退出 0：${stderr}`)
  const diffs = readdirSync(outDir).filter((name) => name.endsWith('.diff'))
  assert.equal(diffs.length, 3)
  const seamDiff = readFileSync(join(outDir, 'packages_core_system-prompt_src_seam.ts.diff'), 'utf8')
  assert.ok(seamDiff.includes('diff --git'), '统一 diff 头')
  assert.ok(seamDiff.includes('approval/request'), 'seam 关键词出现在 diff 上下文里')
  assert.ok(seamDiff.includes('+ctx.effect'), '新增行在 diff 里')
  const cssDiff = readFileSync(join(outDir, 'packages_client_ui-settings-general_src_visual.css.diff'), 'utf8')
  assert.ok(cssDiff.includes('+  --dsw-y: 2;'), 'CSS 变更行在 diff 里')
  rmSync(outDir, { recursive: true, force: true })
})

// ---------- --trees 模式 ----------

test('--trees：变更包出两短 SHA，不变包 ALL-SAME，全程本地', () => {
  const { code, stdout, stderr } = runCli(['--trees', `${OLD_TAG},${NEW_TAG}`, '--repo', fixture])
  assert.equal(code, 0, `应退出 0：${stderr}`)
  const lines = stdout.split(/\r?\n/).filter((line) => line !== '')
  assert.equal(lines.filter((line) => line.includes('\tALL-SAME')).length, 6, stdout)
  const changed = lines.find((line) => line.startsWith('packages/core/system-prompt/src\t'))
  assert.ok(changed !== undefined, 'system-prompt 在两 tag 间 tree 不同')
  const shas = changed.split('\t')[1].split(' ')
  assert.equal(shas.length, 2)
  assert.notEqual(shas[0], shas[1])
  assert.ok(shas.every((sha) => /^[0-9a-f]{12}$/.test(sha)), '短 SHA 形状')
  assert.equal(lines.at(-1), '预分类是分诊不是判决，SKIM 不等于免检')
})

// ---------- 负例：三类都要可操作地红 ----------

test('负例：--repo 指向不存在的路径 → 退出 1 且指路', () => {
  const { code, stderr } = runCli([OLD_TAG, NEW_TAG, '--repo', join(fixture, 'no-such-repo')])
  assert.equal(code, 1)
  assert.ok(stderr.includes('--repo'), stderr)
})

test('负例：无缓存且未指 --repo → 退出 1 且给出可操作的建缓存命令', () => {
  const emptyCache = join(fixture, '..', 'compat-diff-empty-cache', 'dsh-upstream.git')
  const { code, stderr } = runCli([OLD_TAG, NEW_TAG, '--cache', emptyCache])
  assert.equal(code, 1)
  assert.ok(stderr.includes('git clone'), stderr)
  assert.ok(stderr.includes('--filter=blob:none'), stderr)
})

test('负例：本地路径 repo 缺 tag → 退出 1 且说明不自动 fetch', () => {
  const { code, stderr } = runCli(['dsh-v9.9.9', NEW_TAG, '--repo', fixture])
  assert.equal(code, 1)
  assert.ok(stderr.includes('不自动 fetch'), stderr)
})

test('fixture：9 个包路径与占位文件都在盘上（防 fixture 静默缩水）', () => {
  for (const pkg of KEEP_PKGS) assert.ok(existsSync(join(fixture, pkg, 'keep.ts')), pkg)
  assert.ok(existsSync(join(fixture, 'packages/core/system-prompt/src/seam.ts')))
  assert.ok(existsSync(join(fixture, 'packages/client/ui-settings-general/src/visual.css')))
  assert.ok(existsSync(join(fixture, 'packages/boot/plugin-manager/src/notes.md')))
  assert.equal(readFileSync(join(fixture, 'packages/client/ui-settings-general/src/visual.css'), 'utf8').includes('--dsw-x: 1'), true)
})
