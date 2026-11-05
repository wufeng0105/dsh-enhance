#!/usr/bin/env node
/**
 * compat-diff：例行核验第 2/3 步（tree-diff 与读 diff）的工具化。
 *
 * 为什么进仓：上游每个 rc 都可能动接缝，「列变更 → 取 blob → 逐文件 diff → 按接缝
 * 关键词预分类」此前靠临时脚本与 gh api 手工完成（2026-11-06 的 0.2.2-rc.1 轮该步
 * 占 35% 工时）。这里把流程固化成一条命令，blobless clone 缓存建一次反复用。
 *
 * 用法：
 *   node tools/compat-diff.mjs <oldTag> <newTag> [--out <dir>] [--cache <dir>]
 *                              [--repo <url|path>] [--trees <tag,...>]
 *
 * 主模式：对 9 个核验包列两 tag 间的文件级变更（+/~/-），逐文件统一 diff（--out 落盘，
 * 缺省不落盘只打印清单），并按 docs/compatibility.md「例行核验」第 1a 步表格的 8 组
 * 接缝关键词表达式预分类。stdout 首行是机器可判的数量行 `changed-files: <n>`，
 * 每文件一行分类，尾部打印边界句：
 *
 *   changed-files: 38
 *   SEAM-HIT <组名,...>\t<路径>     任一表达式命中（需人读）
 *   SKIM\t<路径>                    零命中（可略读，但不是免检）
 *   预分类是分诊不是判决，SKIM 不等于免检
 *
 * repo 来源与缓存语义（.zhll/02-审计-S1.md B1 的实证口径，不夸大成「gh api 归零」）：
 *   - 优先级：--repo 指向的本地路径 > --repo URL / 缺省时的缓存目录；
 *   - tree 阶段零网络：blobless clone（git clone --filter=blob:none --no-checkout）
 *     里 commit 与 tree 对象全在本地，列变更不回源；
 *   - blob 首读按需回源（lazy fetch）：git 对 promisor 缺失的 blob 自动回源
 *     （每对 tag 一次，秒级/文件；需要代理时按本仓规则临时设 HTTPS_PROXY）；
 *   - 缓存后离线：blob 一旦进 .git/objects，同一 diff 重跑零网络。
 *   缓存不存在且 --repo 不是本地路径时，打印可操作的建缓存命令后退出 1（不自动 clone）。
 *   --repo 指向本地路径时不自动 fetch：tag 缺了直接报错（fixture / 私有仓没有 origin）。
 *
 * --trees 模式：对 9 个核验包逐个列各 tag 的 tree SHA（全同打 ALL-SAME，否则短 SHA
 * 序列），替代文档第 2 步的逐包脚本；tree 对象全在本地，全程零网络。
 *
 * 表达式权威源是 docs/compatibility.md 第 1a 步表格：改表须同步这里的 SEAM_GROUPS。
 * 预分类是分诊不是判决——判定标准永远是「我们这侧不改一行代码就会被它弄坏」。
 *
 * @module tools/compat-diff
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 上游核验包清单：与 docs/compatibility.md「例行核验」第 2 步的 $pkgs 同源。 */
const PKGS = [
  'packages/core/system-prompt/src',
  'packages/host/webserver/src',
  'packages/interaction/user-approval/src',
  'packages/interaction/permission-presets/src',
  'packages/client/ui-settings/src',
  'packages/client/ui-settings-general/src',
  'packages/client/ui-permission-presets/src',
  'packages/boot/app-boot/src',
  'packages/boot/plugin-manager/src',
]

/**
 * 8 组接缝表达式，逐字取自 docs/compatibility.md「例行核验」第 1a 步表格（权威源，
 * 改表须同步这里）。pattern 是字符串，运行时按 `|` 拆回原子表达式再 new RegExp——
 * 不存裸正则字面量，避免正则入字符串的双重转义漂移。
 */
export const SEAM_GROUPS = [
  {
    group: 'cordis 插件 API',
    pattern: 'ctx\\.on|ctx\\.inject|ctx\\.effect|ctx\\.slots|systemPrompt|getSectionOrder|web\\.register|settings\\.section|agent/created|approval/request|agent\\.ctx\\.inject',
  },
  {
    group: '浏览器半装载',
    pattern: "__ModuleLoader__|require\\(['\"]react['\"]\\)|dsh\\.client",
  },
  {
    group: '宿主视觉 token',
    pattern: '--dsw-|--ds-|data-ds-dark-theme',
  },
  {
    group: 'profile 与 patch',
    pattern: 'profileContext|patchPath|DSH_PROFILE_DIR|cordis\\.patch\\.yml|presets|defaultPreset|approval/policy',
  },
  {
    group: '会话日志探针',
    pattern: 'session\\.v4\\.jsonl\\.zstd|system-prompt|zstd',
  },
  {
    group: '版本探测链',
    pattern: 'DSH_VERSION|dsh-package-manifest|app\\.asar|LOCALAPPDATA|dsh-runtimes|runtime\\.json',
  },
  {
    group: 'home',
    pattern: 'DSH_HOME|\\.dsh|enhance/',
  },
  {
    group: '装载与冒烟工具链',
    pattern: 'dsh\\.cmd|dsh plugin|dump-config|smoke\\.ps1',
  },
]

