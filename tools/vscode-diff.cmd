@echo off
setlocal

rem 这一段确保外部 Diff 传入了旧文件和当前文件两个路径。
rem Ensure the external diff bridge provided both old and current file paths.
if "%~1"=="" exit /b 2
if "%~2"=="" exit /b 2

rem 这一段优先使用当前用户安装的 VS Code，避免依赖 PATH。
rem Prefer the current user's VS Code install instead of relying on PATH.
set "VSCODE_EXE=%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe"
if exist "%VSCODE_EXE%" (
  start "" "%VSCODE_EXE%" --diff "%~1" "%~2"
  exit /b 0
)

rem 这一段在默认安装路径不存在时回退到 code 命令。
rem Fall back to the code command when the default install path is unavailable.
where code >nul 2>nul
if not errorlevel 1 (
  start "" code --diff "%~1" "%~2"
  exit /b 0
)

exit /b 1
