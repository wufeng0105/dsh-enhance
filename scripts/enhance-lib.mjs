/**
 * 两个使用者脚本的共享逻辑（`enhance-install.ps1` / `enhance-uninstall.ps1` 只是薄壳）。
 *
 * 薄壳负责三件只有 PowerShell 能做好的事：找 node、解析参数、把控制台留住（双击不闪退）。
 * 其余全部在这里：探测 DSH 根与安装状态、按「未装 / 同版本 / 异版本 / 清单坏了」四分支决策、
 * 调 `install.mjs` / `doctor.mjs` / `uninstall.mjs`、打印「请重启」或「无需重启」。
 *
 * 两条硬约束（写在这里，薄壳不再重复）：
 *   - **不自动重启 DSH**：装/卸完成只打印一行提示。
 *   - 交互式菜单只在有 stdin 且没给 `--yes` 时出现；`--yes` 下不提问、不阻塞，供门禁调用。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { toolVersion } from '../shared/tool-version.mjs'

/** 仓库根（本文件在 `scripts/` 下）。 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 默认 DSH 根（注册表读不到时的回退位置）。 */
export function defaultDshRoot(env = process.env) {
  const local = env.LOCALAPPDATA ?? env.USERPROFILE ?? ''
  return join(local, 'Programs', 'DeepSeek Harness')
}

/** 宿主 DSH 的默认 home；环境变量 `DSH_HOME` 优先（与 `shared/state.mjs` 同一口径）。 */
export function defaultHome(env = process.env) {
  const envHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (envHome !== '') return envHome
  return join(env.USERPROFILE ?? env.HOME ?? '', '.dsh')
}

/**
 * 从注册表 `HKCU` 卸载项里找 `InstallLocation`。
 * 读不到注册表（非 Windows / 无 reg.exe）就返回空数组，调用方回退默认位置。
 */
function registryDshRoots() {
  const out = []
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DeepSeek Harness'], { encoding: 'utf8' })
    for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
      const match = /InstallLocation\s+REG_\w+\s+(.+)$/.exec(line.trim())
      if (match !== null) out.push(match[1].trim())
    }
  } catch {
    // 没有注册表：交给默认位置
  }
  return out
}

/**
 * 探测 DSH 根。顺序：显式参数 → HKCU 卸载项 → `%LOCALAPPDATA%\Programs\DeepSeek Harness`。
 * @param {{ override?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ root: string, source: string, hasAsar: boolean } | undefined}
 */
export function resolveDshRoot(options = {}) {
  const env = options.env ?? process.env
  // 显式给根时以它为准：指错了就报「没找到」，不要悄悄回退到别的安装（那会让人以为在改 A 其实改了 B）。
  const override = typeof options.override === 'string' ? options.override.trim() : ''
  if (override !== '') {
    const path = resolve(override)
    if (!existsSync(path)) return undefined
    return { root: path, source: '参数 --dsh-root', hasAsar: existsSync(join(path, 'resources', 'app.asar')) }
  }
  const candidates = []
  for (const path of registryDshRoots()) candidates.push({ path, source: '注册表 HKCU 卸载项' })
  candidates.push({ path: defaultDshRoot(env), source: '默认位置 %LOCALAPPDATA%\\Programs' })
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) {
      return { root: candidate.path, source: candidate.source, hasAsar: existsSync(join(candidate.path, 'resources', 'app.asar')) }
    }
  }
  return undefined
}

/**
 * 读落盘的安装状态。四分支的判定依据全在这里，菜单与门禁共用。
 * @param {string} home
 * @returns {{ state: 'not-installed'|'installed'|'broken', version?: string, toolVersion?: string, files?: string[], fileHashes?: Record<string,string> }}
 */
export function readInstalledState(home) {
  const dir = join(home, 'enhance')
  if (!existsSync(dir)) return { state: 'not-installed' }
  const manifestPath = join(dir, 'install-manifest.json')
  if (!existsSync(manifestPath)) return { state: 'broken', reason: '`<home>/enhance` 在，但清单 `install-manifest.json` 缺失' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return { state: 'broken', reason: '清单 `install-manifest.json` 不是合法 JSON' }
  }
  if (manifest === null || typeof manifest !== 'object' || typeof manifest.profiles !== 'object') {
    return { state: 'broken', reason: '清单 `install-manifest.json` 形状不对（缺 `profiles`）' }
  }
  if (typeof manifest.toolVersion !== 'string' || manifest.toolVersion.trim() === '') {
    return { state: 'broken', manifest, reason: '清单没有 `toolVersion`（旧版安装，判不出版本）' }
  }
  return {
    state: 'installed',
    version: manifest.toolVersion,
    manifest,
    files: Array.isArray(manifest.files) ? manifest.files : [],
    fileHashes: manifest.fileHashes !== null && typeof manifest.fileHashes === 'object' ? manifest.fileHashes : {},
  }
}

