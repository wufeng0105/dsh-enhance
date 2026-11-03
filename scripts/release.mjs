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
 *   node scripts/release.mjs minor --ship       # 改版本 → 门禁 → 提交 → 打标签 → 推
 *   node scripts/release.mjs minor --publish    # 自检通过后从本机直接发到 npm
 *   node scripts/release.mjs --check            # 只核对 npm / git tag / GitHub Release 是否一致
 *   node scripts/release.mjs 3.0.0              # 指定版本（必须 x.y.z，不带预发布标签）
 *
 * `--ship` 是推荐路径：它把「版本、标签、Release、npm」四件事绑成一条链——
 * 推标签后由 `.github/workflows/release.yml` 用 OIDC 发 npm 并建 GitHub Release。
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
  console.error('用法：node scripts/release.mjs [patch|minor|major|x.y.z] [--ship | --publish [--otp=NNNNNN]] | --check')
  process.exit(2)
}

const args = process.argv.slice(2)
const publish = args.includes('--publish')
// 推标签让 CI 发：这是推荐路径，不用长期 token，也不会被 2027-01 的策略变更掐掉。
const ship = args.includes('--ship')
// 只读核对，不改任何文件：npm / git tag / GitHub Release 三家是否指同一个版本。
const checkOnly = args.includes('--check')
// npm 对发布强制二次验证，手动发布必然要带验证码（30 秒一次、用过即废）。
// 也可以不用这个开关，改成在 npmjs.com 配 OIDC 可信发布后由 CI 发。
const otpArg = args.find((a) => a.startsWith('--otp='))
const otp = otpArg === undefined ? null : otpArg.slice('--otp='.length)
const bumpArg = args.find((a) => !a.startsWith('--'))
const KNOWN_FLAGS = new Set(['--publish', '--ship', '--check'])
const unknown = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a) && !a.startsWith('--otp='))
if (unknown.length) usage(`认不出的开关：${unknown.join(' ')}`)
if (ship && publish) usage('--ship 与 --publish 二选一：前者推标签让 CI 发，后者从本机发')
if (!checkOnly && bumpArg === undefined) usage('缺版本参数（只想核对就加 --check）')
if (otp !== null && publish && !/^\d{6}$/.test(otp)) usage('--otp 应该是 6 位数字')

