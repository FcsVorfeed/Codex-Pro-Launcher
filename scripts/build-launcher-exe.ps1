param(
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

# 这一段定位仓库根目录和 private 开发启动器输出路径。
# Locate the repository root and private development launcher output paths.
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetDir = Join-Path $repoRoot "private\target\codex-pro-dev"
$builtExe = Join-Path $targetDir "debug\Codex-Pro-Launcher.exe"
$privateBinDir = Join-Path $repoRoot "private\bin"
$targetExe = Join-Path $privateBinDir "Codex-Pro-Launcher.exe"

Set-Location $repoRoot

# 这一段显式检查原生命令退出码，避免 PowerShell 在 cargo 失败后继续复制旧 exe。
# Explicitly check native command exit codes so PowerShell cannot copy a stale exe after cargo fails.
function Assert-LastExitCode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Step
  )

  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

if (-not $SkipTests) {
  # 这一段先运行 Rust 回归检查，避免 private 开发入口落后于源码。
  # Run Rust regression checks before replacing the private development entry.
  cargo test --target-dir $targetDir --workspace
  Assert-LastExitCode "cargo test --target-dir $targetDir --workspace"
  cargo fmt --check
  Assert-LastExitCode "cargo fmt --check"
}

# 这一段删除旧构建产物，确保本次复制的一定是刚刚成功编译出的 exe。
# Remove the old build output so the copied exe must come from the successful build below.
if (Test-Path -LiteralPath $builtExe) {
  Remove-Item -LiteralPath $builtExe -Force
}

# 这一段构建调试配置 launcher；默认双击入口不嵌入管理员 manifest，必要时由运行期 fallback 单独触发 UAC。
# Build the debug launcher without an admin manifest by default; runtime fallback triggers UAC only when needed.
cargo build --target-dir $targetDir --bin Codex-Pro-Launcher
Assert-LastExitCode "cargo build --target-dir $targetDir --bin Codex-Pro-Launcher"

if (-not (Test-Path -LiteralPath $builtExe)) {
  throw "Rust launcher was not found: $builtExe"
}

# 这一段用临时文件替换 private 目录里的开发 exe，避免复制中断留下半成品。
# Replace the private development exe via a temporary file so interrupted copies do not leave a partial launcher.
New-Item -ItemType Directory -Force -Path $privateBinDir | Out-Null
$temporaryTargetExe = "$targetExe.rebuild"
Copy-Item -LiteralPath $builtExe -Destination $temporaryTargetExe -Force
if (Test-Path -LiteralPath $targetExe) {
  Remove-Item -LiteralPath $targetExe -Force
}
Move-Item -LiteralPath $temporaryTargetExe -Destination $targetExe -Force

$sizeBytes = (Get-Item -LiteralPath $targetExe).Length
$sizeMb = [Math]::Round($sizeBytes / 1MB, 2)
Write-Host "Built Rust development launcher: $targetExe"
Write-Host "Size: $sizeMb MB"
