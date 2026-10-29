# enhance-install.ps1 —— 安装脚本的薄壳（菜单与全部逻辑在 scripts/enhance-install.mjs）。
#
# 用法：
#   .\enhance-install.ps1                    # 交互式中文菜单
#   .\enhance-install.ps1 -Yes               # 非交互（门禁用）
#   .\enhance-install.ps1 -DryRun            # 只预览
#   .\enhance-install.ps1 -Profiles desktop,headless
#   .\enhance-install.ps1 -DshRoot "D:\Program Files\DeepSeek Harness" -Home "D:\dsh-home"
#
# 路径含空格可用（所有路径都用引号与 -LiteralPath 处理）。装完只打印重启提示，不自动重启。

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\enhance-shell.ps1')
$script:EnhanceErrorLabel = 'enhance-install'

$options = @{ Yes = $false; DryRun = $false; Profiles = $null; DshRoot = $null; Home = $null }
$index = 0
while ($index -lt $args.Count) {
  $arg = [string]$args[$index]
  if ($arg -eq '-Yes') { $options.Yes = $true; $index += 1 }
  elseif ($arg -eq '-DryRun') { $options.DryRun = $true; $index += 1 }
  elseif ($arg -eq '-Profiles') {
    if ($index + 1 -ge $args.Count) { Fail '-Profiles 需要一个值' }
    $options.Profiles = [string]$args[$index + 1]
    $index += 2
  }
  elseif ($arg -eq '-DshRoot') {
    if ($index + 1 -ge $args.Count) { Fail '-DshRoot 需要一个值' }
    $options.DshRoot = [string]$args[$index + 1]
    $index += 2
  }
  elseif ($arg -eq '-Home') {
    if ($index + 1 -ge $args.Count) { Fail '-Home 需要一个值' }
    $options.Home = [string]$args[$index + 1]
    $index += 2
  }
  else {
    Fail "未知参数：$arg（用法：-Yes -DryRun -Profiles a,b -DshRoot <path> -Home <path>）"
  }
}

$node = Get-EnhanceNode $options.DshRoot
$scriptPath = Join-Path $PSScriptRoot 'scripts\enhance-install.mjs'
$nodeArgs = @($scriptPath)
if ($options.Yes) { $nodeArgs += '--yes' }
if ($options.DryRun) { $nodeArgs += '--dry-run' }
if ($options.Profiles) { $nodeArgs += @('--profiles', $options.Profiles) }
if ($options.DshRoot) { $nodeArgs += @('--dsh-root', $options.DshRoot) }
if ($options.Home) { $nodeArgs += @('--home', $options.Home) }

& $node @nodeArgs
exit $LASTEXITCODE
