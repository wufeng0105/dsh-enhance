#!/usr/bin/env node
/**
 * 把 enhance 的四件插件装进一个 DSH home，并按 profile 改 `cordis.patch.yml`。
 *
 * 做什么（幂等：重复跑第二次不再改动）：
 *   1. 把 `enhance-scope/`、`auto-approve/`、`enhance-permissions/`、`ui/` 与共享层拷到 `<home>/enhance/`
 *   2. 缺 `content-scope.txt` 时种一份（从不覆盖用户已改的内容）
 *   3. 对每个已有 profile：先备份 `cordis.patch.yml`，清掉内联 persona-suffix 文本
 *      （`personaSuffix: |` 变成 `''`），再追加三行 insert
 *      （`enhance-scope`、`auto-approve`、`enhance-ui`）
 *   4. 把这次写了什么记进 `<home>/enhance/install-manifest.json`；`uninstall.mjs` 靠它找回装前备份
 *
 * 宿主自己的行一个字节都不碰：官方 `fs-observation-policy`（先读后写）保持原样，
 * 要开关它去宿主自己的设置里改。
 *
 * 缺 patch 的 profile 记 `skipped`；**一个可装的 profile 都没有**时在任何写盘之前拒绝。
 *
 * 但**一个可装的 profile 都没有**时必须拒绝：那时插件目录、state、manifest 都落了盘，
 * 而没有任何 profile 的 patch 引用它们 —— 宿主启动后一行都不会加载，退出码却是 0。
 * 拒绝发生在任何写盘之前（见 `installTargetProblem`），与 `uninstall.mjs` 的空集拒绝同形。
 *
 * 不运行 `dsh`：验证交给独立命令（`doctor --home`、headless 会话、`build-client --check --asar`）。
 *
 * 用法：
 *   node install.mjs [--home <dsh-home>] [--profiles desktop] [--dry-run]
 *   node install.mjs [--home <dsh-home>] --restore <archive> [--replace] [--dry-run]
 */

import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVALS, STATE_VERSION, TEXT_LIMIT, normalizeText, paths, readState, textBytes, textSha256, writeFileAtomic, writeState, writeText } from './shared/state.mjs'
import { eolOf, joinLines, splitLines } from './shared/text-lines.mjs'
import { wirePermissions, ensureEnhancedPreset, defaultPresetApproval } from './shared/patch-rows.mjs'
import { toolVersion } from './shared/tool-version.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** Insert rows this installer owns: profile patch id + the path it resolves to. */
const INSERT_ROWS = [
  { id: 'enhance-scope', from: '../../enhance/enhance-scope/index.js' },
  { id: 'auto-approve', from: '../../enhance/auto-approve/index.js' },
  { id: 'enhance-ui', from: '../../enhance/ui/index.js' },
]

/** Directories copied into `<home>/enhance/`, with the files each one needs. */
const PLUGIN_DIRS = [
  { name: 'enhance-scope', files: ['index.js', 'package.json'] },
  { name: 'auto-approve', files: ['index.js', 'package.json'] },
  { name: 'enhance-permissions', files: ['index.js', 'package.json', 'client.js'] },
  { name: 'ui', files: ['index.js', 'package.json', 'client.js'] },
]

/** 插件入口 import 到的共享层：不在任何插件目录里，必须单独落盘。 */
const EXTRA_FILES = ['shared/state.mjs', 'shared/text-lines.mjs', 'shared/session-probe.mjs', 'shared/patch-rows.mjs', 'uninstall.mjs']

/** Where the manifest lives; `uninstall.mjs` reads the same path. */
const MANIFEST_NAME = 'install-manifest.json'

/** `--restore` 只认当前格式的归档（`version` 必须等于 `STATE_VERSION`）。 */

