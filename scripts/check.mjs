#!/usr/bin/env node
/**
 * 门禁总入口。
 *
 * 分层：
 *   fast  version、syntax、tests、graph（结构）、docs、bundle
 *   full  fast + 有 docs/generated 时的 graph --strict
 *
 * 每道门禁都必须能红。`--self-test` 用一次性副本证明这一点：坏语法文件、坏测试、
 * 未登记的源文件、死链、坏 bundle 声明、超限文本。
 *
 * 用法：
 *   node scripts/check.mjs [--layer fast|full] [--self-test]
 *
 * 退出码：0 请求的门禁全过 / 自检全部能红；1 有门禁失败或负例没能变红；2 用法错。
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeFiles as codeFilesIn } from './code-files.mjs'
import { copyRepoTree } from './repo-copy.mjs'
import { basisLabel, declarationOf, displayRange, inRange, parseEnginesDsh } from '../shared/compat.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const node = process.execPath

/** 仓库的 tests 数有一个地板：防「大批删除仍 exit 0」。 */
const TEST_FLOOR = 50

const args = process.argv.slice(2)
const layerIndex = args.indexOf('--layer')
const layer = layerIndex >= 0 ? args[layerIndex + 1] : 'fast'
const selfTest = args.includes('--self-test')
const dshVersionIndex = args.indexOf('--dsh-version')
const dshVersion = dshVersionIndex >= 0 ? args[dshVersionIndex + 1] : undefined

if (layerIndex >= 0 && args[layerIndex + 1] === undefined) {
  console.error('check: --layer needs a value')
  process.exit(2)
}
if (dshVersionIndex >= 0 && (dshVersion === undefined || dshVersion.startsWith('--'))) {
  console.error('check: --dsh-version needs a value')
  process.exit(2)
}
if (layerIndex >= 0 && !['fast', 'full'].includes(layer)) {
  console.error(`check: unknown --layer ${layer}`)
  process.exit(2)
}

/** Run one Node command and collect both streams. */
function run(toolArgs, cwd = root, timeout = 120_000) {
  const result = spawnSync(node, toolArgs, { cwd, encoding: 'utf8', timeout })
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    signal: result.signal ?? null,
  }
}

/**
 * Code files the syntax gate covers.
 *
 * 实现挪到 `scripts/code-files.mjs`：那个集合是判据（门禁报的数必须等于仓库里的数），
 * 只留一处实现，测试才能直接钉住它而不用起整条 fast 层。
 * @param {string} [base]
 * @returns {string[]}
 */
function codeFiles(base = root) {
  return codeFilesIn(base)
}

function testFiles(base = root) {
  const dir = join(base, 'tests')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(dir, name))
}

// ---------------------------------------------------------------- gates

/**
 * 版本身份与兼容声明。
 *
 * **唯一权威是 `package.json` 的 `engines.dsh`**：README 里那句适用版本是它的
 * 派生文本（门禁要求两处逐字一致），本机 DSH 版本超出区间时给可操作提示。
 * 解析与成员判定在 `shared/compat.mjs`（唯一实现），这里只做门禁判断。
 *
 * 为什么 README 不是第二权威：README 是给人读的散文，它的那一句必须由声明生成，
 * 否则「改了声明忘了改 README」和「改了 README 忘了改声明」会各错一次。
 * 为什么不是版本数组：宿主在装/载的三个时机读 engines.dsh 做 semver 匹配
 * （详见 docs/compatibility.md「宿主怎么执行这条声明」），字段形状跟着宿主走。
 */
