#!/usr/bin/env node
/**
 * 发版：一条命令走完「改版本 → 过门禁 → 发 npm」。
 *
 * 为什么要脚本而不是手打几步：这几步之间有**隐式依赖**，手打必踩——
 *   - `VERSION` 与 `package.json` 的 `version` 必须逐字相同（`version` 门会核），
 *     只改一个是最常见的失误；
 *   - 本机 `.npmrc` 指的是 `npmmirror` 镜像（只读），直接 `npm publish` 会静默走错源；
 *   - scope 包不加 `--access public` 发出去是私有的，别人装不了；
 *   - 仓库里没有的版本发出去，用户从 GitHub 装到的东西和 npm 上的对不上。
 *
 * 刻意**不做**的事：不自动 commit / tag / push。版本号一旦进了 commit 又被 force-push
 * 覆盖，npm 上那个版本就永远对不上仓库了。脚本在最后把该跑的 git 命令打出来，由人决定。
 *
 * 用法：
 *   node scripts/release.mjs patch              # 1.2.1 -> 1.2.2，只改版本并自检，不发
 *   node scripts/release.mjs minor --publish    # 1.2.1 -> 1.3.0，自检通过后发到 npm
 *   node scripts/release.mjs 3.0.0-rc.1         # 指定版本（必须 x.y.z，不带预发布标签）
 *
 * 退出码：0 成功 / 1 某一步失败 / 2 用法错。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM_REGISTRY = 'https://registry.npmjs.org/'
const PKG_FILE = join(root, 'package.json')
const VERSION_FILE = join(root, 'VERSION')
const PATCH_FILE = join(root, 'cordis.patch.yml')
const CHANGELOG_FILE = join(root, 'CHANGELOG.md')

/** 用法错：直接退出，不动任何文件。 */
function usage(why) {
  console.error(`release: ${why}`)
  console.error('用法：node scripts/release.mjs <patch|minor|major|x.y.z> [--publish]')
  process.exit(2)
}

const args = process.argv.slice(2)
const publish = args.includes('--publish')
const bumpArg = args.find((a) => !a.startsWith('--'))
if (bumpArg === undefined) usage('缺版本参数')
const unknown = args.filter((a) => a.startsWith('--') && a !== '--publish')
if (unknown.length) usage(`认不出的开关：${unknown.join(' ')}`)

/** Windows 上 npm 是 .cmd，必须经 shell 解析。 */
function npm(argv) {
  return spawnSync('npm', argv, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
}

function git(argv) {
  return spawnSync('git', argv, { cwd: root, encoding: 'utf8' })
}

/** 任一步失败就报出可操作的原因，不猜。 */
function fail(message) {
  console.error(`\nrelease: ${message}`)
  process.exit(1)
}

// ---------------------------------------------------------------- 1. 前置检查

// 工作区干净：带未提交改动发版，等于发一个仓库里不存在的版本。
const status = git(['status', '--porcelain'])
if (status.status !== 0) fail(`git status 读不到：${status.stderr ?? ''}`)
if ((status.stdout ?? '').trim() !== '') {
  fail(`工作区不干净，先提交或 stash：\n${status.stdout}`)
}

// 必须在 main 上：从特性分支发版，main 上就没有这个版本。
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
const currentBranch = (branch.stdout ?? '').trim()
if (currentBranch !== 'main') fail(`当前分支是 ${currentBranch}，发版要在 main 上`)

// 与远端同步：仓库里没有的版本不发。
git(['fetch', 'origin', 'main', '--quiet'])
const head = (git(['rev-parse', 'HEAD']).stdout ?? '').trim()
const remote = (git(['rev-parse', 'origin/main']).stdout ?? '').trim()
if (head !== remote) fail('本地 main 与 origin/main 不一致，先 git pull --rebase origin main')

// 包名与 bundle 入口前缀必须一致：不一致时装完两个入口解析不到，插件等于没装上。
const pkg = JSON.parse(readFileSync(PKG_FILE, 'utf8'))
const patchText = readFileSync(PATCH_FILE, 'utf8')
const entryNames = [...patchText.matchAll(/^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1])
const badEntries = entryNames.filter((n) => !n.startsWith('./') && !n.startsWith(`${pkg.name}/`))
if (badEntries.length) {
  fail(`cordis.patch.yml 的入口名没有以包名 "${pkg.name}" 开头：${badEntries.join(', ')}\n`
    + '  改包名时这个前缀必须一起改，否则装完入口解析不到。')
}
if (typeof pkg.private === 'boolean' && pkg.private) fail('package.json 声明了 private，npm publish 会拒绝')
if (pkg.publishConfig?.access !== 'public') fail('package.json 缺 publishConfig.access: "public"，scope 包发出去会是私有的')

// npm 身份：没登录或登错账号，发布一定失败。
const who = npm(['whoami', '--registry', NPM_REGISTRY])
if (who.status !== 0) {
  fail(`npm 未登录或登录已失效（--registry ${NPM_REGISTRY}）。先跑：npm login --registry ${NPM_REGISTRY}`)
}
const npmUser = (who.stdout ?? '').trim()
const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0].slice(1) : null
if (scope !== null && scope !== npmUser) {
  fail(`包名 scope 是 "@${scope}"，但当前 npm 账号是 "${npmUser}"——只有该 scope 的持有者能发布`)
}