function valueOf(argv, index, flag) {
  const value = argv[index + 1]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${flag} 需要一个值`)
  return value
}

function parseArgs(argv) {
  const options = {
    home: process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'),
    profiles: ['desktop'],   // 默认只装桌面端；headless/web 显式 --profiles，t1 仅测试
    dryRun: false,
    noWire: false,
    all: false,
    restore: undefined,
    replace: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--all') options.all = true
    else if (arg === '--no-wire') options.noWire = true
    else if (arg === '--replace') options.replace = true
    else if (arg === '--restore') { options.restore = valueOf(argv, i, '--restore'); i += 1 }
    else if (arg === '--home') { options.home = valueOf(argv, i, '--home'); i += 1 }
    else if (arg === '--profiles') {
      options.profiles = valueOf(argv, i, '--profiles').split(',').map(name => name.trim()).filter(Boolean)
      i += 1
    }
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 发现 <home>/profiles/*；一个都没有就返回空数组（打印 skipped 而不是抛）。 */
async function discoverProfiles(home) {
  try {
    const entries = await readdir(join(home, 'profiles'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/** 追加缺失的 insert 行（已存在的行不重复加）。 */
function ensureInsertRows(text) {
  const missing = INSERT_ROWS.filter((row) => !new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${row.id}[ \\t]*$`, 'm').test(text))
  if (missing.length === 0) return { text, changed: undefined }
  const block = [
    '',
    '# enhance: 内容边界（enhance-scope）、审批（auto-approve）、设置页（enhance-ui）。',
    '# 改行为请改 <home>/enhance/state.json 或 enhance/content-scope.txt，不要动这些 id。',
    '- insert:',
    ...missing.map(row => `    - id: ${row.id}\n      name: '${row.from}'`),
    '',
  ].join('\n')
  // 空文档标记 `[]` 必须先摘掉：它在，追加 `- insert:` 就成了同一文件里的第二个 document，
  // YAML 解析器直接报 "end of the stream or a document separator is expected"。
  const eol = eolOf(text)
  const withoutEmptyDocument = text.replace(/^[ \t]*\[\][ \t]*$/m, '')
  const body = block.split('\n').join(eol)
  return { text: `${withoutEmptyDocument.replace(/\s*$/, '')}${eol}${body}`, changed: `add insert rows: ${missing.map(row => row.id).join(', ')}` }
}

/** Collapse a `key: |` block-scalar into `key: ''`, keeping its indentation and the file's EOL. */
function emptyKeyBlock(text, key) {
  const pattern = new RegExp(`^([ \\t]*)${key}: \\|[ \\t]*\\r?\\n(?:\\1[ \\t]+[^\\r\\n]*(?:\\r?\\n|$))+`, 'm')
  if (!pattern.test(text)) return { text, changed: false }
  const eol = eolOf(text)
  return { text: text.replace(pattern, (_match, indent) => `${indent}${key}: ''${eol}`), changed: true }
}

/** Read the patch of every target profile，用来在播种 state 前判断宿主默认档位。 */
async function readProfilePatches(home, profiles) {
  const out = []
  for (const profile of profiles) {
    const file = join(home, 'profiles', profile, 'cordis.patch.yml')
    try {
      out.push({ profile, text: await readFile(file, 'utf8') })
    } catch {
      // 没有 patch 的 profile 不参与判断：安装器会给它补块，默认档位由我们定
    }
  }
  return out
}

/**
 * 首装时该种哪一档审批。
 *
 * 宿主在 `user-approval` 里先判档位策略：`approval: never` 的档位在分发前就 `rejected`，
 * 我们种的 `allow` 永远轮不到。所以播种必须看这台机器的实际默认档位，不能无条件种 `allow`：
 * 只要有一个目标 profile 的 `defaultPreset` 是 `never`，就种 `ask`（问人，语义诚实）并警告。
 *
 * @param {{ profile: string, text: string }[]} patches
 * @returns {{ approval: 'allow' | 'ask', blockedBy: string | undefined }}
 */
function seedApproval(patches) {
  for (const patch of patches) {
    const preset = defaultPresetApproval(patch.text)
    if (preset?.approval === 'never') return { approval: 'ask', blockedBy: `${patch.profile}:${preset.name}` }
  }
  return { approval: 'allow', blockedBy: undefined }
}

async function copyPluginDirs(home, dryRun, profiles = []) {
  const target = join(home, 'enhance')
  const copied = []
  const missing = []
  for (const plugin of PLUGIN_DIRS) {
    const source = join(here, plugin.name)
    if (!await exists(source)) {
      missing.push(plugin.name)
      continue
    }
    if (!dryRun) await mkdir(join(target, plugin.name), { recursive: true })
    for (const file of plugin.files) {
      const from = join(source, file)
      if (!await exists(from)) continue
      if (!dryRun) await copyFile(from, join(target, plugin.name, file))
      copied.push(`${plugin.name}/${file}`)
    }
  }
  // 共享层不在插件目录里，插件入口靠 `../shared/state.mjs` 找到它；漏拷就是"装了但不生效"
  for (const relative of EXTRA_FILES) {
    const from = join(here, relative)
    if (!await exists(from)) {
      missing.push(relative)
      continue
    }
    if (!dryRun) {
      await mkdir(dirname(join(target, relative)), { recursive: true })
      await copyFile(from, join(target, relative))
    }
    copied.push(relative)
  }
  const data = join(target, 'content-scope.txt')
  const seeded = !await exists(data)
  if (seeded && !dryRun) {
    await mkdir(target, { recursive: true })
    await copyFile(join(here, 'content-scope.txt'), data)
  }
  // state.json 缺失时种子：文本与总开关都开；审批按宿主实际默认档位决定（见 seedApproval）
  const p = paths(home)
  const stateMissing = readState(p).degradedReason === 'missing'
  const patches = stateMissing ? await readProfilePatches(home, profiles) : []
  const seed = seedApproval(patches)
  if (stateMissing && !dryRun) writeState(p, { contentScope: true, approval: seed.approval })
  if (stateMissing && seed.blockedBy !== undefined) {
    console.log(`warn: ${seed.blockedBy} 的默认档位是 approval: never，宿主会在分发前拒绝审批请求；state 种成 approval=ask（要自动放行请把默认档位改成 Enhanced）`)
  }
  return { data, seeded, stateMissing, seededApproval: seed.approval, copied, missing }
}