function gateVersion(base = root, options = {}) {
  const problems = []
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
  } catch (error) {
    return { pass: false, detail: `package.json 读不到：${String(error?.message ?? error)}` }
  }
  let version
  try {
    version = readFileSync(join(base, 'VERSION'), 'utf8').trim()
  } catch (error) {
    return { pass: false, detail: `VERSION 读不到：${String(error?.message ?? error)}` }
  }
  if (pkg.name !== 'dsh-enhance') problems.push(`package.json name=${String(pkg.name)}（期望 dsh-enhance）`)
  if (pkg.private !== true) problems.push('package.json private 必须是 true')
  if (pkg.type !== 'module') problems.push('package.json type 必须是 module')
  if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`VERSION 不是 x.y.z：${version}`)
  if (pkg.version !== version) problems.push(`package.json version=${String(pkg.version)} != VERSION ${version}`)

  // ---- 兼容声明（engines.dsh 区间 + dsh.compatibility 证据元数据） ----
  const declared = declarationOf(pkg)
  let parsed = null
  if (declared.error !== undefined) {
    problems.push(declared.error)
    if (typeof pkg?.engines?.dsh === 'string') {
      const attempt = parseEnginesDsh(pkg.engines.dsh)
      if (attempt.error !== undefined) problems.push(attempt.error)
    }
  } else {
    if (!existsSync(join(base, declared.doc))) {
      problems.push(`兼容元数据的 doc 指向不存在的文件：${declared.doc}`)
    } else {
      parsed = parseEnginesDsh(declared.enginesDsh)
    }
  }

  // ---- README 派生句（声明是权威，README 是派生文本） ----
  if (parsed !== null) {
    const sentence = compatibilitySentence(declared, parsed)
    let readme = ''
    try {
      readme = readFileSync(join(base, 'README.md'), 'utf8')
    } catch {
      problems.push('README.md 读不到，无法核对适用版本句')
    }
    if (readme !== '' && !readme.includes(sentence)) {
      problems.push(`README 缺由声明生成的适用版本句（应逐字包含）：${sentence}`)
    }
  }

  // ---- 本机 DSH 版本超出声明范围 ----
  if (parsed !== null) {
    const local = options.dshVersion ?? detectDshVersion()
    if (local === undefined) {
      return {
        pass: problems.length === 0,
        detail: problems.length === 0 ? `${pkg.name}@${version}（未探测到本机 DSH 版本）` : problems.join(' | '),
      }
    }
    if (!inRange(parsed, local)) {
      problems.push(
        `本机 DSH ${local} 不在声明范围 ${displayRange(parsed)}：`
        + '先按 docs/compatibility.md 的例行核验跑一遍（约 15 分钟），核验过了再扩 package.json 的 engines.dsh 区间',
      )
    }
    if (problems.length === 0) return { pass: true, detail: `${pkg.name}@${version} · DSH ${local}` }
    return { pass: false, detail: problems.join(' | ') }
  }

  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${pkg.name}@${version}` : problems.join(' | '),
  }
}

/** 由声明拼出 README 必须逐字包含的那一句（`basis` → 中文口径）。 */
function compatibilitySentence(declared, parsed) {
  return `DeepSeek Harness ${displayRange(parsed)}（${declared.tested} 实测，全系${basisLabel(declared.basis)}）`
}

/**
 * 探测本机 DSH 版本。顺序：`--dsh-version` → `DSH_VERSION` → `dsh --version`。
 * 探不到就返回 undefined——**探测失败不许判红**（CI 上必然探不到）。
 */
function detectDshVersion() {
  const env = typeof process.env.DSH_VERSION === 'string' ? process.env.DSH_VERSION.trim() : ''
  if (VERSION_SHAPE.test(env)) return env

  // 1) PATH 上的 dsh（需要 shell 才能解析 .cmd/.ps1 shim）
  const onPath = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 8000, shell: true })
  if (onPath.status === 0) {
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${onPath.stdout ?? ''}`)
    if (match !== null) return match[1]
  }

  // 2) 桌面版的启动器（路径含空格，直接 spawn .cmd 会 EINVAL；用 shell 让它自己解析）
  const local = process.env.LOCALAPPDATA ?? process.env.USERPROFILE
  if (typeof local === 'string' && local !== '') {
    const launcher = join(local, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
    if (existsSync(launcher)) {
      const result = spawnSync(`"${launcher}" --version`, { encoding: 'utf8', timeout: 8000, shell: true })
      if (result.status === 0) {
        const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(`${result.stdout ?? ''}`)
        if (match !== null) return match[1]
      }
    }
  }
  return undefined
}

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function gateSyntax(base = root) {
  const files = codeFiles(base)
  const broken = []
  for (const file of files) {
    const result = run(['--check', file], base, 30_000)
    if (result.code !== 0) broken.push(relative(base, file))
  }
  return {
    pass: broken.length === 0,
    detail: broken.length === 0 ? `${files.length} files` : `broken: ${broken.slice(0, 5).join(', ')}`,
  }
}

function gateTests(base = root) {
  const files = testFiles(base)
  if (files.length === 0) return { pass: false, detail: 'no tests/*.test.mjs' }
  const result = run(['--test', ...files], base)
  const ran = Number((/^ℹ tests (\d+)$/m.exec(result.output) ?? [])[1] ?? 0)
  if (ran < TEST_FLOOR) return { pass: false, detail: `${ran} tests ran, floor is ${TEST_FLOOR}` }
  if (result.code === 0) return { pass: true, detail: `${ran} tests in ${files.length} files` }
  const failed = result.output.split(/\r?\n/).filter((line) => /^not ok|^✖/.test(line.trim())).slice(0, 3)
  return { pass: false, detail: failed.join(' | ') || 'test runner exited non-zero' }
}

