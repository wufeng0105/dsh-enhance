#!/usr/bin/env node
/**
 * 卸载：**行级手术**。
 *
 * 默认只摘我们写过的东西，其余行一个字节都不动：
 *   0. 默认摘哪些 profile：清单（`<home>/enhance/install-manifest.json`）里记的那些；
 *      清单缺失/为空时用 `<home>/profiles/` 下实际存在的；两者都没有才退回 `desktop`。
 *      这一条是硬要求：`<home>/enhance` 是全局的，默认只摘 desktop 会让别的 profile 悬空；
 *      反过来的雷同样躲开：解析出来是**空集**（`--profiles` 给了空值、或 `--all` 一个 profile 都没扫到）
 *      就当场报错退出——一条 patch 都没摘，没有理由去动全局的插件目录。
 *   1. 删三行 insert（enhance-scope / auto-approve / enhance-ui）；
 *   2. 删 enhance-permissions 那一行，并把 `ui-permission` 的 `disabled` 摘掉；
 *   3. 删 `<home>/enhance`（删之前归档用户手写的文本与状态）；
 *   4. `*.bak-*` 全部保留当回滚网。
 *
 * 官方行一个字节都不碰：`fs-observation-policy`（读后写）从安装到卸载都不读不写——
 * 它只属于宿主。`ui-permission` 的 `disabled` 只摘我们自己停的那一份（清单记了归属）。
 *
 * **不再有 L1/L2 这种"整份换备份"**：整份回滚只在维护者显式 `--to <file>` 时发生，
 * 且必须指名、没有默认值。想"只是关掉"用 `state.json` 的 `enabled: false`，那是软关闭。
 *
 * 幂等：已经摘过就打 skipped；没有 patch 的 profile 也打 skipped，不报错。
 *
 * 用法：
 *   node uninstall.mjs --home <DSH_HOME> [--dry-run]        # 摘清单里记的全部 profile
 *   node uninstall.mjs --home <DSH_HOME> --profiles desktop [--all] [--dry-run]
 *   node uninstall.mjs --home <DSH_HOME> --to <某份备份文件> --profiles <单个 profile> [--dry-run]
 *   node uninstall.mjs --home <DSH_HOME> --thorough [--profiles desktop]
 */

import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eolOf, joinLines, removeInsertRow, removeRowBlock, splitLines } from './shared/text-lines.mjs'
import { writeFileAtomic } from './shared/state.mjs'
import { removePermissionPreset, removeUnownedEnhancedPreset } from './shared/patch-rows.mjs'

/** 我们插进 patch 的三行。 */
const INSERT_IDS = ['enhance-scope', 'auto-approve', 'enhance-ui']

/** 权限选择器的替换行。 */
const PERMISSION_ID = 'enhance-permissions'

/** 清单文件名（与 install.mjs 同一个）。 */
const MANIFEST_NAME = 'install-manifest.json'