/**
 * 把权限选择器整行换掉：停用官方 `ui-permission`、插入 `enhance-permissions`。
 * desktop 的 `Enhanced` 图标靠它；漏了这一步菜单就还是官方字形表（历史事故一次）。
 * 幂等：已经接过线就返回原样。实现见 `shared/patch-rows.mjs`（全仓只此一份，install 自己用）。
 */
async function patchProfile(home, profile, dryRun, wire = false) {
  const file = join(home, 'profiles', profile, 'cordis.patch.yml')
  if (!await exists(file)) return { file, skipped: 'no patch', changes: [], backup: undefined }
  let text = await readFile(file, 'utf8')
  const changes = []

  const deployment = emptyKeyBlock(text, 'personaSuffix')
  if (deployment.changed) {
    text = deployment.text
    changes.push("deployment personaSuffix -> ''")
  }
  const preset = emptyKeyBlock(text, 'suffix')
  if (preset.changed) {
    text = preset.text
    changes.push("preset persona suffix -> ''")
  }
  // 官方行一律不碰：`fs-observation-policy`（读后写）属于宿主，装/卸都不读也不写它。
  const insert = ensureInsertRows(text)
  if (insert.changed !== undefined) {
    text = insert.text
    changes.push(insert.changed)
  }
  const presets = ensureEnhancedPreset(text)
  if (presets.error !== undefined) {
    // 认不出安全改法就**拒绝**：往下走写出的是一份宿主解析不了的 patch（重复 `presets`
    // 键），而 doctor 事后未必看得见。调用方拿到 error 就终止该 profile，一个字节都不写。
    return { file, skipped: undefined, changes, backup: undefined, refused: presets.error }
  }
  if (presets.changed !== undefined) {
    text = presets.text
    changes.push(presets.changed)
  }
  let wiredUi = false
  let uiPermissionAction
  if (wire) {
    const wired = wirePermissions(text)
    if (wired.changed !== undefined) {
      text = wired.text
      changes.push(wired.changed)
      wiredUi = true
      uiPermissionAction = wired.action
    }
  }
  if (changes.length === 0) return { file, skipped: undefined, changes, backup: undefined, permissionAction: presets.action, permissionDefaultAction: presets.defaultAction }

  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18)
  const backup = `${file}.bak-enhance-${stamp}`
  if (!dryRun) {
    await copyFile(file, backup)
    writeFileAtomic(file, text)
  }
  return { file, skipped: undefined, changes, backup, wiredUi, uiPermissionAction, permissionAction: presets.action, permissionDefaultAction: presets.defaultAction }
}

