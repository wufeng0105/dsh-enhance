#!/usr/bin/env node
/**
 * 文档计数一致性门（补审计 §4.3 的「计数无人管」）。
 *
 * 单一来源是 `scripts/known-counts.json`：测试条数、`--self-test` 负例数、门数、README 结构
 * 检查项数、冒烟断言数、设置组数、触点条数。这个工具做四件事：
 *
 *   1. **生产事实先自证**：设置组数从 `ui/client.js` 的 `group("enh-block-…")` 现场数；
 *      门数由 `check.mjs` 通过 `--gates` 传进来现场比对。来源写错就红，不是「文档抄来源」的循环论证。
 *   2. **扫文档里的计数声明**：`NN 项测试` / `NN 个负例` / `N 道闸|门` / `NN 项检查` /
 *      `NN 条断言` / `N 组|个组名` / `NN 条触点`，与来源值比对；不等就红。
 *   3. **必需声明位**：每一项计数（除 README 检查项，见下）至少有一处**点名声明**；
 *      把那行删掉 → 「缺声明」红，不是「没找到就算过」的空转。
 *   4. **历史不按现值校验**：以日期开头的标题（`### 2026-10-30（…）`）下面记的是**当时的读数**，
 *      是事实、不是承诺（`CHANGELOG.md` 同理由 `known-counts.json` 的 note 与 `.zhll/OUTLINE.md`
 *      的「旧计数不改」定下），不参与现值比对。
 *
 * 口径边界，写清楚不装：
 *   - `smokeAssertions` / `hostContacts` 是**人工维护值**——冒烟要 pwsh + dsh CLI、触点计数口径
 *     是散文公式，fast 层算不出来。它们只校验「来源值 == 各文档声明值」，不假装能机算。
 *   - `readmeChecks` 已从单一来源**移除**：README 结构检查的项数随章节数变化（增删一节就 ±1），
 *     既没有文档声明位、也抓不到缺陷，钉住它只会逼人「改 README 章节就同步一个 JSON」。
 *     readme 门现在只判「结构检查有没有过」，不再比对总数。
 *
 * 用法：node tools/counts-check.mjs [--root <项目根>] [--gates <本次运行的门的数量>]
 * 退出码：0 全一致；1 有漂移/缺声明/用法错。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 中文数字（文档里写「七道闸」「五组」），只到十：再大就不是这些计数了。 */
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
/** 英文数字（`README.en.md` 写 `seven gates` / `five groups`）。 */
const EN_DIGITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/** 把捕获到的数字串（阿拉伯/中文/英文）转成数字；转不了返回 NaN（不猜）。 */
function toNumber(raw) {
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Number(text)
  if (Object.prototype.hasOwnProperty.call(CN_DIGITS, text)) return CN_DIGITS[text]
  const lower = text.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(EN_DIGITS, lower)) return EN_DIGITS[lower]
  return Number.NaN
}

/**
 * 扫描规则：文档里出现这些说法就是一句计数声明。
 * 每条 `{ count, regex }`；regex 的第 1 组是数字，若有第 2 组则必须与第 1 组同值（`17/17` 形）。
 */
const SCAN = [
  { count: 'tests', regex: /(\d+)\s*项测试/g },
  { count: 'tests', regex: /(\d+)\s*tests\b/gi },
  { count: 'selfTestCases', regex: /(\d+)\s*个负例/g },
  { count: 'selfTestCases', regex: /(\d+)\s*negative (?:cases|examples)/gi },
  { count: 'selfTestCases', regex: /--self-test[^\n\d]{0,12}(\d+)\s*\/\s*(\d+)/g },
  { count: 'gates', regex: /([一二三四五六七八九十\d]+)\s*道(?:闸|门|门禁)/g },
  { count: 'gates', regex: /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+gates?\b/gi },
  // readmeChecks 不再参与比对（见文件头口径边界），所以它那两个扫描式也一并去掉：
  // 留着只会让「文档里写了 N 项结构检查」指向一个不存在的来源值。
  { count: 'smokeAssertions', regex: /(\d+)\s*条断言/g },
  { count: 'smokeAssertions', regex: /(\d+)\s*assertions?\b/gi },
  { count: 'smokeAssertions', regex: /smoke[^\n]{0,30}?(\d+)\s*\/\s*(\d+)/gi },
  { count: 'settingsGroups', regex: /([一二三四五六七八九十\d]+)\s*组[：:]/g },
  { count: 'settingsGroups', regex: /([一二三四五六七八九十\d]+)\s*个组(?:名|设置)?/g },
  { count: 'settingsGroups', regex: /([一二三四五六七八九十\d]+)\s*组设置/g },
  { count: 'settingsGroups', regex: /\b(five|four|three|six|\d+)\s+groups?\b/gi },
  { count: 'hostContacts', regex: /(\d+)\s*条(?:独立)?触点/g },
  { count: 'hostContacts', regex: /(?:共|合计|总共|正好)\s*(\d+)\s*条/g },
  { count: 'hostContacts', regex: /(?:现为|重数为)\s*(\d+)\s*条/g },
  { count: 'hostContacts', regex: /(\d+)\s*(?:independent )?host contacts?/gi },
]

