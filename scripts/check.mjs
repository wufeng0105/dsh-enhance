#!/usr/bin/env node
/**
 * 门禁总入口。
 *
 * 分层：
 *   fast  version、syntax、tests、graph（结构 + 宿主字段禁令）、docs（文档机械残渣 + 计数一致性）、
 *         readme、bundle
 *   full  fast + 有 docs/generated 时的 graph --strict
 *
 * 每道门禁都必须能红。`--self-test` 用一次性副本证明这一点：坏语法文件、坏测试、
 * 未登记的源文件、死链、坏 README 里的图路径、坏 bundle 声明、超限文本。
 *
 * **现在是七道门、20 个负例**（见 `scripts/known-counts.json`）。两个数都是**下限**：
 * 只许多，不许少——加判据、加负例不需要先走一轮文档批。门数不是不许变的指标：
 * 判据该独立成门就独立成门，只是要连文档一起改。
 * 2026-11-02 的门禁加固把三处新判据并进了现有门：宿主原文核对并进 `version` 门，文档计数一致性并进
 * `docs` 门，未文档化宿主字段禁令并进 `graph` 门，CHANGELOG/CONTRIBUTING 并进 `docs` 的收集范围，
 * README.en.md 并进 `version` 的适用版本句校验。
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
import { gateReadme } from './check-readme.mjs'
import { basisLabel, declarationOf, displayRange, inRange, parseEnginesDsh } from '../shared/compat.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const node = process.execPath

/** 仓库的 tests 数有一个地板：防「大批删除仍 exit 0」。 */
const TEST_FLOOR = 50

/**
 * 读单一来源 `scripts/known-counts.json` 里的一个计数。
 *
 * 读不到返回 undefined：读数缺失由 `docs` 门（tools/counts-check.mjs）判红，
 * 不在这里编一个默认值——「按缺省值放过」正是这次要消掉的坑。
 * @param {string} name
 * @returns {number|undefined}
 */
function knownCount(name) {
  try {
    const parsed = JSON.parse(readFileSync(join(here, 'known-counts.json'), 'utf8'))
    const value = parsed?.counts?.[name]?.value
    return Number.isInteger(value) && value >= 0 ? value : undefined
  } catch {
    return undefined
  }
}

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

/** 跑一条 Node 命令，两个流都收回来。 */
function run(toolArgs, cwd = root, timeout = 120_000) {
  const result = spawnSync(node, toolArgs, { cwd, encoding: 'utf8', timeout })
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    signal: result.signal ?? null,
  }
}