function gateGraph(base = root, strict = false) {
  const graphArgs = ['tools/graph.mjs', '--check', ...(strict ? ['--strict'] : [])]
  const result = run(graphArgs, base)
  if (result.code === 0) return { pass: true, detail: strict ? 'structure + diagrams' : 'structure' }
  const failed = result.output.split(/\r?\n/).filter((line) => line.trim().startsWith('- ')).slice(0, 3)
  return { pass: false, detail: failed.join(' | ') || 'graph exited non-zero' }
}

function gateDocs(base = root) {
  const result = run(['tools/docs-check.mjs', '--root', base], base)
  if (result.code === 0) return { pass: true, detail: result.output.split(/\r?\n/)[0] ?? 'docs' }
  const failed = result.output.split(/\r?\n/).filter((line) => line.trim().startsWith('- ')).slice(0, 3)
  return { pass: false, detail: failed.join(' | ') || 'docs-check exited non-zero' }
}

/**
 * bundle 门禁：能 `dsh plugin add` 的仓库必须同时满足
 *   - `package.json` 声明 `dsh.bundle.patch`（字符串或字符串数组）；
 *   - 声明的 patch 文件存在；
 *   - patch 里每条 insert 的 `name` 是本包路径（`<包名>/…`），且有对应文件。
 * 解析只够用：按行找 `- id:` 后紧跟的 `name:`，不做完整 YAML。
 */
function gateBundle(base = root) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
  } catch (error) {
    return { pass: false, detail: `package.json 读不到：${String(error?.message ?? error)}` }
  }
  const declared = pkg?.dsh?.bundle?.patch
  const patches = typeof declared === 'string' ? [declared] : declared
  if (!Array.isArray(patches) || patches.length === 0 || !patches.every((file) => typeof file === 'string')) {
    return { pass: false, detail: 'package.json 缺 dsh.bundle.patch（字符串或字符串数组）' }
  }
  const packageName = typeof pkg.name === 'string' ? pkg.name : ''
  const problems = []
  for (const file of patches) {
    const patchPath = resolve(base, file)
    if (!existsSync(patchPath)) {
      problems.push(`bundle patch 不存在：${file}`)
      continue
    }
    const lines = readFileSync(patchPath, 'utf8').split(/\r?\n/)
    let currentId
    for (const line of lines) {
      const idMatch = /^[ \t]*-[ \t]*id:[ \t]*(\S+)[ \t]*$/.exec(line)
      if (idMatch !== null) {
        currentId = idMatch[1]
        continue
      }
      const nameMatch = /^[ \t]+name:[ \t]*['"]?([^'"\s]+)['"]?[ \t]*$/.exec(line)
      if (nameMatch === null || currentId === undefined) continue
      const target = nameMatch[1]
      // 合法形态：本包精确包名（包根 main）、本包子路径、包内相对路径（相对本包目录）。
      let rel
      if (target === packageName) {
        rel = undefined
      } else if (packageName !== '' && target.startsWith(`${packageName}/`)) {
        rel = target.slice(packageName.length + 1)
      } else if (target.startsWith('./')) {
        rel = target.slice(2)
      } else {
        problems.push(`insert ${currentId} 的 name 既不是本包路径、也不是包内相对路径：${target}`)
      }
      if (rel !== undefined && !existsSync(join(base, rel))) problems.push(`insert ${currentId} 指向不存在的文件：${rel}`)
      currentId = undefined
    }
  }
  if (problems.length > 0) return { pass: false, detail: problems.join(' | ') }
  return { pass: true, detail: `${patches.length} 个 bundle patch` }
}

function gateStrict(base = root) {
  const generated = join(base, 'docs', 'generated')
  if (!existsSync(generated)) return { pass: true, skipped: true, detail: 'no docs/generated' }
  return gateGraph(base, true)
}

// ---------------------------------------------------------------- self-test

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'enhance-selftest-'))
  copyRepoTree(root, dir)
  return dir
}