// ---------------------------------------------------------------- 2. 版本

const current = readFileSync(VERSION_FILE, 'utf8').trim()
const [major, minor, patch] = current.split('.').map(Number)
let next
if (bumpArg === 'patch') next = `${major}.${minor}.${patch + 1}`
else if (bumpArg === 'minor') next = `${major}.${minor + 1}.0`
else if (bumpArg === 'major') next = `${major + 1}.0.0`
else if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg
else usage(`版本参数认不出：${bumpArg}（要 patch / minor / major / x.y.z，且不带预发布标签）`)

console.log(`# 包     ${pkg.name}`)
console.log(`# 版本   ${next === current ? `${current}（不变）` : `${current} -> ${next}`}`)
console.log(`# 账号   ${npmUser}`)
console.log(`# 模式   ${publish ? '自检后发布到 npm' : '只自检，不发布'}`)
console.log()

// 显式传当前版本是合法用法（「把这个已经改好版本的包发出去」）。这时不要重写文件——
// `JSON.stringify` 的排版未必与原文件逐字节相同，重写会平白制造一个 diff，
// 而这个脚本的前置检查正是「工作区必须干净」，等于自己把自己卡住。
if (next !== current) {
  writeFileSync(VERSION_FILE, `${next}\n`, 'utf8')
  writeFileSync(PKG_FILE, `${JSON.stringify({ ...pkg, version: next }, null, 2)}\n`, 'utf8')
}

// CHANGELOG 是人的产物，不代写；但提醒一句，免得版本号裸奔。
const changelog = readFileSync(CHANGELOG_FILE, 'utf8')
if (!changelog.includes(`## [${next}]`)) {
  console.log(`⚠️  CHANGELOG.md 里没有 "## [${next}]" 一节。版本已改，但变更记录要你自己补。\n`)
}

// ---------------------------------------------------------------- 3. 门禁

console.log('# 跑门禁：node scripts/check.mjs')
const gate = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: root, stdio: 'inherit' })
if (gate.status !== 0) {
  fail(`门禁没过（exit ${gate.status}）。版本号已改到 ${next}，修完再重跑，别提交半成品。`)
}

// ---------------------------------------------------------------- 4. 预演

console.log('\n# 会发布出去的文件（npm pack --dry-run）')
const pack = npm(['pack', '--dry-run', '--json', '--registry', NPM_REGISTRY])
if (pack.status !== 0) fail(`npm pack --dry-run 失败：${pack.stderr ?? ''}`)
try {
  const info = JSON.parse(pack.stdout)[0]
  console.log(`  ${info.filename}  ${info.files.length} 个文件  ${(info.size / 1024).toFixed(1)} KB`)
  for (const f of info.files) console.log(`    ${f.path}`)
} catch {
  console.log(pack.stdout)
}

if (!publish) {
  console.log(`
# 只自检，没有发布。
# 确认上面的文件清单没问题，再跑一次带 --publish：
#   node scripts/release.mjs ${next} --publish
`)
  process.exit(0)
}

// ---------------------------------------------------------------- 5. 发布

console.log(`\n# 发布到 ${NPM_REGISTRY}`)
const pub = npm(['publish', '--access', 'public', '--registry', NPM_REGISTRY])
if (pub.status !== 0) {
  // 发布失败时把版本退回原值，避免仓库停在一个 npm 上不存在的版本上。
  writeFileSync(VERSION_FILE, `${current}\n`, 'utf8')
  writeFileSync(PKG_FILE, `${JSON.stringify({ ...pkg, version: current }, null, 2)}\n`, 'utf8')
  fail(`npm publish 失败（exit ${pub.status}），版本已退回 ${current}：\n${pub.stderr ?? ''}`)
}
console.log((pub.stdout ?? '').trim())

const published = (npm(['view', pkg.name, 'version', '--registry', NPM_REGISTRY]).stdout ?? '').trim()
if (published !== next) fail(`发布后核对失败：npm 上的 version 是 "${published}"，期望 "${next}"`)

console.log(`
# 发布成功：${pkg.name}@${next}
#
# 剩下的 git 动作脚本不代做（版本号被 force-push 覆盖会让 npm 与仓库对不上），你自己决定：
#   git add VERSION package.json CHANGELOG.md
#   git commit -m "chore: release ${next}"
#   git tag v${next}
#   git push origin main --tags
#
# 市场那边不用管：awesome-dsh-plugin 每夜采集 npm，自动更新版本号、下载量、能力标签与宿主要求。
`)
