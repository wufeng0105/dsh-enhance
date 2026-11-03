#!/usr/bin/env node
/**
 * 文档计数一致性门（补审计 §4.3 的「计数无人管」）。
 *
 * 单一来源是 `scripts/known-counts.json`：测试条数、`--self-test` 负例数、冒烟断言数、
 * 设置组数、触点条数（曾列在其中的一项已移除，原因见下面的「口径边界」）。这个工具做四件事：
 *
 *   1. **生产事实先自证**：设置组数从 `ui/client.js` 的 `group("enh-block-…")` 现场数。
 *      来源写错就红，不是「文档抄来源」的循环论证。
 *   2. **扫文档里的计数声明**：`NN 项测试` / `NN 个负例` / `NN 项检查` /
 *      `NN 条断言` / `N 组|个组名` / `NN 条触点`，与来源值比对；不等就红。
 *      门数**不在**这个体系里（本仓主动拆掉的承诺位）：门数是 `scripts/check.mjs` 的
 *      运行时读数，文档不写数字，加一道门不需要同步任何文档。
 *   3. **必需声明位**：每一项计数（除 README 检查项，见下）至少有一处**点名声明**；
 *      把那行删掉 → 「缺声明」红，不是「没找到就算过」的空转。
 *   4. **历史不按现值校验**：以日期开头的标题（`### 2026-10-30（…）`）下面记的是**当时的读数**，
 *      是事实、不是承诺（`CHANGELOG.md` 同理由 `known-counts.json` 的 note 与仓库根的 `OUTLINE.md`
 *      的「旧计数不改」定下），不参与现值比对。
 *   5. **`--report` 只读**：把 2/3 两步扫到的每一处声明位打成清单（`文件:行` + 现写值 +
 *      是否与来源一致），必需声明位单独成节，末行固定是
 *      `[counts] report: <M> 处声明 / <R> 个必需声明位`。它**不改任何比对逻辑、不写盘**，
 *      常规运行的行为与输出逐字不变；M 取清单条数（不是另一套计数器），所以清单被截断
 *      或伪造一条，末行数字会跟着变——这是「报告自己数错却自洽」的防线。
 *
 * 口径边界，写清楚不装：
 *   - `smokeAssertions` / `hostContacts` **原先标人工维护值**——当时的理由是「冒烟要 pwsh + dsh CLI、
 *     触点计数口径是散文公式，算不出来」，判据只剩「某份日志里写着 total=NN」，而日志不进仓，
 *     等于没人核：谁把数改成任意值、文档跟着改就全绿。**这一点已证伪**——`tools/smoke.mjs` 的
 *     `EXPECTED_ASSERTIONS` 跑完自校、`tools/contacts-count.mjs` 按 `docs/compatibility.md` 的口径
 *     现场数，两个数都有了机器来源，`known-counts.json` 里两者的 `kind` 也已从 `manual` 改成
 *     `computed`（各自的 `computedBy` 写着来源）。它们现在与其余计数一样，只校验
 *     「来源值 == 各文档声明值」。
 *   - `readmeChecks` 已从单一来源**移除**：README 结构检查的项数随章节数变化（增删一节就 ±1），
 *     既没有文档声明位、也抓不到缺陷，钉住它只会逼人「改 README 章节就同步一个 JSON」。
 *     readme 门现在只判「结构检查有没有过」，不再比对总数。
 *
 * 用法：node tools/counts-check.mjs [--root <项目根>] [--report]
 * 退出码：0 全一致；1 有漂移/缺声明/用法错。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 英文数字（`README.en.md` 写 `five groups`）。 */
const EN_DIGITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * 把捕获到的数字串（阿拉伯/中文/英文）转成数字；**转不了返回 NaN，由调用方判红**。
 *
 * 中文按「百/十/个位」拆，覆盖到千（`二百`、`三十五`、`一百零八`）。原先只认十以内，
 * 于是 `self-test 二百个负例` 这种写法会匹配到、转不出数、被静默跳过——**不猜 = 放过**，
 * 那是比算错更坏的一种静默（独立审计实测过这一条）。
 */