/** Validate an uninstall archive before writing anything. @param {string} archive */
async function readRestore(archive) {
  const dir = resolve(archive)
  const stateFile = join(dir, 'state.json')
  const textFile = join(dir, 'content-scope.txt')
  if (!await exists(stateFile) || !await exists(textFile)) {
    throw new Error(`restore archive needs state.json and content-scope.txt: ${dir}`)
  }
  let parsed
  try {
    parsed = JSON.parse(await readFile(stateFile, 'utf8'))
  } catch (error) {
    throw new Error(`restore state.json is not valid JSON: ${String(error?.message ?? error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('restore state.json must be an object')
  }
  // 只认当前格式的归档：字段就 enabled / contentScope / approval。旧版本归档没有迁移支路，
  // 直接拒绝并说明期望值——半读半猜会把一份说不清的状态写进 home。
  if (parsed.version !== STATE_VERSION) {
    throw new Error(`restore state.json version=${String(parsed.version)}; expected ${STATE_VERSION}`)
  }
  if (!APPROVALS.includes(parsed.approval)) {
    throw new Error(`restore approval=${String(parsed.approval)}; expected ${APPROVALS.join('|')}`)
  }
  for (const key of ['enabled', 'contentScope']) {
    if (typeof parsed[key] !== 'boolean') throw new Error(`restore ${key} must be boolean`)
  }
  const text = normalizeText(await readFile(textFile, 'utf8'))
  const bytes = textBytes(text)
  if (bytes > TEXT_LIMIT) throw new Error(`restore text is ${bytes} B; limit ${TEXT_LIMIT} B`)
  return {
    archive: dir,
    from: parsed.version,
    state: { enabled: parsed.enabled, contentScope: parsed.contentScope, approval: parsed.approval },
    text,
    bytes,
    sha256: textSha256(text),
  }
}

async function readManifest(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'enhance', MANIFEST_NAME), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.profiles === 'object') return parsed
  } catch {
    // 首次安装或文件坏了：从空的开始，下一段会整份重写
  }
  return { version: 1, installedAt: undefined, files: [], profiles: {} }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  // 用法错只给一行、exit 1：栈会让人以为是脚本崩了，而不是「参数写错了」
  console.error(`install: ${String(error?.message ?? error)}`)
  process.exit(1)
}
const home = resolve(options.home)
let restore
if (options.restore !== undefined) {
  try {
    restore = await readRestore(resolve(options.restore))
    const target = paths(home)
    if (!options.replace && (await exists(target.state) || await exists(target.text))) {
      throw new Error('restore target already has state.json or content-scope.txt; pass --replace to overwrite')
    }
    console.log(`restore=${restore.archive} version=v${restore.from} approval=${restore.state.approval} enabled=${restore.state.enabled} contentScope=${restore.state.contentScope} text=${restore.bytes} B sha256=${restore.sha256}`)
    if (options.dryRun) {
      console.log('restore: dry run, no files written')
      process.exit(0)
    }
  } catch (error) {
    console.error(`install: ${String(error?.message ?? error)}`)
    process.exit(1)
  }
}
if (options.all) options.profiles = await discoverProfiles(home)
console.log(`home=${home}${options.dryRun ? ' (dry run)' : ''}`)

/**
 * 「这次安装有没有可接线的地方」。
 *
 * `skipped=no patch` 对单个 profile 是正常信息（那个 profile 还没被宿主建出 patch），
 * 但**一个都接不上**时整次安装只剩副作用：插件目录、state、manifest 全落盘，却没有任何
 * profile 引用它们，而退出码是 0、`doctor --home` 也全绿 —— 用户重启后什么都不会发生。
 * 所以这里在**任何写盘之前**挡下来，给一行可行动的原因。
 * @param {string[]} profiles
 * @returns {Promise<string | undefined>} 拒绝原因；`undefined` 表示至少有一个可装。
 */
async function installTargetProblem(profiles) {
  if (profiles.length === 0) {
    return '没有 profile 可装：--profiles 给了空值，或 --all 一个 profile 都没扫到'
  }
  const withoutPatch = []
  for (const profile of profiles) {
    if (!await exists(join(home, 'profiles', profile, 'cordis.patch.yml'))) withoutPatch.push(profile)
  }
  if (withoutPatch.length === profiles.length) {
    return `${withoutPatch.join(', ')} 没有 cordis.patch.yml：装上去没有任何 profile 会加载它；先启动一次 DSH 让宿主建出这些 profile，或用 --profiles 指定已有的 profile`
  }
  return undefined
}

const targetProblem = await installTargetProblem(options.profiles)
if (targetProblem !== undefined) {
  // 固定形状：一行 stderr + exit 1；插件目录、state、patch 全都没写（与坏形态拒绝同一条纪律）
  console.error(`install: ${targetProblem}`)
  process.exit(1)
}

/**
 * 装之前先把每个 patch 的 `presets` 形态探一遍。
 *
 * 拒绝的价值只在"一个字节都没写"时才成立：等 `copyPluginDirs` 落完盘再拒绝，
 * 留下的是一个半装的 home —— 插件目录在、patch 没改，用户看到的是"装了但不生效"。
 * 所以认不出安全改法的 profile 在**任何写盘之前**就挡下来。
 * @returns {Promise<string[]>} 每个被拒绝的 profile 的说明；空数组表示全都能安全改。
 */
async function preflightProfiles(profiles) {
  const blocked = []
  for (const profile of profiles) {
    const file = join(home, 'profiles', profile, 'cordis.patch.yml')
    if (!await exists(file)) continue
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue   // 读不到交给后面的 patchProfile 报 failed，preflight 不抢它的活
    }
    const probe = ensureEnhancedPreset(text)
    if (probe.error !== undefined) blocked.push(`profile=${profile} ${probe.error}`)
  }
  return blocked
}

const blocked = await preflightProfiles(options.profiles)
if (blocked.length > 0) {
  // 固定形状：一行 stderr + exit 1；插件目录、state、patch 全都没写
  console.error(`install: ${blocked.join('; ')}`)
  process.exit(1)
}

const plugins = await copyPluginDirs(home, options.dryRun, options.profiles)
console.log(`content-scope.txt=${plugins.data} ${plugins.seeded ? (options.dryRun ? 'would-seed' : 'seeded') : 'kept'}`)
console.log(`state.json=${plugins.stateMissing ? (options.dryRun ? 'would-seed' : `seeded approval=${plugins.seededApproval}`) : 'kept'} (${paths(home).state})`)
console.log(`plugins=${plugins.copied.join(',') || '(none)'}`)
if (plugins.missing.length > 0) console.log(`plugins_missing=${plugins.missing.join(',')}`)

const fileHashes = {}
if (!options.dryRun) {
  for (const rel of plugins.copied) {
    const file = join(home, 'enhance', rel)
    fileHashes[rel] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
}

if (restore !== undefined) {
  const target = paths(home)
  writeState(target, restore.state)
  writeText(target, restore.text)
  console.log(`restore=written state.json + content-scope.txt (${restore.bytes} B)`)
}

const manifest = await readManifest(home)
const profiles = {}
let failed = 0
/** 被「认不出安全改法」拒绝的 profile：patch 逐字节不动，最终 exit 1。 */
const refused = []
for (const profile of options.profiles) {
  let result
  try {
    result = await patchProfile(home, profile, options.dryRun, profile === 'desktop' && options.noWire !== true)
  } catch (error) {
    failed += 1
    console.log(`profile=${profile} failed=${String(error?.message ?? error)}`)
    continue
  }
  if (result.refused !== undefined) {
    // 一行 stderr、exit 1、patch 一个字节都不动（备份也不留）：这部分是用户的文件形态
    // 我们读不懂，不是"装到一半失败"，所以不进 failed 计数之外的任何写盘路径。
    failed += 1
    refused.push(`profile=${profile} ${result.refused}`)
    continue
  }
  if (result.skipped !== undefined) {
    console.log(`profile=${profile} skipped=${result.skipped}`)
    continue
  }
  console.log(`profile=${profile} changed=${result.changes.length === 0 ? 'false' : (options.dryRun ? 'would-change' : 'true')} ${result.changes.join(' | ')}`)
  profiles[profile] = {
    // 第一次安装记下的那份就是「装之前」的原件；之后不再覆盖
    original: manifest.profiles?.[profile]?.original ?? (result.backup === undefined ? undefined : result.backup.split(/[\\/]/).pop()),
    changedOnLastRun: result.changes.length > 0,
    // 只记这一次真的看到的事实：没改动的字段就是 `undefined`（重装不改归属，
    // 归属丢了由卸载的「逐字节认领 + 告警」兜住，见 shared/patch-rows.mjs）。
    uiPermissionAction: result.uiPermissionAction,
    permissionPresetAction: result.permissionAction,
    permissionDefaultAction: result.permissionDefaultAction,
  }
}

if (!options.dryRun) {
  const next = {
    version: 1,
    // 写清单的版本：doctor 用它回答「这份落盘是哪个版本写的」，与当前工具不一致就提示重装。
    toolVersion: toolVersion(),
    installedAt: manifest.installedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: plugins.copied,
    fileHashes,
    profiles: { ...manifest.profiles, ...profiles },
  }
  writeFileAtomic(join(home, 'enhance', MANIFEST_NAME), `${JSON.stringify(next, null, 2)}\n`)
}

if (failed > 0) process.exitCode = 1
if (refused.length > 0) {
  // 拒绝路径的固定形状：**一行** stderr + exit 1。多行会让人以为是堆栈；
  // 这里每条都带着行号与「改回块风格」的下一步动作，拼成一行也读得懂。
  console.error(`install: ${refused.join('; ')}`)
}

if (restore !== undefined) {
  const doctor = spawnSync(process.execPath, [join(here, 'doctor.mjs'), '--home', home], { stdio: 'inherit' })
  if (doctor.status !== 0) process.exitCode = doctor.status ?? 1
}