/**
 * 安装脚本的四分支决策（纯函数，测试直接钉它）。
 * @param {{ home: string, dshRoot?: { root: string } | undefined, currentVersion: string }} input
 * @returns {{ action: 'host-missing'|'install'|'verify'|'update'|'broken', detail: string, state?: ReturnType<typeof readInstalledState> }}
 */
export function decideInstall(input) {
  const { home, dshRoot, currentVersion } = input
  if (dshRoot === undefined) {
    return { action: 'host-missing', detail: '没有找到 DeepSeek Harness 的安装目录：本脚本不自动下载安装包，请先安装 DSH，或用 --dsh-root 指定它的根目录' }
  }
  const state = readInstalledState(home)
  if (state.state === 'broken') {
    return { action: 'broken', detail: `${state.reason}：拒绝静默跳过。先执行「清理后重装」：node uninstall.mjs --home "${home}" --thorough && node install.mjs --home "${home}"`, state }
  }
  if (state.state === 'not-installed') {
    return { action: 'install', detail: `${home} 下还没有 enhance/，将执行安装`, state }
  }
  if (state.version === currentVersion) {
    return { action: 'verify', detail: `已安装且版本一致（${currentVersion}）：不重装、不改 patch，只做一致性校验`, state }
  }
  return { action: 'update', detail: `已安装版本 ${state.version} 与当前工具 ${currentVersion} 不同：将更新`, state }
}

/** 跑一个仓库内的 CLI，输出直通控制台；返回退出码。 */
export function runCli(script, args) {
  const result = spawnSync(process.execPath, [join(repoRoot, script), ...args], { cwd: repoRoot, stdio: 'inherit' })
  return result.status ?? 1
}

/** 非交互/交互共用的小工具：一行提问，返回是否选中。 */
export async function confirm(question, { yes, defaultValue = true } = {}) {
  if (yes) return true
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const suffix = defaultValue ? '[Y/n]' : '[y/N]'
    const answer = await new Promise((res) => rl.question(`${question} ${suffix} `, res))
    const text = String(answer).trim().toLowerCase()
    if (text === '') return defaultValue
    return text === 'y' || text === 'yes'
  } finally {
    rl.close()
  }
}

/** 一致性校验（同版本分支）：doctor --home、清单 hash、派生件代际（有 asar 才做）。 */
export function verifyInstall({ home, dshRoot, profiles, say }) {
  const problems = []
  const doctorCode = runCli('doctor.mjs', ['--home', home])
  if (doctorCode !== 0) problems.push('doctor --home 未全 PASS')

  const state = readInstalledState(home)
  const mismatched = []
  for (const [rel, expected] of Object.entries(state.fileHashes ?? {})) {
    try {
      const bytes = readFileSync(join(home, 'enhance', rel))
      if (createHash('sha256').update(bytes).digest('hex') !== expected) mismatched.push(rel)
    } catch {
      mismatched.push(`${rel}(missing)`)
    }
  }
  if (mismatched.length > 0) problems.push(`落盘文件与清单 hash 不符：${mismatched.join(', ')}`)

  if (dshRoot?.hasAsar === true) {
    const code = runCli('enhance-permissions/build-client.mjs', ['--check', '--asar', join(dshRoot.root, 'resources', 'app.asar')])
    if (code !== 0) problems.push('派生件与当前宿主 asar 不同代（重跑 build-client.mjs 派生）')
  } else {
    say('派生件代际：本机没有 resources\\app.asar，跳过代际校验（升级/换机后请补跑 build-client --check --asar）')
  }
  if (problems.length > 0) return { ok: false, problems }
  say(`一致性校验通过：doctor 全 PASS、落盘 hash 与清单一致${dshRoot?.hasAsar === true ? '、派生件同代' : ''}`)
  return { ok: true, problems }
}

/** 列出目录里本工具自己的备份（`*.bak-*` 里前缀属于我们的那些）。 */
export function ownBackups(home) {
  const prefixes = ['cordis.patch.yml.bak-enhance-', 'cordis.patch.yml.bak-uninstall-', 'cordis.patch.yml.bak-permissions-', 'cordis.patch.yml.bak-presetmerge-', 'cordis.patch.yml.bak-presetsplit-']
  const out = []
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return out
  for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!profile.isDirectory()) continue
    for (const name of readdirSync(join(profilesDir, profile.name))) {
      if (prefixes.some((prefix) => name.startsWith(prefix))) out.push(`${profile.name}/${name}`)
    }
  }
  return out
}

export { toolVersion }
