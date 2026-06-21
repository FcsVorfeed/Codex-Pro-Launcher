param(
  [switch]$SkipTests,
  [switch]$Desktop
)

$ErrorActionPreference = "Stop"

# 这一段定位仓库根目录。
# Locate the repository root.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
Set-Location $repoRoot

# 这一段显式检查原生命令退出码，避免 PowerShell 在 cargo 失败后继续发布旧 exe。
# Explicitly check native command exit codes so PowerShell cannot publish a stale exe after cargo fails.
function Assert-LastExitCode {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Step
  )

  if ($LASTEXITCODE -ne 0) {
    throw "$Step failed with exit code $LASTEXITCODE"
  }
}

# 这一段读取 Cargo workspace 版本，作为 exe 文件名和 Windows 文件属性的同一版本源头。
# Read the Cargo workspace version so the exe filename and Windows file metadata share one source.
function Get-WorkspacePackageVersion {
  $cargoTomlPath = Join-Path $repoRoot "Cargo.toml"
  $insideWorkspacePackage = $false
  foreach ($line in Get-Content -LiteralPath $cargoTomlPath -Encoding UTF8) {
    if ($line -eq "[workspace.package]") {
      $insideWorkspacePackage = $true
      continue
    }
    if ($insideWorkspacePackage -and $line -match '^\[') {
      break
    }
    if ($insideWorkspacePackage -and $line -match '^version\s*=\s*"(?<version>[0-9]+\.[0-9]+\.[0-9]+)"') {
      return $Matches.version
    }
  }

  throw "Cargo.toml missing [workspace.package] semantic version"
}

# 这一段固定输出目录到 private，避免发布产物混入公开源码树。
# Use a dedicated private output directory so release artifacts do not mix into the public source tree.
$outputDir = Join-Path $repoRoot "private\build\rust"
$releaseVersion = Get-WorkspacePackageVersion
$outputExe = Join-Path $outputDir "Codex-Pro-Launcher.exe"
$versionedOutputExe = Join-Path $outputDir "Codex-Pro-Launcher-v$releaseVersion.exe"
$targetDir = Join-Path $repoRoot "private\target"
$releaseConfigEnvName = "CODEX_PRO_RELEASE_CONFIG_JSON"

# 这一段读取 release 需要内嵌的公开运行配置。
# Read the public runtime config that must be embedded into the release executable.
function Get-RequiredString {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Value,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $text = [string]$Value
  $trimmed = $text.Trim()
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    throw "release config missing required field: $Name"
  }
  return $trimmed
}

# 这一段限制 release 内嵌 URL 为 HTTPS，避免把开发本机地址发给用户。
# Restrict embedded release URLs to HTTPS so local development endpoints are not shipped to users.
function Assert-HttpsUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne "https") {
    throw "release config field must be an HTTPS URL: $Name"
  }
}

# 这一段限制 release 内嵌授权 Key 必须是公开 Key，避免把服务端私钥编进 exe。
# Restrict the embedded license key to publishable keys so server secrets are not compiled into the exe.
function Assert-LicensePublishableKey {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ($Value -notmatch '^pk_[A-Za-z0-9_-]{8,200}$') {
    throw "release config field must be a publishable license key: $Name"
  }
}

# 这一段限制产品标识只能作为 URL 路径片段使用。
# Restrict the product slug so it is safe as a URL path segment.
function Assert-LicenseProductSlug {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ($Value -notmatch '^[A-Za-z0-9._-]{1,120}$') {
    throw "release config field must be a safe product slug: $Name"
  }
}

