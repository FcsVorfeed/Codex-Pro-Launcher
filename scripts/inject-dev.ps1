$ErrorActionPreference = "Stop"

# 这一段定位仓库根目录，并固定开发注入只能通过 private 目录里的真实 launcher 进入。
# Locate the repository root and force development injection through the real private launcher.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildScript = Join-Path $repoRoot "scripts\build-launcher-exe.ps1"
$privateLauncher = Join-Path $repoRoot "private\bin\Codex-Pro-Launcher.exe"

Set-Location $repoRoot

# 这一段显式检查原生命令退出码，避免构建或注入失败后继续使用旧运行态。
# Explicitly check native command exit codes so build or injection failures cannot keep stale runtime state.
function Assert-LastExitCode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Step
  )

  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

# 这一段给 Start-Process 拼接参数时保留带空格路径的单个参数边界。
# Preserve single-argument boundaries for paths with spaces when passing Start-Process arguments.
function ConvertTo-ProcessArgument {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + ($Value -replace '"', '\"') + '"'
}

# 这一段先把当前源码构建并覆盖 private 开发 exe，保证用户双击入口和开发注入入口一致。
# Build the current source into the private dev exe first so double-click and dev injection use the same launcher.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildScript -SkipTests
Assert-LastExitCode "build private Codex-Pro-Launcher.exe"

if (-not (Test-Path -LiteralPath $privateLauncher)) {
  throw "Private Codex-Pro launcher was not found: $privateLauncher"
}

# 这一段等待 GUI 子系统 launcher 完整退出，避免脚本先返回但后台仍是旧 worker。
# Wait for the GUI-subsystem launcher to exit so the script cannot return while an old worker remains.
$launcherArguments = @(
  "--attach-only",
  "--native-bridge",
  "--dev-runtime",
  "--source-root",
  $repoRoot
) | ForEach-Object { ConvertTo-ProcessArgument $_ }
$launcherProcess = Start-Process -FilePath $privateLauncher -ArgumentList $launcherArguments -PassThru -WindowStyle Hidden
$launcherProcess.WaitForExit()
if ($launcherProcess.ExitCode -ne 0) {
  throw "inject with private Codex-Pro-Launcher.exe failed with exit code $($launcherProcess.ExitCode). See %USERPROFILE%\.codex\.Codex-Pro-Launcher\logs\portable-launcher.log"
}