function valueOf(argv, index, flag) {
  const value = argv[index + 1]
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${flag} 需要一个值`)
  return value
}

function parseArgs(argv) {
  const options = {
    home: process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'),
    // 不给默认值：`undefined` 的含义是「按清单/现有 profile 推」，见 defaultProfiles()
    profiles: undefined,
    profilesExplicit: false,
    all: false,
    dryRun: false,
    staging: undefined,
    to: undefined,
    thorough: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--all') options.all = true
    else if (arg === '--thorough') options.thorough = true
    else if (arg === '--home') { options.home = valueOf(argv, index, '--home'); index += 1 }
    else if (arg === '--profiles') {
      options.profiles = valueOf(argv, index, '--profiles').split(',').map((name) => name.trim()).filter(Boolean)
      options.profilesExplicit = true
      index += 1
    }
    else if (arg === '--staging') { options.staging = valueOf(argv, index, '--staging'); index += 1 }
    else if (arg === '--to') { options.to = valueOf(argv, index, '--to'); index += 1 }
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

/** 发现 `<home>/profiles/*`；一个都没有就返回空数组。 */
async function discoverProfiles(home) {
  try {
    const entries = await readdir(join(home, 'profiles'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

async function readManifest(home) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'enhance', MANIFEST_NAME), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.profiles === 'object') return parsed
  } catch {
    // 没有清单（旧安装 / 已被删）：只做行级摘除；disabled 的归属不明时进 warnings，不猜。
  }
  return { profiles: {} }
}

/**
 * 默认要摘的 profile 集合（没传 `--profiles`/`--all` 时）。
 *
 * `<home>/enhance` 是全局的：摘完 patch 就把整份插件目录删了，所以默认集必须覆盖
 * 「所有装过的 profile」，否则别的 profile 会指向一个已经不存在的目录。
 *   1. 清单里记的 profile —— 装的时候写过什么，就摘什么（含 `--profiles`/`--all` 装的那些）；
 *   2. 清单缺失或为空（旧安装/已被删）→ 当前 home 里实际存在的 profile；
 *   3. 两者都没有 → `desktop`（干净机器上的唯一约定）。
 *
 * @param {string} home
 * @param {{ profiles?: Record<string, unknown> }} manifest
 * @returns {Promise<string[]>}
 */
async function defaultProfiles(home, manifest) {
  const recorded = Object.keys(manifest.profiles ?? {}).sort()
  if (recorded.length > 0) return recorded
  const found = await discoverProfiles(home)
  return found.length > 0 ? found : ['desktop']
}

/** 摘掉 `ui-permission` 行下的 `disabled: true`（我们装的才摘）。 */
function restoreUiPermission(lines) {
  const rowPattern = /^([ \t]*)-[ \t]*id:[ \t]*ui-permission[ \t]*$/
  for (let index = 0; index < lines.length; index += 1) {
    const match = rowPattern.exec(lines[index])
    if (match === null) continue
    const base = match[1].length
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan]
      const indent = line.length - line.trimStart().length
      if (line.trim() !== '' && indent <= base) break
      if (/^[ \t]*disabled:[ \t]*true[ \t]*$/.test(line)) {
        lines.splice(scan, 1)
        return { lines, restored: true }
      }
    }
    return { lines, restored: false }
  }
  return { lines, restored: false }
}

/**
 * 行级手术：返回新文本与"做了什么"。
 *
 * `kept` 是**没摘、也没敢摘**的东西：归属没记下来（清单丢失后被 install
 * 收养）而我们又认不出那份 `enhanced` 是不是自己写的时，这里只记一行说明，由调用方打
 * `warn:` —— 不许静默。见 `shared/patch-rows.mjs` 的 `removeUnownedEnhancedPreset`。
 *
 * @param {string} text
 * @param {{ uiPermissionAction?: string, permissionPresetAction?: 'added'|'inserted'|'unchanged', permissionDefaultAction?: 'added'|'kept' }} entry
 */