function toNumber(raw) {
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return Number(text)

  const lower = text.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(EN_DIGITS, lower)) return EN_DIGITS[lower]

  // 纯中文数字：按位权累加，支持 百 / 十 / 个位；允许「两」= 2。
  if (/^[一二三四五六七八九十百两零]+$/.test(text)) {
    const digit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    let total = 0
    let current = 0
    for (const ch of text) {
      if (ch === '百') { total += (current === 0 ? 1 : current) * 100; current = 0 }
      else if (ch === '十') { total += (current === 0 ? 1 : current) * 10; current = 0 }
      else current = digit[ch] ?? 0
    }
    return total + current
  }
  return Number.NaN
}

/**
 * 扫描规则：文档里出现这些说法就是一句计数声明。
 * 每条 `{ count, regex }`；regex 的第 1 组是数字，若有第 2 组则必须与第 1 组同值（`17/17` 形）。
 */
const SCAN = [
  // ---- tests：测试条数 ----
  // 光认「NN 项测试」会漏掉实测过的四种写法（独立审计抓到的）：`999 条测试`、
  // `999 个用例`、`验证结果 999/999`、以及英文 `999 tests`。量词必须是「测试/用例」，
  // 不能用裸「条」或「个」——那两个在中文里遍地都是（`一条消息`、`一个开关`），
  // 扩成裸量词会把正常表达判红。这是「枚举合法说法」而不是「模糊匹配」。
  { count: 'tests', regex: /(\d+)\s*(?:条|项|个)\s*(?:测试|用例)/g },
  { count: 'tests', regex: /(\d+)\s*项测试/g },
  { count: 'tests', regex: /(\d+)\s*tests?\b/gi },
  { count: 'tests', regex: /(?:验证结果|测试结果)[^\d\n]{0,6}(\d+)\s*\/\s*(\d+)/g },

  // ---- selfTestCases：负例条数（中文数字也要认，`二百` 这类先按十位内处理） ----
  { count: 'selfTestCases', regex: /([一二三四五六七八九十百两\d]+)\s*个负例/g },
  { count: 'selfTestCases', regex: /(\d+)\s*negative (?:cases|examples)/gi },
  { count: 'selfTestCases', regex: /--self-test[^\n\d]{0,12}(\d+)\s*\/\s*(\d+)/g },

  // readmeChecks 不再参与比对（见文件头口径边界），所以它那两个扫描式也一并去掉：
  // 留着只会让「文档里写了 N 项结构检查」指向一个不存在的来源值。
  { count: 'smokeAssertions', regex: /([一二三四五六七八九十\d]+)\s*(?:条|项)\s*断言/g },
  { count: 'smokeAssertions', regex: /(\d+)\s*assertions?\b/gi },
  { count: 'smokeAssertions', regex: /smoke[^\n]{0,30}?(\d+)\s*\/\s*(\d+)/gi },
  { count: 'settingsGroups', regex: /([一二三四五六七八九十\d]+)\s*组[：:]/g },
  { count: 'settingsGroups', regex: /([一二三四五六七八九十\d]+)\s*个组(?:名|设置)?/g },
  { count: 'settingsGroups', regex: /([一二三四五六七八九十\d]+)\s*组设置/g },
  { count: 'settingsGroups', regex: /\b(five|four|three|six|\d+)\s+groups?\b/gi },
  { count: 'hostContacts', regex: /([二三四五六七八九十\d]+)\s*条(?:独立)?触点/g },
  { count: 'hostContacts', regex: /(?:共|合计|总共|正好)\s*([二三四五六七八九十\d]+)\s*条/g },
  { count: 'hostContacts', regex: /(?:现为|重数为)\s*([二三四五六七八九十\d]+)\s*条/g },
  // 注意：中文「一」不进这些族。`一条触点`、`一组设置` 是叙述量词，不是计数声明；
  // 实测过一次误报（`brand-persona.md:258` 的「一条触点」被当成 hostContacts=1）。
  // 「一」作为计数只出现在「一 项测试」这类英文式写法里，而那种写法在中文文档里不存在。
  { count: 'hostContacts', regex: /(\d+)\s*(?:independent )?host contacts?/gi },
]

