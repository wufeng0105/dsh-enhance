# 端到端冒烟：在一次性 DSH_HOME + 一次性 profile 上真装、真组合、真调用。
# 不碰用户的 ~/.dsh，也不动你日常在用的 desktop profile。
$ErrorActionPreference = 'Stop'
$repo = (Get-Location).Path
$cli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
# 注意：不要用 $home —— PowerShell 的 $HOME 是只读自动变量，大小写不敏感。
$smokeHome = Join-Path $env:TEMP ("dsh-enhance-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$env:DSH_HOME = $smokeHome
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7897' }

Write-Output "# home = $smokeHome"
Write-Output "# repo = $repo"
Write-Output "# cli  = $cli"
Write-Output ''
Write-Output '===== 1. dsh plugin add（真机装载）====='
& $cli plugin --profile smoke add $repo 2>&1 | ForEach-Object { $_ }
Write-Output "exit=$LASTEXITCODE"

Write-Output ''
Write-Output '===== 2. 冒烟断言 ====='
& node (Join-Path $repo 'tools\smoke.mjs') 2>&1 | ForEach-Object { $_ }
$code = $LASTEXITCODE

Write-Output ''
Write-Output '===== 3. 收尾（删掉这次的一次性 home）====='
Remove-Item -Recurse -Force $smokeHome -ErrorAction SilentlyContinue
Write-Output "cleaned $smokeHome"
Write-Output "summary exit=$code"
exit $code