function withCopy(caseName, mutate, observe) {
  const copy = freshCopy()
  try {
    mutate(copy)
    const red = observe(copy) === false
    return { name: caseName, pass: red, detail: red ? 'gate went red' : 'gate stayed green' }
  } catch (error) {
    return { name: caseName, pass: false, detail: `threw: ${error?.message ?? error}` }
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}

/** A gate is red for the expected reason only when it failed and its detail names the failure. */
function expectRed(marker) {
  return (result) => !(result.pass === false && result.detail.includes(marker))
}

function runSelfTest() {
  const cases = []

  cases.push(withCopy(
    'syntax red',
    (copy) => appendFileSync(join(copy, 'shared', 'state.mjs'), '\nconst broken =\n'),
    (copy) => expectRed('broken')(gateSyntax(copy)),
  ))

  cases.push(withCopy(
    'tests red',
    (copy) => writeFileSync(join(copy, 'tests', 'zz-self-test.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('self-test fails', () => assert.fail('expected'))\n"),
    (copy) => expectRed('self-test fails')(gateTests(copy)),
  ))

  cases.push(withCopy(
    'graph red',
    (copy) => writeFileSync(join(copy, 'zz-unregistered.mjs'), 'export const x = 1\n'),
    (copy) => expectRed('未登记')(gateGraph(copy)),
  ))

  cases.push(withCopy(
    'docs red',
    // 门禁扫 README 与 docs/ 下的 markdown：正文里点名一个不存在的仓内路径必须判红
    (copy) => appendFileSync(join(copy, 'README.md'), '\n临时负例：`docs/nope.md`\n'),
    (copy) => expectRed('不存在的路径')(gateDocs(copy)),
  ))

  cases.push(withCopy(
    'bundle red',
    // bundle 门禁：把 patch 指向一个不存在的文件，必须判红
    (copy) => {
      const file = join(copy, 'package.json')
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      pkg.dsh.bundle.patch = './nope.yml'
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    },
    (copy) => expectRed('bundle patch 不存在')(gateBundle(copy)),
  ))

  cases.push(withCopy(
    'zero tests red',
    (copy) => {
      for (const file of testFiles(copy)) writeFileSync(file, '// emptied by self-test\n', 'utf8')
    },
    (copy) => expectRed('floor')(gateTests(copy)),
  ))

  /**
   * 回退源码型守卫：把源码改回旧写法，看守卫它的那条测试会不会红。
   *
   * **极性**：`withCopy` 把 `observe(copy) === false` 记成「gate went red」。
   * 所以 observe 直接返回 `testPasses(...)`：源码回退后测试**红了** → 返回 false → 记为红。
   */

  /** 副本里跑单个测试文件；整文件通过返回 true。 */
  const testPasses = (copy, file) => run(['--test', file], copy).code === 0

  /** 把 `reverted` 写回文件；替换没命中就抛，免得留一条永远绿的假负例。 */
  const assertMutated = (copy, relativePath, before, after) => {
    if (after === before) throw new Error(`${relativePath} 的回退替换没命中：守卫改了名，这条负例要跟着改`)
    writeFileSync(join(copy, relativePath), after, 'utf8')
  }

  /** 带回 `.git` 的副本：`git ls-files` 只在真仓库里可用。 */
  const withGitCopy = (caseName, mutate, observe) => {
    const copy = mkdtempSync(join(tmpdir(), 'enhance-selftest-git-'))
    try {
      copyRepoTree(root, copy, { includeGit: true })
      mutate(copy)
      const red = observe(copy) === false
      return { name: caseName, pass: red, detail: red ? 'gate went red' : 'gate stayed green' }
    } catch (error) {
      return { name: caseName, pass: false, detail: `threw: ${error?.message ?? error}` }
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  }

  cases.push(withGitCopy(
    'syntax counts tracked files',
    // 读数口径：退回「走盘数一切」的旧实现（不认 .gitignore，也不问 git）
    (copy) => {
      const file = join(copy, 'scripts', 'code-files.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text
        .replace(`new Set(['.git', 'node_modules', 'design', '.codegraph', '.zhll', '.tmp', 'ZCode'])`, `new Set(['.git', 'node_modules'])`)
        .replace('if (tracked.status === 0 && typeof tracked.stdout', 'if (false && typeof tracked.stdout')
      assertMutated(copy, 'scripts/code-files.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/gate-counts.test.mjs'),
  ))

  cases.push(withCopy(
    'derive refuses oversize text',
    // 退掉读路径的上限：derive 又会对超限文本返回 injecting:true
    (copy) => {
      const file = join(copy, 'shared', 'state.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('if (textBytes(text.text) > TEXT_LIMIT) {', 'if (false && textBytes(text.text) > TEXT_LIMIT) {')
      assertMutated(copy, 'shared/state.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/state.test.mjs'),
  ))

  cases.push(withCopy(
    'orphan bundle entry red',
    // bundle 门禁的另一侧：patch 里的 insert 名指向包内不存在的文件必须判红
    (copy) => {
      const file = join(copy, 'cordis.patch.yml')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace("name: 'dsh-enhance/enhance-scope/index.js'", "name: 'dsh-enhance/enhance-scope/missing.js'")
      assertMutated(copy, 'cordis.patch.yml', text, reverted)
    },
    (copy) => expectRed('指向不存在的文件')(gateBundle(copy)),
  ))

  cases.push(withCopy(
    'version mismatch red',
    // 版本身份：把 VERSION 改成另一个 x.y.z，package.json 与它就不再一致
    (copy) => writeFileSync(join(copy, 'VERSION'), '9.9.9\n', 'utf8'),
    (copy) => expectRed('!= VERSION')(gateVersion(copy, { dshVersion: '0.2.1-rc.3' })),
  ))

  cases.push(withCopy(
    'compat declaration red',
    // 兼容元数据的 tested 必须落在 engines.dsh 区间内：改成一个区间外的版本
    (copy) => {
      const file = join(copy, 'package.json')
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      pkg.dsh.compatibility.tested = '9.9.9'
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    },
    (copy) => expectRed('tested=')(gateVersion(copy, { dshVersion: '0.2.1-rc.3' })),
  ))

  cases.push(withCopy(
    'compat missing red',
    // 第三证（空转检查）：整个 engines.dsh 删掉必须判红——挡「常量定义了、没进判定」
    (copy) => {
      const file = join(copy, 'package.json')
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      delete pkg.engines.dsh
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    },
    (copy) => expectRed('缺兼容声明')(gateVersion(copy, { dshVersion: '0.2.1-rc.3' })),
  ))

  cases.push(withCopy(
    'engines malformed red',
    // 区间形状写歪（单界、坏算符）必须判红——宽进等于把宿主已拒的写法放行
    (copy) => {
      const file = join(copy, 'package.json')
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      pkg.engines.dsh = '>=0.2.1'
      writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    },
    (copy) => expectRed('区间形状不认')(gateVersion(copy, { dshVersion: '0.2.1-rc.3' })),
  ))

  cases.push(withCopy(
    'compat readme sentence red',
    // README 是派生文本：删掉那句必须判红
    (copy) => {
      const file = join(copy, 'README.md')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace(/DeepSeek Harness \S+–\S+（\S+ 实测[^）]*）/g, 'DeepSeek Harness 某版本')
      assertMutated(copy, 'README.md', text, reverted)
    },
    (copy) => expectRed('README 缺由声明生成的适用版本句')(gateVersion(copy, { dshVersion: '0.2.1-rc.3' })),
  ))

  cases.push(withCopy(
    'compat out-of-range red',
    // 本机 DSH 不在声明范围：必须判红并给「先跑例行核验」的可操作提示
    () => {},
    (copy) => expectRed('例行核验')(gateVersion(copy, { dshVersion: '0.9.9' })),
  ))

  return cases
}

// ---------------------------------------------------------------- main

if (selfTest) {
  const cases = runSelfTest()
  let failed = 0
  for (const item of cases) {
    console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name.padEnd(32)} ${item.detail}`)
    if (!item.pass) failed += 1
  }
  console.log(`summary  pass=${cases.length - failed} fail=${failed} total=${cases.length}`)
  process.exit(failed === 0 ? 0 : 1)
}

const gates = [
  ['version', gateVersion],
  ['syntax', gateSyntax],
  ['tests', gateTests],
  ['graph', gateGraph],
  ['docs', gateDocs],
  ['bundle', gateBundle],
]
if (layer === 'full') {
  gates.push(['graph-strict', gateStrict])
}

let failed = 0
let skipped = 0
const started = Date.now()
for (const [name, gate] of gates) {
  const at = Date.now()
  const result = name === 'version' ? gate(root, { dshVersion }) : gate()
  const ms = Date.now() - at
  if (result.skipped) skipped += 1
  if (!result.pass) failed += 1
  const label = result.skipped ? 'SKIP' : (result.pass ? 'PASS' : 'FAIL')
  console.log(`${label}  ${name.padEnd(14)} ${String(ms).padStart(5)} ms  ${result.detail}`)
}
const total = Date.now() - started
console.log(`summary  pass=${gates.length - failed - skipped} fail=${failed} skip=${skipped} total=${gates.length} in ${total} ms`)
process.exit(failed === 0 ? 0 : 1)
