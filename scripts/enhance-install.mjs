#!/usr/bin/env node
/**
 * 使用者安装脚本的逻辑（薄壳：`enhance-install.ps1` / `enhance-install.cmd`）。
 *
 * 四分支决策（`decideInstall`）：
 *   host-missing  没有 DSH 根 → 一行说明 + exit 1，**不自动下载安装包**
 *   install       home 下没有 enhance/ → 装 → 打印重启行
 *   verify        版本一致 → 不装、不改 patch，只做一致性校验 → 打印「无需重启」
 *   update        版本不一致 → 更新 → 打印重启行
 *   broken        enhance/ 在但清单缺/坏/无版本 → 拒绝并给一条可执行的清理/重装命令
 *
 * 默认只装 desktop；`--profiles headless,web` 显式装别的；`--dry-run` 只预览。
 * 交互式中文菜单只在没给 `--yes` 且有 stdin 时出现。
 */

import { decideInstall, defaultHome, readInstalledState, repoRoot, resolveDshRoot, runCli, toolVersion, verifyInstall } from './enhance-lib.mjs'

const args = process.argv.slice(2)
const options = {
  home: defaultHome(),
  dshRoot: undefined,
  profiles: ['desktop'],
  yes: false,
  dryRun: false,
}
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  const value = () => {
    const next = args[i + 1]
    if (typeof next !== 'string' || next.trim() === '' || next.startsWith('-')) {
      console.error(`enhance-install: ${arg} 需要一个值`)
      process.exit(1)
    }
    i += 1
    return next
  }
  if (arg === '--yes') options.yes = true
  else if (arg === '--dry-run') options.dryRun = true
  else if (arg === '--home') options.home = value()
  else if (arg === '--dsh-root') options.dshRoot = value()
  else if (arg === '--profiles') options.profiles = value().split(',').map((name) => name.trim()).filter(Boolean)
  else {
    console.error(`enhance-install: 未知参数：${arg}`)
    process.exit(1)
  }
}

const version = toolVersion()
const home = options.home
const dsh = resolveDshRoot({ override: options.dshRoot })
const decision = decideInstall({ home, dshRoot: dsh, currentVersion: version })

const say = (line) => console.log(line)
say(`DSH 根：${dsh === undefined ? '（未找到）' : `${dsh.root}（来源：${dsh.source}，app.asar ${dsh.hasAsar ? '在' : '不在'}）`}`)
say(`home：${home}`)
say(`当前工具版本：${version}`)
const before = readInstalledState(home)
say(`enhance：${before.state === 'installed' ? `已安装 v${before.version}` : before.state === 'broken' ? `清单异常（${before.reason}）` : '未安装'}`)
say(`决策：${decision.action} — ${decision.detail}`)

if (decision.action === 'host-missing' || decision.action === 'broken') {
  console.error(`enhance-install: ${decision.detail}`)
  process.exit(1)
}

const plan = decision.action === 'verify'
  ? '不安装、不改 patch；只跑 doctor --home、清单 hash 比对、派生件代际检查'
  : `安装到 ${home}（profiles: ${options.profiles.join(', ') || '（空）'}），装完跑 doctor --home`
say(`计划：${plan}`)
if (options.dryRun) {
  say('dry run：未写任何文件')
  process.exit(0)
}

// 交互式确认：只有「要写盘」的动作需要确认；verify 只读。
if (decision.action !== 'verify' && options.yes !== true) {
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolveAnswer) => rl.question('继续？ [Y/n] ', resolveAnswer))
  rl.close()
  const text = String(answer).trim().toLowerCase()
  if (text !== '' && text !== 'y' && text !== 'yes') {
    say('已取消，未写任何文件')
    process.exit(0)
  }
}

if (decision.action === 'verify') {
  const result = verifyInstall({ home, dshRoot: dsh, profiles: options.profiles, say })
  if (!result.ok) {
    console.error(`enhance-install: 一致性校验未通过：${result.problems.join('；')}`)
    process.exit(1)
  }
  say('无需重启 DeepSeek Harness：本次没有改动任何文件')
  process.exit(0)
}

const installArgs = ['--home', home, '--profiles', options.profiles.join(',')]
const installCode = runCli('install.mjs', installArgs)
if (installCode !== 0) {
  console.error(`enhance-install: install.mjs 退出码 ${installCode}；未打印重启提示，先按上面的报错修`)
  process.exit(installCode)
}
const doctorCode = runCli('doctor.mjs', ['--home', home])
if (doctorCode !== 0) {
  console.error('enhance-install: doctor --home 未全 PASS；先按 FAIL 行修，再重启')
  process.exit(doctorCode)
}
say('请重启 DeepSeek Harness 使改动生效')
process.exit(0)