/**
 * 必需声明位：**对外承诺与口径权威**必须点名一个计数，其余文档只做「出现即校验」。
 * 删掉那一行 → 红（不是「扫不到就放过」）。`what` 只用于报错时指路。
 *
 * 为什么只留这些：契约文档（`docs/brand-persona.md`）里的测试数 / 冒烟数 / 触点
 * 「现为 NN 条」原先也是必需位，结果是**每加一个测试都得去改契约的措辞**，否则门禁
 * 红——那是把「计数必须说对」错做成了「计数必须提到」。现在这三处改为：写了就按现值
 * 校验，没写不算错；对外承诺（README 的门数与组数、CONTRIBUTING 的负例数）与口径
 * 权威（compatibility 的触点数、terminology 的组名）仍然强制，因为它们是对读者的承诺。
 */
const REQUIRED = [
  { doc: 'README.md', count: 'gates', what: '七道门禁', regex: /([一二三四五六七八九十\d]+)\s*道门禁/g },
  { doc: 'README.en.md', count: 'gates', what: 'seven gates', regex: /\b(seven|six|eight|\d+)\s+gates?\b/gi },
  { doc: 'CONTRIBUTING.md', count: 'gates', what: '七道闸', regex: /([一二三四五六七八九十\d]+)\s*道闸/g },
  { doc: 'CONTRIBUTING.md', count: 'selfTestCases', what: 'NN 个负例', regex: /(\d+)\s*个负例/g },
  { doc: 'docs/compatibility.md', count: 'hostContacts', what: '共 NN 条', regex: /共\s*(\d+)\s*条/g },
  { doc: 'docs/terminology.md', count: 'settingsGroups', what: 'N 个组名', regex: /([一二三四五六七八九十\d]+)\s*个组名/g },
  { doc: 'README.md', count: 'settingsGroups', what: 'N 组：', regex: /([一二三四五六七八九十\d]+)\s*组[：:]/g },
  { doc: 'README.en.md', count: 'settingsGroups', what: 'five groups', regex: /\b(five|four|three|six|\d+)\s+groups?\b/gi },
]

/** 以日期开头的标题：下面记的是当时的读数，不按现值校验。 */
const DATED_HEADING = /^\d{4}-\d{1,2}-\d{1,2}\b/

/** 用法错只打一行、exit 1。 */
function parseArgs(argv) {
  const options = { root: resolve(here, '..'), gates: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--root') {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--root 需要一个值')
      options.root = resolve(value)
      index += 1
    } else if (arg === '--gates') {
      if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) throw new Error('--gates 需要一个是整数的值')
      options.gates = Number(value.trim())
      index += 1
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

let cli
try {
  cli = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`counts-check: ${String(error?.message ?? error)}`)
  process.exit(1)
}

const root = cli.root
const problems = []

// ---------------------------------------------------------------- 单一来源

const countsPath = join(root, 'scripts', 'known-counts.json')
let known
try {
  known = JSON.parse(readFileSync(countsPath, 'utf8'))
} catch (error) {
  console.error(`[counts] 红：单一来源读不出来（${countsPath}）：${String(error?.message ?? error)}`)
  process.exit(1)
}
const source = {}
for (const [key, entry] of Object.entries(known?.counts ?? {})) {
  if (!Number.isInteger(entry?.value) || entry.value < 0) {
    problems.push(`单一来源里 ${key} 的 value 不是非负整数：${JSON.stringify(entry?.value)}`)
    continue
  }
  source[key] = entry.value
}
if (Object.keys(source).length === 0) problems.push('单一来源里一个计数都没有')

// ---------------------------------------------------------------- 生产事实先自证

/** 设置组数：`ui/client.js` 里 `group("enh-block-…")` 的调用数。 */
function productionGroupCount() {
  const file = join(root, 'ui', 'client.js')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { error: `读不到 ui/client.js：${String(error?.message ?? error)}` }
  }
  const names = [...text.matchAll(/\bgroup\(\s*["'](enh-block-[^"']+)["']/g)].map((match) => match[1])
  return { value: names.length, names }
}