const BOUNDARY_LINE = '预分类是分诊不是判决，SKIM 不等于免检'
const ZEROS = '0'.repeat(40)
const USAGE = '用法：node tools/compat-diff.mjs <oldTag> <newTag> [--out <dir>] [--cache <dir>] [--repo <url|path>] [--trees <tag,...>]'

/** 原子表达式与归属组（模块加载时编译一次）。 */
const ATOMS = SEAM_GROUPS.flatMap(({ group, pattern }) =>
  pattern.split('|').map((atom) => ({ group, atom, re: new RegExp(atom) })))

const ATOM_TO_GROUP = new Map(ATOMS.map(({ atom, group }) => [atom, group]))

/**
 * 前缀去重：`--ds-` 是 `--dsw-` 的前缀，同一文本命中长前缀时不重复报短前缀
 * （.zhll/02-审计-S1.md C2）。没有长前缀在场时短前缀原样保留。
 * @param {string[]} hits 命中的原子表达式
 * @returns {string[]} 去重后的原子
 */
export function dedupePrefixHits(hits) {
  const set = new Set(hits)
  if (set.has('--dsw-')) set.delete('--ds-')
  return [...set]
}

/**
 * 按第 1a 步表格的 8 组表达式预分类一段文本。
 * @param {string} text 文件内容（blob 原文）
 * @returns {string[]} 命中的组名（去重、保持表格顺序）；零命中返回 []
 */
export function classify(text) {
  const hits = ATOMS.filter(({ re }) => re.test(text)).map(({ atom }) => atom)
  if (hits.length === 0) return []
  const groups = []
  for (const atom of dedupePrefixHits(hits)) {
    const group = ATOM_TO_GROUP.get(atom)
    if (group !== undefined && !groups.includes(group)) groups.push(group)
  }
  return groups
}

/** 在 repo 里跑一条 git 命令，stdout 以文本返回；失败抛出带 stderr 的错误。 */
function git(repo, ...args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    throw new Error(stderr !== '' ? stderr : String(error?.message ?? error))
  }
}

function isLocalRepoDir(path) {
  if (!existsSync(path)) return false
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const looksLikeUrl = (value) => /^(https?|ssh|git|file):\/\/|^git@/.test(value)

function defaultCacheDir() {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'dsh-enhance', 'cache', 'dsh-upstream.git')
}

/**
 * 解析 repo：--repo 本地路径优先；否则用缓存目录（--cache / DSH_ENHANCE_CACHE /
 * %LOCALAPPDATA%\dsh-enhance\cache\dsh-upstream.git）。缓存不存在时打印建缓存命令
 * 后退出 1——建缓存是一次性动作，交给用户跑，不替他 clone。
 */
function resolveRepo({ repo, cache }) {
  if (repo !== undefined && !looksLikeUrl(repo)) {
    const path = resolve(repo)
    if (!isLocalRepoDir(path)) {
      console.error(`compat-diff：--repo 指向的路径不是 git 仓库：${path}`)
      console.error('核对路径；或去掉 --repo 改用缓存目录（首次要按提示建缓存）。')
      process.exit(1)
    }
    return { path, canFetch: false }
  }
  const path = resolve(cache ?? process.env.DSH_ENHANCE_CACHE ?? defaultCacheDir())
  if (isLocalRepoDir(path)) return { path, canFetch: true }
  const url = repo ?? 'https://github.com/deepseek-ai/deepseek-harness'
  console.error([
    'compat-diff：本地还没有 blobless 缓存，tree 阶段拿不到对象。',
    '先建一次缓存（约 1–2 分钟，一次性；需要代理时按本仓规则临时设 HTTPS_PROXY）：',
    '',
    `  git clone --filter=blob:none --no-checkout ${url} "${path}"`,
    '',
    '之后重跑本命令；或用 --repo 直接指向一个已有的本地 clone / bare 仓库。',
  ].join('\n'))
  process.exit(1)
}

/** 确认 tag 可解析；缓存 repo 缺 tag 时增量回源一次，本地路径 repo 不自动 fetch。 */
function ensureTag(repo, tag) {
  try {
    git(repo.path, 'rev-parse', '-q', '--verify', `${tag}^{commit}`)
    return
  } catch { /* 缺 tag，看能否增量回源 */ }
  if (!repo.canFetch) {
    console.error(`compat-diff：tag 在 --repo 指向的仓库里不存在：${tag}（本地路径不自动 fetch）`)
    process.exit(1)
  }
  console.error(`compat-diff：缓存缺 ${tag}，git fetch --tags 增量回源……`)
  try {
    git(repo.path, 'fetch', '--tags', 'origin')
  } catch (error) {
    console.error(`compat-diff：fetch 失败（检查网络/代理后重跑）：${String(error?.message ?? error)}`)
    process.exit(1)
  }
  try {
    git(repo.path, 'rev-parse', '-q', '--verify', `${tag}^{commit}`)
  } catch {
    console.error(`compat-diff：fetch 后仍没有 tag ${tag}——上游确实没发过这个 tag？`)
    process.exit(1)
  }
}

