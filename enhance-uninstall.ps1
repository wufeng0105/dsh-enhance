# enhance-uninstall.ps1 —— 卸载脚本的薄壳（菜单与全部逻辑在 scripts/enhance-uninstall.mjs）。
#
# 用法：
#   .\enhance-uninstall.ps1                  # 交互式：选 1 保留备份 / 2 彻底清理（二次确认）
#   .\enhance-uninstall.ps1 -Yes             # 非交互：默认方式（保留备份，归档）
#   .\enhance-uninstall.ps1 -Thorough -Yes   # 非交互：彻底清理
#   .\enhance-uninstall.ps1 -DryRun          # 只预览
#   .\enhance-uninstall.ps1 -Home "D:\dsh-home"
#
# 做完只打印重启提示，不自动重启。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\enhance-shell.ps1')
$script:EnhanceErrorLabel = 'enhance-uninstall'

$options = @{ Yes = $false; DryRun = $false; Thorough = $false; Home = $null }
$index = 0
while ($index -lt $args.Count) {
  $arg = [string]$args[$index]
  if ($arg -eq '-Yes') { $options.Yes = $true; $index += 1 }
  elseif ($arg -eq '-DryRun') { $options.DryRun = $true; $index += 1 }
  elseif ($arg -eq '-Thorough') { $options.Thorough = $true; $index += 1 }
  elseif ($arg -eq '-Home') {
    if ($index + 1 -ge $args.Count) { Fail '-Home 需要一个值' }
    $options.Home = [string]$args[$index + 1]
    $index += 2
  }
  else {
    Fail "未知参数：$arg（用法：-Yes -DryRun -Thorough -Home <path>）"
  }
}

$node = Get-EnhanceNode $null
$scriptPath = Join-Path $PSScriptRoot 'scripts\enhance-uninstall.mjs'
$nodeArgs = @($scriptPath)
if ($options.Yes) { $nodeArgs += '--yes' }
if ($options.DryRun) { $nodeArgs += '--dry-run' }
if ($options.Thorough) { $nodeArgs += '--thorough' }
if ($options.Home) { $nodeArgs += @('--home', $options.Home) }

& $node @nodeArgs
exit $LASTEXITCODE