/**
 * 语法门禁覆盖的文件集合。
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
  // 包身份就是 npm 身份：`@wufeng0105/dsh-enhance`（2026-11-03 起）。无 scope 的
  // `dsh-enhance` 在 npm 上已被他人占用，所以只能用 scope。这个名字同时是
  // `cordis.patch.yml` 入口名的前缀，两处必须逐字一致——bundle 门会兜住不一致。
  if (pkg.name !== '@wufeng0105/dsh-enhance') {
    problems.push(`package.json name=${String(pkg.name)}（期望 @wufeng0105/dsh-enhance）`)
  }
  // `private: true` 会让 `npm publish` 直接拒绝，所以这里反过来判：
  // 声明了 private 就是红的。改回 private 等于宣布「不发 npm」，那要连这条与 CONTRIBUTING 一起改。
  if (pkg.private === true) {
    problems.push('package.json 不能声明 private —— 这是要发布到 npm 的包（private 会让 npm publish 直接拒绝）')
  }
  if (pkg.publishConfig?.access !== 'public') {
    problems.push('package.json publishConfig.access 必须是 public —— scope 包默认私有，不加发出去别人装不了')
  }
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

  // ---- README 派生句：中英两份都必须逐字包含（2026-11-02 起纳入 README.en.md） ----
  if (parsed !== null) {
    const sentence = compatibilitySentence(declared, parsed)
    for (const file of ['README.md', 'README.en.md']) {
      const label = file === 'README.md' ? 'README' : file
      let readme = ''
      try {
        readme = readFileSync(join(base, file), 'utf8')
      } catch {
        problems.push(`${label} 读不到，无法核对适用版本句`)
        continue
      }
      // 空 README 也必须判红：`readme !== '' &&` 那个短路会让「把 README 删空」
      // 变成静默关掉这道门（2026-10-31 实测：0 字节 README 时 version 门仍 PASS）。
      if (!readme.includes(sentence)) {
        problems.push(`${label} 缺由声明生成的适用版本句（应逐字包含）：${sentence}`)
      }
    }
  }

  // ---- 宿主原文基准核对（作为 version 门的一个步骤） ----
  // tools/host-check.mjs 自己负责「没有 asar 时如实跳过、坏 asar 判红」的极性；
  // 这里只把它的退出码并进本门，跳过（exit 0 且打印「跳过」）不算红。
  const host = run(['tools/host-check.mjs'], base)
  const hostFirst = host.output.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  const hostNote = host.code !== 0
    ? '宿主核对：红'
    : (hostFirst.includes('跳过') ? '宿主核对：跳过（没有 asar）' : '宿主核对：命中')
  if (host.code !== 0) {
    const detail = host.output.split(/\r?\n/).filter((line) => line.trim() !== '').slice(0, 2).join(' | ')
    problems.push(`宿主原文基准核对没过：${detail}`)
  }

  // ---- 本机 DSH 版本超出声明范围 ----
  if (parsed !== null) {
    const local = options.dshVersion ?? detectDshVersion()
    if (local === undefined) {
      return {
        pass: problems.length === 0,
        detail: problems.length === 0 ? `${pkg.name}@${version} · README.md + README.en.md 适用版本句一致（未探测到本机 DSH 版本）· ${hostNote}` : problems.join(' | '),
      }
    }
    if (!inRange(parsed, local)) {
      problems.push(
        `本机 DSH ${local} 不在声明范围 ${displayRange(parsed)}：`
        + '先按 docs/compatibility.md 的例行核验跑一遍（约 15 分钟），核验过了再扩 package.json 的 engines.dsh 区间',
      )
    }
    if (problems.length === 0) return { pass: true, detail: `${pkg.name}@${version} · DSH ${local} · README.md + README.en.md 适用版本句一致 · ${hostNote}` }
    return { pass: false, detail: problems.join(' | ') }
  }

  return {
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${pkg.name}@${version} · ${hostNote}` : problems.join(' | '),
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

  // `node --check` 只解析不执行，抓不到「跑起来才炸」的错误——最典型的是作用域：
  // `scripts/release.mjs` 曾经把 `const npmUser` 缩进进一个 if 块、又在块外引用，
  // 语法完全合法，但任何非 `--check` 模式一跑就 ReferenceError，而当时七道门全绿。
  // 所以这里真的把它跑一遍冒烟：`--dry` 不打网络、不写文件，只走到汇总打印为止。
  const smoke = run(['scripts/release.mjs', '0.0.0', '--dry'], base, 60_000)
  if (smoke.code !== 0) {
    const first = smoke.output.split('\n').find((line) => /Error|error/.test(line)) ?? smoke.output.slice(0, 200)
    broken.push(`scripts/release.mjs（--dry 冒烟失败：${first.trim()}）`)
  }

  return {
    pass: broken.length === 0,
    detail: broken.length === 0 ? `${files.length} files · release.mjs --dry 冒烟通过` : `broken: ${broken.slice(0, 5).join(', ')}`,
  }
}

function gateTests(base = root) {
  const files = testFiles(base)
  if (files.length === 0) return { pass: false, detail: 'no tests/*.test.mjs' }
  const result = run(['--test', ...files], base)
  const ran = Number((/^ℹ tests (\d+)$/m.exec(result.output) ?? [])[1] ?? 0)
  if (ran < TEST_FLOOR) return { pass: false, detail: `${ran} tests ran, floor is ${TEST_FLOOR}` }
  // 条数既要在地板之上，也要与单一来源一致：测试数变了就逼着改 known-counts.json + 文档声明，
  // 不许「测试悄悄变多、文档里的 161 却没人动」。
  const expected = knownCount('tests')
  const countProblem = expected !== undefined && ran !== expected
    ? `测试条数 ${ran} != 单一来源 scripts/known-counts.json 的 ${expected}（改条数要连文档一起改）`
    : undefined
  if (result.code === 0) {
    if (countProblem !== undefined) return { pass: false, detail: countProblem }
    return { pass: true, detail: `${ran} tests in ${files.length} files` }
  }
  const failed = result.output.split(/\r?\n/).filter((line) => /^not ok|^✖/.test(line.trim())).slice(0, 3)
  return {
    pass: false,
    detail: [failed.join(' | ') || 'test runner exited non-zero', countProblem].filter(Boolean).join(' | '),
  }
}

function gateGraph(base = root, strict = false) {
  const graphArgs = ['tools/graph.mjs', '--check', ...(strict ? ['--strict'] : [])]
  const result = run(graphArgs, base)
  if (result.code === 0) {
    // 把 graph 的读数带进门禁行：模块/边/生产文件数都是现场核过的事实，不只是「structure」
    const line = result.output.split(/\r?\n/).find((item) => item.startsWith('[graph] OK'))
    const detail = line === undefined ? (strict ? 'structure + diagrams' : 'structure') : line.replace(/^\[graph\] OK：/, '').replace(/（[^）]*）$/, '')
    return { pass: true, detail }
  }
  const failed = result.output.split(/\r?\n/).filter((line) => line.trim().startsWith('- ')).slice(0, 3).map((line) => line.trim())
  return { pass: false, detail: failed.join(' | ') || 'graph exited non-zero' }
}

function gateDocs(base = root, options = {}) {
  const problems = []
  const docs = run(['tools/docs-check.mjs', '--root', base], base)
  const countsArgs = ['tools/counts-check.mjs', '--root', base]
  if (Number.isInteger(options.gateCount)) countsArgs.push('--gates', String(options.gateCount))
  const counts = run(countsArgs, base)
  // 两个「人工维护值」各自的可机算来源：它们原先标 manual，判据是「某份日志里写着
  // total=NN」——日志不进仓，等于没人核。这里让它们现场数出来与单一来源对账。
  const contacts = run(['tools/contacts-count.mjs', '--root', base], base)
  const dashes = (result) => {
    const lines = result.output.split(/\r?\n/).filter((line) => line.trim().startsWith('- ')).slice(0, 3)
    return lines.length > 0 ? lines : [result.output.split(/\r?\n/).filter((line) => line.trim() !== '')[0] ?? 'exited non-zero']
  }
  if (docs.code !== 0) problems.push(...dashes(docs))
  if (counts.code !== 0) problems.push(...dashes(counts))
  if (contacts.code !== 0) problems.push(...dashes(contacts))
  if (problems.length > 0) return { pass: false, detail: problems.join(' | ') }
  const docsLine = docs.output.split(/\r?\n/).find((line) => line.startsWith('[docs]')) ?? 'docs'
  const countsLine = counts.output.split(/\r?\n/).find((line) => line.startsWith('[counts]')) ?? 'counts'
  const contactsLine = contacts.output.split(/\r?\n/).find((line) => line.startsWith('[contacts]')) ?? 'contacts'
  return { pass: true, detail: `${docsLine}；${countsLine}；${contactsLine}` }
}

/**
 * README 门禁：结构性的写作约束——章节顺序、站内链接是否失效、图是否真的存在、
 * ToC 是否覆盖全部二级标题、代码块有没有标语言、许可证是不是最后一节。
 *
 * 与 version 门不重叠：version 门只管「README 必须逐字含 package.json 派生的那句
 * 适用版本」，这里管其余部分。
 */
