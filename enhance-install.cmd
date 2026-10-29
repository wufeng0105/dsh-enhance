@echo off
rem 双击运行 = 交互式菜单；带参数时透传给 enhance-install.ps1（-Yes / -DryRun / -Profiles ...）。
setlocal
set "PWSH=pwsh"
where pwsh >nul 2>nul || set "PWSH=powershell"
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0enhance-install.ps1" %*
set "EC=%ERRORLEVEL%"
rem 双击（没有参数）时留住窗口，否则一闪而过看不到错误
if "%~1"=="" pause
exit /b %EC%