const groups = productionGroupCount()
if (groups.error !== undefined) problems.push(`设置组数算不出来：${groups.error}`)
else if (source.settingsGroups !== undefined && groups.value !== source.settingsGroups) {
  problems.push(`设置组数漂移：ui/client.js 里数到 ${groups.value} 组（${groups.names.join(' / ')}），单一来源写 ${source.settingsGroups}`)
}

if (cli.gates !== undefined && source.gates !== undefined && cli.gates !== source.gates) {
  problems.push(`门数漂移：本次运行 gates=${cli.gates}，单一来源写 ${source.gates}（门数变了要连文档一起改，不能悄悄加第八道）`)
}

// ---------------------------------------------------------------- 文档声明

/** 参与现值比对的文档：README 两份 + CONTRIBUTING + docs/**（`CHANGELOG.md` 是历史事实，不收）。 */
function collectDocs() {
  const out = []
  for (const name of ['README.md', 'README.en.md', 'CONTRIBUTING.md']) {
    const path = join(root, name)
    if (existsSync(path)) out.push(path)
  }
  const add = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) add(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path)
    }
  }
  if (existsSync(join(root, 'docs'))) add(join(root, 'docs'))
  return out
}

const docs = collectDocs()
if (docs.length === 0) problems.push('一份文档都没收到：计数一致性静默失效，判红')

const show = (path) => relative(root, path).split(sep).join('/')

/** 一行是否落在「以日期开头的标题」下面（历史核验记录）。 */
function datedLineFlags(lines) {
  const flags = []
  const stack = []
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      while (stack.length > 0 && stack[stack.length - 1].level >= heading[1].length) stack.pop()
      stack.push({ level: heading[1].length, dated: DATED_HEADING.test(heading[2].trim()) })
    }
    flags.push(stack.some((item) => item.dated))
  }
  return flags
}

let scanned = 0
for (const file of docs) {
  const rel = show(file)
  // 去掉 markdown 的强调标记：「**161** 项测试」与「161 项测试」是同一句声明
  const lines = readFileSync(file, 'utf8').replace(/\*/g, '').split(/\r?\n/)
  const dated = datedLineFlags(lines)
  lines.forEach((line, index) => {
    if (dated[index]) return
    for (const { count, regex } of SCAN) {
      const expected = source[count]
      if (expected === undefined) continue
      for (const match of line.matchAll(regex)) {
        const first = toNumber(match[1])
        const second = match[2] === undefined ? first : toNumber(match[2])
        if (Number.isNaN(first) || Number.isNaN(second)) continue
        scanned += 1
        if (first !== expected || second !== expected) {
          problems.push(`${rel}:${index + 1} 的「${match[0].trim()}」与单一来源不一致：${count} 应为 ${expected}，这里是 ${first}${second === first ? '' : `/${second}`}`)
        }
      }
    }
  })
}

// ---------------------------------------------------------------- 必需声明位

for (const required of REQUIRED) {
  const expected = source[required.count]
  if (expected === undefined) continue
  const path = join(root, required.doc)
  let text
  try {
    text = readFileSync(path, 'utf8').replace(/\*/g, '')
  } catch (error) {
    problems.push(`必需声明位缺失：${required.doc} 读不到（${String(error?.message ?? error)}）`)
    continue
  }
  const matches = [...text.matchAll(required.regex)]
  if (matches.length === 0) {
    problems.push(`${required.doc} 缺计数声明（${required.what}）：删掉声明行不是「没声明就不管」，是红`)
    continue
  }
  for (const match of matches) {
    const value = toNumber(match[1])
    if (Number.isNaN(value)) continue
    if (value !== expected) {
      problems.push(`${required.doc} 的「${match[0].trim()}」与单一来源不一致：${required.count} 应为 ${expected}，这里是 ${value}`)
    }
  }
}

// ---------------------------------------------------------------- 结果

if (problems.length > 0) {
  console.error(`[counts] ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
const manual = Object.entries(known.counts).filter(([, entry]) => entry.kind === 'manual').map(([key]) => key)
console.log(`[counts] OK：${Object.keys(source).length} 个计数（${manual.length} 个人工维护：${manual.join(' / ')}）/ ${docs.length} 份文档 / ${scanned} 处声明 / ${REQUIRED.length} 个必需声明位都一致（CHANGELOG.md 是历史事实，不按现值校验）`)
process.exit(0)