function surgery(text, entry) {
  const eol = eolOf(text)
  const hadTrailingNewline = text.endsWith(eol) || text.endsWith('\n')
  let lines = splitLines(text)
  const removed = []
  const restored = []
  const kept = []

  for (const id of INSERT_IDS) {
    const result = removeInsertRow(lines, id)
    if (result.removed) removed.push(id)
    lines = result.lines
  }
  const permission = removeInsertRow(lines, PERMISSION_ID)
  if (permission.removed) removed.push(PERMISSION_ID)
  lines = permission.lines

  if (entry.permissionPresetAction === 'added' || entry.permissionPresetAction === 'inserted') {
    const presets = removePermissionPreset(joinLines(lines, eol), entry.permissionPresetAction, entry.permissionDefaultAction === 'added')
    if (presets.changed !== undefined) {
      removed.push(presets.changed)
      lines = splitLines(presets.text)
    }
  } else if (removed.length > 0) {
    // 归属没记下来（清单丢失后被 install 收养），而这个 patch 里确实摘掉过我们的行：
    // 那是一份「我们没记归属的 enhanced」——只摘逐字节长成我们输出的那一份，其余保持原样并告警。
    const orphan = removeUnownedEnhancedPreset(joinLines(lines, eol))
    if (orphan.changed !== undefined) {
      removed.push(orphan.changed)
      lines = splitLines(orphan.text)
    }
    if (orphan.kept !== undefined) kept.push(orphan.kept)
  }

  if (entry.uiPermissionAction === 'added') {
    const ui = removeRowBlock(lines, 'ui-permission')
    if (ui.removed) restored.push('ui-permission')
    lines = ui.lines
  } else if (entry.uiPermissionAction === 'flipped') {
    const ui = restoreUiPermission(lines)
    lines = ui.lines
    if (ui.restored) restored.push('ui-permission')
  }
  // 官方 `fs-observation-policy` 一行都不动：它是宿主的行，本工具从安装到卸载都不读不写。

  // 摘块时会顺手吃掉块尾的空行（含文件末尾那个），这里把"原来有尾换行"还回去
  let out = joinLines(lines, eol)
  // 空的 patch 不是合法的 entry 列表（宿主按顶层数组解析）：还原成空数组标记
  if (out.trim() === '') out = '[]'
  if (hadTrailingNewline && !out.endsWith(eol)) out += eol
  return { text: out, removed, restored, kept }
}

/**
 * 某个 id 行下面的缩进块里有没有 `disabled: true`。
 * @param {string} text
 * @param {string} id
 * @returns {boolean}
 */
function rowDisabled(text, id) {
  const lines = text.split(/\r?\n/)
  const rowPattern = new RegExp(`^[ \\t]*-[ \\t]*id:[ \\t]*${id}[ \\t]*$`)
  for (let index = 0; index < lines.length; index += 1) {
    if (!rowPattern.test(lines[index])) continue
    const base = (lines[index].match(/^[ \t]*/) ?? [''])[0].length
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const line = lines[scan]
      const indent = line.length - line.trimStart().length
      if (line.trim() !== '' && indent <= base) break
      if (/^[ \t]*disabled:[ \t]*true[ \t]*$/.test(line)) return true
    }
    return false
  }
  return false
}

/**
 * 本工具自己的备份前缀 —— 彻底清理只删这些，别人写的 `.bak-*` 一个不碰。
 *   install.mjs → `.bak-enhance-<stamp>`（装之前那份原件）
 *   本文件      → `.bak-uninstall-<stamp>`（摘行之前那份）
 *
 * 后三类是历史一次性迁移工具留下的（那些工具已删除）：旧机器上可能还有，
 * 所以彻底清理仍然认领它们 —— 不认领就等于永远清不掉。
 */
const OWN_BACKUP_PREFIXES = [
  'cordis.patch.yml.bak-enhance-',
  'cordis.patch.yml.bak-uninstall-',
  'cordis.patch.yml.bak-permissions-',
  'cordis.patch.yml.bak-presetmerge-',
  'cordis.patch.yml.bak-presetsplit-',
]

