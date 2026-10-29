@echo off
rem 双击运行 = 交互式菜单；带参数时透传给 enhance-uninstall.ps1（-Yes / -Thorough ...）。
setlocal
set "PWSH=pwsh"
where pwsh >nul 2>nul || set "PWSH=powershell"
"%PWSH%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0enhance-uninstall.ps1" %*
set "EC=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %EC%