/**
 * 列两 tag 间 9 个核验包的文件级变更。tree 操作，blobless 缓存下零网络。
 * @returns {{path: string, status: string, shaOld: string, shaNew: string}[]}
 */
function listChanges(repo, oldTag, newTag) {
  const raw = git(repo, 'diff-tree', '-r', '--raw', '--no-renames', '--no-commit-id', '-z', oldTag, newTag, '--', ...PKGS)
  const rows = []
  const parts = raw.split('\0')
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Za-z]+)$/.exec(parts[index])
    if (meta === null) throw new Error(`diff-tree 输出无法解析：${parts[index].slice(0, 80)}`)
    const [, modeOld, modeNew, shaOld, shaNew, status] = meta
    if (modeOld === '160000' || modeNew === '160000') continue // submodule 指针没有 blob，不在本工具口径内
    rows.push({ path: parts[index + 1], status, shaOld, shaNew })
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return rows
}

/** 取 blob 原文。promisor 缺失时 git 自动按需回源（lazy fetch），失败抛错由入口统一提示。 */
function blob(repo, sha) {
  return git(repo, 'cat-file', 'blob', sha)
}

function diffOne(repo, oldTag, newTag, path) {
  return git(repo, 'diff', '--no-ext-diff', oldTag, newTag, '--', path)
}

function parseArgs(argv) {
  const options = { out: undefined, cache: undefined, repo: undefined, trees: undefined }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = (name) => {
      index += 1
      if (index >= argv.length) throw new Error(`${name} 缺值`)
      return argv[index]
    }
    if (arg === '--out') options.out = value(arg)
    else if (arg === '--cache') options.cache = value(arg)
    else if (arg === '--repo') options.repo = value(arg)
    else if (arg === '--trees') options.trees = value(arg)
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
    else positional.push(arg)
  }
  if (options.trees === undefined) {
    if (positional.length !== 2) throw new Error('需要两个位置参数 <oldTag> <newTag>')
    options.oldTag = positional[0]
    options.newTag = positional[1]
  } else if (positional.length !== 0) {
    throw new Error('--trees 模式不接受位置参数，tag 列表由 --trees 给出')
  }
  return options
}

/** --trees 模式：逐包列各 tag 的 tree SHA。rev-parse 失败（包不存在）记 NOT-FOUND，不炸。 */
function treesMode(repo, spec) {
  const tags = spec.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
  if (tags.length < 2) throw new Error('--trees 至少要两个 tag（逗号分隔）')
  for (const pkg of PKGS) {
    const shas = tags.map((tag) => {
      try {
        return git(repo, 'rev-parse', `${tag}:${pkg}`).trim()
      } catch {
        return null
      }
    })
    if (shas.every((sha) => sha !== null) && new Set(shas).size === 1) {
      console.log(`${pkg}\tALL-SAME`)
    } else {
      console.log(`${pkg}\t${shas.map((sha) => (sha === null ? 'NOT-FOUND' : sha.slice(0, 12))).join(' ')}`)
    }
  }
  console.log(BOUNDARY_LINE)
}

/** 主模式：列变更 → 逐文件分类与 diff。 */
function diffMode(repo, oldTag, newTag, options) {
  ensureTag(repo, oldTag)
  ensureTag(repo, newTag)
  const rows = listChanges(repo.path, oldTag, newTag)
  console.log(`changed-files: ${rows.length}`)
  if (options.out !== undefined) mkdirSync(options.out, { recursive: true })
  for (const row of rows) {
    const sha = row.shaNew !== ZEROS ? row.shaNew : row.shaOld // 删除的文件按旧内容分类
    const groups = classify(blob(repo.path, sha))
    const label = groups.length > 0 ? `SEAM-HIT ${groups.join(',')}` : 'SKIM'
    console.log(`${label}\t${row.path}`)
    if (options.out !== undefined) {
      const diffFile = join(options.out, `${row.path.replaceAll('/', '_')}.diff`)
      writeFileSync(diffFile, diffOne(repo.path, oldTag, newTag, row.path))
    }
  }
  console.log(BOUNDARY_LINE)
}

// ---------- 入口 ----------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2))
  if (options.trees === undefined && (options.oldTag === undefined || options.newTag === undefined)) {
    console.error(`compat-diff：${USAGE}`)
    process.exit(2)
  }
  let repo
  try {
    repo = resolveRepo(options)
    if (options.trees !== undefined) treesMode(repo.path, options.trees)
    else diffMode(repo, options.oldTag, options.newTag, options)
  } catch (error) {
    console.error(`compat-diff：${String(error?.message ?? error)}`)
    if (options.trees === undefined) {
      console.error('提示：blob 首读会按需回源（lazy fetch），断网/代理问题只挡第一次；重跑只补缺失的 blob，已缓存的不再回源。')
    }
    process.exit(1)
  }
}