/** 这份备份是不是我们写的。 */
function isOwnBackup(name) {
  return OWN_BACKUP_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** 同一份备份（profile + 文件名）只留一条：实跑时 `freshBackups` 与目录扫描会重叠。 */
function dedupeBackups(items) {
  const seen = new Set()
  const out = []
  for (const item of items) {
    const key = `${item.profile}/${item.name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/**
 * Our own backup files under `profiles/<name>/`; other `.bak-*` files are not ours.
 * @param {string} home
 */
async function backupFiles(home) {
  const result = []
  let profiles = []
  try {
    profiles = await readdir(join(home, 'profiles'), { withFileTypes: true })
  } catch {
    return result
  }
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    let names = []
    try {
      names = await readdir(join(home, 'profiles', profile.name))
    } catch {
      continue
    }
    for (const name of names) {
      if (isOwnBackup(name)) result.push({ profile: profile.name, name })
    }
  }
  return result
}

/**
 * @param {{ home: string, profiles?: string[], all?: boolean, dryRun?: boolean, staging?: string, to?: string, thorough?: boolean }} options
 */
export async function uninstall(options) {
  const home = resolve(options.home)
  const dryRun = options.dryRun === true
  const thorough = options.thorough === true
  if (thorough && options.to !== undefined) throw new Error('--thorough 不能和 --to 同用：回滚一个档位不是卸载')
  if (options.to !== undefined && options.profilesExplicit !== true) throw new Error('--to 必须显式 --profiles <单个 profile>')
  const manifest = await readManifest(home)
  const profiles = options.all
    ? await discoverProfiles(home)
    : (options.profiles ?? await defaultProfiles(home, manifest))
  // 空集是用法错，不是「什么都不做」：下面删的是全局 `<home>/enhance`，一条 patch 都没摘就删目录，
  // 等于把每个 profile 的 insert 行留在原地指向不存在的插件。写盘前就拒绝（含 dry-run 预览）。
  if (profiles.length === 0) {
    throw new Error('没有 profile 可摘：拒绝执行（--profiles 给了空值，或 --all 一个 profile 都没扫到）')
  }
  if (options.to !== undefined && profiles.length !== 1) {
    throw new Error('--to 只能配合 --profiles 指定一个 profile（一份备份只对一份 patch 有意义）')
  }
  const changed = []
  const skipped = []
  const failed = []
  const planned = []
  const warnings = []
  /**
   * 本次运行自己造的 `.bak-uninstall-<stamp>`（每个被摘过的 profile 一份）。
   * 实跑时它当场落盘、同一趟里又被彻底清理删掉；预览里它还不存在。
   * 「彻底清理」报的份数必须两种模式一致，所以这里两种模式都记，见下面 thorough 分支。
   */
  const freshBackups = []

  for (const profile of profiles) {
    const patch = join(home, 'profiles', profile, 'cordis.patch.yml')
    if (!await exists(patch)) {
      skipped.push(`${profile}: no patch`)
      continue
    }
    try {
      const before = await readFile(patch, 'utf8')
      if (options.to !== undefined) {
        // 维护者显式整份回滚
        const target = resolve(options.to)
        if (!await exists(target)) {
          failed.push(`${profile}: --to 指向的文件不存在：${target}`)
          continue
        }
        const text = await readFile(target, 'utf8')
        if (text === before) {
          skipped.push(`${profile}: 已是 ${target}`)
          continue
        }
        planned.push(`${profile}: 整份回滚自 ${target}（显式 --to）`)
        if (!dryRun) {
          await copyFile(patch, `${patch}.bak-uninstall-${Date.now()}`)
          writeFileAtomic(patch, text)
        }
        changed.push(`${profile}: restore from --to`)
        continue
      }

      const entry = manifest.profiles?.[profile] ?? {}
      const result = surgery(before, entry)
      if (result.removed.length === 0 && result.restored.length === 0) {
        skipped.push(`${profile}: 本来就没装（没有我们的行）`)
        continue
      }
      planned.push(`${profile}: 删 ${result.removed.join(', ') || '（无）'}；恢复 ${result.restored.join(', ') || '（无）'}`)
      if (rowDisabled(result.text, 'ui-permission') && entry.uiPermissionAction !== 'added' && entry.uiPermissionAction !== 'flipped') {
        warnings.push(`${profile}: ui-permission 的 disabled 归属不确定（清单没有记录），保持原样`)
      }
      for (const item of result.kept) warnings.push(`${profile}: ${item}`)
      const scratch = `${patch}.bak-uninstall-${Date.now()}`
      if (!dryRun) {
        await copyFile(patch, scratch)
        writeFileAtomic(patch, result.text)
      }
      freshBackups.push({ profile, name: dryRun ? `${basename(scratch)}（本次运行新造）` : basename(scratch) })
      changed.push(`${profile}: ${result.removed.length} 行删除 / ${result.restored.length} 行恢复`)
    } catch (error) {
      failed.push(`${profile}: ${String(error?.message ?? error)}`)
    }
  }

  const enhanceDir = join(home, 'enhance')
  const patchOnly = options.to !== undefined
  if (failed.length > 0) {
    // 任一 profile 失败就保留插件目录与 staging：失败路径不该顺手删掉可恢复的东西
    skipped.push('有 failed 项：保留 enhance 目录与 staging，先修失败项')
  } else if (patchOnly) {
    // `--to` 只恢复 patch：它只覆盖一个 profile，删全局插件目录会让别的 profile 悬空
    skipped.push('--to 只回滚 patch：保留 enhance 目录与 staging（要卸载请单独跑一次不带 --to）')
  } else {
    const backups = await backupFiles(home)
    if (thorough) {
      if (await exists(enhanceDir)) {
        if (!dryRun) await rm(enhanceDir, { recursive: true, force: true })
        planned.push(`彻底清理：不归档，删 ${enhanceDir}`)
        changed.push(`remove ${enhanceDir}`)
      }
      // 预览与实跑数同一批：实跑在循环里已经给自己造了 freshBackups 那几份（同一趟里会被删掉，
      // 是本次运行的临时物），预览里它们还不存在 —— 并上，两边才是同一个数。
      const cleanup = dedupeBackups([...backups, ...freshBackups])
      if (cleanup.length > 0) {
        if (!dryRun) {
          for (const backup of cleanup) await rm(join(home, 'profiles', backup.profile, backup.name), { force: true })
        }
        planned.push(`彻底清理：删 ${cleanup.length} 份备份（${cleanup.map((item) => `${item.profile}/${item.name}`).join(', ')}）`)
        changed.push(`remove ${cleanup.length} backups`)
      }
      if (!await exists(enhanceDir) && cleanup.length === 0) skipped.push('no enhance directory or backups')
    } else if (await exists(enhanceDir)) {
      const archive = join(home, `enhance-archive-${Date.now()}`)
      if (!dryRun) {
        await mkdir(archive, { recursive: true })
        for (const name of ['content-scope.txt', 'state.json', MANIFEST_NAME]) {
          const from = join(enhanceDir, name)
          if (await exists(from)) await copyFile(from, join(archive, name))
        }
        await rm(enhanceDir, { recursive: true, force: true })
      }
      planned.push(`归档 ${archive}；删 ${enhanceDir}`)
      changed.push(`remove ${enhanceDir}`)
    } else {
      skipped.push('no enhance directory')
    }
    if (!thorough && backups.length > 0) planned.push(`回滚备份保留 ${backups.length} 份（默认不删）`)

    if (options.staging !== undefined && await exists(options.staging)) {
      if (!dryRun) await rm(options.staging, { recursive: true, force: true })
      changed.push(`remove ${options.staging}`)
    }
  }

  const backups = await backupFiles(home)
  return { ok: failed.length === 0, dryRun, thorough, changed, skipped, failed, planned, warnings, backups, needRestart: changed.length > 0 }
}

export const __testing = { parseArgs, surgery, rowDisabled, restoreUiPermission, removeInsertRow, removeRowBlock, defaultProfiles, discoverProfiles }

const isMain = process.argv[1] !== undefined && (() => {
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await uninstall(options)
    console.log(`home=${resolve(options.home)}${options.dryRun ? ' (dry run)' : ''}`)
    for (const line of result.planned) console.log(`  plan:    ${line}`)
    for (const line of result.changed) console.log(`  changed: ${line}`)
    for (const line of result.skipped) console.log(`  skipped: ${line}`)
    for (const line of result.warnings) console.log(`  warn:    ${line}`)
    for (const line of result.failed) console.log(`  failed:  ${line}`)
    for (const backup of result.backups ?? []) console.log(`  backup:  ${backup.profile}/${backup.name}`)
    console.log(`thorough=${result.thorough === true}`)
    console.log(`need_restart=${result.needRestart}`)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    console.error(`uninstall: ${String(error?.message ?? error)}`)
    process.exitCode = 1
  }
}