/**
 * 必需声明位：**对外承诺与口径权威**必须点名一个计数，其余文档只做「出现即校验」。
 * 删掉那一行 → 红（不是「扫不到就放过」）。`what` 只用于报错时指路。
 *
 * 为什么只留这些：契约文档（`docs/brand-persona.md`）里的测试数 / 冒烟数 / 触点
 * 「现为 NN 条」原先也是必需位，结果是**每加一个测试都得去改契约的措辞**，否则门禁
 * 红——那是把「计数必须说对」错做成了「计数必须提到」。现在这三处改为：写了就按现值
 * 校验，没写不算错；对外承诺（README 的组数、CONTRIBUTING 的负例数）与口径
 * 权威（compatibility 的触点数、terminology 的组名）仍然强制，因为它们是对读者的承诺。
 *
 * 门数**不在这张表里**：门数不是文档承诺，加一道门也不该逼人改三份文档——本仓拆掉
 * 门数承诺位时把它从 REQUIRED / SCAN / 单一来源三处一起移除了。
 */
const REQUIRED = [
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
  const options = { root: resolve(here, '..'), report: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--root') {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('--root 需要一个值')
      options.root = resolve(value)
      index += 1
    } else if (arg === '--report') {
      options.report = true
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
/** 每个计数的 kind：`computed` = 精确值；`floor` = 下限（文档里写的数只许 ≥ 它）。缺省按 computed。 */
const sourceKind = {}
for (const [key, entry] of Object.entries(known?.counts ?? {})) {
  if (!Number.isInteger(entry?.value) || entry.value < 0) {
    problems.push(`单一来源里 ${key} 的 value 不是非负整数：${JSON.stringify(entry?.value)}`)
    continue
  }
  source[key] = entry.value
  sourceKind[key] = entry?.kind === 'floor' ? 'floor' : 'computed'
}
if (Object.keys(source).length === 0) problems.push('单一来源里一个计数都没有')

/**
 * 一个文档声明值是否与单一来源相符。
 *
 * `computed` 要精确相等；`floor` 只要求 ≥（「只许增不许减」的计数用它——
 * 加一条负例、加一道门不该先欠一轮文档批，但悄悄减掉必须判红）。
 * @param {string} key
 * @param {number} value
 * @returns {boolean}
 */
function agrees(key, value) {
  const expected = source[key]
  return sourceKind[key] === 'floor' ? value >= expected : value === expected
}

/** 生成「不一致」说明里「应为」那一段的措辞：floor 类要说清是下界。 */
function expectedLabel(key) {
  return sourceKind[key] === 'floor' ? `不得低于 ${source[key]}` : `应为 ${source[key]}`
}

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

// ---------------------------------------------------------------- 文档声明

/** 参与现值比对的文档：README 两份 + CONTRIBUTING + docs/**（`CHANGELOG.md` 是历史事实，不收）。 */
function collectDocs() {
  const out = []
  for (const name of ['README.md', 'README.en.md', 'CONTRIBUTING.md']) {
    const path = join(root, name)
    if (existsSync(path)) out.push(path)
  }
  // 除 `.md` 之外，还要收文档型产物：SVG 与图源 JSON 里也写着计数（实测漏过——
  // `docs/figures/sources/compat-verify.workflow.json` 把「36 条独立触点」改成 35，
  // 只收 `.md` 时这里 exit 0）。这些文件抽纯文本比对即可，不需要解析结构。
  const DOC_EXT = /\.(md|svg|json)$/i
  const add = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) add(path)
      else if (entry.isFile() && DOC_EXT.test(entry.name)) out.push(path)
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

/**
 * 豁免：这些位置上的「N <量词>」是**另一个意思**，不是计数声明。
 *
 * 每条必须写 `reason`：豁免本身就是新的静默通道，没有理由的豁免等于把门禁开个洞。
 * 只允许按「文件 + 精确文本片段」豁免，不许按文件整体豁免（那会把整份文档放空）。
 * 豁免片段在扫描时先被抹掉，抹掉后照常扫其余部分。
 */
const EXEMPT = [
  {
    file: 'docs/figures/sources/save-roundtrip.sequence.json',
    text: '三道门',
    reason: '图里的标题指「文本进系统提示要过的三道判定」，不是门禁道数',
  },
]

/**
 * 声明位收集表：**只供 `--report` 打印**，不参与任何判定——判定仍然走 `problems`，
 * 所以加不加 `--report`，红绿与常规输出完全一致。
 *
 * `sites` 与 `scanned` 在同一处自增：汇总行的 M 取 `sites.length` 而不是 `scanned`，
 * 是因为报告要「数它自己列出来的东西」——截断清单或伪造一条，M 会跟着变，判据才抓得住。
 */
const sites = []
const requiredSites = []

let scanned = 0
const exempted = []
for (const file of docs) {
  const rel = show(file)
  // 去掉 markdown 的强调标记：「**161** 项测试」与「161 项测试」是同一句声明
  let raw = readFileSync(file, 'utf8').replace(/\*/g, '')
  for (const rule of EXEMPT) {
    if (rule.file !== rel) continue
    if (!raw.includes(rule.text)) {
      // 豁免失效也要吭声：文档改过之后豁免就该删掉，否则它会掩盖真问题
      problems.push(`豁免失效：${rel} 里已找不到「${rule.text}」，把这条从 EXEMPT 删掉（${rule.reason}）`)
      continue
    }
    raw = raw.split(rule.text).join('　') // 全角空格占位，保持行号不变
    exempted.push(`${rel}「${rule.text}」`)
  }
  const lines = raw.split(/\r?\n/)
  const dated = datedLineFlags(lines)
  lines.forEach((line, index) => {
    if (dated[index]) return
    for (const { count, regex } of SCAN) {
      const expected = source[count]
      if (expected === undefined) continue
      for (const match of line.matchAll(regex)) {
        const first = toNumber(match[1])
        const second = match[2] === undefined ? first : toNumber(match[2])
        // 认不出数字就必须报：`二百个负例` 原先匹配到但 toNumber 返回 NaN，被静默放过。
        if (Number.isNaN(first) || Number.isNaN(second)) {
          problems.push(`${rel}:${index + 1} 的「${match[0].trim()}」认得是计数声明、但解析不出数字——要么改写成阿拉伯数字，要么进 EXEMPT`)
          continue
        }
        scanned += 1
        const ok = agrees(count, first) && agrees(count, second)
        sites.push({ file: rel, line: index + 1, count, text: match[0].trim(), value: first, second, ok })
        if (!ok) {
          problems.push(`${rel}:${index + 1} 的「${match[0].trim()}」与单一来源不一致：${count} ${expectedLabel(count)}，这里是 ${first}${second === first ? '' : `/${second}`}`)
        }
      }
    }
  })
}

// ---------------------------------------------------------------- 必需声明位

/**
 * **实际核过**的规则序号。汇总行只报这个集合的大小，不再报 `REQUIRED.length`：
 * 规则表里有一条指向不存在的来源值时，旧写法会 `continue` 跳过它，却仍按规则表长度
 * 打印「N 个必需声明位都一致」——本批实测过：报 8 的时候其中 3 条根本没核。
 */
const requiredChecked = new Set()

for (const [ruleIndex, required] of REQUIRED.entries()) {
  const expected = source[required.count]
  if (expected === undefined) {
    // 规则在、来源值不在 = 这条规则永远核不到。跳过它却把它算进汇总行就是虚报，
    // 所以这里判红（fail-closed），不是静默 continue。
    problems.push(`必需声明位规则 ${ruleIndex + 1}（${required.doc} 的「${required.what}」）指向单一来源里不存在的计数 ${required.count}：补来源值，或把这条规则删掉`)
    requiredSites.push({
      rule: ruleIndex + 1, file: required.doc, line: 0, count: required.count,
      what: required.what, text: '', value: undefined, second: undefined, ok: false,
      missing: `规则指向不存在的计数 ${required.count}`,
    })
    continue
  }
  requiredChecked.add(ruleIndex + 1)
  const path = join(root, required.doc)
  const missingSite = (reason) => requiredSites.push({
    rule: ruleIndex + 1, file: required.doc, line: 0, count: required.count,
    what: required.what, text: '', value: undefined, second: undefined, ok: false, missing: reason,
  })
  let text
  try {
    text = readFileSync(path, 'utf8').replace(/\*/g, '')
  } catch (error) {
    problems.push(`必需声明位缺失：${required.doc} 读不到（${String(error?.message ?? error)}）`)
    missingSite(`读不到 ${required.doc}`)
    continue
  }
  const matches = [...text.matchAll(required.regex)]
  if (matches.length === 0) {
    problems.push(`${required.doc} 缺计数声明（${required.what}）：删掉声明行不是「没声明就不管」，是红`)
    missingSite(`缺计数声明（${required.what}）`)
    continue
  }
  for (const match of matches) {
    const value = toNumber(match[1])
    if (Number.isNaN(value)) continue
    // 行号从 match.index 反推：`*` 已被抹掉但行数不变，所以这里与文件里的行号一致。
    const line = text.slice(0, match.index).split('\n').length
    const ok = agrees(required.count, value)
    requiredSites.push({
      rule: ruleIndex + 1, file: required.doc, line, count: required.count,
      what: required.what, text: match[0].trim(), value, second: undefined, ok, missing: '',
    })
    if (!ok) {
      problems.push(`${required.doc} 的「${match[0].trim()}」与单一来源不一致：${required.count} ${expectedLabel(required.count)}，这里是 ${value}`)
    }
  }
}

/** 汇总行报的 R：这一轮**实际核过**的规则条数（不是规则表长度，见上面的洞）。 */
const requiredCount = requiredChecked.size

// ---------------------------------------------------------------- 报告模式

/**
 * `--report`：只读地把「每一处声明位」打成一张清单，让「改一个计数」从
 * 「跑门禁 → 读一条红项 → 改一处 → 再跑」变成「照着清单一次改完」。
 *
 * 三条硬约束（输出契约，判据靠它解析）：
 *   1. 每处扫到的声明位一行，行内含 `文件:行` 与当轮现写值；
 *   2. 必需声明位单独成节，不与扫到的混在一起；
 *   3. 末行固定 `[counts] report: <M> 处声明 / <R> 个必需声明位`。
 *
 * M 取 `sites.length`（清单本身），R 取 `requiredCount`（实际核过的规则数，与常规运行
 * 「N 个必需声明位」同一个表达式）：两数都是当轮现算。清单被截断或伪造一条，M 会变；
 * 规则表里有一条核不到，R 会跟着少——这是判据的抓手。
 * 本分支**不写盘、不改文件**；有 problems 时照常打红到 stderr 并 exit 1。
 */
if (cli.report) {
  if (problems.length > 0) {
    console.error(`[counts] ${problems.length} 项：`)
    for (const problem of problems) console.error(`  - ${problem}`)
  }

  const width = Math.max(
    0,
    ...sites.map((site) => `${site.file}:${site.line}`.length),
    ...requiredSites.filter((site) => site.missing === '').map((site) => `${site.file}:${site.line}`.length),
  )
  const where = (site) => `${site.file}:${site.line}`.padEnd(width)
  const verdict = (site) => (site.ok ? '一致' : `不一致（${expectedLabel(site.count)}）`)
  const sourceLine = Object.entries(source)
    .map(([key, value]) => `${key}=${value}${sourceKind[key] === 'floor' ? '（下限）' : ''}`)
    .join('  ')

  console.log('[counts] 报告模式（--report）：只读，不写盘、不改文件')
  console.log(`[counts] 单一来源：${Object.keys(source).length} 个计数 / ${docs.length} 份文档`)
  console.log(`[counts] 来源值：${sourceLine}`)
  console.log('[counts]')
  console.log(`[counts] 声明位（扫到 ${sites.length} 处；格式：文件:行  计数=现写值  「原文」  判定）`)
  for (const site of sites) {
    const shown = site.second === site.value ? `${site.value}` : `${site.value}/${site.second}`
    console.log(`  ${where(site)}  ${site.count}=${shown}  「${site.text}」  ${verdict(site)}`)
  }
  console.log('[counts]')
  const hits = requiredSites.filter((site) => site.missing === '').length
  console.log(`[counts] 必需声明位（REQUIRED ${REQUIRED.length} 条规则，逐处列出共 ${hits} 处）`)
  for (const site of requiredSites) {
    if (site.missing !== '') {
      console.log(`  缺：${site.file}  ${site.count}（${site.missing}）——必需位一处都没命中，这是红`)
      continue
    }
    console.log(`  ${where(site)}  ${site.count}=${site.value}  「${site.text}」  ${verdict(site)}（必需位 ${site.rule}/${requiredCount}：${site.what}）`)
  }
  console.log('[counts]')
  console.log(`[counts] report: ${sites.length} 处声明 / ${requiredCount} 个必需声明位`)
  process.exit(problems.length > 0 ? 1 : 0)
}

// ---------------------------------------------------------------- 结果

if (problems.length > 0) {
  console.error(`[counts] ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`[counts] OK：${Object.keys(source).length} 个计数 / ${docs.length} 份文档 / ${scanned} 处声明 / ${requiredCount} 个必需声明位都一致（CHANGELOG.md 是历史事实，不按现值校验）`)
process.exit(0)