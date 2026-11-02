#!/usr/bin/env node
/**
 * 宿主原文基准核对（补审计 §3.3 的第一处「零门禁读宿主」）。
 *
 * 背景：全仓唯一写死宿主原句的地方是 `enhance-scope/index.js` 的 `HOST_IDENTITY_SENTENCE`
 * （`keep` 态预览句 = 「去掉」那一路的证伪目标）。宿主改句 → 预览句与实况不符，而七道门
 * 全绿。这道核对把**装上那台机器上的宿主 asar** 当基准，只读比对：
 *
 *   1. `harness:identity` 这个座位存在（section 注册）；
 *   2. 本仓的 `HOST_IDENTITY_SENTENCE` 在宿主原文里**逐字**命中；
 *   3. `harness:source` / `app:web-surface` 各自**同时**以 section 与 context 出现
 *      （本仓的遮蔽计划按「成对」注册，宿主少一条就是不变量变了）。
 *
 * 三条都不改仓、不写盘、不联网。
 *
 * **跳过 ≠ 通过**：没有 asar（CI 上必然没有）时打印「跳过（没有宿主 asar）」并 exit 0，
 * 但**不打印 OK**；`DSH_ASAR` 指到一个坏/空 asar 时必须 exit 1——把「核不了」和「核过了」
 * 混成同一种信号，正是这道核对要防的事。
 *
 * 用法：
 *   node tools/host-check.mjs [--asar <路径>] [--root <项目根>]
 *   DSH_ASAR=<路径> node tools/host-check.mjs
 *
 * 退出码：0 命中或如实跳过；1 红（asar 坏/条目缺/原句没命中/成对关系不成立）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findEntry, openAsar } from './asar-read.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

/** 宿主包里放这两组注册项的模块（路径后缀；精确路径优先）。 */
const SYSTEM_PROMPT_SUFFIX = '/@deepseek-ai/dsh-system-prompt/lib/index.js'
const DEV_CONTEXT_SUFFIX = '/@deepseek-ai/dsh-harness-dev-context/lib/index.js'
const SYSTEM_PROMPT_PATH = 'dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
const DEV_CONTEXT_PATH = 'dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js'

/** 本仓声明的宿主原句常量。抽不出来 = 红（不猜、不退回空串）。 */
const SENTENCE_SOURCE = 'enhance-scope/index.js'
const SENTENCE_CONST = 'HOST_IDENTITY_SENTENCE'

/** 用法错只打一行、exit 1。 */
function parseArgs(argv) {
  const options = { asar: undefined, root: repo }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === '--asar' || arg === '--root') {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`${arg} 需要一个值`)
      options[arg === '--asar' ? 'asar' : 'root'] = resolve(value)
      index += 1
    } else throw new Error(`未知参数：${arg}`)
  }
  return options
}

let cli
try {
  cli = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`host-check: ${String(error?.message ?? error)}`)
  process.exit(1)
}