/** Windows 上 npm 是 .cmd，必须经 shell 解析。 */
function npm(argv) {
  return spawnSync('npm', argv, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
}

/** 同步睡一会儿。脚本是同步风格（前置检查串行），不值得为一次等待改成 async。 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 发布后等 registry 真的能读到这个版本。
 *
 * 为什么必须轮询：npm 对新包回的是 **202 Accepted** ——「已接收，处理中」，
 * 而不是 201。它要走安全扫描才会公开可读，实测第一次用了约 **5 分钟**。
 * 2.0.0 那次首发就是被这条坑了：包明明发出去了，脚本立刻 `npm view` 拿到 404，
 * 于是报「发布后核对失败」，把一次成功说成失败。所以这里是轮询，不是一次性判断。
 */
function waitForRegistry(name, version, { tries = 24, delayMs = 20000 } = {}) {
  console.log(`\n# 等 registry 公开可读（npm 对新包返回 202，通常要几分钟）`)
  let last = ''
  for (let i = 1; i <= tries; i += 1) {
    const out = npm(['view', name, 'version', '--registry', NPM_REGISTRY])
    last = (out.stdout ?? '').trim()
    if (last === version) {
      console.log(`  第 ${i} 次就绪：${name}@${last}`)
      return last
    }
    console.log(`  第 ${i}/${tries} 次还读不到（${last === '' ? '404' : `"${last}"`}），${delayMs / 1000}s 后重试`)
    if (i < tries) sleep(delayMs)
  }
  return last
}

function git(argv) {
  return spawnSync('git', argv, { cwd: root, encoding: 'utf8' })
}

/** 任一步失败就报出可操作的原因，不猜。 */
function fail(message) {
  console.error(`\nrelease: ${message}`)
  process.exit(1)
}

/**
 * 只读核对：`VERSION` / `package.json` / 最新 git tag / npm latest / GitHub Release
 * 五处是不是同一个版本号。
 *
 * 为什么需要它：这五处是**各自独立写入**的，谁也不会自动跟着谁变——
 *   - `VERSION` 与 `package.json` 由脚本一起改，但人可能手改其中一个；
 *   - tag 是人打的，忘了打就没有；
 *   - npm 的 latest 由 `npm publish` 写；
 *   - GitHub Release 由工作流建，工作流挂了就没有。
 * 所以「它们一致」不是天然成立的，得有余检查。`--check` 就是这个检查，
 * 不进七道门（那七道在本地跑、不联网就够了），适合挂在发版前或定时任务里。
 */
function consistencyCheck() {
  const pkg = JSON.parse(readFileSync(PKG_FILE, 'utf8'))
  const rows = []
  const add = (label, value, ok) => rows.push({ label, value: value ?? '（读不到）', ok })

  const version = readFileSync(VERSION_FILE, 'utf8').trim()
  add('VERSION', version, true)
  add('package.json version', pkg.version, pkg.version === version)

  // 最新标签：按版本号排序取最大，不能按创建时间——补打的旧标签会排错。
  const tagOut = git(['tag', '--list', 'v*', '--sort=-v:refname']).stdout ?? ''
  const latestTag = tagOut.split('\n').map((s) => s.trim()).filter(Boolean)[0] ?? null
  add('最新 git tag', latestTag, latestTag === `v${version}`)

  // npm 侧：拿不到就说拿不到，不假装一致。
  const view = npm(['view', pkg.name, 'version', '--registry', NPM_REGISTRY])
  const npmVersion = view.status === 0 ? (view.stdout ?? '').trim() : null
  add('npm latest', npmVersion, npmVersion === version)

  // GitHub Release：`gh` 没装或没登录时如实标为「跳过」，不冒充通过。
  const slug = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(pkg.repository?.url ?? '')
  let releaseOk = null
  let releaseValue = '（跳过：gh 不可用）'
  if (slug !== null) {
    const r = spawnSync('gh', ['release', 'view', `v${version}`, '--repo', `${slug[1]}/${slug[2]}`, '--json', 'tagName'], { cwd: root, encoding: 'utf8' })
    if (r.status === 0) {
      releaseValue = `v${version}`
      releaseOk = true
    } else if (/release not found|not found/i.test(`${r.stderr ?? ''}`)) {
      releaseValue = '（不存在）'
      releaseOk = false
    }
  }
  add('GitHub Release', releaseValue, releaseOk)

  console.log(`# 版本一致性核对：${pkg.name}\n`)
  for (const row of rows) {
    const mark = row.ok === null ? '·' : row.ok ? '✅' : '❌'
    console.log(`  ${mark}  ${row.label.padEnd(22)} ${row.value}`)
  }

  const bad = rows.filter((r) => r.ok === false)
  if (bad.length) {
    console.log(`\n${bad.length} 处不一致。补齐缺的那一两处即可：`)
    for (const r of bad) {
      if (r.label === 'package.json version') console.log(`  - 把 package.json 的 version 改成 ${version}`)
      if (r.label === '最新 git tag') console.log(`  - git tag v${version} && git push origin v${version}`)
      if (r.label === 'npm latest') console.log(`  - 发 npm：node scripts/release.mjs ${version} --publish（或推标签走 CI）`)
      if (r.label === 'GitHub Release') console.log(`  - 建 Release：gh release create v${version} --generate-notes（或推标签让 CI 建）`)
    }
    process.exit(1)
  }
  console.log('\n五处一致。')
  process.exit(0)
}

if (checkOnly) consistencyCheck()

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

// npm 身份：只有「从本机直接发」才需要。`--ship` 走的是推标签 + CI 的 OIDC，
// 本机根本没有 npm 登录态也该能打标签——所以这条检查跟着 `publish` 走。
if (publish && !ship) {
  const who = npm(['whoami', '--registry', NPM_REGISTRY])
  if (who.status !== 0) {
    fail(`npm 未登录或登录已失效（--registry ${NPM_REGISTRY}）。先跑：npm login --registry ${NPM_REGISTRY}`)
  }
  const npmUser = (who.stdout ?? '').trim()
  const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0].slice(1) : null
  if (scope !== null && scope !== npmUser) {
    fail(`包名 scope 是 "@${scope}"，但当前 npm 账号是 "${npmUser}"——只有该 scope 的持有者能发布`)
  }
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

// ---------------------------------------------------------------- 5. 发（两条路）

if (ship) {
  // 推标签：npm / git tag / GitHub Release 三件事由同一次标签推送串起来。
  // 提交 → 打标签 → 推，顺序不能换：先推分支再推标签，CI 才拿得到这个 commit。
  const tag = `v${next}`
  const existing = git(['tag', '--list', tag])
  if ((existing.stdout ?? '').trim() !== '') fail(`标签 ${tag} 已存在——版本号没变，别重复发`)

  console.log(`\n# 提交版本改动`)
  const staged = git(['add', 'VERSION', 'package.json', 'CHANGELOG.md'])
  if (staged.status !== 0) fail(`git add 失败：${staged.stderr ?? ''}`)
  const committed = git(['commit', '-m', `chore: release ${next}`])
  if (committed.status !== 0) fail(`git commit 失败（CHANGELOG 可能没改）：${committed.stderr ?? ''}`)

  console.log(`# 打标签 ${tag} 并推送`)
  const tagged = git(['tag', '-a', tag, '-m', `Release ${next}`])
  if (tagged.status !== 0) fail(`git tag 失败：${tagged.stderr ?? ''}`)
  const pushedBranch = git(['push', 'origin', 'main'])
  if (pushedBranch.status !== 0) fail(`git push main 失败：${pushedBranch.stderr ?? ''}`)
  const pushedTag = git(['push', 'origin', tag])
  if (pushedTag.status !== 0) fail(`git push ${tag} 失败：${pushedTag.stderr ?? ''}`)

  console.log(`
# 已推 ${tag}
#
# 接下来由 .github/workflows/release.yml 完成，不用你管：
#   1. 核对「标签 == VERSION」
#   2. 跑七道门禁
#   3. OIDC 可信发布到 npm
#   4. 用 CHANGELOG 里 [${next}] 那一节建 GitHub Release
#
# 想看结果：gh run watch
# 想随时核对 npm / tag / Release 是否还一致：node scripts/release.mjs --check
`)
  process.exit(0)
}

if (!publish) {
  console.log(`
# 只自检，没有发布。三条后续路径选一条：
#   node scripts/release.mjs ${next} --ship      # 推标签，CI 发 npm 并建 Release（推荐）
#   node scripts/release.mjs ${next} --publish   # 从本机直接发 npm（要过 2FA）
#   node scripts/release.mjs --check             # 只核对 npm / tag / Release 是否一致
`)
  process.exit(0)
}

// ---------------------------------------------------------------- 6. 本机发布

console.log(`\n# 发布到 ${NPM_REGISTRY}`)
const pub = npm(['publish', '--access', 'public', '--registry', NPM_REGISTRY, ...(otp === null ? [] : ['--otp', otp])])
if (pub.status !== 0) {
  // 发布失败时把版本退回原值，避免仓库停在一个 npm 上不存在的版本上。
  // 只有真的改过版本才需要退——`next === current` 时原样写回会平白重排 package.json。
  if (next !== current) {
    writeFileSync(VERSION_FILE, `${current}\n`, 'utf8')
    writeFileSync(PKG_FILE, `${JSON.stringify({ ...pkg, version: current }, null, 2)}\n`, 'utf8')
  }
  const hint = /E403|two-factor|2fa/i.test(pub.stderr ?? '')
    ? '\n  这是 npm 的发布 2FA 要求。三条路：'
      + '\n   - 加 --otp=<6 位验证码> 再跑一次（验证码 30 秒有效）；'
      + '\n   - 到 npmjs.com 建带 "Bypass two-factor authentication" 的 granular token'
      + '\n     （注意：这类 token 约 2027-01 起不能再直接发布）；'
      + '\n   - 或者改用 --ship 推标签，让 .github/workflows/release.yml 走 OIDC 可信发布。'
    : ''
  fail(`npm publish 失败（exit ${pub.status}）${hint}\n${pub.stderr ?? ''}`)
}
console.log((pub.stdout ?? '').trim())

// npm 对新包回 202（已接收、处理中），所以这里必须轮询而不是立刻判定。
const published = waitForRegistry(pkg.name, next)
if (published !== next) {
  fail(`等不到 npm 上的 ${next}（最后读到 "${published || '404'}"）。`
    + '\n  包可能仍在处理，过几分钟用 node scripts/release.mjs --check 再看。')
}

console.log(`
# 发布成功：${pkg.name}@${next}
#
# 但 npm 已经发了、git 还没有——这是**不一致**的状态。补上标签与提交：
#   git add VERSION package.json CHANGELOG.md
#   git commit -m "chore: release ${next}"
#   git tag v${next}
#   git push origin main --tags
#
# 或者一开始就用 --ship，让脚本替你做这一串。
# 随时核对三家是否一致：node scripts/release.mjs --check
#
# 市场那边不用管：awesome-dsh-plugin 每夜采集 npm，自动更新版本号、下载量、能力标签与宿主要求。
`)
