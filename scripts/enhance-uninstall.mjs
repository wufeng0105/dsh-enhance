#!/usr/bin/env node
/**
 * 使用者卸载脚本的逻辑（薄壳：`enhance-uninstall.ps1` / `enhance-uninstall.cmd`）。
 *
 * 两个选项，先打印各自删什么留什么：
 *   1 保留备份（默认卸载）：归档 state.json / content-scope.txt / install-manifest.json 到
 *     `<home>/enhance-archive-<时间戳>/`，保留 `.bak-*` 回滚网，再删 `<home>/enhance/`。
 *   2 不留备份（彻底清理）：不归档，删 `<home>/enhance/` 与本工具自己的备份；别人写的 `.bak-*`
 *     一个不碰。需要二次确认。
 *
 * `--yes` 供门禁调用（不提问）；`--thorough` 选择选项 2；`--dry-run` 只预览。
 * 做完只打印一行「请重启」，不自动重启 DSH。
 */

import { defaultHome, readInstalledState, runCli } from './enhance-lib.mjs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const options = { home: defaultHome(), yes: false, dryRun: false, thorough: false }
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  const value = () => {
    const next = args[i + 1]
    if (typeof next !== 'string' || next.trim() === '' || next.startsWith('-')) {
      console.error(`enhance-uninstall: ${arg} 需要一个值`)
      process.exit(1)
    }
    i += 1
    return next
  }
  if (arg === '--yes') options.yes = true
  else if (arg === '--dry-run') options.dryRun = true
  else if (arg === '--thorough') options.thorough = true
  else if (arg === '--home') options.home = value()
  else {
    console.error(`enhance-uninstall: 未知参数：${arg}`)
    process.exit(1)
  }
}

const say = (line) => console.log(line)
const home = options.home
const state = readInstalledState(home)
say(`home：${home}`)
say(`enhance：${state.state === 'installed' ? `已安装 v${state.version}` : state.state === 'broken' ? `清单异常（${state.reason}）` : '未安装'}`)

if (state.state === 'not-installed') {
  say(`没有可卸载的东西：${home}\\enhance 不存在`)
  process.exit(0)
}
if (state.state === 'broken') {
  // 清单坏了仍可卸载（行级摘除 + 告警），但先把话说清楚
  say('注意：清单异常，卸载只能做行级摘除；`disabled` 归属不明的行会保持原样并打 warn:')
}

if (options.dryRun !== true && options.yes !== true) {
  say('')
  say('请选择卸载方式：')
  say('  1 保留备份（默认）：归档 state.json / content-scope.txt / install-manifest.json 到')
  say('    <home>/enhance-archive-<时间戳>/，保留 .bak-* 回滚网，再删 <home>/enhance/')
  say('  2 不留备份（彻底清理）：不归档，删 <home>/enhance/ 与本工具自己的备份；')
  say('    别人写的 .bak-* 一个不碰')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const pick = await new Promise((resolvePick) => rl.question('输入 1 或 2 [1]：', resolvePick))
  let choice = String(pick).trim()
  if (choice === '') choice = '1'
  if (choice !== '1' && choice !== '2') {
    rl.close()
    console.error(`enhance-uninstall: 无效选项：${choice}（只能输入 1 或 2）`)
    process.exit(1)
  }
  if (choice === '2') {
    const confirm = await new Promise((resolveConfirm) => rl.question('彻底清理会删掉本工具的全部备份且不归档，确认？ [y/N] ', resolveConfirm))
    if (String(confirm).trim().toLowerCase() !== 'y') {
      rl.close()
      say('已取消，未做任何改动')
      process.exit(0)
    }
    options.thorough = true
  }
  rl.close()
}

const uninstallArgs = ['--home', home]
if (options.thorough) uninstallArgs.push('--thorough')
if (options.dryRun) uninstallArgs.push('--dry-run')
const code = runCli('uninstall.mjs', uninstallArgs)
if (code !== 0) {
  console.error(`enhance-uninstall: uninstall.mjs 退出码 ${code}；先按上面的报错修，未打印重启提示`)
  process.exit(code)
}
if (options.dryRun) {
  say('dry run：以上是计划，未写任何文件')
  process.exit(0)
}
say('请重启 DeepSeek Harness 使改动生效')
process.exit(0)
