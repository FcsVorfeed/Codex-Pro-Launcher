@echo off
rem Keep this batch file ASCII-only. Some Windows cmd.exe versions parse
rem non-ASCII batch content before the UTF-8 code page takes effect.
chcp 65001 >nul

rem Pin the current directory to the repository root.
cd /d "%~dp0"

echo.
echo [Codex-Pro] Release single-exe build entry
echo.

rem Forward all arguments to the PowerShell build script.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-release-interactive.ps1" %*
set "BUILD_EXIT=%ERRORLEVEL%"

echo.
if "%BUILD_EXIT%"=="0" (
  echo [Codex-Pro] Build entry finished.
) else (
  echo [Codex-Pro] Build entry failed with exit code: %BUILD_EXIT%
)
echo.
echo If the build failed, screenshot this window or send the newest log under private\build\logs.
echo.
pause
exit /b %BUILD_EXIT%
