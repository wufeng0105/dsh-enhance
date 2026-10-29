# 两个使用者脚本共用的小工具（薄壳只做「找 node / 解析参数 / 留住控制台」）。
# 逻辑不在这里：见 scripts/enhance-install.mjs 与 scripts/enhance-uninstall.mjs。

# 错误前缀由调用方设定：同一次运行里所有失败都用同一个入口名（install / uninstall）。
$script:EnhanceErrorLabel = 'enhance'
function Fail([string]$message) {
  [Console]::Error.WriteLine("$($script:EnhanceErrorLabel): $message")
  exit 1
}

<#
  找 node，按顺序：
    1. DSH 根（`-DshRoot` 给了就用它）自带的 resources\runtime\primary-runtime\dependencies\node\bin\node.exe
    2. %LOCALAPPDATA%\Programs\DeepSeek Harness 下同一个相对路径
    3. PATH 里的 node（必须 >= 22）
  都没有 → 一行可行动错误 + exit 1。
#>
function Get-EnhanceNode([string]$DshRoot) {
  $relative = 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  $candidates = @()
  if ($DshRoot) { $candidates += (Join-Path $DshRoot $relative) }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA ('Programs\DeepSeek Harness\' + $relative)) }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      $version = & $candidate --version 2>$null
      if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $candidate }
    }
  }
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) {
    $version = & $command.Source --version 2>$null
    if ($version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $command.Source }
  }
  Fail '找不到可用的 node（需要 >= 22）：先安装 DeepSeek Harness（它自带 node），或把 node 加进 PATH'
}