/** 装机根下的 asar 候选路径（跨机器不回退到 `%TEMP%` 的临时件）。 */
function candidateAsars() {
  const out = []
  const local = process.env.LOCALAPPDATA
  if (typeof local === 'string' && local !== '') out.push(join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[key]
    if (typeof base === 'string' && base !== '') out.push(join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  const profile = process.env.USERPROFILE
  if (typeof profile === 'string' && profile !== '') out.push(join(profile, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  return out
}

/** 从生产代码里抽宿主原句常量（唯一写死处；抽不出来判红）。 */
function hostIdentitySentence(root) {
  const file = join(root, SENTENCE_SOURCE)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`${SENTENCE_SOURCE} 读不到：${String(error?.message ?? error)}`)
  }
  const match = new RegExp(`const\\s+${SENTENCE_CONST}\\s*=\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`).exec(text)
  if (match === null) throw new Error(`${SENTENCE_SOURCE} 里抽不出 ${SENTENCE_CONST} 常量`)
  return match[2]
}

/**
 * 解析源码里的注册项：`.section({ name: X, … })` / `.context({ name: X, … })`。
 * `name` 可以是字面量，也可以是本文件里的 `const X = "字符串"` 常量。
 * @param {string} text
 * @returns {{ kind: 'section'|'context', name: string, raw: string }[]}
 */
function parseRegistrations(text) {
  const constants = new Map()
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'])([^"'\n]*)\2/g)) {
    constants.set(match[1], match[3])
  }
  const out = []
  const pattern = /\.(section|context)\(\s*\{\s*name:\s*([A-Za-z_$][\w$]*|["'][^"'\n]*["'])/g
  for (const match of text.matchAll(pattern)) {
    const raw = match[2]
    const literal = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw
    const resolved = literal.includes(':') ? literal : (constants.get(literal) ?? literal)
    out.push({ kind: match[1], name: resolved, raw: literal })
  }
  return out
}

/** 取 asar 里某个文件的文本；缺失抛错。 */
function readEntry(asar, exact, suffix) {
  const entry = findEntry(asar.entries, exact, suffix)
  if (entry === undefined) throw new Error(`asar 里找不到条目：${exact}`)
  return asar.read(entry.path).toString('utf8')
}

const problems = []
const notes = []

const explicit = typeof cli.asar === 'string' ? cli.asar : (typeof process.env.DSH_ASAR === 'string' && process.env.DSH_ASAR.trim() !== '' ? resolve(process.env.DSH_ASAR.trim()) : undefined)
const auto = explicit === undefined ? candidateAsars().find((path) => existsSync(path)) : undefined
const archive = explicit ?? auto

if (archive === undefined) {
  // 没有 asar：如实跳过，绝不打印 OK。
  console.log('跳过（没有宿主 asar）：未设置 DSH_ASAR，也没在装机根下探测到 resources/app.asar')
  process.exit(0)
}

const source = explicit === undefined ? '自动探测' : (typeof cli.asar === 'string' ? '--asar' : 'DSH_ASAR')

if (!existsSync(archive)) {
  console.error(`[host] 红：${source} 指向的 asar 不存在：${archive}`)
  process.exit(1)
}

let asar
try {
  asar = openAsar(archive)
} catch (error) {
  console.error(`[host] 红：asar 读不出来（${source}）：${String(error?.message ?? error)}`)
  process.exit(1)
}

try {
  // ---- 1. 身份段存在 + 宿主原句逐字命中 ----
  let sentence
  try {
    sentence = hostIdentitySentence(cli.root)
  } catch (error) {
    problems.push(`本仓基准抽不出来：${String(error?.message ?? error)}`)
  }
  let systemText = null
  try {
    systemText = readEntry(asar, SYSTEM_PROMPT_PATH, SYSTEM_PROMPT_SUFFIX)
  } catch (error) {
    problems.push(`读不到宿主 system-prompt 模块：${String(error?.message ?? error)}`)
  }
  if (systemText !== null) {
    const registrations = parseRegistrations(systemText)
    const identity = registrations.filter((item) => item.name === 'harness:identity')
    if (identity.length === 0) problems.push('宿主原文里没有 name=harness:identity 的注册项（座位没了）')
    else if (!identity.some((item) => item.kind === 'section')) problems.push('harness:identity 不再是 section 注册')
    else notes.push('harness:identity：section 座位存在')

    if (typeof sentence === 'string' && sentence !== '') {
      if (systemText.includes(sentence)) notes.push(`宿主原句逐字命中：「${sentence}」`)
      else problems.push(`宿主原句没命中：本仓写的是「${sentence}」，宿主原文里找不到（宿主改句，或我们的常量写错）`)
    }
  }

  // ---- 2. source / web-surface 必须 section + context 成对 ----
  let devText = null
  try {
    devText = readEntry(asar, DEV_CONTEXT_PATH, DEV_CONTEXT_SUFFIX)
  } catch (error) {
    problems.push(`读不到宿主 harness-dev-context 模块：${String(error?.message ?? error)}`)
  }
  if (devText !== null) {
    const registrations = parseRegistrations(devText)
    for (const name of ['harness:source', 'app:web-surface']) {
      const kinds = new Set(registrations.filter((item) => item.name === name).map((item) => item.kind))
      const missing = ['section', 'context'].filter((kind) => !kinds.has(kind))
      if (missing.length === 0) notes.push(`${name}：section + context 成对`)
      else problems.push(`${name} 不再是 section + context 成对：缺 ${missing.join(' / ')}`)
    }
  }
} finally {
  asar.close()
}

if (problems.length > 0) {
  console.error(`[host] 红：宿主原文基准核对没过（${problems.length} 项，asar=${archive}）`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`[host] OK：${notes.length} 项宿主原文基准全中（asar=${archive}，${source}）`)
for (const note of notes) console.log(`  - ${note}`)
process.exit(0)