# 这一段把 private 配置抽取成允许进入 release exe 的公开运行配置。
# Extract only public runtime fields from private config for the release executable.
function Get-ReleaseRuntimeConfigJson {
  $configPath = Join-Path $repoRoot "private\config\codex-pro.local.json"
  if (-not (Test-Path -LiteralPath $configPath)) {
    throw "release config file does not exist: $configPath"
  }

  $rawConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $cloudSyncEndpoint = Get-RequiredString $rawConfig.sync.cloudSyncEndpoint "sync.cloudSyncEndpoint"
  $petSyncEndpoint = Get-RequiredString $rawConfig.sync.petSyncEndpoint "sync.petSyncEndpoint"
  $conversationArchiveEndpoint = Get-RequiredString $rawConfig.sync.conversationArchiveEndpoint "sync.conversationArchiveEndpoint"
  $keyAcquisitionUrl = Get-RequiredString $rawConfig.sync.keyAcquisitionUrl "sync.keyAcquisitionUrl"
  $licenseApiBase = Get-RequiredString $rawConfig.license.apiBase "license.apiBase"
  $licenseApiKey = Get-RequiredString $rawConfig.license.apiKey "license.apiKey"
  $licenseProductSlug = Get-RequiredString $rawConfig.license.productSlug "license.productSlug"

  Assert-HttpsUrl $cloudSyncEndpoint "sync.cloudSyncEndpoint"
  Assert-HttpsUrl $petSyncEndpoint "sync.petSyncEndpoint"
  Assert-HttpsUrl $conversationArchiveEndpoint "sync.conversationArchiveEndpoint"
  Assert-HttpsUrl $keyAcquisitionUrl "sync.keyAcquisitionUrl"
  Assert-HttpsUrl $licenseApiBase "license.apiBase"
  Assert-LicensePublishableKey $licenseApiKey "license.apiKey"
  Assert-LicenseProductSlug $licenseProductSlug "license.productSlug"

  $wallpaperImages = @()
  if ($null -ne $rawConfig.appearance -and $null -ne $rawConfig.appearance.defaultBackgroundWallpaperImages) {
    foreach ($image in @($rawConfig.appearance.defaultBackgroundWallpaperImages)) {
      $imageText = ([string]$image).Trim()
      if ([string]::IsNullOrWhiteSpace($imageText)) {
        continue
      }
      Assert-HttpsUrl $imageText "appearance.defaultBackgroundWallpaperImages"
      $wallpaperImages += $imageText
    }
  }

  $publicConfig = [ordered]@{
    sync = [ordered]@{
      cloudSyncEndpoint = $cloudSyncEndpoint
      petSyncEndpoint = $petSyncEndpoint
      conversationArchiveEndpoint = $conversationArchiveEndpoint
      keyAcquisitionUrl = $keyAcquisitionUrl
    }
    license = [ordered]@{
      apiBase = $licenseApiBase
      apiKey = $licenseApiKey
      productSlug = $licenseProductSlug
    }
    appearance = [ordered]@{
      defaultBackgroundWallpaperImages = $wallpaperImages
    }
    conversationArchive = [ordered]@{}
  }

  return ($publicConfig | ConvertTo-Json -Compress -Depth 8)
}

# 这一段在所有 cargo 调用前设置编译期 release 配置，确保测试、clippy 和最终 exe 使用同一份公开运行配置。
# Set compile-time release config before all cargo calls so tests, clippy, and the final exe use the same public runtime config.
$releaseConfigJson = Get-ReleaseRuntimeConfigJson
Set-Item -Path "Env:$releaseConfigEnvName" -Value $releaseConfigJson
Write-Host "Release runtime config: embedded public sync/license endpoints from private config."

if (-not $SkipTests) {
  # 这一段先跑 Rust 回归检查，避免产出未验证的发布文件。
  # Run Rust regression checks before producing a release artifact.
  cargo test --target-dir $targetDir
  Assert-LastExitCode "cargo test --target-dir $targetDir"
  cargo clippy --target-dir $targetDir --all-targets -- -D warnings
  Assert-LastExitCode "cargo clippy --target-dir $targetDir --all-targets -- -D warnings"
  cargo fmt --check
  Assert-LastExitCode "cargo fmt --check"
}

# 这一段用 release profile 构建单 exe；默认发布入口不嵌入管理员 manifest，必要时由运行期 fallback 单独触发 UAC。
# Build the release executable without an admin manifest by default; runtime fallback triggers UAC only when needed.
cargo build --target-dir $targetDir --release --bin Codex-Pro-Launcher
Assert-LastExitCode "cargo build --target-dir $targetDir --release --bin Codex-Pro-Launcher"

# 这一段复制最终 exe 到发布目录。
# Copy the final executable to the release directory.
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -Force (Join-Path $targetDir "release\Codex-Pro-Launcher.exe") $outputExe
Copy-Item -Force $outputExe $versionedOutputExe

# 这一段输出体积并提示验收风险。
# Print size and warn when it exceeds the acceptance target.
$sizeBytes = (Get-Item $outputExe).Length
$sizeMb = [Math]::Round($sizeBytes / 1MB, 2)
Write-Host "Rust launcher: $outputExe"
Write-Host "Release asset: $versionedOutputExe"
Write-Host "Version: $releaseVersion"
Write-Host "Size: $sizeMb MB"
if ($sizeBytes -gt (15MB)) {
  Write-Warning "Rust exe exceeds 15MB. Audit dependencies/assets/symbols before considering compression."
}

if ($Desktop) {
  # 这一段按需复制到桌面，方便手动烟测。
  # Optionally copy to Desktop for manual smoke testing.
  $desktop = [Environment]::GetFolderPath("Desktop")
  Copy-Item -Force $outputExe (Join-Path $desktop "Codex-Pro-Launcher.exe")
  Copy-Item -Force $versionedOutputExe (Join-Path $desktop "Codex-Pro-Launcher-v$releaseVersion.exe")
  Write-Host "Copied to Desktop."
}
