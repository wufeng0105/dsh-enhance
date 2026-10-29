#!/usr/bin/env node
/**
 * 门禁总入口。
 *
 * 分层：
 *   fast  syntax、tests、doctor（仓库侧）、graph（结构）、docs、install → doctor → uninstall
 *   full  fast + 有 docs/generated 时的 graph --strict + 给了 --asar 时的 build-client
 *
 * 每道门禁都必须能红。`--self-test` 用一次性副本证明这一点：坏语法文件、坏测试、
 * 未登记的源文件、死链、半装、漏拷共享层、空 patch 还原、卸载残留的档位、
 * 零目标安装、超限文本。
 *
 * 用法：
 *   node scripts/check.mjs [--layer fast|full] [--asar <path>] [--self-test]
 *
 * 退出码：0 请求的门禁全过 / 自检全部能红；1 有门禁失败或负例没能变红；2 用法错。
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeFiles as codeFilesIn } from './code-files.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const node = process.execPath

/** The repo has 193 tests; a floor catches mass deletion that still exits 0. */
const TEST_FLOOR = 50

const args = process.argv.slice(2)
const layerIndex = args.indexOf('--layer')
const layer = layerIndex >= 0 ? args[layerIndex + 1] : 'fast'
const asarIndex = args.indexOf('--asar')
const asar = asarIndex >= 0 ? resolve(args[asarIndex + 1]) : undefined
const selfTest = args.includes('--self-test')