function gateReadmeGate(base = root) {
  try {
    // 只判「结构检查有没有过」。**不再拿检查项总数去比对 known-counts**：
    // 那个数随 README 的章节数变化（增删一节就 ±1），而它没有任何文档声明位、
    // 也抓不到任何缺陷——保留它等于要求「改 README 章节必须同步一个 JSON」，
    // 纯粹是维护摩擦（实测：删掉 ToC 一节，132→129，门禁红在数字上而不是内容上）。
    return gateReadme(base)
  } catch (error) {
    // 门禁偶发抛错也得是「红」而不是整条 check 崩掉：README.en.md 被删时 gateReadme 会抛。
    return { pass: false, detail: `readme 门抛错：${String(error?.message ?? error)}` }
  }
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

/** 只有当门禁失败、且 detail 里点了那条失败原因时，才算「因该原因变红」。 */
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
    // 替换锚在「以 '.git' 开头的那个 Set」上而不是整串字面量：SKIP_DIRS 增减条目
    // 不该让这条负例失效（2026-10-31 给 SKIP_DIRS 补 `.dsh` 时，整串 replace 静默没命中，
    // 只有下面第二处替换生效，写出半残变体，负例挂在 `gate stayed green`）。
    (copy) => {
      const file = join(copy, 'scripts', 'code-files.mjs')
      const text = readFileSync(file, 'utf8')
      const reverted = text
        .replace(/new Set\(\['\.git'[^\]]*\]\)/, `new Set(['.git', 'node_modules'])`)
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
      const reverted = text.replace("name: '@wufeng0105/dsh-enhance/enhance-scope/index.js'", "name: '@wufeng0105/dsh-enhance/enhance-scope/missing.js'")
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
    'compat readme empty red',
    // 把 README 删空 = 没有那句派生文本；这不许变成「静默过关」（去掉 `readme !== ''` 短路）
    (copy) => writeFileSync(join(copy, 'README.md'), '', 'utf8'),
    (copy) => expectRed('README 缺由声明生成的适用版本句')(gateVersion(copy, { dshVersion: '0.2.1-rc.3' })),
  ))

  cases.push(withCopy(
    'compat out-of-range red',
    // 本机 DSH 不在声明范围：必须判红并给「先跑例行核验」的可操作提示
    () => {},
    (copy) => expectRed('例行核验')(gateVersion(copy, { dshVersion: '0.9.9' })),
  ))

  cases.push(withCopy(
    'readme red',
    // README 门禁：图路径改成不存在的文件必须判红——链接红掉没人知道是常事
    (copy) => {
      const file = join(copy, 'README.md')
      const text = readFileSync(file, 'utf8')
      const reverted = text.replace('./docs/figures/01-host-seams.svg', './docs/figures/nope.svg')
      assertMutated(copy, 'README.md', text, reverted)
    },
    (copy) => expectRed('图片存在')(gateReadmeGate(copy)),
  ))

  // ---- 内嵌 check 组件各自的负例 ----
  // 这三条挡的是「组件自己静默退化成永远绿」：实测过一次——把 `counts-check` 的比对
  // 改成永远通过、同时把 `docs/compatibility.md` 的「共 36 条」写成 35，七道门与
  // 原来的 17 条负例**全绿**，没有任何东西会响。组件的红态必须由负例钉住，
  // 不能只靠「改的时候手工验过一次」。

  cases.push(withCopy(
    'counts-check red',
    // 文档里的计数与单一来源不符 → docs 门的计数一致性必须判红并点名位置
    (copy) => {
      const file = join(copy, 'docs', 'compatibility.md')
      const text = readFileSync(file, 'utf8')
      const broken = text.replace('共 36 条', '共 35 条')
      assertMutated(copy, 'docs/compatibility.md', text, broken)
    },
    (copy) => expectRed('hostContacts')(gateDocs(copy)),
  ))

  cases.push(withCopy(
    'field-check red',
    // 生产代码里写未登记的宿主字段入口 → graph 门的禁令必须判红（fail-closed）
    (copy) => {
      const file = join(copy, 'enhance-scope', 'index.js')
      const text = readFileSync(file, 'utf8')
      appendFileSync(file, '\n// probe: ctx.systemPrompt.layers\n')
      assertMutated(copy, 'enhance-scope/index.js', text, readFileSync(file, 'utf8'))
    },
    (copy) => expectRed('未文档化宿主字段入口')(gateGraph(copy)),
  ))

  cases.push(withCopy(
    'host-check red',
    // 宿主 asar 读不出来时必须判红、**不能**当成「跳过」（跳过是「没有 asar」，不是「坏了」）
    (copy) => {
      const bad = join(copy, 'not-an-asar.bin')
      writeFileSync(bad, 'garbage-not-asar', 'utf8')
      process.env.DSH_ASAR = bad
    },
    (copy) => {
      try {
        return expectRed('asar 读不出来')(gateVersion(copy, { dshVersion: '0.2.1-rc.5' }))
      } finally {
        delete process.env.DSH_ASAR
      }
    },
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
  // 负例条数是**下限**，不是精确值：少于单一来源判红，多于不判。
  // 为什么允许增长：每新增一条判据都该自带一条负例钉住它的红态，而精确相等会让
  // 「加一条负例」先欠一轮文档批（CONTRIBUTING 的计数声明位要跟着改）——于是没人
  // 愿意加，验证能力停在原地。这与 tests 门的 `TEST_FLOOR` 是同一套取舍：地板保证
  // 不被悄悄掏空，上不封顶保证能长。
  // 读数缺失（undefined）仍放行：它由 docs 门判红，这里不编默认值。
  const floorCases = knownCount('selfTestCases')
  const countOk = floorCases === undefined || cases.length >= floorCases
  if (!countOk) console.error(`FAIL  ${'self-test case count'.padEnd(32)} cases.length=${cases.length} 低于单一来源 scripts/known-counts.json 的地板 ${floorCases}（负例只许增不许减）`)

  // 元检查：每一个内嵌 check 组件（tools/*-check.mjs）都必须至少有一条负例。
  // 这条挡的是今天实测过一次的情形——三个新组件实现都对、但没有任何负例钉住它们的
  // 红态；把它们改成永远绿，七道门与原来的负例**全绿、无人发现**。
  // 加新组件时忘了配负例，这里直接红，而不是等下次退化才后悔。
  // 约定：组件 `tools/<stem>.mjs` 的负例名是「<stem> red」去掉结尾 `-check`
  // （`counts-check.mjs` → `counts-check red`；`docs-check.mjs` → `docs red`）；
  // 也接受带 `-check` 的名字，两种都认。
  const covered = (stem) => {
    const short = stem.replace(/-check$/, '')
    return cases.some((item) => item.name === `${stem} red` || item.name === `${short} red`)
  }
  const uncovered = embeddedCheckModules().filter((stem) => !covered(stem))
  const coverageOk = uncovered.length === 0
  if (!coverageOk) console.error(`FAIL  ${'self-test coverage'.padEnd(32)} 这些内嵌 check 组件没有负例：${uncovered.join(', ')}——加一条「<组件名> red」负例`)

  console.log(`summary  pass=${cases.length - failed} fail=${failed} total=${cases.length}`)
  process.exit(failed === 0 && countOk && coverageOk ? 0 : 1)
}

/** `tools/*-check.mjs` 的基名（去扩展名，保留 `-check`）：必须自带负例的内嵌组件。 */
function embeddedCheckModules() {
  try {
    return readdirSync(join(root, 'tools'))
      .filter((name) => name.endsWith('-check.mjs'))
      .map((name) => name.slice(0, -'.mjs'.length))
  } catch {
    return []
  }
}

const gates = [
  ['version', gateVersion],
  ['syntax', gateSyntax],
  ['tests', gateTests],
  ['graph', gateGraph],
  ['docs', gateDocs],
  ['readme', gateReadmeGate],
  ['bundle', gateBundle],
]
if (layer === 'full') {
  gates.push(['graph-strict', gateStrict])
}

/**
 * 已发布计数「七道门」指的是 fast 层。`graph-strict` 是 full 层附加的一步，
 * 不算进这个数——否则 `--layer full` 会让 docs 门的门数比对误红。
 */
const coreGateCount = gates.filter(([name]) => name !== 'graph-strict').length

let failed = 0
let skipped = 0
const started = Date.now()
for (const [name, gate] of gates) {
  const at = Date.now()
  // 只给需要上下文的门传第二个参数：version 要 --dsh-version，docs 要本次运行的门数
  // （与单一来源比对）；其余门显式只传 root，免得把 options 误当 gateGraph 的 strict。
  const result = name === 'version'
    ? gate(root, { dshVersion, gateCount: coreGateCount })
    : name === 'docs'
      ? gate(root, { gateCount: coreGateCount })
      : gate(root)
  const ms = Date.now() - at
  if (result.skipped) skipped += 1
  if (!result.pass) failed += 1
  const label = result.skipped ? 'SKIP' : (result.pass ? 'PASS' : 'FAIL')
  console.log(`${label}  ${name.padEnd(14)} ${String(ms).padStart(5)} ms  ${result.detail}`)
}
const total = Date.now() - started
console.log(`summary  pass=${gates.length - failed - skipped} fail=${failed} skip=${skipped} total=${gates.length} in ${total} ms`)
process.exit(failed === 0 ? 0 : 1)