if (!['fast', 'full'].includes(layer)) {
  console.error(`check: unknown --layer ${layer === undefined ? '(missing)' : layer}`)
  process.exit(2)
}
if (layerIndex >= 0 && args[layerIndex + 1] === undefined) {
  console.error('check: --layer needs a value')
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
 * 版本身份：`package.json` 与根 `VERSION` 一致，且 `install.mjs` 写进清单的 `toolVersion`
 * 等于当前版本。
 *
 * 三处必须同一个值：README 说的版本、清单里记的版本、`doctor` 比对的版本。
 * 少守一处就会漂：只守文件时 install 可能写死一个旧串；只守 install 时 `VERSION`
 * 与 `package.json` 可以各说各的。
 */
function gateVersion(base = root) {
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

  // 落盘侧：真装一次到临时 home，读清单里记的版本。
  const home = mkdtempSync(join(tmpdir(), 'enhance-version-'))
  try {
    mkdirp(join(home, 'profiles', 't1'))
    writeFileSync(join(home, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')
    const install = run(['install.mjs', '--home', home, '--profiles', 't1'], base)
    if (install.code !== 0) {
      problems.push('install 失败，无法核对写入版本')
    } else {
      const manifest = JSON.parse(readFileSync(join(home, 'enhance', 'install-manifest.json'), 'utf8'))
      if (manifest.toolVersion !== version) {
        problems.push(`install 写入 toolVersion=${manifest.toolVersion ?? '（无）'} != 当前 ${version}`)
      }
    }
  } catch (error) {
    problems.push(`install 版本核对失败：${String(error?.message ?? error)}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${pkg.name}@${version}` : problems.join(' | '),
  }
}

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

function gateDoctor(base = root) {
  const result = run(['doctor.mjs'], base)
  if (result.code === 0) return { pass: true, detail: 'repo checks' }
  const failed = result.output.split(/\r?\n/).filter((line) => line.startsWith('FAIL')).slice(0, 3)
  return { pass: false, detail: failed.join(' | ') || 'doctor exited non-zero' }
}

function gateDoctorHome(base, home) {
  const result = run(['doctor.mjs', '--home', home], base)
  if (result.code === 0) return { pass: true, detail: 'home checks' }
  const failed = result.output.split(/\r?\n/).filter((line) => line.startsWith('FAIL')).slice(0, 3)
  return { pass: false, detail: failed.join(' | ') || 'doctor --home exited non-zero' }
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

/** One temp home: install, doctor, uninstall; assert the patch returns to []. */
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
      if (packageName === '' || !target.startsWith(`${packageName}/`)) {
        problems.push(`insert ${currentId} 的 name 不是本包路径：${target}`)
      } else {
        const rel = target.slice(packageName.length + 1)
        if (!existsSync(join(base, rel))) problems.push(`insert ${currentId} 指向不存在的文件：${rel}`)
      }
      currentId = undefined
    }
  }
  if (problems.length > 0) return { pass: false, detail: problems.join(' | ') }
  return { pass: true, detail: `${patches.length} 个 bundle patch` }
}

function gateLifecycle(base = root) {
  const home = mkdtempSync(join(tmpdir(), 'enhance-check-'))
  try {
    const profile = join(home, 'profiles', 't1')
    const patch = join(profile, 'cordis.patch.yml')
    mkdirp(profile)
    writeFileSync(patch, '[]\n', 'utf8')

    const install = run(['install.mjs', '--home', home, '--profiles', 't1'], base)
    if (install.code !== 0) return { pass: false, detail: 'install exited non-zero' }
    const shared = join(home, 'enhance', 'shared', 'text-lines.mjs')
    if (!existsSync(shared)) return { pass: false, detail: 'install did not ship shared/text-lines.mjs' }

    const doctor = run(['doctor.mjs', '--home', home], base)
    if (doctor.code !== 0) {
      const failed = doctor.output.split(/\r?\n/).filter((line) => line.startsWith('FAIL')).slice(0, 3)
      return { pass: false, detail: `doctor --home: ${failed.join(' | ') || 'non-zero'}` }
    }

    const uninstall = run(['uninstall.mjs', '--home', home, '--profiles', 't1'], base)
    if (uninstall.code !== 0) return { pass: false, detail: 'uninstall exited non-zero' }
    const restored = readFileSync(patch, 'utf8')
    if (restored.trim() !== '[]') return { pass: false, detail: `patch after uninstall is ${JSON.stringify(restored)}` }
    return { pass: true, detail: 'install → doctor → uninstall → []' }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function gateBuildClient(base = root) {
  if (asar === undefined) return { pass: true, skipped: true, detail: 'no --asar' }
  if (!existsSync(asar)) return { pass: false, detail: `asar not found: ${asar}` }
  const result = run(['enhance-permissions/build-client.mjs', '--check', '--asar', asar], base)
  return { pass: result.code === 0, detail: result.output.trim().split(/\r?\n/)[0] ?? 'build-client' }
}

function gateStrict(base = root) {
  const generated = join(base, 'docs', 'generated')
  if (!existsSync(generated)) return { pass: true, skipped: true, detail: 'no docs/generated' }
  return gateGraph(base, true)
}

function mkdirp(dir) {
  mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------- self-test

function freshCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'enhance-selftest-'))
  cpSync(root, dir, {
    recursive: true,
    filter: (src) => {
      const rel = relative(root, src)
      if (rel === '') return true
      const parts = rel.split(sep)
      return !parts.includes('.git') && !parts.includes('node_modules')
    },
  })
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
    // 仓库已没有 docs/，门禁扫的是 README.md：正文里点名一个不存在的仓内路径必须判红
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
    'doctor repo red',
    (copy) => rmSync(join(copy, 'auto-approve', 'index.js'), { force: true }),
    (copy) => expectRed('plugins-present')(gateDoctor(copy)),
  ))

  cases.push(withCopy(
    'zero tests red',
    (copy) => {
      for (const file of testFiles(copy)) writeFileSync(file, '// emptied by self-test\n', 'utf8')
    },
    (copy) => expectRed('floor')(gateTests(copy)),
  ))

  cases.push(withCopy(
    'doctor half-install red',
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 't1'))
      writeFileSync(join(home, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')
      if (run(['install.mjs', '--home', home, '--profiles', 't1'], copy).code !== 0) throw new Error('install failed')
      const patch = join(home, 'profiles', 't1', 'cordis.patch.yml')
      const text = readFileSync(patch, 'utf8')
      writeFileSync(patch, text.replace(/^[ \t]*-[ \t]*id: enhance-ui[ \t]*\r?\n(?:[ \t]+.*\r?\n)*/m, ''), 'utf8')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      return expectRed('半装')(gateDoctorHome(copy, home))
    },
  ))

  cases.push(withCopy(
    'install missing shared red',
    (copy) => {
      const file = join(copy, 'install.mjs')
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.replace("'shared/text-lines.mjs', ", ''), 'utf8')
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 't1'))
      writeFileSync(join(home, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')
      if (run(['install.mjs', '--home', home, '--profiles', 't1'], copy).code !== 0) throw new Error('install failed')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      return expectRed('uninstall:')(gateDoctorHome(copy, home))
    },
  ))


  cases.push(withCopy(
    'manifest hash red',
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 't1'))
      writeFileSync(join(home, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')
      if (run(['install.mjs', '--home', home, '--profiles', 't1'], copy).code !== 0) throw new Error('install failed')
      appendFileSync(join(home, 'enhance', 'enhance-scope', 'index.js'), '\n// tampered\n')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      return expectRed('hash 不符')(gateDoctorHome(copy, home))
    },
  ))

  cases.push(withCopy(
    'enhanced preset red',
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 'desktop'))
      writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '[]\n', 'utf8')
      if (run(['install.mjs', '--home', home], copy).code !== 0) throw new Error('install failed')
      const patch = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
      const text = readFileSync(patch, 'utf8')
      writeFileSync(patch, text.replace(/^[ \t]*enhanced:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*/m, ''), 'utf8')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      return expectRed('缺 enhanced')(gateDoctorHome(copy, home))
    },
  ))

  cases.push(withCopy(
    'preset never red',
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 't1'))
      writeFileSync(join(home, 'profiles', 't1', 'cordis.patch.yml'), [
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
      if (run(['install.mjs', '--home', home, '--profiles', 't1'], copy).code !== 0) throw new Error('install failed')
      // 安装器现在会因 never 档位种 ask；这一条要验的是 doctor 的分支：
      // 把 state 改成 allow（用户手动选了“直接放行”），doctor 必须指出它被 never 短路。
      writeFileSync(join(home, 'enhance', 'state.json'), JSON.stringify({
        version: 3, enabled: true, contentScope: true, approval: 'allow',
      }, null, 2), 'utf8')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      return expectRed('approval=never')(gateDoctorHome(copy, home))
    },
  ))

  cases.push(withCopy(
    'uninstalled enhanced residue red',
    // 卸载残留的门禁侧：`enhance/` 整个不在了（未安装），但 patch 里还留着一份 `enhanced`
    // 档 —— 卸载与门禁不许同时声称干净。这条造的就是「未安装 + 残留」，要求 doctor 判红、
    // 并点名是哪一行（旧实现只查 disabled 两类残留，这里会绿）。
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 'web'))
      writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), [
        '- id: permission',
        '  name: "@deepseek-ai/dsh-permission-presets"',
        '  config:',
        '    presets:',
        '      enhanced:',
        '        sandbox: danger-full-access',
        '        approval: ask',
        '    defaultPreset: enhanced',
        '',
      ].join('\n'), 'utf8')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      return expectRed('残留 enhanced')(gateDoctorHome(copy, home))
    },
  ))

  cases.push(withCopy(
    'uninstall empty-patch red',
    (copy) => {
      const file = join(copy, 'uninstall.mjs')
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.replace("  if (out.trim() === '') out = '[]'\n", ''), 'utf8')
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 't1'))
      const patch = join(home, 'profiles', 't1', 'cordis.patch.yml')
      writeFileSync(patch, '[]\n', 'utf8')
      run(['install.mjs', '--home', home, '--profiles', 't1'], copy)
      run(['uninstall.mjs', '--home', home, '--profiles', 't1'], copy)
      return readFileSync(patch, 'utf8').trim() === '[]'
    },
  ))

  /**
   * 回退源码型守卫六条 + 归属丢失型两条（归属丢失后的 `enhanced` 残留、用户自己的
   * `defaultPreset: enhanced` 不许被摘）。
   * 回退方式都是「把源码改回旧写法，看守卫它的那条负例会不会红」。
   *
   * 为什么不用「造一个坏产物让门禁自己红」那一套：这六条抓的是**我们自己写坏**的形状
   * （重复键、拒绝路径、档位语义、清单漏记、计数口径），产物侧造出来正是被测代码该
   * 拦住的输入 —— 用测试当门禁才问得对问题：旧代码在同一个输入上会「安静地做错事」，
   * 而门禁全绿。`assertMutated` 保证替换真的落到了源码上（替换没命中就抛，不留假负例）。
   *
   * **不涉及 git 的负例**用 `withCopy`：`freshCopy` 不带 `.git`，所以
   * `tests/gate-counts.test.mjs` 里的 tracked 比对在副本里跑不了；那条单独用
   * `withGitCopy`（带 `.git`）走 `runSelfTest` 末尾那段。
   */

  /** 副本里跑单个测试文件；整文件通过返回 true。 */
  const testPasses = (copy, file) => run(['--test', file], copy).code === 0

  /**
   * 注意极性：`withCopy`/`withGitCopy` 把 `observe(copy) === false` 记成「gate went red」。
   * 所以这八条 observe 直接返回 `testPasses(...)`：源码回退后测试**红了** → 返回 false
   * → 记为红，正是我们要的。反过来写成 `!testPasses` 会让每条都永远绿。
   */

  /** 把 `reverted` 写回文件；替换没命中就抛，免得留一条永远绿的假负例。 */
  const assertMutated = (copy, relativePath, before, after) => {
    if (after === before) throw new Error(`${relativePath} 的回退替换没命中：守卫改了名，这条负例要跟着改`)
    writeFileSync(join(copy, relativePath), after, 'utf8')
  }

  /** 带回 `.git` 的副本：`git ls-files` 只在真仓库里可用。 */
  const withGitCopy = (caseName, mutate, observe) => {
    const copy = mkdtempSync(join(tmpdir(), 'enhance-selftest-git-'))
    try {
      cpSync(root, copy, {
        recursive: true,
        filter: (src) => {
          const rel = relative(root, src)
          if (rel === '') return true
          return !rel.split(sep).includes('node_modules')
        },
      })
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
        .replace("export const SKIP_DIRS = new Set(['.git', 'node_modules', 'design'])", "export const SKIP_DIRS = new Set(['.git', 'node_modules'])")
        .replace('if (tracked.status === 0 && typeof tracked.stdout', 'if (false && typeof tracked.stdout')
      assertMutated(copy, 'scripts/code-files.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/gate-counts.test.mjs'),
  ))

  cases.push(withCopy(
    'flow presets stay single-key',
    // flow presets：退回「只认块风格」，flow 形状就会再插一个同层 presets
    (copy) => {
      const file = join(copy, 'shared', 'patch-rows.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace(
        "  const presetsInBlock = block.findIndex((line) => PRESETS_LINE.test(line) && presetsLineShape(line).form !== 'error')",
        "  const presetsInBlock = block.findIndex((line) => /^[ \\t]*presets:[ \\t]*$/.test(line))",
      )
      assertMutated(copy, 'shared/patch-rows.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/patch-rows.test.mjs'),
  ))

  cases.push(withCopy(
    'install refuses unsafe presets',
    // P-2：拆掉两道拒绝（preflight + patchProfile），认不出形态的 patch 就会被写坏
    (copy) => {
      const file = join(copy, 'install.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text
        .replace('const blocked = await preflightProfiles(options.profiles)', 'const blocked = []')
        .replace('  if (presets.error !== undefined) {', '  if (false) {')
      assertMutated(copy, 'install.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/install-default.test.mjs'),
  ))

  cases.push(withCopy(
    'doctor enhanced semantics',
    // 档位语义：拆掉校验，被改窄的 enhanced 不再判红
    (copy) => {
      const file = join(copy, 'doctor.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('      const enhanced = enhancedSemantics(text)', '      const enhanced = undefined')
      assertMutated(copy, 'doctor.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/doctor-home.test.mjs'),
  ))

  cases.push(withCopy(
    'doctor duplicate keys',
    // 重复键：关掉检测，两份 presets 就不再判红
    (copy) => {
      const file = join(copy, 'doctor.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('  const duplicates = duplicateKeys(text)', '  const duplicates = []')
      assertMutated(copy, 'doctor.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/doctor-home.test.mjs'),
  ))


  cases.push(withCopy(
    'unowned enhanced residue red',
    // 卸载残留的另一侧：一份已经增强过的 patch 落到清单里没有归属的 profile 上。
    // install 收养它时把归属记成 `permissionPresetAction: 'unchanged'`——「这档是我们加的」
    // 的事实丢了——默认卸载于是只摘 insert 行、exit 0、报告 changed。回退新守卫
    // （`removeUnownedEnhancedPreset` 那一支）后，卸载完 patch 里仍留着 `defaultPreset: enhanced`；
    // 这条负例就是钉那一支是吃的劲。
    (copy) => {
      const file = join(copy, 'uninstall.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('  } else if (removed.length > 0) {', '  } else if (false && removed.length > 0) {')
      assertMutated(copy, 'uninstall.mjs', text, reverted)
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      const source = join(copy, '.selftest-src')
      mkdirp(join(home, 'profiles', 'web'))
      mkdirp(join(source, 'profiles', 't1'))
      writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n', 'utf8')
      writeFileSync(join(source, 'profiles', 't1', 'cordis.patch.yml'), '[]\n', 'utf8')
      if (run(['install.mjs', '--home', source, '--profiles', 't1'], copy).code !== 0) throw new Error('install (source) failed')
      cpSync(join(source, 'profiles', 't1', 'cordis.patch.yml'), join(home, 'profiles', 'web', 'cordis.patch.yml'))
      if (run(['install.mjs', '--home', home, '--profiles', 'web'], copy).code !== 0) throw new Error('install (adopt) failed')
      if (run(['uninstall.mjs', '--home', home, '--profiles', 'web'], copy).code !== 0) throw new Error('uninstall failed')
      const after = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
      // 摘干净了 → true；回退后残留 → false → 记为红
      return !/^[ \t]*enhanced[ \t]*:/m.test(after) && !/^[ \t]*defaultPreset:[ \t]*enhanced/m.test(after)
    },
  ))

  cases.push(withCopy(
    'user defaultPreset survives uninstall',
    // 用户自写 `defaultPreset: enhanced`（**没有** `enhanced:` 键）的块被 install 收养后，
    // 归属丢失时卸载只许摘我们插进去的 `enhanced` 档 —— 用户那行默认档位是在我们动手之前就在的，
    // 必须留下（并出 warn）。回退归属判据（`permissionRowIsPresetTable` 恒真 = 旧写法把
    // `defaultAdded` 硬编码成 true）后，这一行会被删。
    (copy) => {
      const file = join(copy, 'shared', 'patch-rows.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace(
        '  const rowIsOurs = permissionRowIsPresetTable(lines, found)',
        '  const rowIsOurs = true',
      )
      assertMutated(copy, 'shared/patch-rows.mjs', text, reverted)
    },
    (copy) => {
      const home = join(copy, '.selftest-home')
      mkdirp(join(home, 'profiles', 't1'))
      const patch = join(home, 'profiles', 't1', 'cordis.patch.yml')
      writeFileSync(patch, [
        '- id: permission',
        '  name: "@deepseek-ai/dsh-permission-presets"',
        '  config:',
        '    presets:',
        '      read-only:',
        '        sandbox: read-only',
        '        approval: ask',
        '    defaultPreset: enhanced',
        '',
      ].join('\n'), 'utf8')
      if (run(['install.mjs', '--home', home, '--profiles', 't1'], copy).code !== 0) throw new Error('install failed')
      rmSync(join(home, 'enhance', 'install-manifest.json'), { force: true })
      if (run(['install.mjs', '--home', home, '--all'], copy).code !== 0) throw new Error('install --all failed')
      if (run(['uninstall.mjs', '--home', home, '--profiles', 't1'], copy).code !== 0) throw new Error('uninstall failed')
      // 用户那行还在 → true；回退后被删 → false → 记为红
      return readFileSync(patch, 'utf8').includes('defaultPreset: enhanced')
    },
  ))

  /**
   * 零目标安装与超限文本的守卫。极性同上：回退源码后，守卫它的测试**红了** →
   * `testPasses` 返回 false → 记为红。
   */
  cases.push(withCopy(
    'install empty profile set red',
    // 退掉「一个可装的 profile 都没有就拒绝」：install 又回到 exit 0 的绿色空操作
    (copy) => {
      const file = join(copy, 'install.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('if (targetProblem !== undefined) {', 'if (false && targetProblem !== undefined) {')
      assertMutated(copy, 'install.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/install-default.test.mjs'),
  ))

  cases.push(withCopy(
    'doctor oversize home text red',
    // 退掉 home-text 的上限判据：超限文本又变成 doctor 全绿
    (copy) => {
      const file = join(copy, 'doctor.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('    installed.ok && installedBytes <= TEXT_LIMIT,', '    installed.ok,')
      assertMutated(copy, 'doctor.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/doctor-home.test.mjs'),
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
    'doctor unwired install red',
    // 退掉「装了插件却没有任何 profile 引用」的判红：绿色空操作又隐身
    (copy) => {
      const file = join(copy, 'doctor.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('  if (exists(p.dir) && wireOnly !== true) {', '  if (false) {')
      assertMutated(copy, 'doctor.mjs', text, reverted)
    },
    (copy) => testPasses(copy, 'tests/doctor-home.test.mjs'),
  ))

  cases.push(withCopy(
    'version mismatch red',
    // 版本身份：把 VERSION 改成另一个 x.y.z，package.json 与它就不再一致
    (copy) => writeFileSync(join(copy, 'VERSION'), '9.9.9\n', 'utf8'),
    (copy) => expectRed('!= VERSION')(gateVersion(copy)),
  ))

  cases.push(withCopy(
    'install records toolVersion red',
    // 落盘侧：install 写死一个旧串，清单记的版本与当前工具就对不上
    (copy) => {
      const file = join(copy, 'install.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('    toolVersion: toolVersion(),', "    toolVersion: '0.0.0',")
      assertMutated(copy, 'install.mjs', text, reverted)
    },
    (copy) => expectRed('install 写入 toolVersion')(gateVersion(copy)),
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
  ['doctor', gateDoctor],
  ['graph', gateGraph],
  ['docs', gateDocs],
  ['bundle', gateBundle],
  ['lifecycle', gateLifecycle],
]
if (layer === 'full') {
  gates.push(['graph-strict', gateStrict])
  gates.push(['build-client', gateBuildClient])
}

let failed = 0
let skipped = 0
const started = Date.now()
for (const [name, gate] of gates) {
  const at = Date.now()
  const result = gate()
  const ms = Date.now() - at
  if (result.skipped) skipped += 1
  if (!result.pass) failed += 1
  const label = result.skipped ? 'SKIP' : (result.pass ? 'PASS' : 'FAIL')
  console.log(`${label}  ${name.padEnd(14)} ${String(ms).padStart(5)} ms  ${result.detail}`)
}
const total = Date.now() - started
console.log(`summary  pass=${gates.length - failed - skipped} fail=${failed} skip=${skipped} total=${gates.length} in ${total} ms`)
process.exit(failed === 0 ? 0 : 1)
